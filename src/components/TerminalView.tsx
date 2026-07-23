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
import {
  readText as clipReadText,
  writeText as clipWriteText
} from '@tauri-apps/plugin-clipboard-manager'
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
function termTheme(): Record<string, string> {
  return {
    background: '#1e1e1e',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
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
    brightBlack: '#8b949e',
    brightRed: '#ff7b72',
    brightGreen: '#7ee787',
    brightYellow: '#d29922',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#ffffff'
  }
}

export interface TerminalHandle {
  /** 把文本写入终端并回车(整体发送)。 */
  send: (text: string) => void
  /** 写入原始字节到 PTY(实时转发用,不自动加回车)。 */
  write: (data: string) => void
  /** 杀掉当前 PTY 并用新命令重启会话(用于「恢复历史会话」)。 */
  restartWith: (command: string) => void
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
    const restartRef = useRef<((silent?: boolean) => void) | null>(null)
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
    const outputQueueRef = useRef<Uint8Array[]>([])
    const outputFrameRef = useRef<number | null>(null)
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
      restartWith: (command: string) => {
        // 用新命令重启:更新初始命令 ref,再走 effect 内的重启逻辑
        // (start() 读取 initCmdRef.current,termStart 会先杀掉同 id 旧 PTY)。
        initCmdRef.current = command
        termRef.current?.write(
          `\r\n\x1b[90m[${tRef.current('history.resuming')}]\x1b[0m\r\n`
        )
        restartRef.current?.(true)
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
        theme: termTheme(),
        allowProposedApi: true
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      // xterm 6 不再替应用设置根节点高度。没有这两行时内部 rows 虽然
      // 已经渲染,但 .xterm 本身是 0px 高,Windows WebView2 最终只显示背景。
      if (term.element) {
        term.element.style.width = '100%'
        term.element.style.height = '100%'
      }
      // 让 host 内边距区域也跟随终端背景,避免深色下出现白边框
      host.style.background = termTheme().background
      fit.fit()
      termRef.current = term
      fitRef.current = fit

      let unlistenOut: UnlistenFn | undefined
      let unlistenExit: UnlistenFn | undefined
      let disposed = false
      let activeGen: number | null = null
      let startSequence = 0
      type StartupEvent =
        | { kind: 'output'; gen: number; bytes: Uint8Array }
        | { kind: 'exit'; gen: number }
      let startupEvents: StartupEvent[] = []

      const flushTerminalOutput = (): void => {
        outputFrameRef.current = null
        const chunks = outputQueueRef.current
        outputQueueRef.current = []
        if (disposed || chunks.length === 0) return

        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }

        term.write(bytes)
        const usage = usageRef.current
        if (usage) {
          usageBufferRef.current += decoderRef.current.decode(bytes, { stream: true })
            if (usageBufferRef.current.length > 5000) {
              const timer = usageTimerRef.current
              window.clearTimeout(timer ?? undefined)
              flushUsageOutput()
            } else if (usageTimerRef.current === null) {
            usageTimerRef.current = window.setTimeout(flushUsageOutput, 900)
          }
        }
        onActivityRef.current?.(id)
      }

      const enqueueTerminalOutput = (bytes: Uint8Array): void => {
        outputQueueRef.current.push(bytes)
        if (outputFrameRef.current === null) {
          outputFrameRef.current = window.requestAnimationFrame(flushTerminalOutput)
        }
      }

      const showExit = (): void => {
        if (disposed) return
        started = false
        term.write(`\r\n\x1b[90m[${tRef.current('term.disconnected')}]\x1b[0m\r\n`)
        setExited(true)
        onExitRef.current?.(id)
      }

      const bufferStartupEvent = (event: StartupEvent): void => {
        // term_start 的返回值和 PTY 输出走不同 IPC 通道。Windows 上首屏输出
        // 经常先到,先保留并在拿到 gen 后只回放当前会话的数据。
        if (startupEvents.length >= 256) startupEvents.shift()
        startupEvents.push(event)
      }

