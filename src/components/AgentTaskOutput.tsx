import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Minus, Plus, Search, WrapText } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tailFile } from '@/lib/procs'
import { useI18n } from '@/lib/i18n'
import { observeTheme, terminalTheme } from '@/lib/theme'
import { isLogHighlight, logBufferLines, logLevel, type LogLevel } from '@/lib/logHighlights'
import { outputSpans } from '@/lib/terminalHighlights'

interface Props {
  // 输出文件路径(agent 后台任务的 stdout 落盘文件)
  file: string
  // 命令行(没拿到输出文件时至少告诉用户后台在跑什么)
  args?: string
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
  args,
  host,
  active,
  exited
}: Props): JSX.Element {
  const { t } = useI18n()
  const wrapRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const offsetRef = useRef(0)
  const generationRef = useRef(0)
  const captureRef = useRef<() => void>(() => {})
  const readerRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<string[]>([])
  const [raw, setRaw] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'highlights' | 'error' | 'warning'>('all')
  const [wrap, setWrap] = useState(true)
  const [follow, setFollow] = useState(true)
  const [fontSize, setFontSize] = useState(() => {
    try { const saved = Number(localStorage.getItem('linco:log-font-size')); return saved >= 11 && saved <= 18 ? saved : 13 } catch { return 13 }
  })
  // 最近一次 tail 的错误(文件被删/暂不可读);成功后清空。以前静默吞掉 → 面板空白无解释。
  const [tailError, setTailError] = useState('')

  // 挂载 xterm(一次)
  useEffect(() => {
    if (!wrapRef.current) return
    const term = new Terminal({
      fontSize,
      fontFamily:
        '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
      lineHeight: 1.55,
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
    captureRef.current = () => setLines(logBufferLines(term.buffer.active))
    let disposed = false
    void document.fonts.load('13px "JetBrains Mono"').then(() => {
      if (!disposed) { fit.fit(); captureRef.current() }
    }).catch(() => {})
    const stopObservingTheme = observeTheme(() => {
      term.options.theme = terminalTheme()
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        captureRef.current()
      } catch {
        /* 忽略 */
      }
    })
    ro.observe(wrapRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      stopObservingTheme()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      captureRef.current = () => {}
    }
  }, [])

  // 切换文件:清屏 + 重置 offset(切到另一个任务的输出)
  useEffect(() => {
    generationRef.current++
    offsetRef.current = 0
    setTailError('')
    setLines([])
    setFollow(true)
    termRef.current?.clear()
    termRef.current?.reset()
  }, [file, host])

  // 增量 tail → 写进 xterm(xterm 自己处理 \r / ANSI,tqdm 进度条原地刷新)
  useEffect(() => {
    if (!active || !file) return
    let stop = false
    let timer: number | undefined
    const generation = generationRef.current
    const pull = async (): Promise<void> => {
      try {
        const chunk = await tailFile(file, offsetRef.current, host)
        if (stop) return
        // 文件被截断/重写(后端从头返回)→ 清屏再写,避免旧内容重复堆叠
        if (chunk.start < offsetRef.current && offsetRef.current > 0) {
          termRef.current?.clear()
          termRef.current?.reset()
        }
        if (chunk.data && termRef.current) {
          termRef.current.write(chunk.data, () => {
            if (generation === generationRef.current) captureRef.current()
          })
        }
        // 用本次实际读到的末尾作下次 offset(后端单次最多返回 256KB;直接用 size 会跳过中间内容)
        const read = chunk.start + new TextEncoder().encode(chunk.data).length
        offsetRef.current = Math.min(read, chunk.size)
        setTailError('')
      } catch (e) {
        if (!stop) setTailError(String(e))
      } finally {
        if (!stop) timer = window.setTimeout(() => void pull(), TAIL_MS)
      }
    }
    void pull()
    return () => {
      stop = true
      window.clearTimeout(timer)
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
  }, [active, raw])

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize
    try { fitRef.current?.fit(); captureRef.current() } catch { /* Hidden tab. */ }
    try { localStorage.setItem('linco:log-font-size', String(fontSize)) } catch { /* Optional preference. */ }
  }, [fontSize])

  const annotated = useMemo(() => lines.map((text, index) => ({ text, index, level: logLevel(text) })), [lines])
  const counts = useMemo(() => ({
    error: annotated.filter((line) => line.level === 'error').length,
    warning: annotated.filter((line) => line.level === 'warning').length,
  }), [annotated])
  const visibleLines = useMemo(() => annotated.filter((line) => {
    const matches = filter === 'all' || (filter === 'highlights' ? isLogHighlight(line.level) : line.level === filter)
    return matches && line.text.toLowerCase().includes(query.toLowerCase())
  }), [annotated, filter, query])

  useEffect(() => {
    if (active && follow && !raw && readerRef.current) readerRef.current.scrollTop = readerRef.current.scrollHeight
  }, [active, follow, raw, visibleLines])

  return (
    <div className="task-log-view flex h-full flex-col bg-canvas text-ink">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1 text-[11px] text-ink-faint">
        <span className="truncate font-mono" title={file || args}>
          {file || args}
        </span>
        {tailError && (
          <span className="truncate text-warning" title={tailError}>
            {t('task.tailError')}
          </span>
        )}
        {exited && <span className="ml-auto shrink-0 text-warning">{t('task.exited')}</span>}
      </div>
      {file && <div className="log-toolbar" aria-label={t('task.logTools')}>
        <div className="log-filters" aria-label={t('task.filter')}>
          {(['all', 'highlights', 'error', 'warning'] as const).map((value) => <button key={value} disabled={raw} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {t(`task.filter.${value}`)}{(value === 'error' || value === 'warning') && <span className={`log-count log-${value}`}>{counts[value]}</span>}
          </button>)}
        </div>
        <label className="log-search"><Search size={13} /><input aria-label={t('task.search')} placeholder={t('task.search')} value={query} disabled={raw} onChange={(e) => setQuery(e.target.value)} /></label>
        <button className="icon-button" aria-label={t('task.fontSmaller')} title={t('task.fontSmaller')} disabled={fontSize <= 11} onClick={() => setFontSize((size) => size - 1)}><Minus size={13} /></button>
        <span className="log-font-size">{fontSize}</span>
        <button className="icon-button" aria-label={t('task.fontLarger')} title={t('task.fontLarger')} disabled={fontSize >= 18} onClick={() => setFontSize((size) => size + 1)}><Plus size={13} /></button>
        <button className="icon-button" aria-label={t('task.wrap')} title={t('task.wrap')} aria-pressed={wrap} disabled={raw} onClick={() => setWrap((value) => !value)}><WrapText size={14} /></button>
        <button aria-pressed={raw} onClick={() => setRaw((value) => !value)}>{t('task.raw')}</button>
        <button className="log-follow" disabled={raw} aria-pressed={follow} onClick={() => setFollow((value) => !value)}><ArrowDownToLine size={13} />{t('task.follow')}</button>
      </div>}
      {!file && (
        <div className="shrink-0 border-b border-black/8 px-3 py-2 text-[12px] text-ink-muted">
          <div className="font-mono text-ink">{args}</div>
          <div className="mt-1 text-ink-faint">{t('task.noFileHint')}</div>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* Keep the terminal mounted and sized in both views: it interprets ANSI
            and progress rewrites, and preserves the unfiltered raw output. */}
        <div ref={wrapRef} className="agent-task-output absolute inset-0 overflow-hidden" aria-hidden={!raw} style={{ visibility: raw ? 'visible' : 'hidden' }} />
        {!raw && <div ref={readerRef} className={`log-reader ${wrap ? 'is-wrapped' : ''}`} style={{ fontSize }} aria-label={t('task.readingView')} tabIndex={0} onScroll={(event) => {
          const node = event.currentTarget
          setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 32)
        }}>
          {visibleLines.length ? visibleLines.map((line) => <LogRow key={line.index} text={line.text} index={line.index} level={line.level} query={query} />)
            : <p className="log-empty">{t(lines.length ? 'task.noMatches' : 'task.waiting')}</p>}
        </div>}
      </div>
      {file && <div className="log-footer"><span>{t('task.loadedLines', { n: lines.length })}</span><span>{t('task.highlightHint')}</span></div>}
    </div>
  )
}

