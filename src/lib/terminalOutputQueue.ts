/** Batch PTY reads without depending on animation frames, which stop when minimized. */
export class TerminalOutputQueue {
  private chunks: Uint8Array[] = []
  private byteLength = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly consume: (bytes: Uint8Array) => void) {}

  public push(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return
    this.chunks.push(bytes)
    this.byteLength += bytes.length
    // Timers can also be throttled in the background. Limit each pending batch
    // even when neither timers nor animation frames are running regularly.
    if (this.byteLength >= 256 * 1024) this.flush()
    else if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 16)
  }

  public flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || this.byteLength === 0) return
    const bytes = new Uint8Array(this.byteLength)
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.byteLength = 0
    this.consume(bytes)
  }

  public dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.chunks = []
    this.byteLength = 0
  }
}
