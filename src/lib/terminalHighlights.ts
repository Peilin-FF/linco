import type { IDisposable, Terminal } from '@xterm/xterm'
import { logLevel } from './logHighlights'
import { currentTheme, observeTheme, type Theme } from './theme'

export type OutputTone = 'error' | 'warning' | 'success' | 'metric' | 'debug' | 'number' | 'label' | 'time'
export interface OutputSpan { start: number; end: number; tone: OutputTone }

/** Presentation hints only: never modify bytes sent to or received from a PTY. */
export function outputSpans(text: string): OutputSpan[] {
  const level = logLevel(text)
  const spans: OutputSpan[] = []
  if (level !== 'plain' && level !== 'section') spans.push({ start: 0, end: text.length, tone: level })
  if (level === 'error' || level === 'warning') return spans
  const tokens = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?|\b[A-Za-z_][\w./-]*(?=\s*[:=])|(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?:%|GiB|MiB|KiB|GB|MB|KB|ms|us|ns|s|Hz|MHz)?(?![\w.])/g
  for (const match of text.matchAll(tokens)) {
    const value = match[0]
    const tone = /^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}:\d{2}/.test(value) ? 'time' : /^[A-Za-z_]/.test(value) ? 'label' : 'number'
    spans.push({ start: match.index!, end: match.index! + value.length, tone })
  }
  return spans
}

export function outputPalette(dark: boolean, theme?: Theme): Record<OutputTone, string> {
  if (theme?.ansi) return {
    error: theme.vars.error, warning: theme.vars.warning, success: theme.vars.diffAddedForeground,
    metric: theme.vars.link, debug: theme.vars.inkFaint, number: theme.syntax.number,
    label: theme.vars.link, time: theme.vars.inkMuted
  }
  return dark
    ? { error: '#ff8585', warning: '#e8bc70', success: '#80cba4', metric: '#83baff', debug: '#969fae', number: '#c2a0ee', label: '#83baff', time: '#a2aebd' }
    : { error: '#b42332', warning: '#946000', success: '#23734c', metric: '#2463a5', debug: '#77808b', number: '#8050a4', label: '#2463a5', time: '#63758a' }
}

/** Viewport-only decorations preserve ANSI, selection, copying and TUI layout. */
export function decorateTerminalOutput(term: Terminal): IDisposable {
  let resources: IDisposable[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const clear = () => { resources.forEach(item => item.dispose()); resources = [] }
  const render = () => {
    timer = undefined
    clear()
    const buffer = term.buffer.active
    // Full-screen programs own their presentation.
    if (disposed || buffer.type !== 'normal') return
    const theme = currentTheme()
    const palette = outputPalette(theme.dark, theme)
    const cursor = buffer.baseY + buffer.cursorY
    let count = 0
    for (let y = buffer.viewportY; y < Math.min(buffer.length, buffer.viewportY + term.rows); y++) {
      if (y === cursor) continue // Leave live prompts / echoed input untouched.
      const line = buffer.getLine(y)
      if (!line) continue
      const text = line.translateToString(true)
      const spans = outputSpans(text)
      if (!spans.length) continue
      const tones: (OutputTone | undefined)[] = []
      for (const span of spans) for (let i = span.start; i < span.end; i++) tones[i] = span.tone
      const cells: (OutputTone | undefined)[] = []
      let offset = 0
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (!cell || cell.getWidth() === 0) continue
        const chars = cell.getChars() || ' '
        // Existing foreground/background styling always wins.
        const tone = cell.isFgDefault() && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible() ? tones[offset] : undefined
        for (let w = 0; w < cell.getWidth(); w++) cells[x + w] = tone
        offset += chars.length
      }
      const marker = term.registerMarker(y - cursor)
      if (!marker) continue
      resources.push(marker)
      for (let x = 0; x < cells.length && count < 1200;) {
        const tone = cells[x]
        let end = x + 1
        while (end < cells.length && cells[end] === tone) end++
        if (tone) {
          const decoration = term.registerDecoration({ marker, x, width: end - x, foregroundColor: palette[tone], layer: 'bottom' })
          if (decoration) {
            count++
            decoration.onRender(element => { element.dataset.outputTone = tone })
            resources.push(decoration)
          }
        }
        x = end
      }
    }
  }
  const schedule = () => { if (!disposed && timer === undefined) timer = setTimeout(render, 100) }
  const subscriptions = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule), term.buffer.onBufferChange(schedule)]
  const stopTheme = observeTheme(schedule)
  schedule()
  return { dispose() { disposed = true; clearTimeout(timer); clear(); subscriptions.forEach(item => item.dispose()); stopTheme() } }
}
