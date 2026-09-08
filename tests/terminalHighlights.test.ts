import { describe, expect, it } from 'vitest'
import { outputSpans, outputPalette } from '../src/lib/terminalHighlights'

describe('terminal output hints', () => {
  it('separates keys, numbers, units and timestamps without altering text', () => {
    const text = '2026-09-08 13:20:40 loss=0.125 GPU: 45GiB util=95% time=2.5e-3s'
    const spans = outputSpans(text)
    expect(spans.filter(s => s.tone === 'number').map(s => text.slice(s.start, s.end))).toEqual(['0.125', '45GiB', '95%', '2.5e-3s'])
    expect(spans.find(s => s.tone === 'time')?.end).toBe(19)
    expect(spans.filter(s => s.tone === 'label').map(s => text.slice(s.start, s.end))).toEqual(['loss', 'GPU', 'util', 'time'])
  })
  it('keeps warnings and errors dominant over numeric highlights', () => {
    expect(outputSpans('[ERROR] retry in 12s')).toEqual([{ start: 0, end: 20, tone: 'error' }])
    expect(outputSpans('WARNING: GPU 3')).toHaveLength(1)
  })
  it('finds values in diagnostic dumps without marking them failures', () => {
    const spans = outputSpans('[state-dump] total=0 time=0.00ms')
    expect(spans[0].tone).toBe('debug')
    expect(spans.filter(s => s.tone === 'number')).toHaveLength(2)
    expect(spans.some(s => s.tone === 'error')).toBe(false)
  })
  it('does not color ordinary prose or digits inside identifiers', () => {
    expect(outputSpans('Read the project files')).toEqual([])
    expect(outputSpans('worker42 python3')).toEqual([])
  })
  it('has separate light and dark foregrounds in xterm-compatible format', () => {
    expect(outputPalette(true).number).not.toBe(outputPalette(false).number)
    for (const color of Object.values(outputPalette(true))) expect(color).toMatch(/^#[a-f0-9]{6}$/)
  })
})
