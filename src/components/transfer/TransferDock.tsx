// 文件传输:进度坞 + 拖入(onDragDropEvent)+ 拖出协调。
//
// useTransfers():
//   - 维护进行中/刚完成的 job 列表(订阅 transfer-progress/done)
//   - 注册全局 onDragDropEvent:从 OS 拖入文件 → 命中文件树目标目录 →
//     本地复制(fs_copy)或远程上传(transfer_upload);app 内拖回则移动
//   - 全部 job 完成后自动收起(延时,让用户看到“完成”)
//
// 命中规则(借鉴 FileZilla):
//   - data-drop-dir 只标在【文件夹行】(值=该文件夹)与【文件树根容器】(值=root)。
//   - 落在文件夹行 → 进该文件夹;落在文件行/空白/表头 → 冒泡命中根容器 → 进根目录(cwd)。
//   - 因此落点只有两种确定结果:某个明确文件夹 或 根目录,绝不会“乱落”。
// 坐标:onDragDropEvent 的 position 是物理像素;elementFromPoint 用 CSS 像素,故 ÷ devicePixelRatio。
// 安全:命中元素必须属于【当前可见】的文件视图(不在 pointer-events-none/opacity-0 容器内),
//      否则忽略本次 drop —— 杜绝“文件视图没激活也把文件塞进某目录”。
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { X, ArrowUp, ArrowDown, Loader2, Check, AlertCircle } from 'lucide-react'
import {
  listenTransfer,
  transferUpload,
  transferCancel,
  getInternalDrag,
  clearInternalDrag,
  prewarmDrag,
  notifyFsTouched,
  type TransferJob
} from '../../lib/transfer'
import { copyPath, movePath } from '../../lib/fs'
import { useI18n } from '../../lib/i18n'

interface DropTarget {
  dir: string
  host: string // '' = 本地
}

/** 元素是否在可见容器内(不被 pointer-events-none / opacity-0 隐藏)。 */
function isVisiblyInteractable(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    const st = window.getComputedStyle(node)
    if (st.pointerEvents === 'none') return false
    if (st.opacity !== '' && parseFloat(st.opacity) === 0) return false
    if (st.display === 'none' || st.visibility === 'hidden') return false
    node = node.parentElement
  }
  return true
}

// 平台判定(沿用 TerminalView 的方式,零依赖)。
const IS_WINDOWS = navigator.platform.toLowerCase().includes('win')

// 窗口真实缩放系数(getCurrentWindow().scaleFactor())。Windows 上 onDragDropEvent
// 的坐标是【物理设备像素】,需 ÷scaleFactor 转 CSS 像素;mac 给的已是逻辑像素无需转。
// 缓存它,并在窗口可能跨屏移动后刷新。
let cachedScaleFactor = window.devicePixelRatio || 1
function refreshScaleFactor(): void {
  getCurrentWindow()
    .scaleFactor()
    .then((sf) => {
      if (sf > 0) cachedScaleFactor = sf
    })
    .catch(() => {})
}

/**
 * 把 Tauri onDragDropEvent 的坐标转成 elementFromPoint/getBoundingClientRect 用的 CSS 像素。
 *
 * 依据 wry 0.55 源码,坐标来源因平台而异:
 *   - macOS(wkwebview/drag_drop.rs):position 来自 NSPoint draggingLocation(),是 **逻辑** AppKit 点 → 直接用。
 *     (实测印证:DPR=2 时 phys.y=501 落在窗口逻辑高 832 内,而非物理的 ~1002。)
 *   - Windows(webview2/drag_drop.rs):position 来自 ScreenToClient,是 **物理** 设备像素 → ÷scaleFactor。
 * 用 Tauri 官方 scaleFactor(权威)而非猜 devicePixelRatio,确保 125%/150% 缩放、外接屏也准。
 */
function toCssPoint(physX: number, physY: number): { x: number; y: number } {
  if (IS_WINDOWS) {
    const sf = cachedScaleFactor || 1
    return { x: physX / sf, y: physY / sf }
  }
  return { x: physX, y: physY } // macOS/Linux:已是逻辑像素
}
/**
 * 命中文件树的投放目标(FileZilla / VSCode 规则,rect 命中而非 elementFromPoint)。
 * 坐标用 toCssPoint 归一化(本环境 Tauri 给的就是 CSS 像素,不再误除 DPR)。
 *   1) 找当前【可见】的文件树根容器(data-drop-root);光标不在其内 → 返回 null(不误塞)。
 *   2) 在文件夹行中找 rect 真正包含光标的 → 进该文件夹。
 *   3) 否则(空白/文件行/表头)→ 进根目录。
 */
