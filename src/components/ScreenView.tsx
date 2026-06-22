import { useEffect, useRef, useState } from 'react'
import { RotateCw, ExternalLink, Link2, ChevronLeft, ChevronRight, Bot } from 'lucide-react'
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
  /** 把一段指令提交给当前 agent 会话(用于「提交给 Agent」按钮) */
  onSubmitToAgent?: (text: string) => void
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
  previewPath,
  onSubmitToAgent
}: ScreenViewProps): JSX.Element {
  const { t, lang } = useI18n()
  const [port, setPort] = useState(0)
  // 导航历史栈 + 当前位置(浏览器式前进后退)。url 由 stack[idx] 派生。
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({ stack: [], idx: -1 })
  const [nonce, setNonce] = useState(0) // 强制重载
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [empty, setEmpty] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // 某 url 是否「产物列表(index)」页(/__index__ 或服务器根 /)。
  const isIndexUrl = (u: string): boolean => {
    if (port <= 0) return false
    const base = `http://127.0.0.1:${port}/`
    if (!u.startsWith(base)) return false
    const rel = u.slice(base.length).split('?')[0].split('#')[0]
    return rel === '' || rel === '__index__'
  }

  const url = nav.idx >= 0 ? nav.stack[nav.idx] : ''
  const canForward = nav.idx < nav.stack.length - 1
  // served = 走我们的本地服务器;manual = 用户手填的外部地址(dev server 等)
  const mode: 'served' | 'manual' =
    !url || (port > 0 && url.startsWith(`http://127.0.0.1:${port}`)) ? 'served' : 'manual'
  // 后退可用:① 历史栈里有上一条;或 ② 当前在某个具体 HTML 文件页(后退=回 index,
  // 不依赖栈深)。后者保证远程下即使栈没建起来,文件页上的后退键也可点、能回列表。
  const onFilePage =
    mode === 'served' && !!url && port > 0 && !isIndexUrl(url)
  const canBack = nav.idx > 0 || onFilePage
  const modeRef = useRef(mode)
  modeRef.current = mode

  // 当前预览的 HTML 文件相对路径(从 served url 反推;空 / 列表页 → 无)。
  const currentRel = ((): string => {
    if (mode !== 'served' || !port) return ''
    const base = `http://127.0.0.1:${port}/`
    if (!url.startsWith(base)) return ''
    const rel = decodeURI(url.slice(base.length).split('?')[0].split('#')[0])
    if (!rel || rel === '__index__') return ''
    return rel
  })()
  // 提交给 Agent 的条件:有要看的 HTML 文件 + 父层提供了发送通道。
  const canSubmit = !!currentRel && !!onSubmitToAgent

  // 「提交给 Agent」:让 agent 查看当前 HTML Notebook 里新增的需求,把回答写在需求的下方。
  // 带上当前 HTML 文件的相对路径:agent 仅靠"当前预览上下文"经常感应不到是哪个文件
  // (Windows 上尤其不可靠),把相对路径直接写进指令,让 agent 明确知道要改哪个文件。
  // 注意:整条作为单行发送——PTY 里 \n 可能被 TUI 当作提前回车,故用句子串联不换行。
  const submitToAgent = (): void => {
    if (!canSubmit) return
    const rel = currentRel
    const prompt =
      lang === 'en'
        ? `Open the HTML Notebook file "${rel}" and check the new requirements I added in it, then write each answer directly below its requirement.`
        : `打开 HTML Notebook 文件「${rel}」,查看我在其中新增的需求,把回答写在需求的下方。`
    onSubmitToAgent?.(prompt)
  }

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

  // 后退:在【具体 HTML 文件页】上后退 → 直接回产物列表(index),不依赖历史栈。
  // 这是确定性行为(不受 effect 重跑 / __lincoPath 校正影响),永远一致。
  // 已经在 index(或其它非文件页)时,走普通历史后退。
  const back = (): void => {
    if (mode === 'served' && url && !isIndexUrl(url) && port > 0) {
      pushUrl(`http://127.0.0.1:${port}/__index__`)
      return
    }
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

  // 监听:① 产物首页点链接(__lincoNav)② 任意页面加载后上报自身路径(__lincoPath)。
  // 后者是关键兜底:跨源读不了 iframe location,靠子页面主动上报真实路径,
  // 让地址栏 / currentRel /「提交给 Agent」按钮跟上(点链接/热刷新/直接导航都覆盖)。
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      if (!port) return
      const base = `http://127.0.0.1:${port}/`
      const data = e.data as { __lincoNav?: string; __lincoPath?: string }
      if (typeof data?.__lincoNav === 'string') {
        pushUrl(base + data.__lincoNav.replace(/^\/+/, ''))
        return
      }
      // 子页面上报真实路径 → 校正 React url(不堆历史,只对齐当前条目)
      if (typeof data?.__lincoPath === 'string') {
        const real = base + data.__lincoPath.replace(/^\/+/, '')
        setNav((n) => {
          if (n.stack[n.idx] === real) return n // 已一致
          const stack = [...n.stack.slice(0, n.idx + 1)]
          stack[n.idx < 0 ? 0 : n.idx] = real
          return { stack, idx: Math.max(0, n.idx) }
        })
      }
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

  // iframe 实际加载完成(含其内部点链接跳转)→ 用真实 location 校正 React 的 url 状态。
  // 兜底:有些跳转(尤其首页里点文件)靠 postMessage 通知,若漏了,这里按真实地址补上,
  // 保证工具条地址栏 / currentRel /「提交给 Agent」按钮 跟随真正显示的页面。
  const syncFromIframe = (): void => {
    const win = iframeRef.current?.contentWindow
    if (!win || !port) return
    let real = ''
    try {
      // 同源(都是 127.0.0.1:port)才能读;跨源(manual 外部地址)会抛错,忽略。
      real = win.location.href
    } catch {
      return
    }
    const base = `http://127.0.0.1:${port}/`
    if (!real.startsWith(base)) return // 外部地址不接管
    setNav((n) => {
      if (n.stack[n.idx] === real) return n // 已一致
      const stack = [...n.stack.slice(0, n.idx + 1), real]
      return { stack, idx: stack.length - 1 }
    })
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
        {/* 提交给 Agent:让 agent 查看 HTML 里新增的需求,把回复写在各需求下方 */}
        {onSubmitToAgent && (
          <button
            onClick={submitToAgent}
            disabled={!canSubmit}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:text-ink-faint/40 disabled:hover:bg-transparent"
            title={canSubmit ? t('screen.submitToAgent.hint') : t('screen.submitToAgent.none')}
          >
            <Bot size={15} />
            <span>{t('screen.submitToAgent')}</span>
          </button>
        )}
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
          onLoad={syncFromIframe}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      )}
    </div>
  )
}
