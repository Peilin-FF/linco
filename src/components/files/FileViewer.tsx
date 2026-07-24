import { useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Loader2, FileQuestion, Download, GitCompare, FileText } from 'lucide-react'
import { readBytesCached } from '@/lib/fs'
import {
  invalidateShadowDiff,
  peekShadowDiff,
  shadowDiff
} from '@/lib/shadow'
import { onRemoteFsChange } from '@/lib/watch'
import { useI18n } from '@/lib/i18n'
import FileEditor from './FileEditor'
import TableViewer, { isTableFile } from './TableViewer'
import DiffView from '../git/DiffView'

interface FileViewerProps {
  path: string
  host?: string
  /** 工作目录(= git 仓库根),用于本轮 agent 改动 diff;空则不显 diff */
  repo?: string
  /** 文件树已计算出的本轮改动状态；无状态表示不需要请求单文件 diff。 */
  changeStatus?: string
  changeStatusReady?: boolean
}

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'text'

const MIME: Record<string, string> = {
  // image
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  // video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  m4v: 'video/mp4',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  // pdf
  pdf: 'application/pdf'
}

function kindOf(name: string): { kind: Kind; mime: string } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const mime = MIME[ext]
  if (!mime) return { kind: 'text', mime: '' }
  if (mime.startsWith('image/')) return { kind: 'image', mime }
  if (mime.startsWith('video/')) return { kind: 'video', mime }
  if (mime.startsWith('audio/')) return { kind: 'audio', mime }
  return { kind: 'pdf', mime }
}

/** 是否是需走二进制预览的媒体文件(供预读判断)。 */
export function isMediaFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return !!MIME[ext]
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

/**
 * 按文件类型路由预览(借鉴 yazi 的 previewer 分发思想,但用 webview 原生渲染):
 * 文本/代码 → CodeMirror;图片/视频/音频/PDF → 读 base64 喂给对应 HTML 标签。
 */
export default function FileViewer({
  path,
  host,
  repo,
  changeStatus,
  changeStatusReady = true
}: FileViewerProps): JSX.Element {
  const name = baseName(path)

  // 表格类:csv/tsv/xlsx/xls → 可编辑表格(优先于文本/媒体判断)
  if (isTableFile(name)) {
    return <TableViewer path={path} host={host} />
  }

  const { kind, mime } = kindOf(name)

  // 文本类:交给带「改动/文件」切换的包装(本轮有 agent 改动则默认显 diff)
  if (kind === 'text') {
    return (
      <TextOrDiff
        path={path}
        host={host}
        repo={repo}
        changeStatus={changeStatus}
        changeStatusReady={changeStatusReady}
      />
    )
  }
  return <MediaViewer path={path} host={host} kind={kind} mime={mime} />
}

/**
 * 文本文件:若本轮 agent 改过它,默认显 Cursor 式 diff(红绿增删),可切回完整文件编辑。
 * 没有 repo 或本轮没改动 → 直接完整文件编辑(等同旧行为)。
 */