function hitTest(physX: number, physY: number): DropTarget | null {
  const { x, y } = toCssPoint(physX, physY)

  // 1) 可见的文件树根容器(兜底=根目录)
  const roots = Array.from(
    document.querySelectorAll('[data-drop-root]')
  ) as HTMLElement[]
  const root = roots.find((r) => {
    if (!isVisiblyInteractable(r)) return false
    const b = r.getBoundingClientRect()
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
  })
  if (!root) return null // 光标不在任何可见文件树内 → 不处理(不会误塞)
  const host = root.getAttribute('data-drop-host') || ''
  const rootDir = root.getAttribute('data-drop-dir') || ''

  // 2) 在该根容器内的文件夹行中,找 rect 真正包含光标的
  const rows = Array.from(
    root.querySelectorAll('[data-drop-dir]')
  ) as HTMLElement[]
  for (const row of rows) {
    if (row === root) continue
    const b = row.getBoundingClientRect()
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      const dir = row.getAttribute('data-drop-dir') || ''
      if (dir) return { dir, host: row.getAttribute('data-drop-host') || host }
    }
  }

  // 3) 没命中任何文件夹行 → 根目录(FileZilla:拖到非文件夹处=当前目录)
  if (!rootDir) return null
  return { dir: rootDir, host }
}

export interface UseTransfers {
  jobs: TransferJob[]
  open: boolean
  setOpen: (v: boolean) => void
  cancel: (id: number) => void
  /** 下载:供文件树“下载到本机”调用,登记一个 job 标签 + 本地目标目录。 */
  trackDownload: (id: number, label: string, destDir: string) => void
  /** 拖入时的高亮目标(供文件树显示),null=无 */
  dropHint: string | null
}

