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

  const url = nav.idx >= 0 ? nav.stack[nav.idx] : ''
  const canBack = nav.idx > 0
  const canForward = nav.idx < nav.stack.length - 1
  // served = 走我们的本地服务器;manual = 用户手填的外部地址(dev server 等)
  const mode: 'served' | 'manual' =
    !url || (port > 0 && url.startsWith(`http://127.0.0.1:${port}`)) ? 'served' : 'manual'
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

  // 「提交给 Agent」:让 agent 用 diff 看 HTML 里**新增**的需求,把回复写在各需求下方。
  // 中英文 prompt 不同(跟随界面语言)。需求写在 HTML notebook 的 md cell 里。
  // 注意:整条作为单行发送——PTY 里 \n 可能被 TUI 当作提前回车,故用句子串联不换行。
  const submitToAgent = (): void => {
    if (!canSubmit) return
    const abs =
      cwd && currentRel ? `${cwd.replace(/\/+$/, '')}/${currentRel}` : currentRel
    const prompt =
      lang === 'en'
        ? `Use git diff (e.g. \`git diff ${abs}\`, or diff against the last commit/stash) to see what I just ADDED to the HTML notebook file \`${abs}\` — do NOT re-read the whole file from scratch, only look at the newly added content. It is a notebook of numbered cells and my new requirements live in the added Markdown cells. For each newly added requirement, address it as needed and write your reply directly BELOW that requirement inside the same HTML file (append the response right under the corresponding requirement so it stays paired with it), then save the file. Keep each answer next to its own requirement — do not collect them at the end. Cells are numbered; refer to them by number when helpful.`
        : `请用 git diff(例如 \`git diff ${abs}\`,或与上一次提交/暂存对比)查看我刚刚在 HTML notebook 文件 \`${abs}\` 里**新增**的内容——不要从头重读整个文件,只看新增的部分。它是一个按序号编号的 cell 笔记本,我的新需求写在新增的 Markdown cell 里。对每一条新增需求:按需完成它,并把回复直接写在该需求的下方(就在 HTML 文件里,把回应追加到对应需求正下方,保持一一对应),然后保存文件。每条回答都紧跟它自己的需求,不要堆在最后。cell 有序号,必要时按序号指代。`
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
