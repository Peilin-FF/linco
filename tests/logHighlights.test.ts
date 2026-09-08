import { describe, expect, it } from 'vitest'
import { isLogHighlight, logBufferLines, logLevel } from '../src/lib/logHighlights'

describe('log emphasis', () => {
  it.each([
    ['[ERROR] Worker failed', 'error'],
    ['RuntimeError: CUDA out of memory', 'error'],
    ['Traceback (most recent call last):', 'error'],
    ['errors=3', 'error'],
    ['WARNING: old configuration', 'warning'],
    ['[state-dump] step: 100 loss: 0.7', 'debug'],
    ['[DEBUG] heartbeat', 'debug'],
    ['step=42 loss: 0.19 reward=0.8', 'metric'],
    ['=== Evaluation ===', 'section'],
    ['Completed evaluation', 'success'],
    ['12 passed in 0.4s', 'success'],
    ['errors=0 failures: 0', 'plain'],
    ['The result was not successful', 'plain'],
    ['ErrorRate=0.01', 'plain'],
    ['normal output', 'plain'],
  ])('%s → %s', (text, level) => expect(logLevel(text)).toBe(level))

  it('excludes routine diagnostics from highlights without removing raw content', () => {
    expect(isLogHighlight(logLevel('[state-dump] timing dump'))).toBe(false)
    expect(isLogHighlight(logLevel('loss=0.2'))).toBe(true)
  })
})

describe('terminal buffer projection', () => {
  const buffer = (rows: { text: string; wrapped?: boolean }[]) => ({
    length: rows.length,
    getLine: (index: number) => rows[index] && ({
      isWrapped: !!rows[index].wrapped,
      translateToString: (trim?: boolean) => trim ? rows[index].text.trimEnd() : rows[index].text,
    }),
  })
  it('joins soft wraps without losing a separating space', () => {
    expect(logBufferLines(buffer([{ text: 'loss: ' }, { text: '0.20', wrapped: true }, { text: '' }, { text: 'Done ' }, { text: '' }]))).toEqual(['loss: 0.20', '', 'Done'])
  })
  it('bounds retained output and tolerates the start being a continued line', () => {
    expect(logBufferLines(buffer([{ text: 'old' }, { text: 'current', wrapped: true }, { text: 'new' }]), 2)).toEqual(['current', 'new'])
  })
})