export function useTransfers(): UseTransfers {
  const [jobs, setJobs] = useState<TransferJob[]>([])
  const [open, setOpen] = useState(false)
  const [dropHint, setDropHint] = useState<string | null>(null)
  const closeTimer = useRef<number | null>(null)
  // 暂存「刚发起、还没等到第一个进度事件」的 job 元信息(方向/标签/刷新目标)
  const pending = useRef<
    Map<
      number,
      { direction: 'upload' | 'download'; label: string; host: string; dir: string }
    >
  >(new Map())

  const upsert = useCallback((id: number, patch: Partial<TransferJob>) => {
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === id)
      if (i === -1) {
        const meta = pending.current.get(id)
        const base: TransferJob = {
          id,
          direction: meta?.direction || 'upload',
          label: meta?.label || '',
          phase: 'scanning',
          done: 0,
          total: 0,
          bytesDone: 0,
          bytesTotal: 0,
          current: '',
          ok: false,
          error: ''
        }
        return [...prev, { ...base, ...patch }]
      }
      const next = prev.slice()
      next[i] = { ...next[i], ...patch }
      return next
    })
  }, [])

  // 订阅后端进度/完成事件
  useEffect(() => {
    let un: (() => void) | undefined
    let dead = false
    listenTransfer(
      (p) => {
        upsert(p.jobId, {
          phase: p.phase,
          done: p.done,
          total: p.total,
          bytesDone: p.bytesDone,
          bytesTotal: p.bytesTotal,
          current: p.current
        })
        setOpen(true)
      },
      (d) => {
        upsert(d.jobId, { phase: 'done', ok: d.ok, error: d.error })
        // 成功完成 → 刷新目标目录(上传刷远程目标、下载刷本地目标)
        const meta = pending.current.get(d.jobId)
        if (d.ok && meta) notifyFsTouched(meta.host, [meta.dir])
        pending.current.delete(d.jobId)
      }
    ).then((fn) => {
      if (dead) fn()
      else un = fn
    })
    return () => {
      dead = true
      un?.()
    }
  }, [upsert])

  // 全部 job 结束 → 延时自动收起 + 清理
  useEffect(() => {
    if (!open) return
    const allDone = jobs.length > 0 && jobs.every((j) => j.phase === 'done')
    if (closeTimer.current != null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (allDone) {
      // 有失败 → 留久点(8s);全成功 → 2.5s 后收起
      const anyErr = jobs.some((j) => !j.ok)
      closeTimer.current = window.setTimeout(
        () => {
          setOpen(false)
          setJobs([])
        },
        anyErr ? 8000 : 2500
      )
    }
    return () => {
      if (closeTimer.current != null) {
        clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
    }
  }, [jobs, open])

  const cancel = useCallback((id: number) => {
    void transferCancel(id)
  }, [])

  const trackDownload = useCallback((id: number, label: string, destDir: string) => {
    // 下载目标在本地(host=''),完成后刷新该目录
    pending.current.set(id, { direction: 'download', label, host: '', dir: destDir })
    setOpen(true)
  }, [])

  // 全局拖入处理(OS 文件 → 文件树目标目录)
  useEffect(() => {
    prewarmDrag() // 预热拖出插件,首次本地拖出更跟手
    if (IS_WINDOWS) refreshScaleFactor() // Windows 需用真实 scaleFactor 换算拖放坐标
    let un: (() => void) | undefined
    let dead = false
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload
        if (p.type === 'over') {
          const t = hitTest(p.position.x, p.position.y)
          setDropHint(t ? `${t.host ? t.host + ':' : ''}${t.dir}` : null)
        } else if (p.type === 'leave') {
          setDropHint(null)
        } else if (p.type === 'drop') {
          setDropHint(null)
          const t = hitTest(p.position.x, p.position.y)
          if (!t || !p.paths || p.paths.length === 0) return
          void handleDrop(p.paths, t)
        }
      })
      .then((fn) => {
        if (dead) fn()
        else un = fn
      })
      .catch((err) => console.error('[transfer] onDragDropEvent 注册失败', err))
    return () => {
      dead = true
      un?.()
    }
    // handleDrop 是稳定纯逻辑,只依赖入参,安全忽略依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 实际执行拖入:区分「app 内拖拽(移动)」与「从 Finder 拖入(导入)」。
  const handleDrop = async (paths: string[], t: DropTarget): Promise<void> => {
    // 是否是 app 内拖拽回来(源路径匹配 + 同 host)→ 移动而非导入
    const internal = getInternalDrag()
    const isInternal =
      internal != null &&
      internal.host === t.host &&
      paths.length === internal.paths.length &&
      paths.every((p) => internal.paths.includes(p))
    if (isInternal) {
      clearInternalDrag()
      const hostArg = t.host || undefined
      const touchedDirs: string[] = [t.dir]
      for (const src of paths) {
        const srcDir = src.slice(0, src.lastIndexOf('/'))
        if (srcDir === t.dir) continue // 已在目标目录
        if (t.dir === src || t.dir.startsWith(src + '/')) continue // 不能移进自身/子目录
        try {
          await movePath(src, t.dir, hostArg)
          if (srcDir) touchedDirs.push(srcDir) // 源目录也要刷(文件移走了)
        } catch (err) {
          console.error('[transfer] 移动失败', src, err)
        }
      }
      notifyFsTouched(t.host, touchedDirs)
      return
    }

    if (t.host) {
      // 从 Finder 拖入远程目录:上传(后端 emit 进度,进度坞自动出现)
      try {
        const id = await transferUpload(t.host, paths, t.dir)
        pending.current.set(id, {
          direction: 'upload',
          label: `上传到 ${t.host}`,
          host: t.host,
          dir: t.dir
        })
        setOpen(true)
      } catch (err) {
        console.error('[transfer] 上传失败', err)
      }
    } else {
      // 从 Finder 拖入本地目录:本地复制(不经网络)
      let any = false
      for (const src of paths) {
        try {
          await copyPath(src, t.dir, undefined)
          any = true
        } catch (err) {
          console.error('[transfer] 本地复制失败', src, err)
        }
      }
      if (any) notifyFsTouched('', [t.dir]) // 主动刷新目标目录(不等 fs 轮询)
    }
  }

  return { jobs, open, setOpen, cancel, trackDownload, dropHint }
}

// ============ 进度坞 UI(借鉴底部停靠终端的外观)============

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function JobRow({
  job,
  onCancel
}: {
  job: TransferJob
  onCancel: (id: number) => void
}): JSX.Element {
  const pct =
    job.total > 0 ? Math.round((job.done / job.total) * 100) : job.phase === 'done' ? 100 : 0
  const DirIcon = job.direction === 'upload' ? ArrowUp : ArrowDown
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 text-[12.5px]">
        <DirIcon size={13} className="shrink-0 text-accent" />
        <span className="truncate font-medium text-ink">{job.label || '传输'}</span>
        <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
          {job.phase === 'scanning'
            ? '扫描中…'
            : `${job.done}/${job.total} · ${fmtBytes(job.bytesDone)}/${fmtBytes(
                job.bytesTotal
              )}`}
        </span>
        {job.phase === 'done' ? (
          job.ok ? (
            <Check size={14} className="shrink-0 text-[#788C5D]" />
          ) : (
            <AlertCircle size={14} className="shrink-0 text-[#D97757]" />
          )
        ) : (
          <button
            onClick={() => onCancel(job.id)}
            className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-black/10 hover:text-ink"
            title="取消"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {/* 进度条 */}
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/10">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${
            job.phase === 'done' && !job.ok ? 'bg-error' : 'bg-accent'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* 当前文件 / 错误 */}
      {job.phase === 'done' && !job.ok ? (
        <div className="mt-1 truncate text-[11px] text-[#D97757]">{job.error}</div>
      ) : job.current ? (
        <div className="mt-1 flex items-center gap-1 truncate text-[11px] text-ink-faint">
          {job.phase !== 'done' && <Loader2 size={11} className="shrink-0 animate-spin" />}
          <span className="truncate">{job.current}</span>
        </div>
      ) : null}
    </div>
  )
}

export default function TransferDock({
  jobs,
  onCancel,
  onClose
}: {
  jobs: TransferJob[]
  onCancel: (id: number) => void
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const active = jobs.filter((j) => j.phase !== 'done').length
  return (
    <div className="relative overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      <div className="flex items-center justify-between border-b border-black/8 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          {active > 0 ? `传输中 · ${active}` : '传输完成'}
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
          title={t('app.terminal.close')}
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[240px] divide-y divide-black/5 overflow-y-auto">
        {jobs.map((j) => (
          <JobRow key={j.id} job={j} onCancel={onCancel} />
        ))}
      </div>
    </div>
  )
}
