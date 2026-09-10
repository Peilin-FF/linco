// One page of the continuous PDF column: canvas, selectable text layer, AI marks.
//
// Two details matter for stability. The page box is sized from the page's own
// dimensions before anything renders, so the column's height never changes as
// pages paint and the scrollbar never appears or disappears mid-render. And the
// bitmap is produced on a detached canvas and copied over in one step, because
// assigning width or height to a live canvas blanks it, and the awaits between
// that and the paint are what made zooming flash.
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api'
import { TextLayer } from 'pdfjs-dist'
import { anchorPdfQuote, researchHighlightColors,
  type ResearchHighlight, type ResearchHighlightKind } from '@/lib/pdfResearchHighlights'

export interface PageBox { width: number; height: number }
interface Mark { kind: ResearchHighlightKind; left: number; top: number; width: number; height: number }

/** Scale that fits a page to the available column width at the given zoom. */
export function pageScale(base: PageBox, columnWidth: number, zoom: number): number {
  if (!base.width) return zoom
  return (columnWidth / base.width) * zoom
}

export default function PdfPageView({
  pdfDocument, pageNumber, base, columnWidth, zoom, active, highlights, showHighlights, label, describe, onText
}: {
  pdfDocument: PDFDocumentProxy
  pageNumber: number
  base: PageBox
  columnWidth: number
  zoom: number
  active: boolean
  highlights: ResearchHighlight[]
  showHighlights: boolean
  label: string
  describe: (highlight: ResearchHighlight) => string
  onText?: (present: boolean) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<TextLayer | null>(null)
  const [painted, setPainted] = useState(0)
  const [marks, setMarks] = useState<Mark[]>([])

  const scale = pageScale(base, columnWidth, zoom)
  const width = Math.round(base.width * scale)
  const height = Math.round(base.height * scale)

  useEffect(() => {
    if (!active) return
    let alive = true
    let render: RenderTask | undefined
    let layer: TextLayer | undefined
    void (async () => {
      const page = await pdfDocument.getPage(pageNumber)
      if (!alive) return
      const viewport = page.getViewport({ scale })
      const content = await page.getTextContent()
      if (!alive) return
      const pixels = Math.min(window.devicePixelRatio || 1, 2)

      // Paint detached so the visible canvas keeps the previous frame until this one is ready.
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.floor(viewport.width * pixels)
      offscreen.height = Math.floor(viewport.height * pixels)
      render = page.render({
        canvas: offscreen,
        viewport,
        transform: pixels === 1 ? undefined : [pixels, 0, 0, pixels, 0, 0]
      })

      const textElement = textRef.current
      if (textElement) {
        textElement.replaceChildren()
        textElement.style.setProperty('--total-scale-factor', String(viewport.scale))
        layer = new TextLayer({ textContentSource: content, container: textElement, viewport })
      }
      await Promise.all([render.promise, layer?.render()])
      if (!alive) return

      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = offscreen.width
        canvas.height = offscreen.height
        canvas.getContext('2d')?.drawImage(offscreen, 0, 0)
      }
      offscreen.width = 0
      offscreen.height = 0
      layerRef.current = layer ?? null
      onText?.(content.items.some(item => 'str' in item && item.str.trim().length > 0))
      setPainted(value => value + 1)
    })().catch(reason => {
      // One page that cannot be drawn stays blank rather than breaking the column,
      // but it must not fail silently either.
      if (alive) console.error(`PDF page ${pageNumber} did not render`, reason)
    })
    return () => { alive = false; render?.cancel(); layer?.cancel() }
  }, [pdfDocument, pageNumber, scale, active, onText])

  // Release the bitmap once the page is far from view; the box keeps its size.
  useEffect(() => {
    if (active) return
    const canvas = canvasRef.current
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    textRef.current?.replaceChildren()
    layerRef.current = null
    setMarks([])
  }, [active])

  useEffect(() => {
    const layer = layerRef.current
    const element = textRef.current
    if (!layer || !element || !showHighlights) { setMarks([]); return }
    layer.textDivs.forEach(div => div.removeAttribute('title'))
    const bounds = element.getBoundingClientRect()
    const next: Mark[] = []
    for (const highlight of highlights) {
      for (const anchor of anchorPdfQuote(layer.textContentItemsStr, highlight.quote)) {
        const div = layer.textDivs[anchor.item]
        const node = div?.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE || anchor.to > (node.textContent?.length || 0)) continue
        const range = document.createRange()
        range.setStart(node, anchor.from)
        range.setEnd(node, anchor.to)
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && rect.height > 0) {
            next.push({ kind: highlight.kind, left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height })
          }
        }
        div.title = describe(highlight)
      }
    }
    setMarks(next)
  }, [highlights, showHighlights, painted, describe])

  return (
    <div
      data-pdf-page={pageNumber}
      className="relative mx-auto mb-3 bg-white shadow-sm"
      style={{ width, height }}
      aria-label={`${label} ${pageNumber}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {marks.map((mark, index) => (
          <span
            key={index}
            data-research-highlight={mark.kind}
            className="absolute rounded-sm"
            style={{ left: mark.left, top: mark.top, width: mark.width, height: mark.height, backgroundColor: researchHighlightColors[mark.kind], opacity: 0.3, mixBlendMode: 'multiply' }}
          />
        ))}
      </div>
      <div ref={textRef} className="paper-text-layer" />
    </div>
  )
}
