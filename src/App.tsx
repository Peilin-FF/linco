import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Eye,
  MessagesSquare,
  TerminalSquare,
  FolderTree,
  GitBranch,
  Settings as SettingsIcon,
  Plus,
  Activity,
  PanelLeft,
  PanelLeftClose,
  X,
  Download,
  Loader2
} from 'lucide-react'
import ScreenView from './components/ScreenView'
import TerminalView, { type TerminalHandle } from './components/TerminalView'
import ChatInput from './components/ChatInput'
import FilesView from './components/FilesView'
import GitView from './components/GitView'
import AgentTaskOutput from './components/AgentTaskOutput'
import SessionRail, { type RailSession, type SessionStatus } from './components/SessionRail'
import SessionHistory from './components/SessionHistory'
import Settings from './components/Settings'
import ConnectionPicker, { type ConnState } from './components/ConnectionPicker'
import RemoteDirPicker from './components/RemoteDirPicker'
import LanguagePicker from './components/LanguagePicker'
import UpdatePanel from './components/UpdatePanel'
import CodeMirrorWarmup from './components/CodeMirrorWarmup'
import ResizeHandle from './components/ResizeHandle'
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
  type AppConfig,
  type AgentConfig
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
import { shadowBeginTurn } from '@/lib/shadow'
import { agentTasks, type AgentTask } from '@/lib/procs'
import { applyTheme, applyFont } from '@/lib/theme'
import { useI18n } from '@/lib/i18n'
import { usageRecordTurn, type UsageAgentContext } from '@/lib/usage'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

type ViewId = 'chat' | 'terminal' | 'preview' | 'files' | 'git'

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

const VIEWS: { id: ViewId; labelKey: string; icon: typeof Eye }[] = [
  { id: 'chat', labelKey: 'view.chat', icon: MessagesSquare },
  { id: 'terminal', labelKey: 'view.terminal', icon: TerminalSquare },
  { id: 'preview', labelKey: 'view.preview', icon: Eye },
  { id: 'files', labelKey: 'view.files', icon: FolderTree },
  { id: 'git', labelKey: 'view.git', icon: GitBranch }
]

// 终端会话独立编号
interface Shell {
  id: string
  label: string
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
  const [view, setView] = useState<ViewId>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  // 点更新横幅 → 弹出「新版更新内容」公告(展示 release notes,再让用户决定是否更新)
  const [showUpdatePanel, setShowUpdatePanel] = useState(false)
  // 已访问过的视图:首次进入后常驻挂载,之后切回瞬时显示(不重新拉数据)
  const [visited, setVisited] = useState<Set<ViewId>>(new Set(['chat']))
  // 后台预热:app 就绪后空闲时悄悄把 文件/Git/预览 三视图挂载好(含各自首次
  // 数据拉取),这样用户真正点开时已经热好 = 瞬现,不再卡那一下(借鉴 VS Code
  // "显示与加载解耦";配合 CodeMirrorWarmup 一起把首次开销提前)。
  const [prewarmed, setPrewarmed] = useState(false)
  // 预览目标文件(右键预览时指定;空=默认目标)
  const [previewPath, setPreviewPath] = useState<string | undefined>(undefined)

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
  const [chatBoxHeight, setChatBoxHeight] = useState(0) // 对话框输入区额外高度(0=默认)

  // 终端/预览视图的左侧对话分栏:默认打开,可拖宽、可关闭。
  // 复用同一个对话会话(移动定位,不重挂),边看输出边对话。
  const [chatSplitOpen, setChatSplitOpen] = useState(true)
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
  const [tasks, setTasks] = useState<AgentTask[]>([])

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

