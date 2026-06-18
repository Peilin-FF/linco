import { useEffect, useRef, useState } from 'react'
import { RotateCw, ExternalLink, Link2 } from 'lucide-react'
import {
  onPreviewReload,
  previewDefaultTarget,
  previewPrefetchAssets,
  previewSetTarget,
  previewStart
} from '@/lib/preview'

interface ScreenViewProps {
  /** 远程主机(空=本地) */
  host?: string
  /** 工作目录(预览服务器的根) */
  cwd?: string
  /** 指定要预览的文件绝对路径(右键预览时);空=默认目标 */
  previewPath?: string
}

/**
 * 预览区:Linco 自己在 Mac 起的本地 HTTP 服务器(preview.rs)。
 *
 * iframe 永远只访问 http://127.0.0.1:<port>/(瞬时、不卡)。被预览的 HTML
 * 在工作目录里:本地直接读盘,远程经持久 SSH 通道按需读+缓存。claude 改了
 * HTML 会经 mtime 轮询触发热刷新,iframe 自动重载。
 *
 * 地址栏可手填:输入别的 http(s):// 地址(如 dev server)会直接加载、绕过本服务器。
 */
export default function ScreenView({
  host,
  cwd,
  previewPath
}: ScreenViewProps): JSX.Element {
  const [port, setPort] = useState(0)
  const [url, setUrl] = useState('')
  const [nonce, setNonce] = useState(0) // 强制重载
  const [mode, setMode] = useState<'served' | 'manual'>('served')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [empty, setEmpty] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const reload = (): void => setNonce((n) => n + 1)

  // 启动本地服务器(幂等),拿端口
  useEffect(() => {
    previewStart()
      .then(setPort)
      .catch((e) => console.error('预览服务器启动失败', e))
  }, [])

  // 后台预取渲染引擎(KaTeX 等)到缓存:连接/工作目录就绪时就暖好,
  // 等真正打开预览时引擎已在内存,首屏不等传输(远程尤其关键)。
  useEffect(() => {
    if (!port) return
    previewPrefetchAssets(host).catch(() => {})
  }, [port, host])

  // 工作目录 / 目标文件变化 → 设定预览目标、重指 iframe(served 模式)
  useEffect(() => {
    if (!port || !cwd || modeRef.current === 'manual') return
    let alive = true
    const base = `http://127.0.0.1:${port}/`
    ;(async () => {
      try {
        // previewPath 为绝对路径时,取相对 cwd 的部分;否则求默认目标
        let rel = ''
        if (previewPath) {
          rel = previewPath.startsWith(cwd)
            ? previewPath.slice(cwd.length).replace(/^\/+/, '')
            : previewPath
        } else {
          rel = await previewDefaultTarget(cwd, host)
        }
        if (!alive) return
        await previewSetTarget(cwd, rel, host)
        if (!alive) return
        setEmpty(false)
        setUrl(base + encodeURI(rel))
        setNonce((n) => n + 1)
      } catch {
        if (!alive) return
        // 没找到 HTML:显示空态,但保留地址栏可手填
        setEmpty(true)
        setUrl(base)
      }
    })()
    return () => {
      alive = false
    }
  }, [port, cwd, host, previewPath])

  // 热刷新:claude 改了 HTML → 重载(仅 served 模式)
  useEffect(() => {
    let un: (() => void) | undefined
    onPreviewReload(() => {
      if (modeRef.current === 'served') setNonce((n) => n + 1)
    }).then((f) => (un = f))
    return () => un?.()
  }, [])

  const go = (next: string): void => {
    let u = next.trim()
    if (!u) return
    if (!/^https?:\/\//.test(u)) u = `http://${u}`
    // 属于本地服务器 → served;否则 manual(直接加载外部地址,绕过)
    setMode(u.startsWith(`http://127.0.0.1:${port}`) ? 'served' : 'manual')
    setUrl(u)
    setEmpty(false)
    setEditing(false)
    setNonce((n) => n + 1)
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-black/8 px-2.5 py-1.5">
        <button
          onClick={reload}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title="刷新"
        >
          <RotateCw size={15} />
        </button>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(draft)
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={() => setEditing(false)}
            className="flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-black/25"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(url)
              setEditing(true)
            }}
            className="flex flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1 text-left font-mono text-[12px] text-ink-muted hover:bg-black/5"
            title="点击编辑地址"
          >
            <Link2 size={13} className="shrink-0 text-ink-faint" />
            <span className="truncate">{url || '未选择预览'}</span>
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title="在浏览器中打开"
        >
          <ExternalLink size={15} />
        </a>
      </div>

      {/* 预览 iframe / 空态 */}
      {empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-faint">
          工作目录里没找到 HTML。让 claude 生成 index.html,或在文件树右键某个
          .html 选「预览」,也可在上方地址栏手填地址。
        </div>
      ) : (
        <iframe
          key={nonce}
          ref={iframeRef}
          title="preview"
          src={url}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      )}
    </div>
  )
}