function TextOrDiff({
  path,
  host,
  repo,
  changeStatus,
  changeStatusReady
}: {
  path: string
  host?: string
  repo?: string
  changeStatus?: string
  changeStatusReady: boolean
}): JSX.Element {
  const { t } = useI18n()
  const cachedAtMount = repo ? peekShadowDiff(repo, path, host) : undefined
  const [diff, setDiff] = useState<string | null>(
    cachedAtMount?.trim() ? cachedAtMount : null
  )
  const [diffLoading, setDiffLoading] = useState(
    Boolean(repo && cachedAtMount === undefined && (!changeStatusReady || changeStatus))
  )
  const [mode, setMode] = useState<'diff' | 'file'>(
    cachedAtMount?.trim() ? 'diff' : 'file'
  )
  // 用户是否手动切过:手动切了就尊重选择,不再自动跳回 diff
  const touchedRef = useRef(false)
  const hasRenderedDiffRef = useRef(Boolean(cachedAtMount?.trim()))

  // 拉本轮 diff;文件变更事件来时重拉(灵敏:agent 改完即更新)。
  // 文件页只反映「本轮 agent 改动」:本轮有 diff → 显红绿;本轮没改 → 直接显完整文件,
  // 不提示任何「未提交改动」(那是 Git 页面的职责,文件页不越界)。
  useEffect(() => {
    if (!repo) {
      setDiff(null)
      setDiffLoading(false)
      setMode('file')
      return
    }
    if (!changeStatusReady) {
      if (peekShadowDiff(repo, path, host) === undefined) setDiffLoading(true)
      return
    }
    if (!changeStatus) {
      setDiff(null)
      setDiffLoading(false)
      setMode('file')
      hasRenderedDiffRef.current = false
      return
    }
    let alive = true
    let un: (() => void) | undefined
    const load = (invalidate = false): void => {
      if (invalidate) invalidateShadowDiff(repo, path, host)
      const cached = peekShadowDiff(repo, path, host)
      if (cached !== undefined) {
        const has = cached.trim().length > 0
        setDiff(has ? cached : null)
        setDiffLoading(false)
        hasRenderedDiffRef.current = has
        if (has && !touchedRef.current) setMode('diff')
        if (!has) setMode('file')
        return
      }
      if (!hasRenderedDiffRef.current) setDiffLoading(true)
      shadowDiff(repo, path, host)
        .then((d) => {
          if (!alive) return
          const has = d.trim().length > 0
          setDiff(has ? d : null)
          setDiffLoading(false)
          hasRenderedDiffRef.current = has
          if (has && !touchedRef.current) setMode('diff')
          if (!has) setMode('file')
        })
        .catch((e) => {
          console.error('[shadow-diff] ❌ 拉 diff 失败 path=', path, e)
          if (alive) {
            setDiffLoading(false)
            if (!hasRenderedDiffRef.current) {
              setDiff(null)
              setMode('file')
            }
          }
        })
    }
    load()
    onRemoteFsChange((e) => {
      if ((e.host || undefined) !== (host || undefined)) return
      const target = path.replace(/\\/g, '/')
      if (e.paths.some((p) => p.replace(/\\/g, '/') === target)) load(true)
    }).then((f) => (un = f))
    // 发消息(新一轮)时主动重拉本轮 diff:基线已被 shadowBeginTurn 重置,
    // 立即反映上一轮对该文件的增删,无需等远端轮询。
    const onTurn = (): void => load(true)
    window.addEventListener('linco:turn-refresh', onTurn)
    return () => {
      alive = false
      un?.()
      window.removeEventListener('linco:turn-refresh', onTurn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, host, repo, changeStatus, changeStatusReady])

  if (diffLoading && !diff) {
    return (
      <div className="flex h-full flex-col bg-canvas text-ink">
        <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[13px]">
          <FileText size={14} className="text-ink-muted" />
          <span className="truncate text-ink">{baseName(path)}</span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-canvas text-[12px] text-ink-faint">
          <Loader2 size={14} className="animate-spin" />
          <span>{t('fileViewer.loadingChanges')}</span>
        </div>
      </div>
    )
  }

  if (mode === 'diff' && diff) {
    return (
      <div className="flex h-full flex-col">
        <ViewToggle
          mode={mode}
          hasDiff
          onMode={(m) => {
            setMode(m)
            touchedRef.current = true
          }}
          name={baseName(path)}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          <DiffView diff={diff} />
        </div>
      </div>
    )
  }
  // 完整文件:有 diff 时顶部给个切回「改动」的开关
  return (
    <div className="flex h-full flex-col">
      {diff && (
        <ViewToggle
          mode="file"
          hasDiff
          onMode={(m) => {
            setMode(m)
            touchedRef.current = true
          }}
          name={baseName(path)}
        />
      )}
      <div className="min-h-0 flex-1">
        <FileEditor path={path} host={host} diff={diff || ''} />
      </div>
    </div>
  )
}

function ViewToggle({
  mode,
  hasDiff,
  onMode,
  name
}: {
  mode: 'diff' | 'file'
  hasDiff: boolean
  onMode: (m: 'diff' | 'file') => void
  name: string
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[12px]">
      <span className="truncate text-ink-muted">{name}</span>
      <div className="ml-auto flex items-center gap-0.5 rounded-md bg-sidebar p-0.5">
        <button
          onClick={() => onMode('diff')}
          disabled={!hasDiff}
          className={`flex items-center gap-1 rounded px-2 py-0.5 ${
            mode === 'diff' ? 'bg-canvas text-ink shadow-sm' : 'text-ink-muted'
          } disabled:opacity-40`}
        >
          <GitCompare size={12} />{t('fileViewer.changes')}
        </button>
        <button
          onClick={() => onMode('file')}
          className={`flex items-center gap-1 rounded px-2 py-0.5 ${
            mode === 'file' ? 'bg-canvas text-ink shadow-sm' : 'text-ink-muted'
          }`}
        >
          <FileText size={12} />{t('fileViewer.file')}
        </button>
      </div>
    </div>
  )
}

function MediaViewer({
  path,
  host,
  kind,
  mime
}: {
  path: string
  host?: string
  kind: Exclude<Kind, 'text'>
  mime: string
}): JSX.Element {
  const { t } = useI18n()
  const [src, setSrc] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setErr(null)
    // 本地:走 asset:// 协议(convertFileSrc),浏览器原生流式加载,
    // 无 base64 膨胀、无超长字符串 —— 大图也丝滑。
    if (!host) {
      setSrc(convertFileSrc(path))
      setLoading(false)
      return
    }
    // 远程:没有本地路径,只能经 SSH 传 base64 → data URL。
    // 用缓存(悬停已预读则命中,瞬时显示);加载中保留上一张不闪屏。
    setLoading(true)
    readBytesCached(path, host)
      .then((b64) => {
        if (alive) setSrc(`data:${mime};base64,${b64}`)
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [path, host, mime])

  return (
    <div className="flex h-full flex-col">
      {/* 文件名条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[13px]">
        <span className="truncate text-ink">{baseName(path)}</span>
        <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] text-ink-faint">
          {kind}
        </span>
      </div>

      {/* 内容 */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#f4f4f2] p-3">
        {loading ? (
          <span className="flex items-center gap-2 text-[13px] text-ink-faint">
            <Loader2 size={14} className="animate-spin" />
            {t('fileViewer.loading')}
          </span>
        ) : err ? (
          <span className="flex items-center gap-2 text-[13px] text-ink-faint">
            <FileQuestion size={14} />
            {err}
          </span>
        ) : kind === 'image' ? (
          <img
            src={src}
            alt={baseName(path)}
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: 'auto' }}
          />
        ) : kind === 'video' ? (
          <video src={src} controls className="max-h-full max-w-full" />
        ) : kind === 'audio' ? (
          <div className="flex flex-col items-center gap-3">
            <Download size={28} className="text-ink-faint" />
            <audio src={src} controls />
          </div>
        ) : (
          // pdf
          <embed
            src={src}
            type="application/pdf"
            className="h-full w-full"
          />
        )}
      </div>
    </div>
  )
}