  // 启动时检查 GitHub release updater；只在发现新版本时显示右上角提示。
  useEffect(() => {
    let cancelled = false
    const runCheck = async (): Promise<void> => {
      try {
        const update = await check({ timeout: 8000 })
        if (!cancelled) {
          setAvailableUpdate(update)
          setUpdateError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setUpdateError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    runCheck().catch(() => {})
    const timer = window.setInterval(() => {
      runCheck().catch(() => {})
    }, 6 * 60 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // 当前激活的连接(空 = 本地)
  const activeConn = useMemo<Connection | undefined>(
    () => config?.connections.find((c) => c.id === config.activeConnection),
    [config]
  )
  const host = activeConn?.host || undefined // undefined = 本地

  // 默认 agent:决定对话会话要自动启动的命令与注入的环境变量
  const defaultAgent = useMemo(
    () => config?.agents.find((a) => a.id === config.defaultAgent),
    [config]
  )
  const agentEnvVars = useMemo(
    () => (defaultAgent ? agentEnv(defaultAgent) : undefined),
    [defaultAgent]
  )
  const agentCommand = useMemo(
    () => (defaultAgent ? agentLaunchCommand(defaultAgent) : undefined),
    [defaultAgent]
  )
  const agentCommandBase = useMemo(
    () => (defaultAgent ? agentExecutable(defaultAgent) : undefined),
    [defaultAgent]
  )
  const agentLabel = defaultAgent
    ? defaultAgent.model
      ? `${defaultAgent.name} · ${defaultAgent.model}`
      : defaultAgent.name
    : 'Agent'

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
    const GRACE_MS = 9000
    const merge = (list: AgentTask[]): void => {
      const now = Date.now()
      const seen = taskSeenRef.current
      for (const t of list) seen.set(t.pid, { task: t, at: now })
      // 超过宽限期仍未再出现的才删
      for (const [pid, v] of seen) {
        if (now - v.at > GRACE_MS) seen.delete(pid)
      }
      // 按 pid 稳定排序,保持 tab 顺序不乱跳
      const merged = [...seen.values()].map((v) => v.task).sort((a, b) => a.pid - b.pid)
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
    const t = window.setInterval(pull, 3000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [host, cwd, remoteDataReady, agentCommandBase])


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

  // 左侧对话分栏是否当前生效:开关开 + 存在活动会话 + 在终端/预览视图。
  // 无活动会话时不留左栏空位。
  const hasActiveChat = chatSessions.some((s) => s.id === activeChatId)
  const chatSplitActive =
    chatSplitOpen && hasActiveChat && (view === 'terminal' || view === 'preview')

  // 懒挂载活动会话:不存在则加入(从此**常驻、固化**)。
  // 每个 连接+agent+工作目录 各一个会话:切到新项目/切 Codex=新会话(agent 在后台
  // 起,不冻 UI);切回访问过的组合=原会话还在(agent 在对话、终端、渲染态全保留),
  // 瞬现。**不杀任何旧会话**——这正是"固化"。会话很轻(一个 PTY),保留到 app 退出。
  useEffect(() => {
    if (!config || !cwd) return
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
    // 仅在活动会话 id 变化时运行(切连接/切项目)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId])

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
    const t = window.setInterval(() => setActivityTick((n) => n + 1), 1000)
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
        status = now - last < 3000 ? 'busy' : 'idle'
      }
      const proj = s.cwd ? s.cwd.replace(/\/+$/, '').split('/').pop() || s.cwd : '—'
      return { id: s.id, connId: s.connId, connName: connName(s.connId), project: proj, status }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSessions, exitedSessions, activityTick, config])

  const handleConfigChange = (next: AppConfig): void => {
    setConfig(next)
    saveConfig(next).catch((e) => console.error('保存配置失败', e))
  }

  // 聊天框改默认 agent 的字段(模型/权限/effort)→ 写配置文件。
  // 这些是启动参数,只写配置;**下次该会话启动**才生效(不重启正在跑的会话)。
  const patchDefaultAgent = (patch: Partial<AgentConfig>): void => {
    if (!config || !defaultAgent) return
    handleConfigChange({
      ...config,
      agents: config.agents.map((a) =>
        a.id === defaultAgent.id ? { ...a, ...patch } : a
      )
    })
  }

  // 激活某连接后:尝试静默 connect(key/已有 master)。
  // 成功 → connected;失败(需密码/2FA)→ 切到终端视图交互连接。
  const tryConnect = async (h: string, identity?: string): Promise<void> => {
    setConnState('connecting')
    const _t = performance.now()
    try {
      await sshConnect(h, identity)
      console.log('[switch] sshConnect OK', h, 'cost', (performance.now() - _t).toFixed(0), 'ms')
      setConnState('connected')
      // 连上后把当前语言的插件装到远端 ~/.claude/plugins(每 host 一次,后台、失败静默)。
      if (!remotePluginsDoneRef.current.has(h)) {
        remotePluginsDoneRef.current.add(h)
        installRemotePlugins(h).catch(() => remotePluginsDoneRef.current.delete(h))
      }
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
  const jumpToSession = (sid: string): void => {
    if (!config) return
    const sess = chatSessions.find((s) => s.id === sid)
    if (!sess) return
    setView('chat')
    if (sess.connId === 'local') {
      setConnState('idle')
      handleConfigChange({
        ...config,
        activeConnection: '',
        cwd: sess.cwd ?? config.cwd
      })
    } else {
      setConnState('connecting')
      handleConfigChange({
        ...config,
        activeConnection: sess.connId,
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
    setView('chat')
    const cmd = agentLaunchCommand(defaultAgent, id)
    // 活动会话的 TerminalView 可能要等懒挂载;轮询拿到句柄再重启(最多 ~2s)。
    let tries = 0
    const tryRestart = (): void => {
      const handle = chatRefs.current.get(activeChatId)
      if (handle) {
        handle.restartWith(cmd)
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
  const newShell = (dir?: string): void => {
    const id = `shell-${++shellSeq}`
    const useDir = dir ?? cwd
    const label = useDir ? useDir.split('/').pop() || t('app.terminalN', { n: shellSeq }) : t('app.terminalN', { n: shellSeq })
    setShells((prev) => [
      ...prev,
      { id, label, cwd: useDir, host, identity: activeConn?.identity || undefined }
    ])
    setActiveShell(id)
    setView('terminal')
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
    if (cwd) {
      shadowBeginTurn(cwd, host)
        .then(() => window.dispatchEvent(new CustomEvent('linco:turn-refresh')))
        .catch(() => {})
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
  const handleForward = (data: string): void => {
    // 转发到当前活动连接的对话会话
    chatRefs.current.get(activeChatId)?.write(data)
  }

  // 从预览页「提交给 Agent」:把一段指令发给当前对话会话(等价于在对话框输入并回车)。
  // 走 handleSend 记基线/用量,再把整段文本 + 单独回车写进 PTY 放行 agent。
  // 此路径没有逐字转发(文本来自按钮),所以要整段送入;但不 Ctrl-U(claude/codex 不认),
  // 且 \r 单独发(下一帧),避免混进文本 burst 被当 paste 换行。
  const submitToAgent = (text: string): void => {
    const t = text.trim()
    if (!t) return
    const handle = chatRefs.current.get(activeChatId)
    if (!handle) return
    handleSend(t)
    handle.write(t)
    window.setTimeout(() => handle.write('\r'), 16)
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
      <div className="flex h-full w-full items-center justify-center bg-canvas text-ink-faint">
        {t('app.loading')}
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-sidebar font-sans text-ink">
      <CodeMirrorWarmup />
      {/* 顶部:视图切换(为 macOS 红绿灯留出左侧空间)。
          data-tauri-drag-region + .drag 双保险:Overlay 标题栏下拖动更可靠。 */}
      <div
        data-tauri-drag-region
        className="drag flex h-11 shrink-0 items-center gap-1 pl-20 pr-3"
      >
        {VIEWS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`no-drag flex items-center gap-1.5 rounded-lg px-3 py-1 text-[13px] transition-colors ${
              id === view
                ? 'bg-canvas text-ink shadow-sm'
                : 'text-ink-muted hover:bg-black/5'
            }`}
          >
            <Icon size={15} />
            <span>{t(labelKey)}</span>
            {/* 终端 tab:有 agent 后台任务在跑时显示绿点计数 */}
            {id === 'terminal' && tasks.length > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-white">
                {tasks.length}
              </span>
            )}
          </button>
        ))}
        {/* 左分栏开关:终端/预览视图显示,放顶部视图栏(在视图按钮右边),不挡视图内工具栏。 */}
        {(view === 'terminal' || view === 'preview') && (
          <button
            onClick={() => setChatSplitOpen((o) => !o)}
            title={chatSplitOpen ? t('app.chatPane.collapse') : t('app.chatPane.expand')}
            className={`no-drag ml-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] transition-colors ${
              chatSplitOpen
                ? 'bg-canvas text-ink shadow-sm'
                : 'text-ink-muted hover:bg-black/5'
            }`}
          >
            {chatSplitOpen ? (
              <PanelLeftClose size={15} />
            ) : (
              <PanelLeft size={15} />
            )}
            <span>{t('app.chatPane')}</span>
          </button>
        )}
        <div data-tauri-drag-region className="flex-1" />
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
              className="flex items-center gap-1.5 rounded-lg bg-sky-100 px-2.5 py-1.5 text-[12px] font-medium text-sky-700 shadow-sm ring-1 ring-sky-200 transition-colors hover:bg-sky-200 disabled:cursor-default disabled:opacity-75"
            >
              {installingUpdate ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              <span>
                {installingUpdate
                  ? t('update.installing')
                  : t('update.available', { version: availableUpdate.version })}
              </span>
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
        <button
          onClick={() => setShowSettings(true)}
          className="no-drag rounded-lg p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('common.settings')}
        >
          <SettingsIcon size={17} />
        </button>
      </div>

      {/* 主区 */}
      <div className="min-h-0 flex-1 px-1.5">
        <div className="relative h-full w-full">
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
                style={leftPane ? { width: chatWidth } : undefined}
                className={`overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5 ${
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
              style={{ left: chatWidth - 4 }}
            >
              <ResizeHandle
                orientation="vertical"
                onResize={(dx) =>
                  setChatWidth((w) =>
                    Math.max(260, Math.min(window.innerWidth - 360, w + dx))
                  )
                }
              />
            </div>
          )}

          {!remoteDataReady && host && view !== 'chat' && view !== 'terminal' && (
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
              style={{ left: chatSplitActive ? chatWidth + 8 : 0 }}
              className={`absolute right-0 top-0 bottom-0 flex flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5 ${
                view === 'terminal'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              {/* 终端标签条:用户的 shell + 「新建终端」按钮放最前(固定好找),
                  agent 自动起的后台任务 tab 放在它们之后,避免把用户的入口挤跑。
                  左侧留出空间给浮动的「对话栏开关」按钮,不被它压住。 */}
              <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-black/8 px-2 py-1.5">
                {shells.map((s) => (
                  <div
                    key={s.id}
                    className={`group flex shrink-0 items-center gap-1 rounded-lg pl-2.5 pr-1 py-1 text-[12px] ${
                      s.id === activeShell
                        ? 'bg-sidebar text-ink'
                        : 'text-ink-muted hover:bg-black/5'
                    }`}
                  >
                    <button onClick={() => setActiveShell(s.id)}>{s.label}</button>
                    <button
                      onClick={() => closeShell(s.id)}
                      className="rounded p-0.5 text-ink-faint hover:bg-black/10 hover:text-ink"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => newShell()}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5"
                  title={t('app.terminal.new')}
                >
                  <Plus size={13} />
                  {t('app.terminal.new')}
                </button>
                {/* agent 后台任务 tab(自动出现/消失,不可手动关——进程结束即移除)。
                    放在用户终端之后,加一条竖分隔线区分。 */}
                {tasks.length > 0 && (
                  <div className="mx-1 h-4 w-px shrink-0 bg-black/10" />
                )}
                {tasks.map((t) => (
                  <button
                    key={`task:${t.pid}`}
                    onClick={() => setActiveShell(`task:${t.pid}`)}
                    className={`flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] ${
                      activeShell === `task:${t.pid}`
                        ? 'bg-sidebar text-ink'
                        : 'text-ink-muted hover:bg-black/5'
                    }`}
                    title={t.args}
                  >
                    <Activity size={12} className="text-emerald-500" />
                    {taskLabel(t.args)}
                  </button>
                ))}
              </div>
              {/* 终端内容 */}
              <div className="relative min-h-0 flex-1">
                {tasks.length === 0 && shells.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-ink-faint">
                    <span>{t('app.taskEmpty')}</span>
                    <span className="text-[11px]">
                      {t('app.taskEmptyHint')}
                    </span>
                    <button
                      onClick={() => newShell()}
                      className="mt-1 flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-2 text-[13px] text-ink hover:bg-black/5"
                    >
                      <Plus size={15} />
                      {t('app.terminal.new')}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* agent 任务输出面板(每个 task 一个,常驻挂载) */}
                    {tasks.map((t) => {
                      const id = `task:${t.pid}`
                      const selected =
                        activeShell === id ||
                        // 没选任何 tab 时默认显示第一个任务
                        (activeShell === '' && tasks[0]?.pid === t.pid)
                      return (
                        <div
                          key={id}
                          className={`absolute inset-0 ${
                            selected ? 'z-10 opacity-100' : 'pointer-events-none opacity-0'
                          }`}
                        >
                          <AgentTaskOutput
                            file={t.file}
                            host={host}
                            active={view === 'terminal' && selected}
                          />
                        </div>
                      )
                    })}
                    {shells.map((s) => (
                      <div
                        key={s.id}
                        className={`absolute inset-0 ${
                          s.id === activeShell
                            ? 'z-10 opacity-100'
                            : 'pointer-events-none opacity-0'
                        }`}
                      >
                        <TerminalView
                          id={s.id}
                          cwd={s.cwd}
                          host={s.host}
                          identity={s.identity}
                        />
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}

          {/* 预览:预热后或访问过即常驻挂载(iframe 状态保留),切回瞬时显示 */}
          {remoteDataReady && (prewarmed || visited.has('preview')) && (
            <div
              style={{ left: chatSplitActive ? chatWidth + 8 : 0 }}
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
          {/* 文件 / Git:预热后或访问过即常驻挂载,切回瞬时显示(不重挂载、不重拉) */}
          {remoteDataReady && (prewarmed || visited.has('files')) && (
            <div
              className={`absolute inset-0 ${
                view === 'files'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <FilesView
                root={cwd}
                onPickRoot={pickRoot}
                onOpenInTerminal={(dir) => newShell(dir)}
                onPreview={openInPreview}
                host={host}
                onDownload={transfers.trackDownload}
              />
            </div>
          )}
          {remoteDataReady && (prewarmed || visited.has('git')) && (
            <div
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
        </div>
      </div>

      {/* screen ⟷ 对话框 的拖拽分隔条:向上拖加高对话框输入区(screen 变矮) */}
      <div className="shrink-0 px-1.5">
        <ResizeHandle
          onResize={(dy) =>
            setChatBoxHeight((h) => Math.max(0, Math.min(360, h - dy)))
          }
        />
      </div>

      {/* 底部对话框:常驻所有视图,始终与「对话」会话通信。
          输入/提交不切换当前视图(想看对话自己点「对话」)。
          对话框居中(max-w-820);右侧空白区浮一个「会话总览侧栏」,
          列出所有机器×项目的 agent 会话(忙/空闲),点击直达——不挤压对话框宽度。 */}
      <div className="relative shrink-0 px-1.5 pb-1.5">
        <div className="mx-auto w-full max-w-[820px]">
          <ChatInput
            onSend={handleSend}
            onForward={handleForward}
            cwd={cwd}
            recentDirs={host && activeConn ? activeConn.recentDirs ?? [] : config.recentDirs}
            onPickDir={handlePickDir}
            remote={!!host}
            onBrowseRemote={pickRoot}
            compact={dockTerminalOpen}
            terminalOpen={dockTerminalOpen}
            extraHeight={chatBoxHeight}
            agentLabel={agentLabel}
            agent={defaultAgent}
            onPatchAgent={patchDefaultAgent}
            onToggleTerminal={() => {
              setDockOpened(true)
              setDockTerminalOpen((o) => !o)
            }}
          />
        </div>
        {/* 会话总览侧栏:在对话框右边缘到屏幕右边之间的「空白区」水平居中。
            左边界 = 居中对话框(max-w-820)的右边缘(中线+410px);该容器铺满到屏幕右边,
            内部 flex 居中放侧栏。与对话框等高(inset-y);窄屏 xl 以下隐藏。一屏约 3 个,超出滚动。 */}
        {railSessions.length > 0 && (
          <div className="pointer-events-none absolute bottom-1.5 right-0 top-0 hidden left-[calc(50%_+_410px)] items-stretch justify-center xl:flex">
            <div className="pointer-events-auto w-[176px] overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
              <SessionRail
                sessions={railSessions}
                activeId={activeChatId}
                onJump={jumpToSession}
              />
            </div>
          </div>
        )}
        {/* 会话历史面板:对话框左侧空白区(与右侧 SessionRail 镜像)。
            只列「当前项目」里该 agent 存的历史会话,可逐个删除防堆积。
            右边界 = 居中对话框(max-w-820)的左边缘(中线-410px);窄屏 xl 以下隐藏。 */}
        {cwd && (
          <div className="pointer-events-none absolute bottom-1.5 right-[calc(50%_+_410px)] top-0 hidden left-0 items-stretch justify-center xl:flex">
            <div className="pointer-events-auto w-[200px] overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5 empty:hidden">
              <SessionHistory
                cwd={cwd}
                provider={defaultAgent?.provider || ''}
                host={host}
                onResume={resumeSession}
              />
            </div>
          </div>
        )}
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
        <div className="absolute inset-0 z-50 bg-sidebar">
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