const LogRow = memo(function LogRow({ text, index, level, query }: { text: string; index: number; level: LogLevel; query: string }): JSX.Element {
  const spans = outputSpans(text)
  const colored = (start: number, end: number): (string | JSX.Element)[] => {
    const boundaries = [...new Set([start, end, ...spans.flatMap(span => [span.start, span.end]).filter(at => at > start && at < end)])].sort((a, b) => a - b)
    return boundaries.slice(0, -1).map((at, i) => {
      const tone = spans.filter(span => span.start <= at && span.end > at).at(-1)?.tone
      const value = text.slice(at, boundaries[i + 1])
      return tone ? <span key={at} className={`output-token output-${tone}`}>{value}</span> : value
    })
  }
  const parts: (string | JSX.Element)[] = []
  let from = 0
  if (query) {
    const source = text.toLowerCase()
    const match = query.toLowerCase()
    let at = source.indexOf(match)
    while (at !== -1) {
      parts.push(...colored(from, at), <mark key={`match-${at}`}>{text.slice(at, at + query.length)}</mark>)
      from = at + query.length
      at = source.indexOf(match, from)
    }
  }
  parts.push(...colored(from, text.length))
  if (!text) parts.push('\u00a0')
  return <div className={`log-line log-${level}`} data-log-level={level}>
    <span className="log-line-number" aria-hidden="true">{index + 1}</span>
    <span className="log-line-text">{parts}</span>
  </div>
})
