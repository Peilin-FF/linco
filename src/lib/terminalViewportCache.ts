import type { Terminal } from '@xterm/xterm'

/** One painted viewport per terminal, held only while an ANSI history replay runs. */
export class TerminalViewportCache {
  private snapshot: HTMLDivElement | undefined
  private waitingForPaint = false
  private readonly rendered

  constructor(private readonly terminal: Terminal, private readonly onChange: (held: boolean) => void) {
    this.rendered = terminal.onRender(() => {
      if (this.waitingForPaint) this.clear()
    })
  }

  public hold(): void {
    this.waitingForPaint = false
    if (this.snapshot) return
    const element = this.terminal.element
    const screen = element?.querySelector<HTMLElement>('.xterm-screen')
    if (!element || !screen || !screen.clientWidth || !screen.clientHeight) return
    // Do not cover a first launch with an empty cache.
    const buffer = this.terminal.buffer.active
    let hasContent = false
    for (let row = buffer.viewportY; row < buffer.viewportY + this.terminal.rows; row++) {
      if (buffer.getLine(row)?.translateToString(true).trim()) { hasContent = true; break }
    }
    if (!hasContent) return

    const copy = screen.cloneNode(true) as HTMLElement
    const canvases = screen.querySelectorAll('canvas')
    try {
      copy.querySelectorAll('canvas').forEach((canvas, index) => {
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Viewport cache canvas unavailable')
        context.drawImage(canvases[index], 0, 0)
      })
    } catch {
      return // A renderer without snapshot support must remain usable.
    }
    copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
    const snapshot = document.createElement('div')
    snapshot.className = element.className
    snapshot.dataset.terminalSnapshot = 'true'
    snapshot.setAttribute('aria-hidden', 'true')
    snapshot.inert = true
    Object.assign(snapshot.style, {
      // Cover xterm's live scrollbar (z-index 11) as well as its text layers;
      // otherwise the thumb still races through the replay above the cache.
      position: 'absolute', inset: '0', overflow: 'hidden', zIndex: '12',
      pointerEvents: 'none', background: this.terminal.options.theme?.background || '#fff'
    })
    snapshot.append(copy)
    element.append(snapshot)
    this.snapshot = snapshot
    this.onChange(true)
  }

  /** Reveal only after xterm has actually painted its fully parsed buffer. */
  public reveal(): void {
    if (!this.snapshot) return
    this.waitingForPaint = true
    this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1))
  }

  /** User input always regains the live terminal immediately. */
  public clear = (): void => {
    this.waitingForPaint = false
    if (!this.snapshot) return
    this.snapshot.remove()
    this.snapshot = undefined
    this.onChange(false)
  }

  public dispose(): void {
    this.rendered.dispose()
    this.snapshot?.remove()
    this.snapshot = undefined
  }
}
