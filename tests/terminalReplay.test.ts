import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalReplayBatcher } from '@/lib/terminalReplay'

describe('TerminalReplayBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces thousands of PTY chunks into one xterm write', () => {
    const writes: Uint8Array[] = []
    const onComplete = vi.fn()
    const batcher = new TerminalReplayBatcher({
      quietMs: 100,
      noOutputMs: 500,
      maxWaitMs: 2000,
      onStart: vi.fn(),
      onComplete,
      write: (data, parsed) => {
        writes.push(data)
        parsed()
      }
    })

    batcher.begin()
    for (let i = 0; i < 5000; i += 1) {
      batcher.push(Uint8Array.of(i % 251, 10))
    }

    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toHaveLength(10000)
    expect(writes[0].slice(0, 6)).toEqual(Uint8Array.of(0, 10, 1, 10, 2, 10))
    expect(onComplete).toHaveBeenCalledOnce()
    expect(batcher.active).toBe(false)
  })

  it('waits for bytes that arrive while xterm is parsing the first batch', () => {
    const writes: Uint8Array[] = []
    const callbacks: Array<() => void> = []
    const onComplete = vi.fn()
    const batcher = new TerminalReplayBatcher({
      quietMs: 50,
      noOutputMs: 500,
      maxWaitMs: 2000,
      onStart: vi.fn(),
      onComplete,
      write: (data, parsed) => {
        writes.push(data)
        callbacks.push(parsed)
      }
    })

    batcher.begin()
    batcher.push(Uint8Array.of(1, 2))
    vi.advanceTimersByTime(50)
    expect(writes).toEqual([Uint8Array.of(1, 2)])

    batcher.push(Uint8Array.of(3, 4))
    vi.advanceTimersByTime(50)
    expect(writes).toHaveLength(1)
    expect(onComplete).not.toHaveBeenCalled()

    callbacks.shift()?.()
    vi.advanceTimersByTime(50)
    expect(writes).toEqual([Uint8Array.of(1, 2), Uint8Array.of(3, 4)])
    callbacks.shift()?.()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('reveals without writing when a resize produces no PTY output', () => {
    const write = vi.fn()
    const onComplete = vi.fn()
    const batcher = new TerminalReplayBatcher({
      noOutputMs: 250,
      onStart: vi.fn(),
      onComplete,
      write
    })

    batcher.begin()
    vi.advanceTimersByTime(249)
    expect(onComplete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('flushes at the memory limit without losing byte order', () => {
    const writes: Uint8Array[] = []
    const batcher = new TerminalReplayBatcher({
      maxBytes: 4,
      onStart: vi.fn(),
      onComplete: vi.fn(),
      write: (data, parsed) => {
        writes.push(data)
        parsed()
      }
    })

    batcher.begin()
    batcher.push(Uint8Array.of(9, 8))
    batcher.push(Uint8Array.of(7, 6))
    expect(writes).toEqual([Uint8Array.of(9, 8, 7, 6)])
  })

  it('does not reveal or write after disposal', () => {
    const write = vi.fn()
    const onComplete = vi.fn()
    const batcher = new TerminalReplayBatcher({
      quietMs: 10,
      onStart: vi.fn(),
      onComplete,
      write
    })

    batcher.begin()
    batcher.push(Uint8Array.of(1))
    batcher.dispose()
    vi.runAllTimers()
    expect(write).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('uses an absolute deadline and switches continuing output to passthrough', () => {
    const callbacks: Array<() => void> = []
    const onComplete = vi.fn()
    const batcher = new TerminalReplayBatcher({
      quietMs: 1000,
      noOutputMs: 50,
      maxWaitMs: 100,
      onStart: vi.fn(),
      onComplete,
      write: (_data, parsed) => callbacks.push(parsed)
    })

    batcher.begin()
    expect(batcher.push(Uint8Array.of(1))).toBe(true)
    vi.advanceTimersByTime(90)
    expect(batcher.push(Uint8Array.of(2))).toBe(true)
    vi.advanceTimersByTime(10)
    expect(callbacks).toHaveLength(1)

    // Data after the hard deadline is live output, not resize replay.
    expect(batcher.push(Uint8Array.of(3))).toBe(false)
    callbacks[0]()
    expect(onComplete).toHaveBeenCalledOnce()
    expect(batcher.active).toBe(false)
  })
})