      // 用户在终端里键入 → 写回 PTY
      const dataSub = term.onData((d) => termWrite(id, d))

      // 复制/粘贴键处理(尤其 Windows:Ctrl+C/V 默认不是复制粘贴)。
      // 平台区分:macOS 用 Cmd(metaKey),Ctrl+C 保持 SIGINT 中断不动;
      // Windows/Linux 用 Ctrl,且仅在「有选中」时 Ctrl+C 才复制(无选中=中断)。
      // 剪贴板走 Tauri 原生插件(WebView2 里 navigator.clipboard 常因安全上下文失效),
      // 失败再退回浏览器 API。
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const copyText = (text: string): void => {
        clipWriteText(text).catch(() => {
          void navigator.clipboard?.writeText(text).catch(() => {})
        })
      }
      const pasteText = (): void => {
        clipReadText()
          .catch(() => navigator.clipboard?.readText?.() ?? '')
          .then((text) => {
            if (text) termWrite(id, text.replace(/\r?\n/g, '\r'))
          })
          .catch(() => {})
      }
      const onKeyDownCapture = (e: KeyboardEvent): void => {
        const mod = isMac ? e.metaKey : e.ctrlKey
        if (!mod) return

        const key = e.key.toLowerCase()
        if (key === 'v') {
          e.preventDefault()
          e.stopImmediatePropagation()
          pasteText()
        } else if (key === 'c' && term.hasSelection()) {
          e.preventDefault()
          e.stopImmediatePropagation()
          copyText(term.getSelection())
          term.clearSelection()
        }
      }
      host.addEventListener('keydown', onKeyDownCapture, true)
      // 粘贴一律放行,交给 xterm 自带的粘贴(浏览器 paste 事件 → onData)→ 天然单次。
      // 历史坑:之前 Windows 分支额外手动 term.paste() 又 return false,以为能拦掉 xterm,
      // 但 return false 并不会 preventDefault,浏览器原生 paste 事件照样触发 → xterm 也粘一次,
      // 于是粘两次(`npm install...npm install...`)。WebView2 的原生 paste 事件本就拿得到
      // 剪贴板内容(无需 navigator.clipboard),所以全平台放行即可,不要再手动插一脚。
      term.attachCustomKeyEventHandler((e): boolean => {
        if (e.type !== 'keydown') return true
        // 复制/粘贴的修饰键:mac=Cmd,其它=Ctrl
        const mod = isMac ? e.metaKey : e.ctrlKey
        if (!mod) return true
        const key = e.key.toLowerCase()
        if (key === 'c') {
          const sel = term.getSelection()
          if (sel && sel.length > 0) {
            copyText(sel)
            term.clearSelection()
            return false // 已复制,不再发 \x03
          }
          return true // 无选中:放行(Ctrl+C=中断)
        }
        // v(粘贴):放行交给 xterm 自带粘贴,单次不重复(见上方注释)。
        return true
      })

      // Keep Codex wheel input inside xterm's normal scrollback. Forwarding the
      // wheel to Codex opens its transcript pager, which steals keyboard focus
      // until the user presses q. Codex is launched with --no-alt-screen, so
      // xterm owns the transcript and can scroll it directly.
      let wheelRemainder = 0
      term.attachCustomWheelEventHandler((event): boolean => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.deltaY === 0) {
          return true
        }

        const commandName = initCmdRef.current
          ?.trim()
          .split(/\s+/)[0]
          ?.replace(/\\/g, '/')
          .split('/')
          .pop()
          ?.toLowerCase()
        const isCodex =
          usageRef.current?.provider === 'openai' ||
          commandName === 'codex' ||
          commandName === 'codex.exe'
        if (!isCodex) return true

