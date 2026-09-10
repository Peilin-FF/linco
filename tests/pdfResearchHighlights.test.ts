import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { analyzePdfReading, startPdfReading, anchorPdfQuote, normalizedPdfText, pdfPageText, type PdfReadingAnalysis } from '../src/lib/pdfResearchHighlights'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const result: PdfReadingAnalysis = { summary: 'Fixture', highlights: [], agent: 'Mock', model: '', createdAt: 1, pages: 1, cached: false, execution: 'local', scope: 'pdf-only' }

describe('AI-selected PDF quote anchoring', () => {
  it('normalizes extraction spacing, preserving original DOM offsets', () => {
    expect(normalizedPdfText('  Key\n findings\t matter. ')).toBe('Key findings matter.')
    expect(pdfPageText(['  Key\n findings', '', 'matter. '])).toBe('Key findings matter.')
    expect(anchorPdfQuote(['  Key\n findings', 'matter. '], 'findings matter.')).toEqual([
      { item: 0, from: 7, to: 15 }, { item: 1, from: 0, to: 7 },
    ])
  })
  it('refuses invented, ambiguous or stale quotes instead of fuzzy highlighting', () => {
    expect(anchorPdfQuote(['Our accuracy is 80%.'], 'Our accuracy is 90%.')).toEqual([])
    expect(anchorPdfQuote(['the result', 'the result'], 'the result')).toEqual([])
    expect(anchorPdfQuote(['text'], '')).toEqual([])
  })
  it('maps only the selected characters, across runs and Unicode', () => {
    const items = ['An αβ result improves', '研究 accuracy by 5%.']
    const anchors = anchorPdfQuote(items, 'αβ result improves 研究 accuracy')
    expect(anchors.map(anchor => items[anchor.item].slice(anchor.from, anchor.to)).join(' ')).toBe('αβ result improves 研究 accuracy')
    expect(anchorPdfQuote(['🧠 memory works'], 'memory')).toEqual([{ item: 0, from: 3, to: 9 }])
  })
  it('deduplicates previews, cancels obsolete AI and coalesces compiles to the newest PDF', async () => {
    vi.mocked(invoke).mockReset()
    let calls = 0
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'latex_ai_pdf_progress') return null
      if (command === 'latex_ai_pdf_cancel') return true
      if (++calls === 1) return new Promise(() => {})
      return result
    })
    const documentId = 'queue-fixture/main.pdf'
    const first = analyzePdfReading(documentId, [{ page: 1, text: 'version one' }])
    expect(analyzePdfReading(documentId, [{ page: 1, text: 'version one' }])).toBe(first)
    const cancelled = expect(first).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(calls).toBe(1))
    const middle = analyzePdfReading(documentId, [{ page: 1, text: 'version two' }])
    const superseded = expect(middle).rejects.toThrow(/superseded|cancelled/)
    const latest = analyzePdfReading(documentId, [{ page: 1, text: 'version three' }])
    await Promise.all([cancelled, superseded, latest])
    expect(calls).toBe(2)
    const analyses = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'latex_ai_pdf_highlights')
    expect(analyses[1][1]).toMatchObject({ pages: [{ page: 1, text: 'version three' }] })
    expect(invoke).toHaveBeenCalledWith('latex_ai_pdf_cancel', expect.objectContaining({ requestId: expect.any(String) }))
  })
  it('sends only PDF text, never the UI document identity or project context', async () => {
    vi.mocked(invoke).mockReset().mockImplementation(async command => command === 'latex_ai_pdf_progress' ? null : result)
    const pages = [{ page: 1, text: 'A paper can be read without reaching its offline remote project.' }]
    const documentId = JSON.stringify(['offline.example', '/remote/private-project', 'main.tex'])
    await expect(analyzePdfReading(documentId, pages)).resolves.toBe(result)
    expect(invoke).toHaveBeenCalledWith('latex_ai_pdf_highlights', {
      pages, force: false, requestId: expect.any(String),
    })
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('private-project')
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain('offline.example')
  })
  it('keeps different open documents independent even when their PDF text matches', async () => {
    let finish: ((value: PdfReadingAnalysis) => void) | undefined
    let readings = 0
    vi.mocked(invoke).mockReset().mockImplementation(async command => {
      if (command === 'latex_ai_pdf_progress') return null
      if (++readings === 1) return new Promise<PdfReadingAnalysis>(resolve => { finish = resolve })
      return result
    })
    const pages = [{ page: 1, text: 'Two independent previews of identical paper text.' }]
    const first = analyzePdfReading('document-one', pages)
    await vi.waitFor(() => expect(readings).toBe(1))
    await expect(analyzePdfReading('document-two', pages)).resolves.toBe(result)
    expect(invoke).not.toHaveBeenCalledWith('latex_ai_pdf_cancel', expect.anything())
    finish!(result)
    await expect(first).resolves.toBe(result)
  })
  it('refuses a legacy project-grounded response', async () => {
    vi.mocked(invoke).mockReset().mockImplementation(async command => command === 'latex_ai_pdf_progress' ? null : { ...result, scope: undefined, context: [{ path: 'project.py' }] })
    await expect(analyzePdfReading('legacy-reading', [{ page: 1, text: 'test' }])).rejects.toThrow('does not support PDF-only highlighting')
  })
  it('refuses an older backend before launching its uncancellable remote analysis', async () => {
    vi.mocked(invoke).mockReset().mockRejectedValue(new Error('Command latex_ai_pdf_progress not found'))
    await expect(analyzePdfReading('old-backend/paper.pdf', [{ page: 1, text: 'test' }])).rejects.toThrow('not found')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('latex_ai_pdf_progress', expect.anything())
  })
  it('lets the user cancel a live analysis and stop progress polling', async () => {
    vi.mocked(invoke).mockReset().mockImplementation(async command => command === 'latex_ai_pdf_progress' ? null : command === 'latex_ai_pdf_cancel' ? true : new Promise(() => {}))
    const task = startPdfReading('cancel-fixture/paper.pdf', [{ page: 1, text: 'test' }])
    const updates = vi.fn()
    const unsubscribe = task.subscribe(updates)
    const cancelled = expect(task.promise).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('latex_ai_pdf_highlights', expect.anything()))
    await task.cancel()
    await cancelled
    expect(updates).toHaveBeenCalledWith(expect.objectContaining({ execution: 'local' }))
    unsubscribe()
  })
  it('also times out an unresponsive capability probe before any AI is launched', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(invoke).mockReset().mockImplementation(() => new Promise(() => {}))
      const task = startPdfReading('frozen-backend/paper.pdf', [{ page: 1, text: 'test' }])
      const expired = expect(task.promise).rejects.toThrow('100 seconds')
      await vi.advanceTimersByTimeAsync(100001)
      await expired
      expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['latex_ai_pdf_progress'])
    } finally { vi.useRealTimers() }
  })
})
