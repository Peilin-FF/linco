export interface TerminalReplayBatcherOptions {
  write: (data: Uint8Array, onParsed: () => void) => void
  onStart: () => void
  onComplete: () => void
  onError?: (error: unknown) => void
  quietMs?: number
  noOutputMs?: number
  maxWaitMs?: number
  maxBytes?: number
}

/**
 * Coalesces a terminal application's resize repaint into large xterm writes.
 * xterm yields to its renderer between queued chunks, so forwarding PTY reads
 * one-by-one makes a long Codex transcript visibly paint from top to bottom.
 */
export class TerminalReplayBatcher {
  private readonly write: TerminalReplayBatcherOptions['write']
  private readonly onStart: TerminalReplayBatcherOptions['onStart']
  private readonly onComplete: TerminalReplayBatcherOptions['onComplete']
  private readonly onError?: TerminalReplayBatcherOptions['onError']
  private readonly quietMs: number
  private readonly noOutputMs: number
  private readonly maxWaitMs: number
  private readonly maxBytes: number

  private chunks: Uint8Array[] = []
  private byteLength = 0
  private pendingWrites = 0
  private finishing = false
  private settling = false
  private sawOutput = false
  private disposed = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private maxTimer: ReturnType<typeof setTimeout> | undefined

  public active = false

  constructor(options: TerminalReplayBatcherOptions) {
    this.write = options.write
    this.onStart = options.onStart
    this.onComplete = options.onComplete
    this.onError = options.onError
    this.quietMs = options.quietMs ?? 250
    this.noOutputMs = options.noOutputMs ?? 1200
    this.maxWaitMs = options.maxWaitMs ?? 5000
    this.maxBytes = options.maxBytes ?? 12 * 1024 * 1024
  }

  public begin(): void {
    if (this.disposed) return
    if (!this.active) {
      this.active = true
      this.finishing = false
      this.settling = false
      this.sawOutput = false
      this.onStart()
    }
    this.clearIdleTimer()
    if (!this.sawOutput) this.armMaxTimer(this.noOutputMs)
  }

  /** Returns true when the bytes were captured instead of written directly. */
  public push(data: Uint8Array): boolean {
    if (this.disposed || !this.active || this.finishing) return false
    this.chunks.push(data)
    this.settling = false
    this.byteLength += data.length
    if (!this.sawOutput) {
      this.sawOutput = true
      this.armMaxTimer(this.maxWaitMs)
    }
    this.armIdleTimer()
    if (this.byteLength >= this.maxBytes) this.flush()
    return true
  }

  public flush(finalize = false): void {
    if (this.disposed || !this.active) return
    if (finalize) this.finishing = true
    // At the hard deadline enqueue all remaining bytes before allowing new
    // output to pass through, even if an earlier size-limited write is parsing.
    if (this.pendingWrites > 0 && !finalize) return
    if (finalize) this.clearTimers()
    else this.clearIdleTimer()
    if (this.byteLength === 0) {
      if (this.pendingWrites > 0) return
      if (this.finishing || this.settling) this.complete()
      else this.armIdleTimer()
      return
    }

    const data = new Uint8Array(this.byteLength)
    let offset = 0
    for (const chunk of this.chunks) {
      data.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.byteLength = 0
    this.pendingWrites++

    try {
      this.write(data, () => {
        this.pendingWrites--
        if (this.disposed) return
        if (this.pendingWrites > 0) return
        if (this.finishing) {
          if (this.byteLength > 0) this.flush(true)
          else this.complete()
        } else if (this.settling && this.byteLength === 0) {
          this.complete()
        } else {
          // A size-limited flush is only part of the replay. Keep buffering
          // later chunks and holding the cached viewport until output settles.
          this.armIdleTimer()
        }
      })
    } catch (error) {
      this.pendingWrites--
      this.onError?.(error)
      this.complete()
    }
  }

  public dispose(): void {
    this.disposed = true
    this.active = false
    this.finishing = false
    this.settling = false
    this.sawOutput = false
    this.chunks = []
    this.byteLength = 0
    this.clearTimers()
  }

  public get bufferedBytes(): number {
    return this.byteLength
  }

  private complete(): void {
    if (!this.active) return
    this.active = false
    this.clearTimers()
    this.chunks = []
    this.byteLength = 0
    this.onComplete()
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.settling = true
      this.flush()
    }, this.quietMs)
  }

  private armMaxTimer(delay: number): void {
    if (this.maxTimer !== undefined) clearTimeout(this.maxTimer)
    this.maxTimer = setTimeout(() => {
      this.maxTimer = undefined
      this.flush(true)
    }, delay)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private clearTimers(): void {
    this.clearIdleTimer()
    if (this.maxTimer !== undefined) clearTimeout(this.maxTimer)
    this.maxTimer = undefined
  }
}
