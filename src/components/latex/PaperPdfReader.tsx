import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ChevronLeft, ChevronRight, Highlighter, Loader2, Minus, Plus, RotateCw, Sparkles, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { startPdfReading, pdfPageText, researchHighlightColors,
  type PdfReadingAnalysis, type PdfReadingPage, type PdfReadingTask, type PdfReadingProgress, type ResearchHighlightKind } from '@/lib/pdfResearchHighlights'
import PdfPageView, { type PageBox } from './PdfPageView'
import './paper-pdf-reader.css'

GlobalWorkerOptions.workerSrc = workerUrl
const kinds = Object.keys(researchHighlightColors) as ResearchHighlightKind[]
// Shared so pages without highlights keep a stable prop and skip needless work.
const NO_HIGHLIGHTS: PdfReadingAnalysis['highlights'] = []
function initialHighlights(): boolean { try { return localStorage.getItem('linco.pdf-ai-highlights') !== 'off' } catch { return true } }

export default function PaperPdfReader({ src, documentId = src }: { src: string; documentId?: string }): JSX.Element {
  const { t } = useI18n()
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(600)
  const [filter, setFilter] = useState<ResearchHighlightKind | null>(null)
  const [enabled, setEnabled] = useState(initialHighlights)
  const [original, setOriginal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [textPresent, setTextPresent] = useState(false)
  const [boxes, setBoxes] = useState<PageBox[]>([])
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]))
  const [analysis, setAnalysis] = useState<PdfReadingAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [analysisProgress, setAnalysisProgress] = useState(0)
  const [analysisStage, setAnalysisStage] = useState<PdfReadingProgress['stage']>('queued')
  const [analysisElapsed, setAnalysisElapsed] = useState(0)
  const [analysisStale, setAnalysisStale] = useState(false)
  const [analysisNotice, setAnalysisNotice] = useState('')
  const [readingOpen, setReadingOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const programmaticScrollRef = useRef(0)
  const zoomAnchorRef = useRef<{ x: number; y: number; from: number; to: number } | null>(null)
  // Read by the native wheel listener so it does not rebind on every zoom step.
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  const forceRef = useRef(false)
  const stopRef = useRef<(() => void) | null>(null)
  const analysisDocumentRef = useRef(documentId)

  useEffect(() => {
    let alive = true
    let task: PDFDocumentLoadingTask | undefined
    setLoading(true); setError(''); setPdfDocument(null); setPageNumber(1); setBoxes([]); setVisiblePages(new Set([1])); setAnalysisStale(true)
    // StrictMode's probe mount must not destroy a worker which the live mount
    // is still initializing. Start only after that synchronous probe finishes.
    const timer = setTimeout(() => {
      task = getDocument({ url: src, enableXfa: false })
      task.promise.then(pdf => { if (alive) setPdfDocument(pdf) }).catch(reason => { if (alive) { setError(String(reason)); setLoading(false) } })
    }, 0)
    return () => { alive = false; clearTimeout(timer); void task?.destroy() }
  }, [src])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    // Measured with a reserved scrollbar gutter (see the viewport's style), so a
    // scrollbar appearing cannot shrink the column, re-scale the page, remove the
    // scrollbar and start again. That loop was the flicker at particular zooms.
    const observer = new ResizeObserver(() => setWidth(Math.max(260, Math.round(element.clientWidth) - 24)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [original])

  // Page boxes are measured once so the column has its full height immediately.
  useEffect(() => {
    if (!pdfDocument) return
    let alive = true
    setLoading(true)
    void (async () => {
      const sizes: PageBox[] = []
      for (let number = 1; number <= pdfDocument.numPages; number++) {
        const page = await pdfDocument.getPage(number)
        if (!alive) return
        const viewport = page.getViewport({ scale: 1 })
        sizes.push({ width: viewport.width, height: viewport.height })
      }
      if (!alive) return
      setBoxes(sizes)
      setLoading(false)
    })().catch(reason => { if (alive) { setError(String(reason)); setLoading(false) } })
    return () => { alive = false }
  }, [pdfDocument])

  useEffect(() => {
    if (analysisDocumentRef.current !== documentId) { setAnalysis(null); analysisDocumentRef.current = documentId }
    setAnalysisError(''); setAnalysisNotice(''); setAnalyzing(false)
    if (!pdfDocument || !enabled) return
    let alive = true
    let task: PdfReadingTask | undefined, unsubscribe: (() => void) | undefined
    let elapsedTimer: ReturnType<typeof setInterval> | undefined
    const force = forceRef.current
    forceRef.current = false
    stopRef.current = () => {
      alive = false; clearTimeout(timer); clearInterval(elapsedTimer); unsubscribe?.()
      void task?.cancel()
      setAnalyzing(false); setAnalysisError(''); setAnalysisNotice(t('latex.reader.cancelled'))
    }
    const timer = setTimeout(() => {
      setAnalyzing(true); setAnalysisProgress(0); setAnalysisElapsed(0); setAnalysisStage('queued'); setAnalysisStale(true)
      const started = Date.now()
      elapsedTimer = setInterval(() => { if (alive) setAnalysisElapsed(Math.floor((Date.now() - started) / 1000)) }, 1000)
      void (async () => {
        if (pdfDocument.numPages > 80) throw new Error(t('latex.reader.tooLong'))
        const pages: PdfReadingPage[] = []
        let characters = 0
        for (let number = 1; number <= pdfDocument.numPages; number++) {
          const page = await pdfDocument.getPage(number)
          const content = await page.getTextContent()
          if (!alive) return
          const text = pdfPageText(content.items.flatMap(item => 'str' in item ? [item.str] : []))
          pages.push({ page: number, text }); characters += [...text].length
          if (characters > 160_000) throw new Error(t('latex.reader.tooLong'))
          setAnalysisProgress(number)
        }
        if (characters < 40) throw new Error(t('latex.reader.noText'))
        if (!alive) return
        task = startPdfReading(documentId, pages, force)
        unsubscribe = task.subscribe(progress => { if (alive) setAnalysisStage(progress.stage) })
        const result = await task.promise
        if (alive) { setAnalysis(result); setAnalysisStale(false) }
      })().catch(reason => {
        if (alive) setAnalysisError(/command.*latex_ai_pdf_(highlights|progress|cancel).*not found|latex_ai_pdf_highlights.*missing required key (repo|currentFile)|desktop backend.*PDF-only highlighting/i.test(String(reason))
          ? t('latex.reader.desktopUpdate') : String(reason))
      }).finally(() => { clearInterval(elapsedTimer); unsubscribe?.(); if (alive) setAnalyzing(false) })
    }, 500)
    return () => { alive = false; clearTimeout(timer); clearInterval(elapsedTimer); unsubscribe?.(); stopRef.current = null }
  }, [pdfDocument, documentId, enabled, revision, t])

  // Which pages are worth painting, and which page the reader is looking at.
  useEffect(() => {
    const element = viewportRef.current
    if (!element || original || !boxes.length) return
    const observer = new IntersectionObserver(entries => {
      let best: { page: number; ratio: number } | null = null
      const entered: number[] = []
      const left: number[] = []
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.pdfPage)
        if (!page) continue
        if (!entry.isIntersecting) { left.push(page); continue }
        entered.push(page)
        if (!best || entry.intersectionRatio > best.ratio) best = { page, ratio: entry.intersectionRatio }
      }
      if (entered.length || left.length) {
        setVisiblePages(current => {
          const next = new Set(current)
          for (const page of entered) next.add(page)
          for (const page of left) next.delete(page)
          return next
        })
      }
      // A scroll the reader started decides the page indicator; one we started does not.
      if (best && Date.now() > programmaticScrollRef.current) setPageNumber(best.page)
    }, { root: element, rootMargin: '400px 0px', threshold: [0, 0.25, 0.6] })
    for (const node of element.querySelectorAll('[data-pdf-page]')) observer.observe(node)
    return () => observer.disconnect()
  }, [boxes.length, original])

  const scrollToPage = useCallback((page: number): void => {
    const element = viewportRef.current?.querySelector(`[data-pdf-page="${page}"]`)
    if (!element) return
    programmaticScrollRef.current = Date.now() + 700
    setPageNumber(page)
    element.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])

  const changeZoom = useCallback((next: number, anchor?: { x: number; y: number }): void => {
    setZoom(previous => {
      const clamped = Math.min(2.5, Math.max(0.6, Math.round(next * 100) / 100))
      if (clamped === previous) return previous
      const element = viewportRef.current
      if (element) {
        const box = element.getBoundingClientRect()
        const x = anchor ? anchor.x - box.left : element.clientWidth / 2
        const y = anchor ? anchor.y - box.top : element.clientHeight / 2
        zoomAnchorRef.current = { x: element.scrollLeft + x, y: element.scrollTop + y, from: previous, to: clamped }
      }
      return clamped
    })
  }, [])

  // Ctrl and the wheel zooms, keeping whatever is under the pointer where it is.
  useEffect(() => {
    const element = viewportRef.current
    if (!element || original) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const step = event.deltaY < 0 ? 1.1 : 1 / 1.1
      changeZoom(zoomRef.current * step, { x: event.clientX, y: event.clientY })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [changeZoom, original])

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    const element = viewportRef.current
    zoomAnchorRef.current = null
    if (!anchor || !element || !anchor.from) return
    const factor = anchor.to / anchor.from
    element.scrollLeft = anchor.x * factor - (anchor.x - element.scrollLeft)
    element.scrollTop = anchor.y * factor - (anchor.y - element.scrollTop)
  }, [zoom])

  const describeHighlight = useCallback(
    (highlight: { kind: ResearchHighlightKind; reason: string }) => `${t(`latex.reader.${highlight.kind}`)} — ${highlight.reason}`,
    [t]
  )
  const pageHighlights = useMemo(() => {
    const byPage = new Map<number, PdfReadingAnalysis['highlights']>()
    if (!enabled) return byPage
    for (const highlight of analysis?.highlights || []) {
      if (filter && highlight.kind !== filter) continue
      const list = byPage.get(highlight.page)
      if (list) list.push(highlight)
      else byPage.set(highlight.page, [highlight])
    }
    return byPage
  }, [analysis, filter, enabled])

  const toggleHighlights = (): void => {
    setOriginal(false)
    if (enabled) stopRef.current?.()
    setEnabled(value => { try { localStorage.setItem('linco.pdf-ai-highlights', value ? 'off' : 'on') } catch { /* Preference storage unavailable. */ } return !value })
  }
  const relevant = analysis?.highlights.filter(mark => !filter || mark.kind === filter) || []
  return <div className="paper-pdf-reader flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-black/10 bg-canvas px-2 py-1 text-[11px]">
      <button type="button" aria-pressed={enabled && !original} title={t('latex.reader.hint')} onClick={toggleHighlights}
        className={`flex items-center gap-1 rounded px-1.5 py-1 ${enabled && !original ? 'bg-amber-500/10 text-ink' : 'text-ink-muted'}`}>
        <Highlighter size={13} />{t('latex.reader.highlights')}
      </button>
      <span className="flex-1" />
      {!original && <>
        <button aria-label={t('latex.reader.previous')} disabled={pageNumber <= 1} onClick={() => scrollToPage(pageNumber - 1)} className="disabled:opacity-30"><ChevronLeft size={15} /></button>
        <input aria-label={t('latex.reader.page')} type="number" min={1} max={pdfDocument?.numPages || 1} value={pageNumber}
          onChange={event => { const page = Number(event.target.value); if (Number.isInteger(page) && page >= 1 && page <= (pdfDocument?.numPages || 1)) scrollToPage(page) }} className="w-9 rounded text-center" />
        <span>/ {pdfDocument?.numPages || '–'}</span>
        <button aria-label={t('latex.reader.next')} disabled={!pdfDocument || pageNumber >= pdfDocument.numPages} onClick={() => scrollToPage(pageNumber + 1)} className="disabled:opacity-30"><ChevronRight size={15} /></button>
        <button aria-label={t('latex.reader.zoomOut')} disabled={zoom <= 0.6} onClick={() => changeZoom(zoom - 0.2)}><Minus size={13} /></button>
        <button title={t('latex.reader.zoomHint')} onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button aria-label={t('latex.reader.zoomIn')} disabled={zoom >= 2.5} onClick={() => changeZoom(zoom + 0.2)}><Plus size={13} /></button>
      </>}
      <button type="button" aria-pressed={original} onClick={() => setOriginal(v => !v)} className="rounded px-1.5 py-1 text-ink-muted hover:bg-black/5">{t('latex.reader.original')}</button>
    </div>
    {enabled && !original && <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-black/5 bg-canvas px-2 py-1.5 text-[10px]">
      {kinds.map(kind => <button key={kind} type="button" aria-pressed={filter === kind} onClick={() => setFilter(current => current === kind ? null : kind)} className={filter && filter !== kind ? 'opacity-40' : ''}>
        <span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: researchHighlightColors[kind] }} />{t(`latex.reader.${kind}`)}
      </button>)}
      <div className="flex w-full items-center gap-2 text-ink-muted">
        {analyzing ? <span role="status" className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" />{t(analysisProgress < (pdfDocument?.numPages || 0) ? 'latex.reader.extracting' : `latex.reader.stage.${analysisStage}`)} · {analysisElapsed}s</span> :
          !analysis && <span>{t('latex.reader.aiHint')}</span>}
        {analyzing && <button type="button" aria-label={t('latex.reader.cancel')} onClick={() => stopRef.current?.()} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-black/5"><X size={11} />{t('latex.reader.cancel')}</button>}
        <span className="flex-1" />
        <button disabled={analyzing || !pdfDocument} title={t('latex.reader.reanalyze')} aria-label={t('latex.reader.reanalyze')} onClick={() => { forceRef.current = true; setRevision(v => v + 1) }}><RotateCw size={11} /></button>
      </div>
      {analysis && <button onClick={() => setReadingOpen(v => !v)} aria-expanded={readingOpen} className="flex items-center gap-1 text-ink"><Sparkles size={11} />{t('latex.reader.insights', { n: analysis.highlights.length })} · {t(analysisStale ? 'latex.reader.previousAnalysis' : analysis.cached ? 'latex.reader.restored' : 'latex.reader.saved')}</button>}
      <p className="w-full text-ink-faint">{t('latex.reader.local')}</p>
      {analysisStale && analysis && <p className="w-full text-amber-700">{t('latex.reader.stale')}</p>}
      {analysisNotice && <p role="status" className="w-full text-ink-muted">{analysisNotice}</p>}
      {analysisError && <p role="alert" className="w-full select-text text-red-600">{t(analysis ? 'latex.reader.refreshFailed' : 'latex.reader.analysisFailed')} {analysisError}</p>}
      {analysis?.saveWarning && <p role="alert" className="w-full select-text text-amber-700">{analysis.saveWarning}</p>}
    </div>}
    {enabled && readingOpen && !original && analysis && <div className="max-h-[35%] shrink-0 select-text overflow-y-auto border-b border-black/10 bg-canvas px-3 py-2 text-[11px] leading-relaxed">
      <p className="mb-1 text-[10px] text-ink-muted">{analysis.agent}{analysis.model ? ` · ${analysis.model}` : ''} · {new Date(analysis.createdAt).toLocaleString()}</p>
      <p className="text-ink">{analysis.summary}</p>
      <p className="my-2 text-[10px] text-ink-faint">{t('latex.reader.textOnly')}</p>
      {!analysis.highlights.length && <p>{t('latex.reader.noHighlights')}</p>}
      {relevant.map((mark, index) => <div key={index} className="mt-2 border-l-2 pl-2" style={{ borderColor: researchHighlightColors[mark.kind] }}>
        <button onClick={() => scrollToPage(mark.page)} className="text-[10px] font-medium text-ink-muted">{t(`latex.reader.${mark.kind}`)} · {t('latex.reader.page')} {mark.page}</button>
        <blockquote className="text-ink">“{mark.quote}”</blockquote><p className="text-ink-muted">{mark.reason}</p>
      </div>)}
    </div>}
    {original ? <embed src={src} type="application/pdf" className="min-h-0 w-full flex-1" /> :
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto bg-black/[0.06] p-3" style={{ scrollbarGutter: 'stable' }}>
        {error && <div role="alert" className="mb-2 rounded bg-red-500/10 p-2 text-[11px] text-red-700">{t('latex.reader.failed')} {error}</div>}
        {loading && <div role="status" className="sticky top-2 z-10 flex justify-center"><Loader2 size={18} className="animate-spin text-ink-muted" /></div>}
        <div ref={columnRef}>
          {pdfDocument && boxes.map((base, index) => (
            <PdfPageView
              key={index + 1}
              pdfDocument={pdfDocument}
              pageNumber={index + 1}
              base={base}
              columnWidth={width}
              zoom={zoom}
              active={visiblePages.has(index + 1)}
              highlights={pageHighlights.get(index + 1) || NO_HIGHLIGHTS}
              showHighlights={enabled}
              label={t('latex.reader.page')}
              describe={describeHighlight}
              onText={index === 0 ? setTextPresent : undefined}
            />
          ))}
        </div>
        {!loading && !error && <p className="my-2 text-center text-[10px] text-ink-faint">{t(textPresent ? 'latex.reader.caution' : 'latex.reader.noText')}</p>}
      </div>}
  </div>
}
