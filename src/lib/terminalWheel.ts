export class TmuxWheelThrottle<T> {
  private pending: T | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly forward: (event: T) => void,
    private readonly intervalMs = 40
  ) {}

  push(event: T): void {
    if (this.disposed) return

    if (this.timer === undefined) {
      this.forward(event)
      this.timer = setTimeout(() => this.flush(), this.intervalMs)
      return
    }

    // Keep only the latest wheel position and direction. Remote tmux redraws
    // must never form a long input queue after the user stops scrolling.
    this.pending = event
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private flush(): void {
    this.timer = undefined
    if (this.disposed || this.pending === undefined) return

    const event = this.pending
    this.pending = undefined
    this.forward(event)
    this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }
}
