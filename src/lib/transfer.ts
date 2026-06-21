// 文件传输前端绑定:对应 Rust 的 transfer.rs。
//
// - upload/download:本地 ↔ 远程,后台并行 scp,立即返回 jobId
// - cancel:取消进行中的 job
// - 进度事件:'transfer-progress' / 'transfer-done',订阅后驱动进度坞渲染
// - startDragOut:本地文件原生拖出到 Finder/资源管理器(tauri-plugin-drag)
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** 后端推送的进度事件(transfer-progress)。 */
export interface TransferProgress {
  jobId: number
  phase: 'scanning' | 'transferring'
  done: number
  total: number
  bytesDone: number
  bytesTotal: number
  current: string
}

/** 后端推送的完成事件(transfer-done)。 */
export interface TransferDone {
  jobId: number
  ok: boolean
  error: string
  total: number
}

/** 前端维护的一次传输任务状态(进度坞渲染用)。 */
export interface TransferJob {
  id: number
  direction: 'upload' | 'download'
  label: string // 目标描述,如 "上传到 cluster-A" / "下载到 ~/Downloads"
  phase: 'scanning' | 'transferring' | 'done'
  done: number
  total: number
  bytesDone: number
  bytesTotal: number
  current: string
  ok: boolean
  error: string
}

/** 上传:本地若干路径 → 远端 host 的 destDir 下。返回 jobId。 */
export async function transferUpload(
  host: string,
  srcs: string[],
  destDir: string
): Promise<number> {
  return invoke<number>('transfer_upload', { host, srcs, destDir })
}

/** 下载:远端 host 若干路径 → 本地 destDir 下。返回 jobId。 */
export async function transferDownload(
  host: string,
  srcs: string[],
  destDir: string
): Promise<number> {
  return invoke<number>('transfer_download', { host, srcs, destDir })
}

/** 取消进行中的 job。 */
export async function transferCancel(jobId: number): Promise<void> {
  return invoke('transfer_cancel', { jobId })
}

/** 订阅进度事件。返回取消订阅函数(两个 listener 一起解绑)。 */
export async function listenTransfer(
  onProgress: (p: TransferProgress) => void,
  onDone: (d: TransferDone) => void
): Promise<UnlistenFn> {
  const un1 = await listen<TransferProgress>('transfer-progress', (e) =>
    onProgress(e.payload)
  )
  const un2 = await listen<TransferDone>('transfer-done', (e) =>
    onDone(e.payload)
  )
  return () => {
    un1()
    un2()
  }
}

// 预热 drag 插件模块:首次拖出前就把动态模块加载好,避免第一次拖拽因 import 延迟而错过手势。
// 关键:原生拖出必须在用户手势(dragstart)里**同步**发起;await 会断开手势链导致拖拽不生效。
// 因此把模块缓存成已解析的引用,startDragOut 同步取用、同步调用 startDrag。
type DragModule = typeof import('@crabnebula/tauri-plugin-drag')
let dragMod: DragModule | null = null
let dragModLoading: Promise<DragModule> | null = null
function loadDragMod(): Promise<DragModule> {
  if (dragMod) return Promise.resolve(dragMod)
  if (!dragModLoading) {
    dragModLoading = import('@crabnebula/tauri-plugin-drag').then((m) => {
      dragMod = m
      return m
    })
  }
  return dragModLoading
}
/** 在 app 启动时调用,预加载拖出插件(必须,保证 startDragOut 能同步发起)。 */
export function prewarmDrag(): void {
  void loadDragMod()
}

// 1×1 全透明 PNG 作为拖拽缩略图。插件要求 image 必须是 `data:image/png;base64,` 开头的字符串,
// 传空串会反序列化失败 → 整个 start_drag 调用报错、拖拽不生效。这里给一个最小合法图。
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC'

/**
 * 本地文件原生拖出到桌面(Finder/资源管理器)。仅本地路径可用——
 * 远程文件没有本地路径,走「下载到本机」流程(transferDownload)。
 *
 * 同步性:必须在 dragstart 手势里**同步**调用 startDrag。模块若已预热(prewarmDrag),
 * 这里直接同步发起;万一还没加载好,退化为异步(首次可能错过,但 prewarm 后基本不会)。
 */
export function startDragOut(paths: string[]): void {
  if (!paths.length) return
  if (dragMod) {
    // 已就绪:同步发起(保住用户手势链)
    try {
      void dragMod.startDrag({ item: paths, icon: TRANSPARENT_PNG })
    } catch (e) {
      console.error('[transfer] 拖出失败', e)
    }
    return
  }
  // 兜底:模块未就绪 → 异步(可能错过本次手势),并触发加载供下次用
  loadDragMod()
    .then((m) => m.startDrag({ item: paths, icon: TRANSPARENT_PNG }))
    .catch((e) => console.error('[transfer] 拖出失败(异步)', e))
}

// ============ 内部拖拽追踪(区分「app 内拖拽」vs「从 Finder 拖入」)============
//
// 本地文件 onDragStart 会发起原生拖出(startDragOut)。若用户把它拖回 app 内某文件夹,
// 全局 onDragDropEvent 会以该文件的本地路径触发 —— 但这是 app 内移动,应当 MOVE 而非
// 从外部 COPY 进来。用一个轻量标志记下「本轮拖拽源自 app 内」,handleDrop 据此区分:
//   - 标志命中(源在 app 内)→ 移动(movePath)
//   - 标志未命中(源自 Finder)→ 导入(本地 copy / 远程 upload)
let internalDrag: { paths: string[]; host: string } | null = null

export function markInternalDrag(paths: string[], host: string): void {
  internalDrag = { paths, host }
}
export function clearInternalDrag(): void {
  internalDrag = null
}
/** 取当前内部拖拽信息(不清除)。 */
export function getInternalDrag(): { paths: string[]; host: string } | null {
  return internalDrag
}

// ============ 传输完成后通知文件树刷新 ============
//
// 拖入复制/移动/下载落盘后,本地 fs 轮询监听有延迟(且不一定盯到子目录),
// 用户会以为"没生效"。这里在传输成功后主动派发一个 window 事件,FilesView 监听它
// 立即刷新对应目录,不再等轮询。host 空=本地,非空=远程别名。
export interface FsTouched {
  host: string
  dirs: string[]
}
const FS_TOUCHED_EVENT = 'linco-fs-touched'

/** 传输成功后调用:通知文件树刷新这些目录(host 空=本地)。 */
export function notifyFsTouched(host: string, dirs: string[]): void {
  if (!dirs.length) return
  window.dispatchEvent(
    new CustomEvent<FsTouched>(FS_TOUCHED_EVENT, {
      detail: { host, dirs: Array.from(new Set(dirs)) }
    })
  )
}

/** 订阅传输落盘通知。返回取消订阅函数。 */
export function onFsTouched(cb: (e: FsTouched) => void): () => void {
  const handler = (ev: Event): void => {
    cb((ev as CustomEvent<FsTouched>).detail)
  }
  window.addEventListener(FS_TOUCHED_EVENT, handler)
  return () => window.removeEventListener(FS_TOUCHED_EVENT, handler)
}
