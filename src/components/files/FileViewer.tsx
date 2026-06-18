import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Loader2, FileQuestion, Download } from 'lucide-react'
import { readBytesCached } from '@/lib/fs'
import FileEditor from './FileEditor'
import TableViewer, { isTableFile } from './TableViewer'

interface FileViewerProps {
  path: string
  host?: string
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
export default function FileViewer({ path, host }: FileViewerProps): JSX.Element {
  const name = baseName(path)

  // 表格类:csv/tsv/xlsx/xls → 可编辑表格(优先于文本/媒体判断)
  if (isTableFile(name)) {
    return <TableViewer path={path} host={host} />
  }

  const { kind, mime } = kindOf(name)

  // 文本类:直接交给现有编辑器(可编辑 + 保存)
  if (kind === 'text') {
    return <FileEditor path={path} host={host} />
  }
  return <MediaViewer path={path} host={host} kind={kind} mime={mime} />
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
            加载中…
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
