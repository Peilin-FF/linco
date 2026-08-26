import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TmuxWheelThrottle } from '@/lib/terminalWheel'

describe('TmuxWheelThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('forwards the first event immediately', () => {
    const forward = vi.fn()
    const throttle = new TmuxWheelThrottle(forward, 40)

    throttle.push('first')

    expect(forward).toHaveBeenCalledWith('first')
  })

  it('coalesces a burst to the latest pending event', () => {
    const forward = vi.fn()
    const throttle = new TmuxWheelThrottle(forward, 40)

    throttle.push('first')
    for (let i = 0; i < 100; i += 1) throttle.push(`pending-${i}`)

    expect(forward).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(40)
    expect(forward).toHaveBeenCalledTimes(2)
    expect(forward).toHaveBeenLastCalledWith('pending-99')

    vi.advanceTimersByTime(400)
    expect(forward).toHaveBeenCalledTimes(2)
  })

  it('drops a pending event when disposed', () => {
    const forward = vi.fn()
    const throttle = new TmuxWheelThrottle(forward, 40)

    throttle.push('first')
    throttle.push('pending')
    throttle.dispose()
    vi.runAllTimers()

    expect(forward).toHaveBeenCalledTimes(1)
  })
})
