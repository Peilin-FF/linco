import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RotateCw } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import {
  onTermExit,
  onTermOutput,
  termKill,
  termResize,
  termStart,
  termWrite
} from '@/lib/terminal'
import {
  usageIngestTerminalOutput,
  type UsageAgentContext
} from '@/lib/usage'
import { useI18n } from '@/lib/i18n'
import type { UnlistenFn } from '@tauri-apps/api/event'

// 跟随系统深浅色:深色模式下 claude 等 TUI 会用深色背景的 ANSI 块,
// 终端背景也必须深,否则块与白底对不齐,出现大片空白(本次修复的问题)。
function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
}

function termTheme(dark: boolean): Record<string, string> {
  if (dark) {
    return {
      background: '#1e1e1e',
      foreground: '#e4e4e4',
      cursor: '#e4e4e4',
      cursorAccent: '#1e1e1e',
      selectionBackground: 'rgba(255,255,255,0.18)',
      black: '#1e1e1e',
      red: '#f47067',
      green: '#57ab5a',
      yellow: '#c69026',
      blue: '#539bf5',
      magenta: '#b083f0',
      cyan: '#39c5cf',
      white: '#d1d5da',
      brightBlack: '#6e7681'
    }
  }
  return {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#1a1a1a',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0,0,0,0.10)',
    black: '#1f1f1f',
    red: '#c0392b',
    green: '#27894e',
    yellow: '#b8860b',
    blue: '#2563eb',
    magenta: '#8b5cf6',
    cyan: '#0e7490',
    white: '#3f3f3f',
    brightBlack: '#9a9a9a'
  }
}

export interface TerminalHandle {
  /** 把文本写入终端并回车(整体发送)。 */
  send: (text: string) => void
  /** 写入原始字节到 PTY(实时转发用,不自动加回车)。 */
  write: (data: string) => void
  focus: () => void
}

interface TerminalViewProps {
  id: string
  cwd?: string
  env?: Record<string, string>
  /** PTY 起来后自动执行的命令(如 `claude`) */
  initialCommand?: string
  /** 远程主机(user@ip 或 ssh config 别名);空=本地 */
  host?: string
  identity?: string
  /** 每次该会话有 PTY 输出时回调(供会话总览侧栏判忙/空闲) */
  onActivity?: (id: string) => void
  /** 会话退出(PTY 结束)时回调 */
  onExit?: (id: string) => void
  /** 对话 agent 会话的使用统计上下文;普通终端不传。 */
  usage?: UsageAgentContext
}

