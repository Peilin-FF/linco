import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalOutputQueue } from '@/lib/terminalOutputQueue'

afterEach(() => vi.useRealTimers())

describe('TerminalOutputQueue', () => {
  it('processes ordered bytes with timers while animation frames are suspended', () => {
    vi.useFakeTimers()
    const writes: Uint8Array[] = []
    const queue = new TerminalOutputQueue(bytes => writes.push(bytes))
    // UTF-8 and ANSI sequences may cross PTY read boundaries.
    const bytes = new TextEncoder().encode('Conversation 中文\x1b[32m ready\x1b[0m')
    for (const byte of bytes) queue.push(Uint8Array.of(byte))
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(writes).toEqual([bytes])
    queue.dispose()
  })

  it('bounds pending batches even when background timers are throttled', () => {
    vi.useFakeTimers()
    const consume = vi.fn()
    const queue = new TerminalOutputQueue(consume)
    const chunk = new Uint8Array(8192).fill(42)
    for (let i = 0; i < 32; i++) queue.push(chunk)
    expect(consume).toHaveBeenCalledOnce()
    expect(consume.mock.calls[0][0]).toEqual(new Uint8Array(256 * 1024).fill(42))
    vi.runAllTimers()
    expect(consume).toHaveBeenCalledOnce()
    queue.dispose()
  })

  it('flushes immediately on restore without delivering the batch twice', () => {
    vi.useFakeTimers()
    const consume = vi.fn()
    const queue = new TerminalOutputQueue(consume)
    queue.push(Uint8Array.of(1, 2))
    queue.flush()
    queue.push(Uint8Array.of(3))
    vi.runAllTimers()
    expect(consume.mock.calls).toEqual([[Uint8Array.of(1, 2)], [Uint8Array.of(3)]])
    queue.dispose()
  })

  it('drops pending output on disposal and ignores late events', () => {
    vi.useFakeTimers()
    const consume = vi.fn()
    const queue = new TerminalOutputQueue(consume)
    queue.push(Uint8Array.of(1))
    queue.dispose()
    queue.push(Uint8Array.of(2))
    queue.flush()
    vi.runAllTimers()
    expect(consume).not.toHaveBeenCalled()
  })
})