        const lineHeight =
          Number(term.options.fontSize ?? 13.5) * Number(term.options.lineHeight ?? 1)
        let deltaPixels = event.deltaY
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          deltaPixels *= lineHeight
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          deltaPixels *= lineHeight * term.rows
        }
        wheelRemainder += deltaPixels
        const rawLines = Math.trunc(wheelRemainder / lineHeight)

        event.preventDefault()
        event.stopPropagation()
        if (rawLines === 0) return false

        wheelRemainder -= rawLines * lineHeight
        const lineCount = Math.min(Math.abs(rawLines), 6)
        term.scrollLines(rawLines < 0 ? -lineCount : lineCount)
        return false
      })

      // 启动(或重启)PTY 会话:重连时复用同一函数。
      let started = false // 会话建好前不发 resize(减少无谓调用)
      const start = (): void => {
        const sequence = ++startSequence
        setExited(false)
        started = false
        activeGen = null
        startupEvents = []
        void termStart(id, term.cols, term.rows, {
          cwd: cwdRef.current,
          env: envRef.current,
          initialCommand: initCmdRef.current,
          host: hostRef2.current,
          identity: identityRef.current
        })
          .then((gen) => {
            if (disposed || sequence !== startSequence) {
              void termKill(id, gen)
              return
            }

            activeGen = gen
            started = true
            const buffered = startupEvents
            startupEvents = []
            for (const event of buffered) {
              if (event.gen !== gen) continue
              if (event.kind === 'output') enqueueTerminalOutput(event.bytes)
              else showExit()
            }
            term.focus()
          })
          .catch((e) => {
            if (disposed || sequence !== startSequence) return
            startupEvents = []
            term.write(`\r\n\x1b[31m[${String(e)}]\x1b[0m\r\n`)
            setExited(true)
            onExitRef.current?.(id)
          })
      }
      restartRef.current = (silent?: boolean) => {
        if (disposed) return
        if (!silent) {
          term.write(`\r\n\x1b[90m[${tRef.current('term.reconnecting')}]\x1b[0m\r\n`)
        }
        start()
      }

      // 订阅输出 + 退出(断线/进程结束 → 显示「重连」覆盖层)
      ;(async () => {
        const stopOutput = await onTermOutput(id, (bytes, gen) => {
          if (disposed) return
          if (activeGen === null) {
            bufferStartupEvent({ kind: 'output', gen, bytes })
          } else if (gen === activeGen) {
            enqueueTerminalOutput(bytes)
          }
        })
        if (disposed) {
          stopOutput()
          return
        }
        unlistenOut = stopOutput

        const stopExit = await onTermExit(id, (gen) => {
          if (disposed) return
          if (activeGen === null) {
            bufferStartupEvent({ kind: 'exit', gen })
          } else if (gen === activeGen) {
            showExit()
          }
        })
        if (disposed) {
          stopExit()
          unlistenOut?.()
          unlistenOut = undefined
          return
        }
        unlistenExit = stopExit
        start()
      })().catch((e) => {
        if (disposed) return
        term.write(`\r\n\x1b[31m[${String(e)}]\x1b[0m\r\n`)
        setExited(true)
        onExitRef.current?.(id)
      })

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
        term.options.theme = termTheme()
        host.style.background = termTheme().background
      }
      mql.addEventListener?.('change', onScheme)

      return () => {
        disposed = true
        startSequence += 1
        const gen = activeGen
        activeGen = null
        startupEvents = []
        ro.disconnect()
        mql.removeEventListener?.('change', onScheme)
        host.removeEventListener('keydown', onKeyDownCapture, true)
        dataSub.dispose()
        const timer = usageTimerRef.current
        window.clearTimeout(timer ?? undefined)
        if (outputFrameRef.current !== null) {
          const frame = outputFrameRef.current
          window.cancelAnimationFrame(frame)
          outputFrameRef.current = null
        }
        outputQueueRef.current = []
        flushUsageOutput()
        unlistenOut?.()
        unlistenExit?.()
        if (gen !== null) void termKill(id, gen)
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
