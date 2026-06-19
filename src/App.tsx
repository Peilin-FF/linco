import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Eye,
  MessagesSquare,
  TerminalSquare,
  FolderTree,
  GitBranch,
  Settings as SettingsIcon,
  Plus,
  X
} from 'lucide-react'
import ScreenView from './components/ScreenView'
import TerminalView, { type TerminalHandle } from './components/TerminalView'
import ChatInput from './components/ChatInput'
import FilesView from './components/FilesView'
import GitView from './components/GitView'
import Settings from './components/Settings'
import ConnectionPicker, { type ConnState } from './components/ConnectionPicker'
import RemoteDirPicker from './components/RemoteDirPicker'
import CodeMirrorWarmup from './components/CodeMirrorWarmup'
import ResizeHandle from './components/ResizeHandle'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  agentEnv,
  loadConfig,
  saveConfig,
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
import { shadowBeginTurn } from '@/lib/shadow'

type ViewId = 'chat' | 'terminal' | 'preview' | 'files' | 'git'

const VIEWS: { id: ViewId; label: string; icon: typeof Eye }[] = [
  { id: 'chat', label: '对话', icon: MessagesSquare },
  { id: 'terminal', label: '终端', icon: TerminalSquare },
  { id: 'preview', label: '预览', icon: Eye },
  { id: 'files', label: '文件', icon: FolderTree },
  { id: 'git', label: 'Git', icon: GitBranch }
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
}

let shellSeq = 0

