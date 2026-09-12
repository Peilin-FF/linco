import { useEffect, useRef, useState } from 'react'
import { RotateCw, ExternalLink, Link2, ChevronLeft, ChevronRight, Bot, LayoutDashboard } from 'lucide-react'
import PreviewWorkboard from './PreviewWorkboard'
import {
  onPreviewReload,
  previewPrefetchAssets,
  previewSetTarget,
  previewStart
} from '@/lib/preview'
import { useI18n } from '@/lib/i18n'
import { loadWorkboard, workboardAgentPrompt } from '@/lib/previewWorkboard'

interface ScreenViewProps {
  /** 远程主机(空=本地) */
  host?: string
  /** 工作目录(预览服务器的根) */
  cwd?: string
  /** 指定要预览的文件绝对路径(右键预览时);空=默认目标 */
  previewPath?: string
  /** 把一段指令提交给当前 agent 会话(用于「提交给 Agent」按钮) */
  onSubmitToAgent?: (text: string) => void | boolean
}

type NavState = { stack: string[]; idx: number }

// 导航历史按 (host, cwd) 持久化在模块级:切换工作区/机器再切回来时,恢复之前正在看的页面,
// 而不是每次都被重置回产物列表(index)。组件重挂载也能从这里捞回状态。
const navCache = new Map<string, NavState>()
const navKey = (host?: string, cwd?: string): string => `${host || ''}|${cwd || ''}`

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
  // 初值优先从 navCache 恢复(切回旧工作区时回到原来在看的页面)。
  const [nav, setNav] = useState<NavState>(
    () => navCache.get(navKey(host, cwd)) ?? { stack: [], idx: -1 }
  )
  const [nonce, setNonce] = useState(0) // 强制重载
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [empty, setEmpty] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Keep the actual document alive while the native board is visible. Returning
  // to the board must not navigate the notebook away or discard in-place edits.
  const retainedPreview = useRef({ scope: navKey(host, cwd), url: '' })
  const pendingPreviewReload = useRef('')
  const servedBaseRef = useRef('')
  servedBaseRef.current = port > 0 ? `http://127.0.0.1:${port}/` : ''
  // nav 当前归属的 (host,cwd) key。切换工作区时用它把旧状态存回正确的桶。
  const navKeyRef = useRef(navKey(host, cwd))

  // 持久化:nav 一变就写回它所属的桶,切回来能恢复。
  useEffect(() => {
    navCache.set(navKeyRef.current, nav)
  }, [nav])

  // 切换工作区/机器:把当前(即将离开的)nav 存回旧桶,再从新桶恢复。
  // 组件常驻挂载不重建,所以靠这个 effect 在 prop 变化时换状态,而不是靠重挂载。
  useEffect(() => {
    const k = navKey(host, cwd)
    if (k === navKeyRef.current) return
    navCache.set(navKeyRef.current, nav) // nav 此刻仍是旧工作区的(state 尚未变)
    navKeyRef.current = k
    setPreviewError('')
    setNav(navCache.get(k) ?? { stack: [], idx: -1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, cwd])

  // 某 url 是否「产物列表(index)」页(/__index__ 或服务器根 /)。
  const isIndexUrl = (u: string): boolean => {
    if (port <= 0) return false
    const base = `http://127.0.0.1:${port}/`
    if (!u.startsWith(base)) return false
    const rel = u.slice(base.length).split('?')[0].split('#')[0]
    return rel === '' || rel === '__index__'
  }

  const url = nav.idx >= 0 ? nav.stack[nav.idx] : ''
  const ownsNavigation = navKeyRef.current === navKey(host, cwd)
  const boardVisible = !url || isIndexUrl(url) || !ownsNavigation
  const boardVisibleRef = useRef(boardVisible)
  boardVisibleRef.current = boardVisible
  if (retainedPreview.current.scope !== navKey(host, cwd)) {
    retainedPreview.current = { scope: navKey(host, cwd), url: '' }
    pendingPreviewReload.current = ''
  }
  if (!boardVisible) retainedPreview.current.url = url
  useEffect(() => {
    if (boardVisible || !pendingPreviewReload.current) return
    if (pendingPreviewReload.current === url) setNonce(n => n + 1)
    pendingPreviewReload.current = ''
  }, [boardVisible, url])
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
  const previewLabel = currentRel
    ? (/^artifacts\/actions\/[^/]+\/action\.html$/.test(currentRel)
      ? (lang === 'en' ? 'Action record' : '行动记录')
      : currentRel.split('/').pop() || currentRel)
    : url || t('screen.noPreview')
  // 提交给 Agent 的条件:有要看的 HTML 文件 + 父层提供了发送通道。
  const canSubmit = !!currentRel && !!onSubmitToAgent

  // 「提交给 Agent」:让 agent 查看当前 HTML Notebook 里新增的需求,把回答写在需求的下方。
  // 带上当前 HTML 文件的相对路径:agent 仅靠"当前预览上下文"经常感应不到是哪个文件
  // (Windows 上尤其不可靠),把相对路径直接写进指令,让 agent 明确知道要改哪个文件。
  // 注意:整条作为单行发送——PTY 里 \n 可能被 TUI 当作提前回车,故用句子串联不换行。
  const submitToAgent = async (): Promise<void> => {
    if (!canSubmit || submittingRef.current) return
    const rel = currentRel
    const scope = navKey(host, cwd)
    let prompt =
      lang === 'en'
        ? `Open the HTML Notebook file "${rel}" and check the new requirements I added in it, then write each answer directly below its requirement.`
        : `打开 HTML Notebook 文件「${rel}」,查看我在其中新增的需求,把回答写在需求的下方。`
    submittingRef.current = true
    setSubmitting(true)
    setPreviewError('')
    try {
      if (cwd) {
        const board = await loadWorkboard(cwd, host)
        const action = board.tasks.find(task => task.actionArtifact === rel || task.primaryArtifact === rel || task.artifacts.includes(rel))
        if (action) prompt += ` ${workboardAgentPrompt(action)}`
      }
      if (scope !== navKeyRef.current || boardVisibleRef.current || retainedPreview.current.url !== url) return
      if (onSubmitToAgent?.(prompt.replace(/\r?\n/g, ' ')) === false) {
        throw new Error(lang === 'en' ? 'The agent session is not ready. Try again when it has opened.' : 'Agent 会话尚未就绪，请在打开后重试。')
      }
    } catch (error) {
      if (scope === navKeyRef.current) setPreviewError(String(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const reload = (): void => {
    if (boardVisible) window.dispatchEvent(new Event('linco-workboard-refresh'))
    else setNonce((n) => n + 1)
  }

  // 跳到新地址:截断当前位置之后的前进历史,压入新条目并定位到它。
  // 与当前同址则只重载(不堆重复历史)。
  const pushUrl = (u: string): void => {
    setNav((n) => {
      if (n.stack[n.idx] === u) return n // 同址,不入栈(下方 nonce 仍触发重载)
      const stack = [...n.stack.slice(0, n.idx + 1), u]
      return { stack, idx: stack.length - 1 }
    })
    if (u === url && !isIndexUrl(u)) setNonce((x) => x + 1)
  }

  // 后退:在【具体 HTML 文件页】上后退 → 回产物列表(index)。
  // 关键:不能用 pushUrl(它会截断前进历史 → `>` 回不到刚才的文件)。
  //  - 上一条已是 index:普通 idx-- 即可(前进仍指向当前文件)。
  //  - 否则在当前文件【前面】插入一条 index,并把 idx 停在 index 上;
  //    这样前进(forward)能回到原文件,实现 index ⇄ 文件 双向切换。
  const back = (): void => {
    if (mode === 'served' && url && !isIndexUrl(url) && port > 0) {
      const indexUrl = `http://127.0.0.1:${port}/__index__`
      setNav((n) => {
        if (n.idx > 0 && isIndexUrl(n.stack[n.idx - 1])) {
          return { ...n, idx: n.idx - 1 } // 上一条就是 index,直接退
        }
        // 在当前条目前插入 index,定位到它;当前文件成为「前进」目标
        const stack = [...n.stack]
        stack.splice(n.idx, 0, indexUrl)
        return { stack, idx: n.idx }
      })
      return
    }
    setNav((n) => (n.idx > 0 ? { ...n, idx: n.idx - 1 } : n))
  }
  const forward = (): void => {
    setNav((n) => (n.idx < n.stack.length - 1 ? { ...n, idx: n.idx + 1 } : n))
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

  // 已处理过的 previewPath(避免同一个右键预览请求在 cwd/host 变动时被重复触发)。
  const handledPreviewRef = useRef<string | undefined>(undefined)

  // 工作目录 / 目标文件就绪 → 设定预览目标。
  // 关键改动:不再每次都把历史重置回 index。
  //  - 显式 previewPath(右键预览某文件):始终导航到该文件。
  //  - 否则(只是 cwd/host/port 就绪):仅当本工作区**还没有任何历史**时,才落到 index;
  //    已有历史(之前看过的页面,可能从 navCache 恢复)则原样保留,不打扰。
  useEffect(() => {
    if (!port || !cwd) return
    let alive = true
    const base = `http://127.0.0.1:${port}/`
    ;(async () => {
      try {
        const isNewPreview =
          !!previewPath && previewPath !== handledPreviewRef.current
        if (isNewPreview) {
          // 右键指定某文件 → 直接进该文件
          handledPreviewRef.current = previewPath
          const rel = previewPath!.startsWith(cwd)
            ? previewPath!.slice(cwd.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
            : previewPath!.replace(/\\/g, '/')
          await previewSetTarget(cwd, rel, host)
          if (!alive) return
          setEmpty(false)
          pushUrl(base + encodeURI(rel))
          return
        }
        // 无新的预览请求:已有历史则保留正在看的页面,不重置。
        // 但**必须重设服务器 root/target**——服务器的 root 是全局状态,切换工作区后它指向
        // 别的工作区(或为空),不重设则恢复的 url 一加载就 404。用恢复的当前条目算出 rel 传回。
        const cached = navCache.get(navKey(host, cwd))
        if (cached?.stack.length) {
          const curUrl = cached.idx >= 0 ? cached.stack[cached.idx] : ''
          let rel = ''
          if (curUrl.startsWith(base)) {
            const r = decodeURI(curUrl.slice(base.length).split('?')[0].split('#')[0])
            if (r && r !== '__index__') rel = r
          }
          await previewSetTarget(cwd, rel, host)
          if (!alive) return
          setEmpty(false)
          if (rel) setNonce((x) => x + 1) // A restored local document needs the new server root first.
          return
        }
        // 首次进入该工作区 → 落到「产物首页」列表(target_rel 空只为把 root 告诉服务器)。
        await previewSetTarget(cwd, '', host)
        if (!alive) return
        setEmpty(false)
        pushUrl(base + '__index__')
      } catch {
        if (!alive) return
        setEmpty(false)
        if (!navCache.get(navKey(host, cwd))?.stack.length) {
          pushUrl(base + '__index__')
        }
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
    if (!ownsNavigation || !cwd || mode !== 'served' || !url || port <= 0) return
    const base = `http://127.0.0.1:${port}/`
    if (!url.startsWith(base)) return
    const rel = decodeURI(url.slice(base.length).split('?')[0].split('#')[0])
    if (!rel || rel === '__index__') return
    previewSetTarget(cwd, rel, host).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, cwd, host, port, ownsNavigation])

  // 热刷新:claude 改了 HTML → 重载(仅 served 模式)
  useEffect(() => {
    let un: (() => void) | undefined
    onPreviewReload(() => {
      if (boardVisibleRef.current) {
        const retained = retainedPreview.current.url
        if (servedBaseRef.current && retained.startsWith(servedBaseRef.current)) pendingPreviewReload.current = retained
      } else if (modeRef.current === 'served') setNonce((n) => n + 1)
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
      if (e.source !== window && e.source !== iframeRef.current?.contentWindow) return
      if (typeof data?.__lincoNav === 'string') {
        if (boardVisibleRef.current && e.source !== window) return
        pushUrl(base + data.__lincoNav.replace(/^\/+/, ''))
        return
      }
      // 子页面上报真实路径 → 校正当前条目的 url(只对齐 stack[idx],**不截断前进历史**,
      // 否则 back 到 index 后、index 一加载就会把「前进→原文件」那条抹掉 → `>` 失效)。
      if (typeof data?.__lincoPath === 'string' && !boardVisibleRef.current) {
        const real = base + data.__lincoPath.replace(/^\/+/, '')
        setNav((n) => {
          const i = n.idx < 0 ? 0 : n.idx
          if (n.stack[i] === real) return n // 已一致
          const stack = [...n.stack]
          stack[i] = real
          return { stack, idx: i }
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
    if (boardVisibleRef.current) return
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
    <div className="pwb-preview-surface flex h-full w-full flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 工具条 */}
      <div className="screen-toolbar flex shrink-0 items-center gap-1.5 border-b border-black/8 px-2.5 py-1.5">
        <button
          onClick={() => {
            if (!port || boardVisible) return
            if (onFilePage) back()
            else {
              const home = `http://127.0.0.1:${port}/__index__`
              setNav((n) => {
                const stack = [...n.stack]
                stack.splice(n.idx, 0, home)
                return { stack, idx: n.idx }
              })
            }
          }}
          aria-pressed={boardVisible}
          className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] ${boardVisible ? 'bg-selection text-ink' : 'text-ink-muted hover:bg-black/5'}`}
          title={lang === 'en' ? 'Project workboard' : '项目看板'}
        >
          <LayoutDashboard size={14} />
          <span>{lang === 'en' ? 'Board' : '看板'}</span>
        </button>
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
            className="preview-address flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1 text-[12px] text-ink outline-none focus:border-black/25"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(url)
              setEditing(true)
            }}
            className="preview-address flex flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-[12px] text-ink-muted hover:bg-black/5"
            title={`${t('screen.editUrl')}${url ? ` · ${url}` : ''}`}
          >
            <Link2 size={13} className="shrink-0 text-ink-faint" />
            <span className="truncate">{boardVisible ? (lang === 'en' ? 'Open a preview…' : '打开预览…') : previewLabel}</span>
          </button>
        )}
        {!boardVisible && <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('screen.openInBrowser')}
        >
          <ExternalLink size={15} />
        </a>}
        {/* 提交给 Agent:让 agent 查看 HTML 里新增的需求,把回复写在各需求下方 */}
        {onSubmitToAgent && !boardVisible && (
          <button
            onClick={submitToAgent}
            disabled={!canSubmit || submitting}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-ink-muted hover:bg-black/5 hover:text-ink disabled:text-ink-faint/40 disabled:hover:bg-transparent"
            title={canSubmit ? t('screen.submitToAgent.hint') : t('screen.submitToAgent.none')}
          >
            <Bot size={15} />
            <span>{t('screen.submitToAgent')}</span>
          </button>
        )}
      </div>

      {previewError && <p role="alert" className="border-b border-black/10 px-4 py-2 text-[12px] text-red-600">{previewError}</p>}

      <div className="min-h-0 flex-1 overflow-hidden" hidden={!boardVisible}>
        <PreviewWorkboard
          key={navKey(host, cwd)}
          cwd={cwd}
          host={host}
          onOpenArtifact={(relativePath) => {
            if (!port || !cwd) {
              setPreviewError(lang === 'en' ? 'The preview is starting. Please try opening the document again.' : '预览正在启动，请稍后重试。')
              return
            }
            const scope = navKey(host, cwd)
            setPreviewError('')
            // Set the project root before the browser requests the document,
            // especially after changing from a remote or external preview.
            void previewSetTarget(cwd, relativePath, host).then(() => {
              if (scope === navKeyRef.current) pushUrl(`http://127.0.0.1:${port}/${relativePath.split('/').map(encodeURIComponent).join('/')}`)
            }).catch((error: unknown) => {
              if (scope === navKeyRef.current) setPreviewError(String(error))
            })
          }}
          onSubmitToAgent={onSubmitToAgent ? (prompt) => {
            if (onSubmitToAgent(prompt.replace(/\r?\n/g, ' ')) === false) {
              throw new Error(lang === 'en' ? 'The agent session is not ready. Try again when it has opened.' : 'Agent 会话尚未就绪，请在打开后重试。')
            }
          } : undefined}
        />
      </div>
      {/* The board is native React. HTML remains a document inside the preview. */}
      {!boardVisible && empty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-faint">
          {t('screen.noHtml')}
        </div>
      ) : retainedPreview.current.url ? (
        <iframe
          key={`${navKey(host, cwd)}:${nonce}`}
          ref={iframeRef}
          title="preview"
          src={retainedPreview.current.url}
          onLoad={syncFromIframe}
          className="min-h-0 flex-1 border-0 bg-white"
          style={boardVisible ? { display: 'none' } : undefined}
        />
      ) : null}
    </div>
  )
}
