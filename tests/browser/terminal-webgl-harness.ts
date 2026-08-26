import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TerminalReplayBatcher } from '../../src/lib/terminalReplay'
import { enableTerminalWebgl } from '../../src/lib/terminalWebgl'

interface HarnessResult {
  ready: boolean
  renderer: string
  writes: number
  resizeCycles: number
  renderEvents: number
  bytes: number
  parseMs: number
  finalLine: string
  baseY: number
  viewportY: number
  canvasCount: number
  canvasWidth: number
  canvasHeight: number
}

declare global {
  interface Window {
    terminalHarness: HarnessResult
  }
}

document.body.style.margin = '0'
document.body.style.background = '#111827'
const host = document.querySelector<HTMLDivElement>('#terminal')!
Object.assign(host.style, {
  width: '100vw',
  height: '100vh',
  padding: '8px',
  boxSizing: 'border-box'
})

const terminal = new Terminal({
  cols: 132,
  rows: 42,
  fontFamily: 'Cascadia Code, monospace',
  fontSize: 14,
  scrollback: 6000,
  theme: { background: '#111827', foreground: '#f3f4f6' }
})
terminal.open(host)
const renderer = enableTerminalWebgl(terminal)
let renderEvents = 0
terminal.onRender(() => {
  renderEvents += 1
})

const encoder = new TextEncoder()
const createPayload = (marker: string): Uint8Array => {
  const lines: string[] = []
  for (let i = 0; i < 5000; i += 1) {
    const color = 31 + (i % 6)
    lines.push(`\x1b[${color}m${String(i).padStart(4, '0')}\x1b[0m ${'terminal-history '.repeat(5)}\r\n`)
  }
  lines.push(`\x1b[1;32m${marker}\x1b[0m`)
  return encoder.encode(lines.join(''))
}
const narrowPayload = createPayload('LINCO_WEBGL_NARROW_MARKER')
const widePayload = createPayload('LINCO_WEBGL_FINAL_MARKER')
let writes = 0
let resizeCycles = 0
const startedAt = performance.now()

const pushInPtyChunks = (batcher: TerminalReplayBatcher, payload: Uint8Array): void => {
  batcher.begin()
  for (let offset = 0; offset < payload.length; offset += 8192) {
    batcher.push(payload.slice(offset, offset + 8192))
  }
}

const batcher = new TerminalReplayBatcher({
  quietMs: 25,
  noOutputMs: 250,
  maxWaitMs: 5000,
  onStart: () => {
    host.dataset.replaying = 'true'
  },
  onComplete: () => {
    terminal.scrollToBottom()
    if (resizeCycles === 1) {
      resizeCycles = 2
      terminal.resize(132, 42)
      pushInPtyChunks(batcher, widePayload)
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const buffer = terminal.buffer.active
        const line = buffer.getLine(buffer.baseY + buffer.cursorY)
        const canvases = [...host.querySelectorAll('canvas')]
        window.terminalHarness = {
          ready: true,
          renderer: renderer.kind,
          writes,
          resizeCycles,
          renderEvents,
          bytes: narrowPayload.length + widePayload.length,
          parseMs: performance.now() - startedAt,
          finalLine: line?.translateToString(true) ?? '',
          baseY: buffer.baseY,
          viewportY: buffer.viewportY,
          canvasCount: canvases.length,
          canvasWidth: canvases[0]?.width ?? 0,
          canvasHeight: canvases[0]?.height ?? 0
        }
        host.dataset.replaying = 'false'
      })
    })
  },
  write: (data, parsed) => {
    writes += 1
    terminal.write(data, parsed)
  }
})

window.terminalHarness = {
  ready: false,
  renderer: renderer.kind,
  writes: 0,
  resizeCycles: 0,
  renderEvents: 0,
  bytes: narrowPayload.length + widePayload.length,
  parseMs: 0,
  finalLine: '',
  baseY: 0,
  viewportY: 0,
  canvasCount: 0,
  canvasWidth: 0,
  canvasHeight: 0
}

resizeCycles = 1
terminal.resize(88, 34)
pushInPtyChunks(batcher, narrowPayload)