const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  function TerminalView(
    { id, cwd, env, initialCommand, host, identity, onActivity, onExit, usage },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const { t } = useI18n()
    // t 用 ref 持有,供 effect 闭包读最新(语言切换后终端内提示也用新语言)
    const tRef = useRef(t)
    tRef.current = t
    // 断线后显示「重连」覆盖层
    const [exited, setExited] = useState(false)
    // 重连用:持有重启 PTY 会话的函数(由 effect 内赋值)
    const restartRef = useRef<(() => void) | null>(null)
    // cwd / env / initialCommand 只在启动时读取一次,用 ref 持有,
    // 避免 prop 身份变化触发终端重挂载(切换全局目录不应重启已开的终端)。
    const cwdRef = useRef(cwd)
    const envRef = useRef(env)
    const initCmdRef = useRef(initialCommand)
    const hostRef2 = useRef(host)
    const identityRef = useRef(identity)
    // 回调用 ref 持有,避免父组件每次重渲染传新函数触发终端重挂载。
    const onActivityRef = useRef(onActivity)
    const onExitRef = useRef(onExit)
    const usageRef = useRef(usage)
    const usageBufferRef = useRef('')
    const usageTimerRef = useRef<number | null>(null)
    const decoderRef = useRef(new TextDecoder())
    hostRef2.current = host
    identityRef.current = identity
    cwdRef.current = cwd
    envRef.current = env
    initCmdRef.current = initialCommand
    onActivityRef.current = onActivity
    onExitRef.current = onExit
    usageRef.current = usage

    useImperativeHandle(ref, () => ({
      send: (text: string) => {
        // 写入文本并以回车提交,等价于在终端输入命令
        termWrite(id, text.endsWith('\n') ? text : text + '\r')
      },
      write: (data: string) => {
        // 原始转发(逐字符同步)
        termWrite(id, data)
      },
      focus: () => termRef.current?.focus()
    }))

    const flushUsageOutput = (): void => {
      const usage = usageRef.current
      const text = usageBufferRef.current
      usageBufferRef.current = ''
      usageTimerRef.current = null
      if (!usage || !text.trim()) return
      usageIngestTerminalOutput({ ...usage, sessionId: id }, text).catch(() => {})
    }

    useEffect(() => {
      const host = hostRef.current
      if (!host) return

      const term = new Terminal({
        fontFamily:
          '"SF Mono", "JetBrains Mono", Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: 13.5,
        lineHeight: 1.35,
        letterSpacing: 0.2,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        theme: termTheme(prefersDark()),
        allowProposedApi: true
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      // 让 host 内边距区域也跟随终端背景,避免深色下出现白边框
      host.style.background = termTheme(prefersDark()).background
      fit.fit()
      termRef.current = term
      fitRef.current = fit

      let unlistenOut: UnlistenFn | undefined
      let unlistenExit: UnlistenFn | undefined
      let disposed = false

      // 用户在终端里键入 → 写回 PTY
      const dataSub = term.onData((d) => termWrite(id, d))

      // 启动(或重启)PTY 会话:重连时复用同一函数。
      let started = false // 会话建好前不发 resize(减少无谓调用)
      const start = (): void => {
        setExited(false)
        void termStart(id, term.cols, term.rows, {
          cwd: cwdRef.current,
          env: envRef.current,
          initialCommand: initCmdRef.current,
          host: hostRef2.current,
          identity: identityRef.current
        }).then(() => {
          started = true
          term.focus()
        })
      }
      restartRef.current = () => {
        if (disposed) return
        term.write(`\r\n\x1b[90m[${tRef.current('term.reconnecting')}]\x1b[0m\r\n`)
        start()
      }

      // 订阅输出 + 退出(断线/进程结束 → 显示「重连」覆盖层)
      ;(async () => {
        unlistenOut = await onTermOutput(id, (bytes) => {
          if (!disposed) {
            term.write(bytes)
            const usage = usageRef.current
            if (usage) {
              usageBufferRef.current += decoderRef.current.decode(bytes, { stream: true })
              if (usageBufferRef.current.length > 5000) {
                if (usageTimerRef.current !== null) {
                  window.clearTimeout(usageTimerRef.current)
                }
                flushUsageOutput()
              } else if (usageTimerRef.current === null) {
                usageTimerRef.current = window.setTimeout(flushUsageOutput, 900)
              }
            }
            onActivityRef.current?.(id) // 上报活动 → 侧栏判忙/空闲
          }
        })
        unlistenExit = await onTermExit(id, () => {
          if (!disposed) {
            term.write(`\r\n\x1b[90m[${tRef.current('term.disconnected')}]\x1b[0m\r\n`)
            setExited(true)
            onExitRef.current?.(id)
          }
        })
        start()
      })()

      // 尺寸自适应:容器变化时 fit + 同步 PTY(会话建好后才发 resize)
      const ro = new ResizeObserver(() => {
        try {
          fit.fit()
          if (started) termResize(id, term.cols, term.rows)
        } catch {
          /* 容器临时为 0 时忽略 */
        }
      })
      ro.observe(host)

      // 监听系统深浅色切换 → 实时更新终端主题
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      const onScheme = (): void => {
        term.options.theme = termTheme(mql.matches)
        host.style.background = termTheme(mql.matches).background
      }
      mql.addEventListener?.('change', onScheme)

      return () => {
        disposed = true
        ro.disconnect()
        mql.removeEventListener?.('change', onScheme)
        dataSub.dispose()
        if (usageTimerRef.current !== null) {
          window.clearTimeout(usageTimerRef.current)
        }
        flushUsageOutput()
        unlistenOut?.()
        unlistenExit?.()
        termKill(id)
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
      // 仅按 id 创建会话:同一终端实例不因 cwd/env 变化而重启
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id])

    return (
      <div className="relative h-full w-full">
        <div ref={hostRef} className="h-full w-full px-3 pt-2" />
        {exited && (
          <div className="pointer-events-none absolute right-2.5 top-2 flex justify-end">
            <button
              onClick={() => restartRef.current?.()}
              title={t('term.reconnect')}
              className="pointer-events-auto flex items-center gap-1 rounded-md bg-black/5 px-2 py-1 text-[11px] text-ink-muted ring-1 ring-black/10 hover:bg-black/10 hover:text-ink"
            >
              <RotateCw size={12} />
              {t('term.reconnectBtn')}
            </button>
          </div>
        )}
      </div>
    )
  }
)

export default TerminalView
