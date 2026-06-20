import { useEffect, useRef, useState } from 'react'
import { RotateCw, ExternalLink, Link2, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  onPreviewReload,
  previewPrefetchAssets,
  previewSetTarget,
  previewStart
} from '@/lib/preview'
import { useI18n } from '@/lib/i18n'

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
 * 导航:浏览器式前进/后退历史栈(在不同 HTML 间跳转),地址栏可手填
 * (输入别的 http(s):// 地址如 dev server 会直接加载、绕过本服务器)。
 */
export default function ScreenView({
  host,
  cwd,
  previewPath
}: ScreenViewProps): JSX.Element {
  const { t } = useI18n()
  const [port, setPort] = useState(0)
  // 导航历史栈 + 当前位置(浏览器式前进后退)。url 由 stack[idx] 派生。
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({ stack: [], idx: -1 })
  const [nonce, setNonce] = useState(0) // 强制重载
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [empty, setEmpty] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const url = nav.idx >= 0 ? nav.stack[nav.idx] : ''
  const canBack = nav.idx > 0
  const canForward = nav.idx < nav.stack.length - 1
  // served = 走我们的本地服务器;manual = 用户手填的外部地址(dev server 等)
  const mode: 'served' | 'manual' =
    !url || (port > 0 && url.startsWith(`http://127.0.0.1:${port}`)) ? 'served' : 'manual'
  const modeRef = useRef(mode)
  modeRef.current = mode

  const reload = (): void => setNonce((n) => n + 1)

  // 跳到新地址:截断当前位置之后的前进历史,压入新条目并定位到它。
  // 与当前同址则只重载(不堆重复历史)。
  const pushUrl = (u: string): void => {
    setNav((n) => {
      if (n.stack[n.idx] === u) return n // 同址,不入栈(下方 nonce 仍触发重载)
      const stack = [...n.stack.slice(0, n.idx + 1), u]
      return { stack, idx: stack.length - 1 }
    })
    setNonce((x) => x + 1)
  }

  const back = (): void => {
    setNav((n) => (n.idx > 0 ? { ...n, idx: n.idx - 1 } : n))
    setNonce((x) => x + 1)
  }
  const forward = (): void => {
    setNav((n) => (n.idx < n.stack.length - 1 ? { ...n, idx: n.idx + 1 } : n))
    setNonce((x) => x + 1)
  }

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

  // 工作目录 / 目标文件变化 → 设定预览目标、压入历史(served 模式)
  useEffect(() => {
    if (!port || !cwd || modeRef.current === 'manual') return
    let alive = true
    const base = `http://127.0.0.1:${port}/`
    ;(async () => {
      try {
        if (previewPath) {
          // 右键指定某文件 → 直接进该文件
          const rel = previewPath.startsWith(cwd)
            ? previewPath.slice(cwd.length).replace(/^\/+/, '')
            : previewPath
          await previewSetTarget(cwd, rel, host)
          if (!alive) return
          setEmpty(false)
          pushUrl(base + encodeURI(rel))
        } else {
          // 默认 → 进「产物首页」列表,自己点选要看的 HTML。
          // 先设根目录(target_rel 空,只为把 root 告诉服务器,否则列表页拿不到 root)
          await previewSetTarget(cwd, '', host)
          if (!alive) return
          setEmpty(false)
          pushUrl(base + '__index__')
        }
      } catch {
        if (!alive) return
        setEmpty(false)
        pushUrl(base + '__index__')
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, cwd, host, previewPath])

  // 当后退/前进切到 served 的具体文件时,同步预览服务器目标(让热刷新盯对文件)。
  // 列表页(__index__)无单一文件可盯,跳过。
  useEffect(() => {
    if (!cwd || mode !== 'served' || !url || port <= 0) return
    const base = `http://127.0.0.1:${port}/`
    if (!url.startsWith(base)) return
    const rel = decodeURI(url.slice(base.length))
    if (!rel || rel === '__index__') return
    previewSetTarget(cwd, rel, host).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // 热刷新:claude 改了 HTML → 重载(仅 served 模式)
  useEffect(() => {
    let un: (() => void) | undefined
    onPreviewReload(() => {
      if (modeRef.current === 'served') setNonce((n) => n + 1)
    }).then((f) => (un = f))
    return () => un?.()
  }, [])

  // 监听产物首页里点链接 → 压入历史(这样工具条后退能回到列表页)
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const href = (e.data as { __lincoNav?: string })?.__lincoNav
      if (typeof href !== 'string' || !port) return
      const base = `http://127.0.0.1:${port}/`
      pushUrl(base + href.replace(/^\/+/, ''))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port])

  const go = (next: string): void => {
    let u = next.trim()
    if (!u) return
    if (!/^https?:\/\//.test(u)) u = `http://${u}`
    setEmpty(false)
    setEditing(false)
    pushUrl(u) // mode 由 url 自动派生(本地服务器→served,其它→manual)
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-black/8 px-2.5 py-1.5">
        <button
          onClick={back}
          disabled={!canBack}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink disabled:text-ink-faint/40 disabled:hover:bg-transparent"
          title={t('screen.back')}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          onClick={forward}
          disabled={!canForward}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink disabled:text-ink-faint/40 disabled:hover:bg-transparent"
          title={t('screen.forward')}
        >
          <ChevronRight size={15} />
        </button>
        <button
          onClick={reload}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('screen.refresh')}
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
            title={t('screen.editUrl')}
          >
            <Link2 size={13} className="shrink-0 text-ink-faint" />
            <span className="truncate">{url || t('screen.noPreview')}</span>
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('screen.openInBrowser')}
        >
          <ExternalLink size={15} />
        </a>
      </div>

      {/* 预览 iframe / 空态 */}
      {empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-faint">
          {t('screen.noHtml')}
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
