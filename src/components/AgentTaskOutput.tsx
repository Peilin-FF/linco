import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tailFile } from '@/lib/procs'
import { useI18n } from '@/lib/i18n'
import { observeTheme, terminalTheme } from '@/lib/theme'

interface Props {
  // 输出文件路径(agent 后台任务的 stdout 落盘文件)
  file: string
  host?: string
  // 仅可见时轮询(tab 选中)
  active: boolean
  // 任务已退出(进程不在了)——仍展示最后的 log,顶部标注
  exited?: boolean
}

const TAIL_MS = 1000

/// agent 后台任务的实时输出面板:每秒增量 tail 输出文件,写进 xterm.js 渲染。
/// 用真终端模拟器(而非 <pre>)的关键原因:训练/评测的 tqdm 进度条用 \r 原地刷新、
/// 带 ANSI 颜色;xterm 能正确处理这些控制序列(进度条原地更新而不是横向堆叠),
/// 普通 <pre> 会把每次 \r 刷新的内容堆在一行 → 横向滚动(本次修复的问题)。
/// 只读:不接受键盘输入,纯展示。
export default function AgentTaskOutput({
  file,
  host,
  active,
  exited
}: Props): JSX.Element {
  const { t } = useI18n()
  const wrapRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const offsetRef = useRef(0)

  // 挂载 xterm(一次)
  useEffect(() => {
    if (!wrapRef.current) return
    const term = new Terminal({
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace',
      convertEol: true, // 把 \n 当作 \r\n,日志按行正常换行
      disableStdin: true, // 只读,不收键盘
      cursorStyle: 'underline',
      cursorBlink: false,
      minimumContrastRatio: 7,
      scrollback: 5000,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(wrapRef.current)
    try {
      fit.fit()
    } catch {
      /* 容器尺寸未就绪 */
    }
    termRef.current = term
    fitRef.current = fit
    const stopObservingTheme = observeTheme(() => {
      term.options.theme = terminalTheme()
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* 忽略 */
      }
    })
    ro.observe(wrapRef.current)

    return () => {
      ro.disconnect()
      stopObservingTheme()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // 切换文件:清屏 + 重置 offset(切到另一个任务的输出)
  useEffect(() => {
    offsetRef.current = 0
    termRef.current?.clear()
    termRef.current?.reset()
  }, [file, host])

  // 增量 tail → 写进 xterm(xterm 自己处理 \r / ANSI,tqdm 进度条原地刷新)
  useEffect(() => {
    if (!active || !file) return
    let stop = false
    const pull = async (): Promise<void> => {
      try {
        const chunk = await tailFile(file, offsetRef.current, host)
        if (stop) return
        if (chunk.data && termRef.current) {
          termRef.current.write(chunk.data)
        }
        offsetRef.current = chunk.size
      } catch {
        // 文件暂不可读:静默重试
      }
    }
    void pull()
    const t = window.setInterval(() => void pull(), TAIL_MS)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [file, host, active])

  // 变可见时重新 fit(隐藏时容器尺寸为 0,切回来要重算)
  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit()
      } catch {
        /* 忽略 */
      }
    }
  }, [active])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1 text-[11px] text-ink-faint">
        <span className="truncate font-mono" title={file}>
          {file}
        </span>
        {exited && <span className="ml-auto text-amber-400/80">{t('task.exited')}</span>}
      </div>
      <div ref={wrapRef} className="min-h-0 flex-1 overflow-hidden px-1 py-1" />
    </div>
  )
}