export default function App(): JSX.Element {
  const [view, setView] = useState<ViewId>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
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
  const [chatBoxHeight, setChatBoxHeight] = useState(0) // 对话框输入区额外高度(0=默认)

  // 连接状态
  const [connState, setConnState] = useState<ConnState>('idle')
  const [sshHosts, setSshHosts] = useState<string[]>([])
  // 远端目录浏览器(打开时持有初始路径)
  const [remoteBrowse, setRemoteBrowse] = useState<string | null>(null)

  // 对话会话:每连接一个,常驻挂载。chatRefs 按 id 持有句柄,
  // 底部对话框转发到当前活动会话。
  const chatRefs = useRef<Map<string, TerminalHandle>>(new Map())
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([])

  // 独立终端列表(可多开)
  const [shells, setShells] = useState<Shell[]>([])
  const [activeShell, setActiveShell] = useState<string>('')

  // 启动时加载本地配置 + 读取 ssh config 主机
  useEffect(() => {
    loadConfig()
      .then(setConfig)
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


  // 对话会话自动启动 claude/codex
  const initialCommand =
    config?.autoStart && defaultAgent ? defaultAgent.command : undefined

  // —— 每连接一个常驻对话会话 ——
  // 连接身份:'' = 本地 → 'local';远程用 activeConnection id。
  const connId = config?.activeConnection || 'local'
  // 会话 id/key 仅含 connId + cwd:切集群=切到另一个常驻会话(不杀);
  // 换工作目录=该会话按新 cwd 重启(有意);agent/env 不进 key(挂载时读一次)。
  const activeChatId = `chat:${connId}:${cwd ?? ''}`

  // 懒挂载活动会话:不存在则加入(从此**常驻、固化**)。
  // 每个 连接+工作目录 各一个会话(id 含 cwd):切到新项目=新会话(claude 在后台
  // 起,不冻 UI);切回访问过的项目=原会话还在(claude 在对话、终端、渲染态全保留),
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
        command: initialCommand
      }
      return [...prev, next]
    })
    // 仅在活动会话 id 变化时运行(切连接/切项目)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId])

  const handleConfigChange = (next: AppConfig): void => {
    setConfig(next)
    saveConfig(next).catch((e) => console.error('保存配置失败', e))
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
    if (!config) return '配置未就绪'
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
      title: '选择工作目录'
    })
    if (typeof selected === 'string') handlePickDir(selected)
  }

  // 新建独立终端(可指定目录,默认用全局工作目录)。继承当前连接(本地/远程)。
  const newShell = (dir?: string): void => {
    const id = `shell-${++shellSeq}`
    const useDir = dir ?? cwd
    const label = useDir ? useDir.split('/').pop() || `终端 ${shellSeq}` : `终端 ${shellSeq}`
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
  const handleSend = (): void => {
    // 用户发消息 = 新一轮:记 git 基线,之后的改动即"本轮 agent 改动"(Cursor 式 diff)。
    if (cwd) shadowBeginTurn(cwd, host).catch(() => {})
    // 实际写入由 onForward 的兜底重发完成(Ctrl-U + 文本 + 回车)
  }
  const handleForward = (data: string): void => {
    // 转发到当前活动连接的对话会话
    chatRefs.current.get(activeChatId)?.write(data)
  }

  // 配置未加载完成前不渲染
  if (!config) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas text-ink-faint">
        加载中…
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-sidebar font-sans text-ink">
      <CodeMirrorWarmup />
      {/* 顶部:视图切换(为 macOS 红绿灯留出左侧空间) */}
      <div className="drag flex h-11 shrink-0 items-center gap-1 pl-20 pr-3">
        {VIEWS.map(({ id, label, icon: Icon }) => (
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
            <span>{label}</span>
          </button>
        ))}
        <div className="flex-1" />
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
          title="设置"
        >
          <SettingsIcon size={17} />
        </button>
      </div>

      {/* 主区 */}
      <div className="min-h-0 flex-1 px-1.5">
        <div className="relative h-full w-full">
          {/* 对话会话(claude agent):每连接一个,常驻挂载、自动启动。
              切连接=切到另一个常驻会话(不卸载、不重启),切回来还在现场。
              仅当前活动会话在「对话」视图下可见,其余 opacity-0 隐藏挂载。 */}
          {chatSessions.map((s) => (
            <div
              key={s.id}
              className={`absolute inset-0 overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5 ${
                view === 'chat' && s.id === activeChatId
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <TerminalView
                ref={(el) => {
                  if (el) chatRefs.current.set(s.id, el)
                  else chatRefs.current.delete(s.id)
                }}
                id={s.id}
                cwd={s.cwd}
                env={s.env}
                initialCommand={s.command}
                host={s.host}
                identity={s.identity}
              />
            </div>
          ))}

          {!remoteDataReady && host && view !== 'chat' && view !== 'terminal' && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-canvas text-[13px] text-ink-faint shadow-card ring-1 ring-black/5">
              正在连接远端…
            </div>
          )}

          {/* 终端视图:独立 shell,可多开 */}
          {view === 'terminal' && (
            <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
              {/* 终端标签条 */}
              <div className="flex shrink-0 items-center gap-1 border-b border-black/8 px-2 py-1.5">
                {shells.map((s) => (
                  <div
                    key={s.id}
                    className={`group flex items-center gap-1 rounded-lg pl-2.5 pr-1 py-1 text-[12px] ${
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
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5"
                  title="新建终端"
                >
                  <Plus size={13} />
                  新建终端
                </button>
              </div>
              {/* 终端内容:每个 shell 常驻挂载,用显隐切换 */}
              <div className="relative min-h-0 flex-1">
                {shells.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <button
                      onClick={() => newShell()}
                      className="flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-2 text-[13px] text-ink hover:bg-black/5"
                    >
                      <Plus size={15} />
                      新建终端
                    </button>
                  </div>
                ) : (
                  shells.map((s) => (
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
                  ))
                )}
              </div>
            </div>
          )}

          {/* 预览:预热后或访问过即常驻挂载(iframe 状态保留),切回瞬时显示 */}
          {remoteDataReady && (prewarmed || visited.has('preview')) && (
            <div
              className={`absolute inset-0 ${
                view === 'preview'
                  ? 'z-10 opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
            >
              <ScreenView
                host={host}
                cwd={cwd}
                previewPath={previewPath}
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
              <GitView repo={cwd} onPickRoot={pickRoot} host={host} />
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
          输入/提交不切换当前视图(想看对话自己点「对话」)。 */}
      <div className="shrink-0 px-1.5 pb-1.5">
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
            commandBase={defaultAgent?.command}
            host={host}
            onToggleTerminal={() => {
              setDockOpened(true)
              setDockTerminalOpen((o) => !o)
            }}
          />
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
                终端{host ? ` · ${host}` : ''}
              </span>
              <button
                onClick={() => setDockTerminalOpen(false)}
                className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
                title="关闭终端"
              >
                <X size={14} />
              </button>
            </div>
            <TerminalView
              id="dock"
              cwd={cwd}
              host={host}
              identity={activeConn?.identity || undefined}
            />
          </div>
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
