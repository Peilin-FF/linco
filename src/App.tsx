import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Settings as SettingsIcon,
  Plus,
  Activity,
  PanelLeft,
  PanelLeftClose,
  TerminalSquare,
  X,
  Download,
  Loader2,
  Minus,
  Square,
  Copy,
  Search,
  FolderOpen,
  ChevronsUpDown,
  MessagesSquare,
  Moon,
  Sun,
} from 'lucide-react'
import ScreenView from './components/ScreenView'
import TerminalView, { type TerminalHandle } from './components/TerminalView'
import ChatInput from './components/ChatInput'
import FilesView from './components/FilesView'
import GitView from './components/GitView'
import DrawingView from './components/DrawingView'
import AgentTaskOutput from './components/AgentTaskOutput'
import SessionRail, { type RailSession, type SessionStatus } from './components/SessionRail'
import SessionHistory from './components/SessionHistory'
import Settings from './components/Settings'
import WorkspaceSidebar, { WORKSPACE_VIEWS as VIEWS, WORKSPACE_MODES, modeForView, type WorkspaceMode, type ViewId } from './components/WorkspaceSidebar'
import CommandPalette, { type WorkspaceCommand } from './components/CommandPalette'
import WelcomeView from './components/WelcomeView'
import NotionView from './components/NotionView'
import ConnectionPicker, { type ConnState } from './components/ConnectionPicker'
import RemoteDirPicker from './components/RemoteDirPicker'
import LanguagePicker from './components/LanguagePicker'
import UpdatePanel from './components/UpdatePanel'
import CodeMirrorWarmup from './components/CodeMirrorWarmup'
import ResizeHandle from './components/ResizeHandle'
import ViewErrorBoundary from './components/ViewErrorBoundary'
import TransferDock, { useTransfers } from './components/transfer/TransferDock'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  agentExecutable,
  agentEnv,
  agentLaunchCommand,
  loadConfig,
  saveConfig,
  setLanguage,
  installRemotePlugins,
  type AppConfig
} from '@/lib/config'
import {
  sshConfigHosts,
  sshConnect,
  parseSshCommand,
  sshConfigAdd,
  remoteHome,
  type Connection
} from '@/lib/connection'
import { watchStart, watchStop } from '@/lib/watch'
import { previewPrefetchAssets } from '@/lib/preview'
import { shadowBeginTurn } from '@/lib/shadow'
import { proxyStart, proxyBeginTurn } from '@/lib/agentProxy'
import AgentCommandLog from './components/AgentCommandLog'
import { agentTasks, type AgentTask } from '@/lib/procs'
import { applyTheme, applyFont, themeById } from '@/lib/theme'
import { baseName } from '@/lib/fs'
import { useI18n } from '@/lib/i18n'
import { usageRecordTurn, type UsageAgentContext } from '@/lib/usage'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getCurrentWindow } from '@tauri-apps/api/window'

const ENABLE_BACKGROUND_PREWARM = false
const IS_MACOS = navigator.platform.toLowerCase().includes('mac')
const IS_WINDOWS = navigator.platform.toLowerCase().includes('win')
const APP_ICON = new URL('../src-tauri/icons/32x32.png', import.meta.url).href

const LatexView = lazy(() => import('./components/LatexView'))

// agent 后台任务 tab 的短标题:从命令行里挑一个有意义的词(脚本名/可执行名)。
function taskLabel(args: string): string {
  const toks = args.split(/\s+/).filter(Boolean)
  // 找第一个像脚本/程序的 token(.py/.sh 结尾,或非选项的可执行名)
  for (const t of toks) {
    const base = t.split('/').pop() || t
    if (/\.(py|sh|js|ts)$/.test(base)) return base
  }
  // 退而求其次:第一个非解释器、非选项的词
  const skip = new Set(['python', 'python3', 'node', 'bash', 'sh', 'nohup', 'env'])
  for (const t of toks) {
    const base = t.split('/').pop() || t
    if (!t.startsWith('-') && !skip.has(base)) return base.slice(0, 18)
  }
  return (toks[0]?.split('/').pop() || 'task').slice(0, 18)
}

function WindowControls(): JSX.Element {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const window = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined
    const syncMaximized = (): void => {
      void window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value)
        })
        .catch(() => {})
    }

    syncMaximized()
    void window.onResized(syncMaximized).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return (
    <div className="no-drag -mr-3 ml-1 flex h-11 shrink-0 self-stretch">
      <button
        onClick={() => void getCurrentWindow().minimize()}
        title={t('window.minimize')}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:bg-black/8 hover:text-ink"
      >
        <Minus size={15} strokeWidth={1.7} />
      </button>
      <button
        onClick={() => {
          void getCurrentWindow()
            .toggleMaximize()
            .then(() => getCurrentWindow().isMaximized())
            .then(setMaximized)
        }}
        title={maximized ? t('window.restore') : t('window.maximize')}
        className="flex h-11 w-11 items-center justify-center text-ink-muted hover:bg-black/8 hover:text-ink"
      >
        {maximized ? (
          <Copy size={12} strokeWidth={1.6} />
        ) : (
          <Square size={12} strokeWidth={1.6} />
        )}
      </button>
      <button
        onClick={() => void getCurrentWindow().close()}
        title={t('common.close')}
        className="flex h-11 w-12 items-center justify-center text-ink-muted hover:bg-[#c42b1c] hover:text-white"
      >
        <X size={15} strokeWidth={1.7} />
      </button>
    </div>
  )
}

// 终端会话独立编号
interface Shell {
  id: string
  label: string
  projectKey: string
  cwd?: string
  host?: string
  identity?: string
}

// 对话会话:每个连接(本地/各集群)一个,常驻挂载。props 在激活时冻结,
// 之后切到别的连接也不卸载,切回来还在现场。
interface ChatSession {
  id: string // chat:${connId}:${cwd}
  connId: string // 'local' 或连接 id —— 每连接最多一个会话
  cwd?: string
  host?: string
  identity?: string
  env?: Record<string, string>
  command?: string
  usage: UsageAgentContext
}

let shellSeq = 0

