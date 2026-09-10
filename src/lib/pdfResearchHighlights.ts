import { invoke } from '@tauri-apps/api/core'

export type ResearchHighlightKind = 'question' | 'contribution' | 'method' | 'result' | 'limitation' | 'conclusion'
export const researchHighlightColors: Record<ResearchHighlightKind, string> = {
  question: '#66bfc7', contribution: '#e5a5b8', method: '#b8a2ed', result: '#81c79f', limitation: '#efbf65', conclusion: '#88b5e6',
}
export interface PdfReadingPage { page: number; text: string }
export interface ResearchHighlight { page: number; kind: ResearchHighlightKind; quote: string; reason: string }
export interface PdfReadingAnalysis {
  summary: string
  highlights: ResearchHighlight[]
  agent: string
  model: string
  createdAt: number
  pages: number
  cached: boolean
  saveWarning?: string | null
  execution: 'local'
  scope: 'pdf-only'
}

export function normalizedPdfText(text: string): string { return text.replace(/\s+/gu, ' ').trim() }
export function pdfPageText(items: readonly string[]): string { return items.map(normalizedPdfText).filter(Boolean).join(' ') }

/** Locate model-selected quotes in PDF.js text runs, retaining original UTF-16
 * offsets for DOM Range. No approximate matching or guessed page coordinates.
 */
export function anchorPdfQuote(items: readonly string[], quote: string): { item: number; from: number; to: number }[] {
  const parts = items.map((raw, item) => {
    const chars: string[] = [], offsets: number[] = []
    for (const match of raw.matchAll(/\S+/gu)) {
      if (chars.length) { chars.push(' '); offsets.push(Math.max(0, match.index! - 1)) }
      for (let i = 0; i < match[0].length; i++) { chars.push(match[0][i]); offsets.push(match.index! + i) }
    }
    return { item, text: chars.join(''), offsets }
  }).filter(part => part.text)
  const text = parts.map(part => part.text).join(' '), clean = normalizedPdfText(quote)
  const start = text.indexOf(clean), end = start + clean.length
  if (!clean || start < 0 || text.indexOf(clean, start + 1) >= 0) return []
  let cursor = 0
  return parts.flatMap(part => {
    const from = Math.max(0, start - cursor), to = Math.min(part.text.length, end - cursor)
    cursor += part.text.length + 1
    return from < to ? [{ item: part.item, from: part.offsets[from], to: part.offsets[to - 1] + 1 }] : []
  })
}

// Deduplicate StrictMode mounts and two previews of the same in-flight paper.
// Durable, PDF-text/model-keyed results are saved by the desktop backend.
export interface PdfReadingProgress {
  stage: 'queued' | 'preparing' | 'cache' | 'starting' | 'reading' | 'validating' | 'saving'
  elapsedMs: number
  timeoutMs: number
  execution: 'local'
}
export interface PdfReadingTask {
  promise: Promise<PdfReadingAnalysis>
  cancel(): Promise<void>
  subscribe(listener: (progress: PdfReadingProgress) => void): () => void
}
const pending = new Map<string, PdfReadingTask>()
const activePaper = new Map<string, PdfReadingTask>()
const latestPaperRequest = new Map<string, string>()
export function startPdfReading(documentId: string, pages: PdfReadingPage[], force = false): PdfReadingTask {
  // documentId coordinates preview lifecycles only. No project identifier,
  // host, evidence paths, or author brief is sent to the reading backend.
  const args = { pages, force }
  const key = JSON.stringify([documentId, args])
  const existing = pending.get(key)
  if (existing) return existing
  const paper = documentId
  const previous = activePaper.get(paper)
  latestPaperRequest.set(paper, key)
  const requestId = crypto.randomUUID()
  const listeners = new Set<(progress: PdfReadingProgress) => void>()
  let progress: PdfReadingProgress = { stage: 'queued', elapsedMs: 0, timeoutMs: 90000, execution: 'local' }
  let cancelled = false, started = false, settled = false, polling = false
  let timer: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: ((reason: Error) => void) | undefined
  const cancel = async (): Promise<void> => {
    if (settled || cancelled) return
    cancelled = true
    rejectCancellation?.(new Error('Paper analysis cancelled. Saved highlights are unchanged.'))
    if (started) {
      // A cancel can overtake command registration; retry briefly in that case.
      for (let attempt = 0; attempt < 3; attempt++) {
        let ackTimer: ReturnType<typeof setTimeout> | undefined
        const acknowledged = await Promise.race([
          invoke<boolean>('latex_ai_pdf_cancel', { requestId }).catch(() => true),
          new Promise<boolean>(resolve => { ackTimer = setTimeout(() => resolve(true), 500) }),
        ])
        clearTimeout(ackTimer)
        if (acknowledged) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  const interrupted = new Promise<never>((_, reject) => {
    rejectCancellation = reject
    deadline = setTimeout(() => {
      reject(new Error('The local AI backend did not respond within 100 seconds. Check the local agent connection and retry. Saved highlights are unchanged.'))
      void cancel()
    }, 100000)
  })
  const task: PdfReadingTask = {
    promise: Promise.resolve(null as unknown as PdfReadingAnalysis),
    cancel,
    subscribe(listener) { listeners.add(listener); listener(progress); return () => { listeners.delete(listener) } },
  }
  const work = (async () => {
    // Superseded PDF versions must not sit behind an obsolete 180-second request.
    if (previous) { await previous.cancel(); await previous.promise.catch(() => undefined) }
    if (latestPaperRequest.get(paper) !== key) throw new Error('A newer PDF superseded this queued analysis.')
    if (cancelled) throw new Error('Paper analysis cancelled. Saved highlights are unchanged.')
    // Check the cancellable backend BEFORE starting AI; a hot-reloaded frontend
    // must never silently fall back to an old backend's SSH-only implementation.
    await invoke('latex_ai_pdf_progress', { requestId })
    if (cancelled) throw new Error('Paper analysis cancelled. Saved highlights are unchanged.')
    started = true
    progress = { ...progress, stage: 'preparing' }
    listeners.forEach(listener => listener(progress))
    timer = setInterval(() => {
      if (polling || settled) return
      polling = true
      void invoke<PdfReadingProgress | null>('latex_ai_pdf_progress', { requestId }).then(next => {
        if (next && !settled) { progress = next; listeners.forEach(listener => listener(next)) }
      }).catch(() => {}).finally(() => { polling = false })
    }, 750)
    const result = await invoke<PdfReadingAnalysis>('latex_ai_pdf_highlights', { ...args, requestId })
    if (cancelled) throw new Error('Paper analysis cancelled. Saved highlights are unchanged.')
    if (result.scope !== 'pdf-only' || result.execution !== 'local') {
      throw new Error('This desktop backend does not support PDF-only highlighting. Rebuild and restart Linco.')
    }
    return result
  })()
  task.promise = Promise.race([work, interrupted])
  pending.set(key, task)
  activePaper.set(paper, task)
  void task.promise.finally(() => {
    settled = true; clearInterval(timer); clearTimeout(deadline)
    if (pending.get(key) === task) pending.delete(key)
    if (activePaper.get(paper) === task) { activePaper.delete(paper); latestPaperRequest.delete(paper) }
  }).catch(() => {})
  return task
}

export function analyzePdfReading(documentId: string, pages: PdfReadingPage[], force = false): Promise<PdfReadingAnalysis> {
  return startPdfReading(documentId, pages, force).promise
}