export default function App(): JSX.Element {
  const { t, lang: uiLang, setLang } = useI18n()
  const [view, setView] = useState<ViewId>('preview')
  const [showSettings, setShowSettings] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const lastModeView = useRef<Record<WorkspaceMode, ViewId>>({ vibe: 'preview', code: 'files', visual: 'drawing' })
  const mode = modeForView(view)
  const workspaceRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const [composerHeight, setComposerHeight] = useState(80)
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth - 16)
  const [canvasHeight, setCanvasHeight] = useState(window.innerHeight - 90)
  const [filesTerminalProject, setFilesTerminalProject] = useState<string | null>(null)
  const [filesTerminalHeight, setFilesTerminalHeight] = useState(230)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const updateCheckInFlightRef = useRef(false)
  // 点更新横幅 → 弹出「新版更新内容」公告(展示 release notes,再让用户决定是否更新)
  const [showUpdatePanel, setShowUpdatePanel] = useState(false)
  // 已访问过的视图:首次进入后常驻挂载,之后切回瞬时显示(不重新拉数据)
  const [visited, setVisited] = useState<Set<ViewId>>(new Set(['chat', 'preview']))
  // 后台预热:app 就绪后空闲时悄悄把 文件/Git/预览 三视图挂载好(含各自首次
  // 数据拉取),这样用户真正点开时已经热好 = 瞬现,不再卡那一下(借鉴 VS Code
  // "显示与加载解耦";配合 CodeMirrorWarmup 一起把首次开销提前)。
  const [prewarmed, setPrewarmed] = useState(false)
  // 预览目标文件(右键预览时指定;空=默认目标)
  const [previewPath, setPreviewPath] = useState<string | undefined>(undefined)

  useEffect(() => { lastModeView.current[mode.id] = view }, [view, mode.id])
  useEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [!!config])
  useEffect(() => {
    const element = composerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setComposerHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [!!config])
  useEffect(() => {
    const element = canvasRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setCanvasHeight(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [!!config])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.isComposing) return
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        event.stopPropagation()
        if (!showSettings) { setProjectsOpen(false); setShowCommands((open) => !open) }
      }
      if (event.key.toLowerCase() === 'b' && !showCommands && !showSettings) {
        event.preventDefault()
        event.stopPropagation()
        setProjectsOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [showSettings, showCommands])

  // 在预览视图打开某文件:记目标 + 切到预览 + 标记已访问(常驻挂载)
  const openInPreview = (absPath: string): void => {
    setPreviewPath(absPath)
    setVisited((prev) => (prev.has('preview') ? prev : new Set(prev).add('preview')))
    setView('preview')
  }

  // 记录访问过的视图(用于常驻挂载)
  useEffect(() => {
    setVisited((prev) => (prev.has(view) ? prev : new Set(prev).add(view)))
  }, [view])

  // 底部停靠终端:dockOpened=曾打开(常驻挂载),dockTerminalOpen=当前可见
  const [dockOpened, setDockOpened] = useState(false)
  const [dockTerminalOpen, setDockTerminalOpen] = useState(false)
  const [dockHeight, setDockHeight] = useState(110) // 可拖拽调整(默认矮)
  // 文件传输:进度坞 + 拖入(OS 文件拖进文件树目标目录)。jobs 全局,坞在对话框下方。
  const transfers = useTransfers()
  // 已开过的 dock 终端(每个 连接+项目 一个独立 PTY,常驻挂载、互不干扰)。
  // 修复:固定 id="dock" 只会在首次挂载时读 cwd/host,切到远程后仍停在本机路径。
  const [dockKeys, setDockKeys] = useState<
    { key: string; cwd?: string; host?: string; identity?: string }[]
  >([])
  const [chatBoxHeight, setChatBoxHeight] = useState(104)
  const [composerEpochs, setComposerEpochs] = useState<Record<string, number>>({})

  // 终端/预览/绘图的左侧对话分栏默认打开；LaTeX 独立记忆开关且默认收起。
  // 复用同一个对话会话(移动定位,不重挂),边看输出边对话。
  const [chatSplitOpen, setChatSplitOpen] = useState(true)
  const [latexChatSplitOpen, setLatexChatSplitOpen] = useState(false)
  const [codeChatSplitOpen, setCodeChatSplitOpen] = useState(false)
  const [chatWidth, setChatWidth] = useState(380)

  // 连接状态
  const [connState, setConnState] = useState<ConnState>('idle')
  const [sshHosts, setSshHosts] = useState<string[]>([])
  // 远端目录浏览器(打开时持有初始路径)
  const [remoteBrowse, setRemoteBrowse] = useState<string | null>(null)

  // 对话会话:每连接一个,常驻挂载。chatRefs 按 id 持有句柄,
  // 底部对话框转发到当前活动会话。
  const chatRefs = useRef<Map<string, TerminalHandle>>(new Map())
  // 已给哪些远程 host 装过插件(每 host 一次,避免重复 rsync)
  const remotePluginsDoneRef = useRef<Set<string>>(new Set())
  // 本地已为哪个「agent 家族+语言」装过插件(避免每次 config 变更都重装)
  const localPluginKeyRef = useRef<string>('')
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([])
  // 会话忙/空闲:id → 最近一次 PTY 输出的时间戳;退出的 id 收进 exitedSet。
  // 供右侧「会话总览侧栏」判忙(近 3s 有输出)/空闲/已结束。
  const sessionActivityRef = useRef<Map<string, number>>(new Map())
  const [exitedSessions, setExitedSessions] = useState<Set<string>>(new Set())
  const [activityTick, setActivityTick] = useState(0) // ~1s 心跳,驱动忙/空闲重算

  // 独立终端列表(可多开)
  const [shells, setShells] = useState<Shell[]>([])
  const [activeShell, setActiveShell] = useState<string>('')
  // agent 起的后台任务(输出落盘可实时看):每个 → 终端区一个 tab,自动出现/消失。
  const [tasks, setTasks] = useState<(AgentTask & { exited?: boolean })[]>([])

  // 启动时加载本地配置 + 读取 ssh config 主机
  useEffect(() => {
    loadConfig()
      .then((c) => {
        setConfig(c)
        // 应用主题 / 字体 / 界面语言(早于主界面渲染)
        applyTheme(c.theme)
        applyFont(c.uiFont, c.uiFontSize)
        if (c.language === 'zh' || c.language === 'en') setLang(c.language)
      })
      .catch(() =>
        setConfig({
          agents: [],
          defaultAgent: '',
          autoStart: true,
          cwd: '',
          recentDirs: [],
          connections: [],
          activeConnection: ''
        })
      )
    sshConfigHosts().then(setSshHosts).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runUpdateCheck = async (): Promise<boolean> => {
    if (updateCheckInFlightRef.current) return true
    updateCheckInFlightRef.current = true
    setUpdateError(null)
    try {
      const update = await check({ timeout: 60_000 })
      setAvailableUpdate(update)
      return true
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      updateCheckInFlightRef.current = false
    }
  }

  // GitHub Release 在部分网络下会偶发 TLS/重定向失败。启动后快速重试，
  // 并保留周期检查，避免一次瞬时错误让客户端数小时收不到更新。
  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined

    const runWithRetry = async (retryIndex = 0): Promise<void> => {
      const succeeded = await runUpdateCheck()
      if (!cancelled && !succeeded) {
        const retryDelays = [15_000, 60_000]
        const delay = retryDelays[retryIndex]
        if (delay !== undefined) {
          retryTimer = window.setTimeout(() => {
            runWithRetry(retryIndex + 1).catch(() => {})
          }, delay)
        }
      }
    }

    runWithRetry().catch(() => {})
    const timer = window.setInterval(() => {
      runWithRetry().catch(() => {})
    }, 30 * 60 * 1000)
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      window.clearInterval(timer)
    }
    // App is the root component; runUpdateCheck intentionally uses current state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 当前激活的连接(空 = 本地)
  const activeConn = useMemo<Connection | undefined>(
    () => config?.connections.find((c) => c.id === config.activeConnection),
    [config]
  )
  const host = activeConn?.host || undefined // undefined = 本地

  // 目标 PTY 的 shell 类型:仅「本地 + Windows」是 cmd.exe(命令拼接的引号规则不同);
  // 远程会话 ssh 到远端是 POSIX shell,本地 Mac/Linux 也是 POSIX。决定 agentLaunchCommand 的引用方式。
  // —— 这是 Windows 上 codex 历史会话恢复失败的根因:POSIX 单引号 cmd.exe 不认,会把
  //    'rollout-...' 整串(含引号)当字面量传给 codex → 匹配不到会话 ID → 进不去。
  const targetShell: 'posix' | 'cmd' =
    !host && navigator.platform.toLowerCase().includes('win') ? 'cmd' : 'posix'

  // 默认 agent:决定对话会话要自动启动的命令与注入的环境变量
  const defaultAgent = useMemo(
    () => config?.agents.find((a) => a.id === config.defaultAgent),
    [config]
  )
  // 命令可见代理:本地启动一个私有代理(若 pv 可用),把 agent 的 base_url 指向它,
  // 旁路抽取每条 bash 命令+结果按回合落盘,供「Agent 命令」面板展示。
  //
  // 三态:pending=还在起/未判定;ready=起好(改 base_url 指向它);off=不启用(降级,直连)。
  // 关键:会话(agent)创建要**门控**在非 pending 上 —— 保证 agent 启动前代理已就绪、
  // base_url 已落定,否则 agent 第一条请求会绕过代理。
  const [proxyState, setProxyState] = useState<
    { kind: 'pending' } | { kind: 'ready'; port: number } | { kind: 'off' }
  >({ kind: 'off' })

  // 该 agent 真实要连的上游 base_url。
  // **订阅模式不挂代理**:① 用第三方中转碰官方订阅 token 违反 ToS、有封号风险;
  // ② 订阅模式 CLI 走 OAuth、未必采纳 base_url 改写,技术上也不可靠。
  // 故仅 authMode!=='subscription'(即 API key 模式)才返回上游 → 才会启代理。
  const upstreamBaseUrl = useMemo(() => {
    // 命令可见代理总开关:暂关闭(代理/「Agent 命令」面板休眠)。
    // 相关代码(agent_proxy.rs / AgentCommandLog / pv submodule)全部保留,
    // 改回 true 即恢复。关闭时 upstream 恒空 → 代理不启、面板不显示、base_url 不改写、
    // 会话创建不被门控,完全回到无代理的原行为。
    const COMMAND_PROXY_ENABLED = false
    if (!COMMAND_PROXY_ENABLED) return ''
    if (!defaultAgent) return ''
    // 仅「API key 模式」才挂代理。判据与 agentEnv 注入 key 的条件一致(config.ts):
    // 非 subscription 且确实填了 apiKey。这样既排除显式订阅,也排除「没填 key = 实际走订阅」
    // 的情况 —— 用第三方中转碰官方订阅 token 违反 ToS、有封号风险,且订阅 CLI 走 OAuth、
    // base_url 改写本就不可靠。
    const isApiMode =
      defaultAgent.authMode !== 'subscription' && !!defaultAgent.apiKey?.trim()
    if (!isApiMode) return ''
    const bu = defaultAgent.baseUrl?.trim()
    if (bu) return bu
    return defaultAgent.provider === 'openai'
      ? 'https://api.openai.com/v1'
      : 'https://api.anthropic.com'
  }, [defaultAgent])

  // 仅本地 + API 模式 + pv 可用时启代理;远程/订阅/无上游 → off(降级)。host/agent 变化时重起。
  useEffect(() => {
    if (host || !defaultAgent || !upstreamBaseUrl) {
      setProxyState({ kind: 'off' })
      return
    }
    let alive = true
    setProxyState({ kind: 'pending' })
    const sess = `${config?.activeConnection || 'local'}:${defaultAgent.id}`
    proxyStart(upstreamBaseUrl, sess)
      .then((p) => {
        if (!alive) return
        setProxyState(p ? { kind: 'ready', port: p } : { kind: 'off' })
      })
      .catch(() => alive && setProxyState({ kind: 'off' }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, upstreamBaseUrl, defaultAgent])

  const agentEnvVars = useMemo(() => {
    if (!defaultAgent) return undefined
    const env = agentEnv(defaultAgent)
    // 代理 ready → 把 base_url 改指向本地代理(agent 的请求先经代理再到真实上游)。
    if (proxyState.kind === 'ready') {
      const proxyUrl = `http://127.0.0.1:${proxyState.port}`
      if ('ANTHROPIC_BASE_URL' in env) env.ANTHROPIC_BASE_URL = proxyUrl
      if ('OPENAI_BASE_URL' in env) env.OPENAI_BASE_URL = proxyUrl
      if (defaultAgent.provider === 'anthropic') env.ANTHROPIC_BASE_URL = proxyUrl
      else if (defaultAgent.provider === 'openai') env.OPENAI_BASE_URL = proxyUrl
    }
    return env
  }, [defaultAgent, proxyState])
  const agentCommand = useMemo(
    () =>
      defaultAgent
        ? agentLaunchCommand(defaultAgent, undefined, targetShell)
        : undefined,
    [defaultAgent, targetShell]
  )
  const agentCommandBase = useMemo(
    () => (defaultAgent ? agentExecutable(defaultAgent) : undefined),
    [defaultAgent]
  )

  // 默认 agent 家族(claude / codex):决定装哪套本地插件。
  const pluginFamily = agentCommandBase === 'codex' ? 'codex' : 'claude'

  // 自动安装本地插件:默认 agent 家族或界面语言变化时,把对应那套
  // (claude→~/.claude/plugins,codex→~/.codex 的 AGENTS.md+skill)装好。
  // 用户在设置里把默认切到 Codex/Claude 即自动生效,无需手动按钮。
  // 仅当「已装记录(pluginAgent+language)」与当前家族+语言不一致时才装,
  // 且每个 key 本会话只装一次(localPluginKeyRef 去重)。首启 LanguagePicker
  // 仍负责未选语言时的初次安装,这里只接管之后的切换。
  useEffect(() => {
    if (!config) return
    const lng = config.language === 'en' ? 'en' : config.language === 'zh' ? 'zh' : ''
    if (!lng || !defaultAgent) return // 未选语言时交给首启弹窗
    if (config.pluginAgent === 'skip') return // 用户选了「稍后配置」:不自动安装
    const key = `${pluginFamily}:${lng}`
    if (localPluginKeyRef.current === key) return // 本会话已装过这套
    if ((config.pluginAgent || '') === pluginFamily && config.language === lng) {
      localPluginKeyRef.current = key // 配置记录已是这套,标记免重装
      return
    }
    localPluginKeyRef.current = key
    setLanguage(pluginFamily, lng)
      .then(() => {
        // 持久化已装家族(setLanguage 后端已写 plugin_agent;此处同步前端态,
        // 避免下次 config 变更又触发重装)
        setConfig((c) => (c ? { ...c, pluginAgent: pluginFamily } : c))
      })
      .catch((e) => {
        console.error('自动安装插件失败', e)
        localPluginKeyRef.current = '' // 失败允许下次重试
      })
  }, [config, defaultAgent, pluginFamily])

  // 工作目录:远程用连接的远端目录,本地用配置的 cwd
  const cwd = (host ? activeConn?.cwd : config?.cwd) || undefined
  const remoteDataReady = !host || connState === 'connected'

  // 后台预热三视图:连接/工作目录就绪后,空闲时悄悄把 文件/Git/预览 挂载好
  // (含各自首次数据拉取),用户真正点开时已热好=瞬现,不再卡那一下。
  // 切连接(host/cwd 变)时重置重热。
  useEffect(() => {
    setPrewarmed(false)
    if (!ENABLE_BACKGROUND_PREWARM) return
    if (!cwd || !remoteDataReady) return // 没选工作目录/远端未 ready 就别空跑
    const ric =
      window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 600))
    const id = ric(() => setPrewarmed(true))
    return () => {
      if (window.cancelIdleCallback && typeof id === 'number') {
        window.cancelIdleCallback(id)
      }
    }
  }, [host, cwd, remoteDataReady])
  // 启动文件监听:工作目录/连接就绪后,让 agent(远程)或本地扫描盯住工作目录,
  // 变更经 remote-fs-change 事件实时推给文件树/Git/预览(灵敏自动刷新)。
  // 注:影子基线不在这里建 —— 只在用户首次给 agent 发消息时才建(见 handleSend)。
  // 这样「只看文件、不用 agent」时零开销;一旦开始对话,基线自动建立、之后每轮重置,
  // 整个过程对用户透明,无需知道「基线」概念。
  useEffect(() => {
    if (!cwd || !remoteDataReady) {
      watchStop().catch(() => {})
      return
    }
    watchStart(cwd, host).catch(() => {})
    return () => {
      watchStop().catch(() => {})
    }
  }, [host, cwd, remoteDataReady])

  // 轮询 agent 起的后台任务(输出落盘的):每 3s 拉一次,终端区据此自动增删 tab。
  // 仅当连接就绪 + 有 agent 命令时跑(没 agent 无从定位根进程)。轻量:一条 RPC。
  //
  // 抗抖动(关键):远程要走 SSH→agent→ps 树走→逐个解析 fd,任何一次 RPC 超时/
  // 某轮 lsof 没返回都可能让本次结果偶发为空。若直接 setTasks(空) 会把所有 tab 和
  // 正在看的输出**瞬间清掉**(用户看到的"点一下就没了")。对策:任务"黏住"——
  // 记每个 pid 最后一次出现的时刻,只有**连续消失超过宽限期(9s)**才真正移除;
  // 单次空结果/失败一律保留上次列表。
  const taskSeenRef = useRef<Map<number, { task: AgentTask; at: number }>>(new Map())
  useEffect(() => {
    // 只要连接就绪且有工作目录就轮询:任务检测靠 cwd 锚点(命中项目目录)+ agent 子树
    // 两路并集,即便没配 defaultAgent(commandBase 为空)也能靠 cwd 抓到后台任务。
    if (!remoteDataReady || !cwd) {
      taskSeenRef.current.clear()
      setTasks([])
      return
    }
    let stop = false
    const GRACE_MS = 16000
    const merge = (list: AgentTask[]): void => {
      const now = Date.now()
      const seen = taskSeenRef.current
      for (const t of list) seen.set(t.pid, { task: t, at: now })
      // 超过宽限期仍未再出现的才删
      for (const [pid, v] of seen) {
        if (now - v.at > GRACE_MS) seen.delete(pid)
      }
      // 同一输出文件只留一个 tab(多进程任务:启动器→python、DataLoader worker、DDP 子进程
      // 共享同一日志,后端已按进程树收敛;这里再兜底一次,远端/宽限期内的残留也收掉)。
      // 存活的优先于宽限期内已消失的;其次 pid 小的(通常是父进程)。
      const ordered = [...seen.values()].sort((a, b) => {
        const la = a.at === now ? 0 : 1
        const lb = b.at === now ? 0 : 1
        return la - lb || a.task.pid - b.task.pid
      })
      const byFile = new Set<string>()
      const merged: (AgentTask & { exited?: boolean })[] = []
      for (const v of ordered) {
        const f = v.task.file ? v.task.file.replace(/\\/g, '/').toLowerCase() : ''
        if (f) {
          if (byFile.has(f)) continue
          byFile.add(f)
        }
        merged.push({ ...v.task, exited: v.at !== now })
      }
      // 按 pid 稳定排序,保持 tab 顺序不乱跳
      merged.sort((a, b) => a.pid - b.pid)
      if (!stop) setTasks(merged)
    }
    const pull = (): void => {
      agentTasks(host, cwd, agentCommandBase)
        .then((list) => merge(list))
        .catch(() => {
          /* 失败:保留上次列表,不清空(下次再试) */
        })
    }
    pull()
    const t = window.setInterval(pull, 8000)
    return () => {
      stop = true
      window.clearInterval(t)
      // 切项目/切连接:上一个目录的任务不能带到下一个(否则会拿旧路径去新 host 上 tail)
      taskSeenRef.current.clear()
    }
  }, [host, cwd, remoteDataReady, agentCommandBase])

  // 选中的任务 tab 消失后(进程结束、被去重合并)要回落到默认,否则右侧一片空白且没有
  // 任何 tab 高亮——这是「看不到后台任务日志」最常见的一种表现。
  useEffect(() => {
    if (activeShell.startsWith('task:') && !tasks.some((x) => `task:${x.pid}` === activeShell)) {
      setActiveShell('')
    }
  }, [tasks, activeShell])


  // 对话会话自动启动 claude/codex
  const initialCommand = config?.autoStart ? agentCommand : undefined

  // —— 每连接一个常驻对话会话 ——
  // 连接身份:'' = 本地 → 'local';远程用 activeConnection id。
  const connId = config?.activeConnection || 'local'
  // 会话 id/key 含 connId + agent + cwd:切集群/切 agent/切项目都会进对应常驻会话。
  // 切回旧组合时原 TUI 还在现场。
  const agentId = defaultAgent?.id || 'agent'
  const activeChatId = `chat:${connId}:${agentId}:${cwd ?? ''}`
  // dock 终端 key:每个 连接+项目 一个独立 PTY(切远程→新 key→新终端起在远端 cwd)。
  const dockKey = `dock:${connId}:${cwd ?? ''}`
  const shellProjectKey = JSON.stringify([connId, host || '', cwd || ''])
  const filesTerminalVisible = view === 'files' && !!cwd && remoteDataReady && filesTerminalProject === shellProjectKey
  const terminalVisible = view === 'terminal' || filesTerminalVisible
  const projectShells = shells.filter((s) => s.projectKey === shellProjectKey)
  const panelShells = filesTerminalVisible ? projectShells : shells
  const panelActiveShell = filesTerminalVisible
    ? projectShells.find((s) => s.id === activeShell)?.id || projectShells.at(-1)?.id || ''
    : activeShell
  const maxFilesTerminalHeight = Math.max(80, canvasHeight - 140)
  const effectiveFilesTerminalHeight = Math.min(filesTerminalHeight, maxFilesTerminalHeight)

  // 左侧对话分栏是否当前生效:开关开 + 存在活动会话 + 在终端/预览视图。
  // 无活动会话时不留左栏空位。
  const hasActiveChat = chatSessions.some((s) => s.id === activeChatId)
  const chatPaneOpen = mode.id === 'code' ? codeChatSplitOpen : view === 'latex' ? latexChatSplitOpen : chatSplitOpen
  const chatSplitActive =
    chatPaneOpen &&
    workspaceWidth >= 660 &&
    hasActiveChat &&
    view !== 'chat'
  const effectiveChatWidth = Math.min(chatWidth, Math.max(240, (workspaceWidth - 8) * 0.46))
  const showComposer = !!cwd && (view === 'chat' || chatSplitActive)
  const maxComposerInputHeight = Math.max(72, Math.min(420, Math.floor(canvasHeight * 0.5) - 42))
  const sessionsVisible = mode.id !== 'visual' && !showSettings
  const toggleChatPane = (): void => {
    if (mode.id === 'code') setCodeChatSplitOpen((open) => !open)
    else if (view === 'latex') setLatexChatSplitOpen((open) => !open)
    else setChatSplitOpen((open) => !open)
  }

  // 懒挂载活动会话:不存在则加入(从此**常驻、固化**)。
  // 每个 连接+agent+工作目录 各一个会话:切到新项目/切 Codex=新会话(agent 在后台
  // 起,不冻 UI);切回访问过的组合=原会话还在(agent 在对话、终端、渲染态全保留),
  // 瞬现。**不杀任何旧会话**——这正是"固化"。会话很轻(一个 PTY),保留到 app 退出。
  useEffect(() => {
    if (!config || !cwd) return
    // 门控:代理还在起(pending)时**不创建会话** —— 否则 agent 会用还没改写 base_url 的 env
    // 启动、绕过代理。等代理 ready(base_url 已指向它)或确定 off(降级直连)再建。
    if (proxyState.kind === 'pending') return
    setChatSessions((prev) => {
      if (prev.some((s) => s.id === activeChatId)) return prev // 已在现场,复用
      const next: ChatSession = {
        id: activeChatId,
        connId,
        cwd,
        host,
        identity: activeConn?.identity || undefined,
        env: agentEnvVars,
        command: initialCommand,
        usage: {
          agentId: defaultAgent?.id || 'agent',
          agentName: defaultAgent?.name || 'Agent',
          provider: defaultAgent?.provider || '',
          model: defaultAgent?.model || ''
        }
      }
      return [...prev, next]
    })
    // 活动会话 id 变化、或代理就绪状态变化时运行(后者让 pending→ready/off 后补建会话)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, proxyState])

  // dock 终端常驻挂载:打开 dock 后,把当前 连接+项目 的 dockKey 记下并保留。
  // 切到别的连接/项目再切回来,原 PTY 还在;切远程则用新 key 起在远端 cwd。
  useEffect(() => {
    if (!dockOpened || !cwd) return
    setDockKeys((prev) =>
      prev.some((d) => d.key === dockKey)
        ? prev
        : [
            ...prev,
            { key: dockKey, cwd, host, identity: activeConn?.identity || undefined }
          ]
    )
    // 仅在 dock 打开 / 连接+项目 变化时运行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockOpened, dockKey])

  // 会话忙/空闲心跳:每 1s tick 一次,驱动侧栏重算(近 3s 有输出=忙)。
  useEffect(() => {
    const t = window.setInterval(() => setActivityTick((n) => n + 1), 3000)
    return () => window.clearInterval(t)
  }, [])

  // 某会话有 PTY 输出 → 记时间戳(忙);若它之前被标记已退出,重新有输出则清除退出态。
  const markActivity = (sid: string): void => {
    sessionActivityRef.current.set(sid, Date.now())
    setExitedSessions((prev) => {
      if (!prev.has(sid)) return prev
      const next = new Set(prev)
      next.delete(sid)
      return next
    })
  }
  const markExited = (sid: string): void => {
    setExitedSessions((prev) => (prev.has(sid) ? prev : new Set(prev).add(sid)))
  }

  // 连接显示名:'local' → 本地;否则取连接的 name/host。
  const connName = (cid: string): string => {
    if (cid === 'local') return t('common.local')
    const c = config?.connections.find((x) => x.id === cid)
    return c?.name || c?.host || cid
  }

  // 派生侧栏会话列表(忙/空闲/已结束)。依赖 activityTick 周期性重算。
  const railSessions: RailSession[] = useMemo(() => {
    void activityTick // 触发重算
    const now = Date.now()
    return chatSessions.map((s) => {
      let status: SessionStatus
      if (exitedSessions.has(s.id)) {
        status = 'exited'
      } else {
        const last = sessionActivityRef.current.get(s.id) ?? 0
        status = now - last < 6000 ? 'busy' : 'idle'
      }
      const proj = s.cwd ? baseName(s.cwd.replace(/[\\/]+$/, '')) || s.cwd : '—'
      return { id: s.id, connId: s.connId, connName: connName(s.connId), project: proj, agentName: s.usage.agentName, status }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSessions, exitedSessions, activityTick, config])

  const handleConfigChange = (next: AppConfig): void => {
    setConfig(next)
    saveConfig(next).catch((e) => console.error('保存配置失败', e))
  }

  // 激活某连接后:尝试静默 connect(key/已有 master)。
  // 成功 → connected;失败(需密码/2FA)→ 切到终端视图交互连接。
  const markRemoteConnected = (h: string): void => {
    setConnState('connected')
    previewPrefetchAssets(h).catch(() => {})
    if (!remotePluginsDoneRef.current.has(h)) {
      remotePluginsDoneRef.current.add(h)
      installRemotePlugins(h).catch(() => remotePluginsDoneRef.current.delete(h))
    }
  }

  const tryConnect = async (h: string, identity?: string): Promise<void> => {
    setConnState('connecting')
    const _t = performance.now()
    try {
      await sshConnect(h, identity)
      console.log('[switch] sshConnect OK', h, 'cost', (performance.now() - _t).toFixed(0), 'ms')
      markRemoteConnected(h)
    } catch {
      console.log('[switch] sshConnect FAIL', h, 'cost', (performance.now() - _t).toFixed(0), 'ms')
      // 需交互认证:跳到终端,让用户输密码;master 建立后各视图随即可用
      setConnState('error')
      setView('chat')
    }
  }

  // 恢复上次远程连接 / 切换连接后,先把 SSH master 与 RPC agent 都预热到 ready。
  // 文件/Git/watch 的数据请求只在 connState=connected 后挂载,避免首次点击承担冷启动。
  useEffect(() => {
    if (!host) {
      setConnState('idle')
      return
    }
    void tryConnect(host, activeConn?.identity || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, activeConn?.identity, activeConn?.id])

  // 切到本地
  useEffect(() => {
    if (!host || connState === 'connected') return
    let stopped = false
    let timer: number | undefined

    const poll = (): void => {
      sshConnect(host, activeConn?.identity || undefined)
        .then(() => {
          if (stopped) return
          markRemoteConnected(host)
        })
        .catch(() => {
          if (!stopped) timer = window.setTimeout(poll, 5000)
        })
    }

    timer = window.setTimeout(poll, connState === 'error' ? 1000 : 5000)
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, connState, activeConn?.identity])

  const selectLocal = (): void => {
    if (!config) return
    console.log('[switch] → local at', performance.now().toFixed(0))
    setConnState('idle')
    handleConfigChange({ ...config, activeConnection: '' })
  }

  // 切到已保存连接
  const selectConnection = (id: string): void => {
    if (!config) return
    console.log('[switch] → connection', id, 'at', performance.now().toFixed(0))
    setConnState('connecting')
    handleConfigChange({ ...config, activeConnection: id })
  }

  // 从侧栏点某会话卡片 → 直接切回该会话(连接 + 项目 cwd 都还原),并切到对话视图。
  // activeChatId = chat:connId:agentId:cwd,所以要同时把 activeConnection 和该连接的
  // cwd 设回会话当时的值,组合才会命中这个常驻会话。
  const revealSession = (): void => {
    // Selecting a session from Code keeps the editor/tool in place.
    if (workspaceWidth >= 660 && view !== 'chat') {
      if (mode.id === 'code') setCodeChatSplitOpen(true)
      else if (view === 'latex') setLatexChatSplitOpen(true)
      else setChatSplitOpen(true)
    } else setView('chat')
  }

  const jumpToSession = (sid: string): void => {
    if (!config) return
    const sess = chatSessions.find((s) => s.id === sid)
    if (!sess) return
    revealSession()
    const sessionAgent = config.agents.find((agent) => agent.id === sess.usage.agentId)
    if (sess.connId === 'local') {
      setConnState('idle')
      handleConfigChange({
        ...config,
        activeConnection: '',
        defaultAgent: sessionAgent?.id || config.defaultAgent,
        cwd: sess.cwd ?? config.cwd
      })
    } else {
      if (config.activeConnection !== sess.connId) setConnState('connecting')
      handleConfigChange({
        ...config,
        activeConnection: sess.connId,
        defaultAgent: sessionAgent?.id || config.defaultAgent,
        connections: config.connections.map((c) =>
          c.id === sess.connId ? { ...c, cwd: sess.cwd ?? c.cwd } : c
        )
      })
    }
  }

  // 恢复历史会话:切到对话视图,用 `--resume <id>`(claude)/`resume <id>`(codex)
  // 重启当前项目的对话 PTY,把那次历史对话载回来继续聊。
  // 历史属于「当前项目 + 当前 agent」,所以恢复进的就是当前活动会话(activeChatId)。
  const resumeSession = (id: string): void => {
    if (!defaultAgent) return
    revealSession()
    const cmd = agentLaunchCommand(defaultAgent, id, targetShell)
    // 活动会话的 TerminalView 可能要等懒挂载;轮询拿到句柄再重启(最多 ~2s)。
    let tries = 0
    const tryRestart = (): void => {
      const handle = chatRefs.current.get(activeChatId)
      if (handle) {
        handle.restartWith(cmd)
        setComposerEpochs((epochs) => ({ ...epochs, [activeChatId]: (epochs[activeChatId] || 0) + 1 }))
        handle.focus()
        return
      }
      if (tries++ < 20) window.setTimeout(tryRestart, 100)
    }
    tryRestart()
  }

  // 从 ~/.ssh/config 主机一键连接:创建一个连接并激活
  const quickConnect = (h: string): void => {
    if (!config) return
    const id = `conn-${h}`
    const exists = config.connections.find((c) => c.id === id || c.host === h)
    const conn: Connection = exists ?? {
      id,
      name: h,
      host: h,
      cwd: '',
      identity: ''
    }
    const connections = exists
      ? config.connections
      : [...config.connections, conn]
    setConnState('connecting')
    handleConfigChange({ ...config, connections, activeConnection: conn.id })
  }

  // 灵动岛:输入 ssh 指令 → 解析 → 写 ~/.ssh/config → 新增连接并激活。
  // 返回错误信息(失败)或 null(成功)。
  const handleAddSshCommand = async (cmd: string): Promise<string | null> => {
    if (!config) return t('app.configNotReady')
    try {
      const t = await parseSshCommand(cmd)
      await sshConfigAdd(t) // 写入 ~/.ssh/config(同名会报错)
      const id = `conn-${t.alias}`
      const conn: Connection = {
        id,
        name: t.alias,
        host: t.alias, // 用别名连,ssh 自动套用刚写入的 config
        cwd: '',
        identity: ''
      }
      const connections = config.connections.some((c) => c.id === id)
        ? config.connections
        : [...config.connections, conn]
      setConnState('connecting')
      handleConfigChange({ ...config, connections, activeConnection: id })
      sshConfigHosts().then(setSshHosts).catch(() => {}) // 刷新主机列表
      return null
    } catch (e) {
      return String(e)
    }
  }

  const handlePickDir = (dir: string): void => {
    if (!config) return
    // 远程时:写到激活连接的 cwd + 该连接的最近列表;本地时:写全局 cwd + 全局最近
    if (host && activeConn) {
      const connections = config.connections.map((c) =>
        c.id === activeConn.id
          ? {
              ...c,
              cwd: dir,
              recentDirs: [
                dir,
                ...(c.recentDirs ?? []).filter((d) => d !== dir)
              ].slice(0, 12)
            }
          : c
      )
      handleConfigChange({ ...config, connections })
    } else {
      const recentDirs = [
        dir,
        ...config.recentDirs.filter((d) => d !== dir)
      ].slice(0, 12)
      handleConfigChange({ ...config, cwd: dir, recentDirs })
    }
  }

  // 选作工作目录:远程 → 远端目录浏览器;本地 → 系统 Finder。
  const pickRoot = async (): Promise<void> => {
    if (host) {
      // 远端:用连接的 cwd 或远端 HOME 作为初始路径
      let init = activeConn?.cwd || ''
      if (!init) {
        try {
          init = await remoteHome(host)
        } catch {
          init = '/'
        }
      }
      setRemoteBrowse(init || '/')
      return
    }
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('app.pickWorkDir')
    })
    if (typeof selected === 'string') handlePickDir(selected)
  }

  // 新建独立终端(可指定目录,默认用全局工作目录)。继承当前连接(本地/远程)。
  const newShell = (dir?: string, destination: 'terminal' | 'files' = 'terminal'): void => {
    const id = `shell-${++shellSeq}`
    const useDir = dir ?? cwd
    const label = useDir ? baseName(useDir.replace(/[\\/]+$/, '')) || t('app.terminalN', { n: shellSeq }) : t('app.terminalN', { n: shellSeq })
    setShells((prev) => [
      ...prev,
      { id, label, projectKey: shellProjectKey, cwd: useDir, host, identity: activeConn?.identity || undefined }
    ])
    setActiveShell(id)
    // A single mounted terminal can be docked below Files or shown full-size.
    // Register it as visited even if the full Terminal view has never been opened.
    setVisited((prev) => prev.has('terminal') ? prev : new Set(prev).add('terminal'))
    if (destination === 'files') setFilesTerminalProject(shellProjectKey)
    setView(destination)
  }

  const hideFilesTerminal = (): void => {
    setFilesTerminalProject(null)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-files-terminal-toggle]')?.focus())
  }

  const toggleFilesTerminal = (): void => {
    if (filesTerminalVisible) { hideFilesTerminal(); return }
    const existing = projectShells.find((s) => s.id === activeShell) || projectShells.at(-1)
    if (!existing) { newShell(cwd, 'files'); return }
    setActiveShell(existing.id)
    setFilesTerminalProject(shellProjectKey)
  }

  // 关闭终端
  const closeShell = (id: string): void => {
    setShells((prev) => {
      const next = prev.filter((s) => s.id !== id)
      setActiveShell((cur) =>
        cur === id ? (next[next.length - 1]?.id ?? '') : cur
      )
      return next
    })
  }

  // 底部对话框:始终与「对话」会话通信。发送/输入不切换当前视图。
  const handleSend = (text: string): void => {
    // 用户发消息 = 新一轮:记 git 基线,之后的改动即"本轮 agent 改动"(Cursor 式 diff)。
    // 基线建好后派发 turn-refresh:让文件树重拉 git 标记、已打开文件重拉 diff,
    // 这样即便远端轮询有 ~1s 延迟,"发消息"这一刻也立即反映上一轮已落盘的改动。
    console.log('[shadow] handleSend  cwd=', cwd, '| typeof cwd=', typeof cwd, '| host=', host, '| typeof host=', typeof host)
    if (cwd) {
      shadowBeginTurn(cwd, host)
        .then(() => {
          console.log('[shadow] ✅ shadowBeginTurn 成功,基线已重置 cwd=', cwd)
          window.dispatchEvent(new CustomEvent('linco:turn-refresh'))
        })
        .catch((e) => console.error('[shadow] ❌ shadowBeginTurn 失败:', e))
    } else {
      console.warn('[shadow] ⚠️ cwd falsy → 跳过基线重置')
    }
    // 命令可见:新回合清空本会话命令日志(纯回合制,不累积)。同 shadow 的回合语义。
    // 无条件调用:proxy_begin_turn 对不存在/已空的文件是 no-op,无害;不依赖 proxyState
    // 避免因状态时序导致清空漏掉(代理没起时本来也没日志,截断也无妨)。
    if (defaultAgent) {
      const sess = `${config?.activeConnection || 'local'}:${defaultAgent.id}`
      proxyBeginTurn(sess).catch(() => {})
    }
    if (defaultAgent) {
      usageRecordTurn(
        {
          agentId: defaultAgent.id,
          agentName: defaultAgent.name,
          provider: defaultAgent.provider,
          model: defaultAgent.model
        },
        text,
        { host, cwd }
      ).catch(() => {})
    }
    // 实际写入由 onForward 的兜底重发完成(Ctrl-U + 文本 + 回车)
  }
  // 从预览页「提交给 Agent」:把一段指令发给当前对话会话(等价于在对话框输入并回车)。
  // 走 handleSend 记基线/用量,再把整段文本 + 单独回车写进 PTY 放行 agent。
  // 此路径没有逐字转发(文本来自按钮),所以要整段送入;但不 Ctrl-U(claude/codex 不认),
  // 且 \r 单独发(晚一帧),避免混进文本 burst 被当 paste 换行。
  //
  // Windows:ConPTY 下 TUI 吞这段多字节文本更慢,16ms 的 \r 常常赶在文本落定前到达、
  // 被 TUI 吸收掉 → 文字进了输入框却没回车提交(就是 Windows 用户反馈的"只进框不发送")。
  // 故 Windows 用更长的延时,且分两次补发 \r 兜底(第二次防第一次仍被吃掉)。
  const submitToAgent = (text: string): void => {
    const t = text.trim()
    if (!t) return
    const handle = chatRefs.current.get(activeChatId)
    if (!handle) return
    handleSend(t)
    handle.write(t)
    const isWindows = navigator.platform.toLowerCase().includes('win')
    if (isWindows) {
      window.setTimeout(() => handle.write('\r'), 120)
      window.setTimeout(() => handle.write('\r'), 320)
    } else {
      window.setTimeout(() => handle.write('\r'), 16)
    }
    handle.focus()
  }

  const handleInstallUpdate = async (): Promise<void> => {
    if (!availableUpdate || installingUpdate) return
    setInstallingUpdate(true)
    setUpdateError(null)
    try {
      await availableUpdate.downloadAndInstall()
      await relaunch()
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err))
      setInstallingUpdate(false)
    }
  }

  // 配置未加载完成前不渲染
  if (!config) {
    return (
      <div className="app-loading" role="status">
        <img src={APP_ICON} alt="" className="h-7 w-7" />
        <span>Linco</span><span className="text-[13px] text-ink-muted">{t('app.loading')}</span>
      </div>
    )
  }

  const dark = themeById(config.theme).dark
  const toggleTheme = (): void => {
    const theme = dark ? 'linco-light' : 'linco-dark'
    applyTheme(theme)
    handleConfigChange({ ...config, theme })
  }
  const commands: WorkspaceCommand[] = [
    ...WORKSPACE_MODES.map(({ id, icon }) => ({ id: `mode-${id}`, label: t(`workflow.${id}`), icon, run: () => setView(lastModeView.current[id]) })),
    ...VIEWS.map(({ id, labelKey, icon }) => ({ id, label: t(labelKey), detail: t(`workspace.description.${id}`), icon, run: () => { setShowSettings(false); setView(id) } })),
    { id: 'project', label: t('workspace.openProject'), icon: FolderOpen, run: () => void pickRoot() },
    { id: 'settings', label: t('common.settings'), icon: SettingsIcon, run: () => setShowSettings(true) },
    { id: 'theme', label: t(dark ? 'workspace.lightMode' : 'workspace.darkMode'), icon: dark ? Sun : Moon, run: toggleTheme },
    { id: 'projects', label: t('workflow.projects'), icon: FolderOpen, run: () => setProjectsOpen(true) },
    { id: 'terminal-dock', label: t('chat.terminal.open'), icon: TerminalSquare, run: () => { setDockOpened(true); setDockTerminalOpen(true) } },
    { id: 'compose', label: t('workspace.focusComposer'), icon: MessagesSquare, run: () => { setView('chat'); requestAnimationFrame(() => document.getElementById('agent-composer')?.focus()) } },
  ]

  return (
    <div className="linco-app relative flex h-full w-full flex-col bg-sidebar font-sans text-ink">
      <CodeMirrorWarmup />
      {/* 顶部:视图切换(为 macOS 红绿灯留出左侧空间)。
          data-tauri-drag-region + .drag 双保险:Overlay 标题栏下拖动更可靠。 */}
      <div
        data-tauri-drag-region
        className={`workbench-titlebar drag flex h-11 shrink-0 items-center gap-1 pr-3 ${
          IS_WINDOWS ? 'pl-2' : IS_MACOS ? 'pl-20' : 'pl-1.5'
        }`}
      >
        {(
          <div
            data-tauri-drag-region
            className="workbench-brand pointer-events-none mr-1 flex shrink-0 items-center gap-2 pr-2"
          >
            <img src={APP_ICON} alt="" className="h-5 w-5" draggable={false} />
            <span className="workbench-wordmark">Linco</span>
          </div>
        )}
        <button className="project-trigger no-drag" onClick={() => { setShowSettings(false); setProjectsOpen(true) }} title={t('workflow.projects')} aria-label={t('workflow.projects')} aria-expanded={projectsOpen} aria-controls="workspace-sidebar"><span>{cwd ? baseName(cwd.replace(/[\\/]+$/, '')) : t('workspace.openProject')}</span><ChevronsUpDown size={12} /></button>
        <nav className="workspace-modes no-drag" aria-label={t('workflow.primary')}>
          {WORKSPACE_MODES.map(({ id, icon: Icon }) => <button key={id} className={`mode-button ${mode.id === id ? 'is-active' : ''}`} aria-current={mode.id === id ? 'page' : undefined} onClick={() => { setShowSettings(false); setView(lastModeView.current[id]) }}><Icon size={14} strokeWidth={1.6} /><span>{t(`workflow.${id}`)}</span></button>)}
        </nav>
        <div data-tauri-drag-region className="flex-1" />
        <button className="icon-button no-drag" onClick={() => { setShowSettings(false); setShowCommands(true) }} aria-label={t('workspace.commands')} title={`${t('workspace.commands')} (${IS_MACOS ? '⌘' : 'Ctrl'}+Shift+P)`}><Search size={16} /></button>
        <button className="icon-button no-drag" onClick={() => setShowSettings((open) => !open)} title={t('common.settings')} aria-label={t('common.settings')}><SettingsIcon size={16} /></button>
        {availableUpdate && (
          <div className="no-drag relative shrink-0">
            <button
              onClick={() => setShowUpdatePanel((o) => !o)}
              disabled={installingUpdate}
              title={
                updateError
                  ? t('update.failed', { error: updateError })
                  : t('update.whatsNew')
              }
              aria-label={t('update.available', { version: availableUpdate.version })}
              className="icon-button text-link"
            >
              {installingUpdate ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
            </button>
            {showUpdatePanel && !installingUpdate && (
              <UpdatePanel
                version={availableUpdate.version}
                body={availableUpdate.body}
                error={updateError}
                t={t}
                onInstall={() => {
                  setShowUpdatePanel(false)
                  handleInstallUpdate().catch(() => {})
                }}
                onClose={() => setShowUpdatePanel(false)}
              />
            )}
          </div>
        )}
        <ConnectionPicker
          connections={config.connections}
          activeId={config.activeConnection}
          state={connState}
          sshHosts={sshHosts}
          onSelectLocal={selectLocal}
          onSelectConnection={selectConnection}
          onQuickConnect={quickConnect}
          onManage={() => setShowSettings(true)}
          onAddSshCommand={handleAddSshCommand}
        />
        {IS_WINDOWS && <WindowControls />}
      </div>

      <div className="workbench-body">
        {projectsOpen && <WorkspaceSidebar
          cwd={cwd} dark={dark} onClose={() => setProjectsOpen(false)}
          recentDirs={host && activeConn ? activeConn.recentDirs || [] : config.recentDirs} onOpenRecent={handlePickDir}
          onPickProject={() => void pickRoot()} onSettings={() => setShowSettings(true)} onToggleTheme={toggleTheme}
          history={cwd && <SessionHistory key={JSON.stringify([host, cwd, defaultAgent?.provider])} cwd={cwd} provider={defaultAgent?.provider || ''} host={host} active={remoteDataReady} onResume={(id) => { setProjectsOpen(false); resumeSession(id) }} />}
        />}
        <main ref={workspaceRef} className="workbench-content" aria-label={t(`workflow.${mode.id}`)}>
          <div className="workspace-contextbar">
            <nav className="context-tabs" aria-label={t('workflow.tools')}>
              {mode.views.map((id) => { const Icon = VIEWS.find((item) => item.id === id)!.icon; return <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)} className={view === id ? 'is-active' : ''}><Icon size={13} /><span>{t(`workflow.tab.${id}`)}</span>{id === 'terminal' && tasks.length > 0 && <span className="nav-count">{tasks.length}</span>}</button> })}
            </nav>
            {sessionsVisible && <SessionRail sessions={railSessions} activeId={activeChatId} onJump={jumpToSession} />}
            <div className="context-actions">
              {cwd && view === 'files' && <button data-files-terminal-toggle className={`context-agent-toggle ${filesTerminalVisible ? 'is-active' : ''}`} onClick={toggleFilesTerminal} disabled={!remoteDataReady} aria-pressed={filesTerminalVisible} aria-controls="workspace-terminal" title={t(filesTerminalVisible ? 'files.terminalHide' : 'files.terminalShow')} aria-label={t(filesTerminalVisible ? 'files.terminalHide' : 'files.terminalShow')}><TerminalSquare size={13} /><span>{t('view.terminal')}</span></button>}
              {cwd && workspaceWidth >= 660 && view !== 'chat' && <button className={`context-agent-toggle ${chatSplitActive ? 'is-active' : ''}`} onClick={toggleChatPane} aria-pressed={chatSplitActive} title={t(chatSplitActive ? 'app.chatPane.collapse' : 'app.chatPane.expand')}>{chatSplitActive ? <PanelLeftClose size={13} /> : <PanelLeft size={13} />}<span>{t('view.chat')}</span></button>}
            </div>
          </div>
      <div ref={canvasRef} className="workspace-canvas min-h-0 flex-1">
        <div className="relative h-full w-full">
          {!cwd && view !== 'notion' && <WelcomeView recentDirs={host && activeConn ? activeConn.recentDirs || [] : config.recentDirs} onPickProject={() => void pickRoot()} onOpenRecent={handlePickDir} onSettings={() => setShowSettings(true)} />}
          {/* 对话会话(claude agent):每连接一个,常驻挂载、自动启动。
              定位随视图变(只改 CSS,绝不重挂,PTY 不丢):
              - 「对话」视图的活动会话 → 铺满中间(inset-0)。
              - 终端/预览视图且左分栏开 → 缩到左栏(left:0,宽 chatWidth)。
              - 其余(非活动 / 分栏关 / 文件·Git)→ opacity-0 隐藏挂载。 */}
          {chatSessions.map((s) => {
            const isActive = s.id === activeChatId
            const centered = view === 'chat' && isActive
            const leftPane = chatSplitActive && isActive
            const visible = centered || leftPane
            return (
              <div
                key={s.id}
                style={{ width: leftPane ? effectiveChatWidth : undefined, bottom: visible ? composerHeight + 8 : 0, height: 'auto' }}
                className={`h-full min-h-0 overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5 ${
                  leftPane
                    ? 'absolute left-0 top-0 bottom-0 z-10 opacity-100'
                    : 'absolute inset-0 ' +
                      (visible ? 'z-10 opacity-100' : 'pointer-events-none opacity-0')
                }`}
              >
                <TerminalView
                  ref={(el) => {
                    if (el) chatRefs.current.set(s.id, el)
                    else chatRefs.current.delete(s.id)
                  }}
                  id={s.id}
                  visible={visible}
                  cwd={s.cwd}
                  env={s.id === activeChatId ? agentEnvVars : s.env}
                  initialCommand={
                    s.id === activeChatId ? initialCommand : s.command
                  }
                  host={s.host}
                  identity={s.identity}
                  onActivity={markActivity}
                  onExit={markExited}
                  usage={s.usage}
                />
              </div>
            )
          })}

          {/* 左分栏竖向拖拽条:仅分栏生效时显示,左右拖改 chatWidth */}
          {chatSplitActive && (
            <div
              className="absolute top-0 bottom-0 z-20"
              style={{ left: effectiveChatWidth - 4 }}
            >
              <ResizeHandle
                orientation="vertical"
                onResize={(dx) =>
                  setChatWidth((w) =>
                    Math.max(240, Math.min((workspaceWidth - 8) * 0.46, w + dx))
                  )
                }
              />
            </div>
          )}

          {!remoteDataReady && host && view !== 'chat' && view !== 'terminal' && view !== 'notion' && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-canvas text-[13px] text-ink-faint shadow-card ring-1 ring-black/5">
              {t('app.connectingRemote')}
            </div>
          )}

          {/* 终端视图:agent 后台任务(自动 tab)+ 用户独立 shell(可多开)。
              **常驻挂载**(访问过即保留):切到 git/文件/预览再切回来,PTY 不被销毁
              (卸载会触发 TerminalView 的 termKill,把后台 shell 杀掉 → 终端全没了)。
              用 opacity 切换可见性,而非 unmount。 */}
          {(prewarmed || visited.has('terminal')) && (
            <div
              id="workspace-terminal"
              data-workspace-view="terminal"
              data-terminal-docked={filesTerminalVisible}
              aria-hidden={!terminalVisible}
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0, top: filesTerminalVisible ? 'auto' : 0, height: filesTerminalVisible ? effectiveFilesTerminalHeight : undefined }}
              className={`absolute right-0 top-0 bottom-0 flex flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5 ${
                terminalVisible
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              {/* 终端标签条:用户的 shell + 「新建终端」按钮放最前(固定好找),
                  agent 自动起的后台任务 tab 放在它们之后,避免把用户的入口挤跑。
                  左侧留出空间给浮动的「对话栏开关」按钮,不被它压住。 */}
              <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-black/8 px-2 py-1.5">
                {panelShells.map((s) => (
                  <div
                    key={s.id}
                    className={`group flex shrink-0 items-center gap-1 rounded-lg pl-2.5 pr-1 py-1 text-[12px] ${
                      s.id === panelActiveShell
                        ? 'bg-sidebar text-ink'
                        : 'text-ink-muted hover:bg-black/5'
                    }`}
                  >
                    <button onClick={() => setActiveShell(s.id)} title={`${s.host || 'Local'} · ${s.cwd || ''}`}>{s.label}</button>
                    <button
                      onClick={() => closeShell(s.id)}
                      aria-label={`${t('app.terminal.close')}: ${s.label}`}
                      className="rounded p-0.5 text-ink-faint hover:bg-black/10 hover:text-ink"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => newShell(undefined, filesTerminalVisible ? 'files' : 'terminal')}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5"
                  title={t('app.terminal.new')}
                >
                  <Plus size={13} />
                  {t('app.terminal.new')}
                </button>
                {/* 「Agent 命令」tab:命令可见代理已启用时出现,展示本会话 agent 跑的 bash+结果。 */}
                {!filesTerminalVisible && proxyState.kind === 'ready' && (
                  <button
                    onClick={() => setActiveShell('cmdlog')}
                    className={`flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] ${
                      activeShell === 'cmdlog'
                        ? 'bg-sidebar text-ink'
                        : 'text-ink-muted hover:bg-black/5'
                    }`}
                    title={t('cmdlog.title')}
                  >
                    <Activity size={12} className="text-accent" />
                    {t('cmdlog.title')}
                  </button>
                )}
                {/* agent 后台任务 tab(自动出现/消失,不可手动关——进程结束即移除)。
                    放在用户终端之后,加一条竖分隔线区分。 */}
                {!filesTerminalVisible && tasks.length > 0 && (
                  <div className="mx-1 h-4 w-px shrink-0 bg-black/10" />
                )}
                {!filesTerminalVisible && tasks.map((task) => {
                  const label = taskLabel(task.args)
                  // 同名脚本多次运行时用 pid 区分,否则几个 main.py 分不清谁是谁
                  const dupName = tasks.filter((x) => taskLabel(x.args) === label).length > 1
                  return (
                    <button
                      key={`task:${task.pid}`}
                      onClick={() => setActiveShell(`task:${task.pid}`)}
                      className={`flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] ${
                        activeShell === `task:${task.pid}`
                          ? 'bg-sidebar text-ink'
                          : 'text-ink-muted hover:bg-black/5'
                      }`}
                      title={`${task.args}\n${task.file || t('task.noFile')}`}
                    >
                      <Activity
                        size={12}
                        className={task.exited ? 'text-ink-faint' : 'text-emerald-500'}
                      />
                      {label}
                      {dupName && <span className="text-ink-faint">#{task.pid}</span>}
                    </button>
                  )
                })}
                {filesTerminalVisible && <button className="icon-button ml-auto" onClick={hideFilesTerminal} title={t('files.terminalHide')} aria-label={t('files.terminalHidePanel')}><X size={14} /></button>}
              </div>
              {/* 终端内容 */}
              <div className="relative min-h-0 flex-1">
                {(filesTerminalVisible ? panelShells.length === 0 : tasks.length === 0 && shells.length === 0 && proxyState.kind !== 'ready') && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-ink-faint">
                    <span>{t(filesTerminalVisible ? 'files.terminalEmpty' : 'app.taskEmpty')}</span>
                    {!filesTerminalVisible && <span className="text-[11px]">
                      {t('app.taskEmptyHint')}
                    </span>}
                    <button
                      onClick={() => newShell(undefined, filesTerminalVisible ? 'files' : 'terminal')}
                      className="mt-1 flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-2 text-[13px] text-ink hover:bg-black/5"
                    >
                      <Plus size={15} />
                      {t('app.terminal.new')}
                    </button>
                  </div>
                )}
                  <>
                    {/* Keep every session mounted, even when the current project's panel is empty. */}
                    {tasks.map((t) => {
                      const id = `task:${t.pid}`
                      const selected =
                        panelActiveShell === id ||
                        // 没选任何 tab 时默认显示第一个任务
                        (!filesTerminalVisible && panelActiveShell === '' && tasks[0]?.pid === t.pid)
                      return (
                        <div
                          key={id}
                          className={`absolute inset-0 ${
                            selected ? 'z-10 opacity-100' : 'pointer-events-none opacity-0'
                          }`}
                        >
                          <AgentTaskOutput
                            file={t.file}
                            args={t.args}
                            host={host}
                            active={view === 'terminal' && selected}
                            exited={t.exited}
                          />
                        </div>
                      )
                    })}
                    {/* Agent 命令面板:代理启用时常驻挂载,activeShell==='cmdlog' 时显示 */}
                    {proxyState.kind === 'ready' && (
                      <div
                        className={`absolute inset-0 ${
                          panelActiveShell === 'cmdlog'
                            ? 'z-10 opacity-100'
                            : 'pointer-events-none opacity-0'
                        }`}
                      >
                        <AgentCommandLog
                          session={`${config?.activeConnection || 'local'}:${defaultAgent?.id || 'agent'}`}
                          host={host}
                          active={view === 'terminal' && activeShell === 'cmdlog'}
                        />
                      </div>
                    )}
                    {shells.map((s) => (
                      <div
                        key={s.id}
                        className={`absolute inset-0 ${
                          s.id === panelActiveShell
                            ? 'z-10 opacity-100'
                            : 'pointer-events-none opacity-0'
                        }`}
                      >
                        <TerminalView
                          id={s.id}
                          visible={terminalVisible && s.id === panelActiveShell}
                          cwd={s.cwd}
                          host={s.host}
                          identity={s.identity}
                        />
                      </div>
                    ))}
                  </>
              </div>
            </div>
          )}

          {filesTerminalVisible && <div
            className="files-terminal-resize absolute right-0 z-20"
            style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0, bottom: effectiveFilesTerminalHeight }}
            role="separator" aria-label={t('files.terminalResize')} aria-orientation="horizontal"
            aria-valuemin={80} aria-valuemax={Math.round(maxFilesTerminalHeight)} aria-valuenow={Math.round(effectiveFilesTerminalHeight)} tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              setFilesTerminalHeight(Math.max(80, Math.min(maxFilesTerminalHeight, effectiveFilesTerminalHeight + (event.key === 'ArrowUp' ? 20 : -20))))
            }}
          ><ResizeHandle onResize={(dy) => setFilesTerminalHeight((h) => Math.max(80, Math.min(maxFilesTerminalHeight, Math.min(h, maxFilesTerminalHeight) - dy)))} /></div>}

          {/* 预览:预热后或访问过即常驻挂载(iframe 状态保留),切回瞬时显示 */}
          {remoteDataReady && (prewarmed || visited.has('preview')) && (
            <div
              data-workspace-view="preview"
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0 }}
              className={`absolute right-0 top-0 bottom-0 ${
                view === 'preview'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <ScreenView
                host={host}
                cwd={cwd}
                previewPath={previewPath}
                onSubmitToAgent={submitToAgent}
              />
            </div>
          )}
          {visited.has('notion') && (
            <div data-workspace-view="notion"
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0 }}
              className={`absolute right-0 top-0 bottom-0 ${view === 'notion' ? 'z-10 opacity-100' : 'pointer-events-none opacity-0'}`}>
              <NotionView active={view === 'notion' && !showSettings && !projectsOpen && !showCommands && !showUpdatePanel && !remoteBrowse}
                cwd={cwd} host={host} canUseAgent={!!cwd && hasActiveChat}
                onSubmitToAgent={submitToAgent} onOpenTerminal={() => newShell()} />
            </div>
          )}
          {/* PowerPoint preview polling is active only while the drawing view is visible. */}
          {remoteDataReady && view === 'drawing' && (
            <div
              data-workspace-view="drawing"
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0 }}
              className="absolute right-0 top-0 bottom-0 z-10"
            >
              <DrawingView
                host={host}
                cwd={cwd}
                onSubmitToAgent={submitToAgent}
              />
            </div>
          )}
          {remoteDataReady && visited.has('latex') && (
            <div
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0 }}
              className={`absolute right-0 top-0 bottom-0 ${
                view === 'latex'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <ViewErrorBoundary>
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center rounded-2xl bg-canvas text-[12px] text-ink-faint shadow-card ring-1 ring-black/5">
                      <Loader2 size={15} className="animate-spin" />
                    </div>
                  }
                >
                  <LatexView
                    host={host}
                    cwd={cwd}
                    active={view === 'latex'}
                    onSubmitToAgent={submitToAgent}
                  />
                </Suspense>
              </ViewErrorBoundary>
            </div>
          )}
          {/* 文件 / Git:预热后或访问过即常驻挂载,切回瞬时显示(不重挂载、不重拉) */}
          {remoteDataReady && (prewarmed || visited.has('files')) && (
            <div
              data-workspace-view="files"
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0, bottom: filesTerminalVisible ? effectiveFilesTerminalHeight + 8 : 0 }}
              className={`absolute inset-0 ${
                view === 'files'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <FilesView
                root={cwd}
                onPickRoot={pickRoot}
                onOpenInTerminal={(dir) => newShell(dir, 'files')}
                onPreview={openInPreview}
                host={host}
                onDownload={transfers.trackDownload}
              />
            </div>
          )}
          {remoteDataReady && (prewarmed || visited.has('git')) && (
            <div
              data-workspace-view="git"
              style={{ left: chatSplitActive ? effectiveChatWidth + 8 : 0 }}
              className={`absolute inset-0 ${
                view === 'git'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <GitView
                repo={cwd}
                onPickRoot={pickRoot}
                host={host}
                githubUser={config.githubUser}
                config={config}
                onChange={handleConfigChange}
              />
            </div>
          )}

      {/* The composer belongs to the agent pane; previews and editors keep their full height. */}
      <div ref={composerRef} className="pane-composer" style={{ width: chatSplitActive ? effectiveChatWidth : '100%', display: showComposer ? undefined : 'none' }}>
      <div className="composer-resize">
        <ResizeHandle
          label={t('workspace.resizeComposer')}
          onResize={(dy) =>
            setChatBoxHeight((h) => Math.max(72, Math.min(maxComposerInputHeight, h - dy)))
          }
        />
      </div>

      {/* 底部对话区:宽屏按比例填充历史/输入/会话三栏,窄屏自动保留输入栏。 */}
      <div
        className={`app-bottom-grid shrink-0 ${
          dockTerminalOpen ? 'app-bottom-grid-compact' : ''
        }`}
      >
        <div className="app-bottom-composer min-w-0">
          {chatSessions.map((session) => <div key={`${session.id}:${composerEpochs[session.id] || 0}`} style={{ display: session.id === activeChatId ? undefined : 'none' }}>
          <ChatInput
            onSend={handleSend}
            onForward={(data) => chatRefs.current.get(session.id)?.write(data)}
            cwd={session.cwd}
            remote={!!session.host}
            active={session.id === activeChatId && showComposer}
            extraHeight={chatBoxHeight}
            maxHeight={maxComposerInputHeight}
          />
          </div>)}
        </div>
      </div>
      </div>
        </div>
      </div>

      {/* 底部停靠终端(VS Code 式):放在对话框下方。干净的普通终端——
          不注入 agent 的 API env、不自动跑 claude;只有对话窗口才跟 AI 对话。
          宽度与上方 screen 一致;首次打开后常驻挂载,关闭仅隐藏不销毁会话。 */}
      {dockOpened && (
        <div
          className={`shrink-0 px-1.5 pb-1.5 ${dockTerminalOpen ? 'block' : 'hidden'}`}
        >
          {/* 拖拽分隔条:向上拖加高终端(screen 自动变矮),向下拖反之 */}
          <ResizeHandle
            onResize={(dy) =>
              setDockHeight((h) =>
                Math.max(60, Math.min(window.innerHeight - 240, h - dy))
              )
            }
          />
          <div
            className="relative overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5"
            style={{ height: dockHeight }}
          >
            <div className="absolute right-2 top-1.5 z-10 flex items-center gap-1">
              <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] text-ink-faint">
                {t('view.terminal')}{host ? ` · ${host}` : ''}
              </span>
              <button
                onClick={() => setDockTerminalOpen(false)}
                className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
                title={t('app.terminal.close')}
              >
                <X size={14} />
              </button>
            </div>
            {/* 每个 连接+项目 一个常驻 dock 终端,只显示当前 key 对应的那个。
                切远程 → dockKey 变 → 新终端起在远端 cwd(不再停在本机路径)。 */}
            {dockKeys.map((d) => (
              <div
                key={d.key}
                className={`absolute inset-0 ${
                  d.key === dockKey ? 'z-[1] opacity-100' : 'pointer-events-none opacity-0'
                }`}
              >
                <TerminalView
                  id={d.key}
                  visible={dockTerminalOpen && d.key === dockKey}
                  cwd={d.cwd}
                  host={d.host}
                  identity={d.identity}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 文件传输进度坞:聊天框下方,传输时出现,全部完成后自动收起(借鉴底部终端外观)。 */}
      {transfers.open && transfers.jobs.length > 0 && (
        <div className="shrink-0 px-1.5 pb-1.5">
          <TransferDock
            jobs={transfers.jobs}
            onCancel={transfers.cancel}
            onClose={() => transfers.setOpen(false)}
          />
        </div>
      )}
        </main>
      </div>

      {showCommands && <CommandPalette commands={commands} onClose={() => setShowCommands(false)} />}

      {/* 远端目录浏览器(远程选工作目录时) */}
      {remoteBrowse !== null && host && (
        <RemoteDirPicker
          host={host}
          initialPath={remoteBrowse}
          onPick={(dir) => {
            setRemoteBrowse(null)
            handlePickDir(dir)
          }}
          onClose={() => setRemoteBrowse(null)}
        />
      )}

      {/* 首启语言选择:config 已载入但未选语言时弹出,选定即装对应语言插件。
          「稍后配置」:只记下界面语言(不装任何插件)关掉引导,之后可在设置里再配。 */}
      {config && !config.language && (
        <LanguagePicker
          onPick={async (agent, lang) => {
            await setLanguage(agent, lang)
            setConfig((c) => (c ? { ...c, language: lang } : c))
          }}
          onSkip={() => {
            // 不装插件:写 language(关掉引导、下次不再弹)+ pluginAgent='skip'
            //(让自动安装 effect 跳过),之后可在设置里再正式选 agent/语言。
            handleConfigChange({
              ...config,
              language: uiLang === 'en' ? 'en' : 'zh',
              pluginAgent: 'skip'
            })
          }}
        />
      )}

      {/* 设置:覆盖层(不替换主树)。主树仍挂载在底下,
          对话/终端等会话不被卸载,claude 不会因开设置而重启。 */}
      {showSettings && (
        <div className="absolute inset-x-0 bottom-0 top-[40px] z-50 bg-sidebar">
          <Settings
            config={config}
            onChange={handleConfigChange}
            onClose={() => setShowSettings(false)}
          />
        </div>
      )}
    </div>
  )
}
