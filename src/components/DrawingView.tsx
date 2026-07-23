import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  Bot,
  Circle as CircleIcon,
  ExternalLink,
  Loader2,
  MessageSquareText,
  MousePointer2,
  Pencil,
  Presentation,
  RefreshCw,
  Trash2,
  Undo2
} from 'lucide-react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { useI18n } from '@/lib/i18n'

interface DrawingViewProps {
  host?: string
  cwd?: string
  onSubmitToAgent?: (text: string) => void
}

interface PowerPointLiveStatus {
  ready: boolean
  file_path: string
  preview_path: string
  slide_index: number
  slide_count: number
  shape_count: number
  slide_width: number
  slide_height: number
  canvas_preset: string
  preview_pixel_width: number
  preview_pixel_height: number
  updated_at: number
}

interface Point {
  x: number
  y: number
}

interface AnnotationBase {
  id: string
  color: string
  width: number
}

interface PenAnnotation extends AnnotationBase {
  type: 'pen'
  points: Point[]
}

interface EllipseAnnotation extends AnnotationBase {
  type: 'ellipse'
  start: Point
  end: Point
}

interface TextAnnotation extends AnnotationBase {
  type: 'text'
  point: Point
  text: string
}

type Annotation = PenAnnotation | EllipseAnnotation | TextAnnotation
type DraftAnnotation = PenAnnotation | EllipseAnnotation
type AnnotationTool = 'pointer' | 'pen' | 'ellipse' | 'text'

interface TextEditorState {
  id: string
  point: Point
  color: string
  value: string
}

const ANNOTATION_COLORS = ['#dc2626', '#2563eb', '#059669', '#111827'] as const
const ANNOTATION_WIDTH = 0.004

function joinPath(root: string | undefined, name: string): string {
  if (!root) return name
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`
}

function pointsToMillimeters(points: number): number {
  return Math.round((points / 72) * 25.4)
}

function annotationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function pointerPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: clamp((event.clientX - bounds.left) / Math.max(bounds.width, 1)),
    y: clamp((event.clientY - bounds.top) / Math.max(bounds.height, 1))
  }
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

function wrapComment(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    const tokens = paragraph.match(/\S+\s*/g) || [paragraph]
    for (const token of tokens) {
      const candidate = line + token
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line.trimEnd())
        line = ''
      }
      if (context.measureText(token).width <= maxWidth) {
        line += token
        continue
      }
      for (const character of Array.from(token)) {
        const characterCandidate = line + character
        if (line && context.measureText(characterCandidate).width > maxWidth) {
          lines.push(line.trimEnd())
          line = character
        } else {
          line = characterCandidate
        }
      }
    }
    if (line) lines.push(line.trimEnd())
  }
  return lines.slice(0, 8)
}

function drawAnnotation(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  annotation: Annotation
): void {
  const scale = Math.min(canvasWidth, canvasHeight)
  const lineWidth = Math.max(2, annotation.width * scale)
  context.save()
  context.strokeStyle = annotation.color
  context.fillStyle = annotation.color
  context.lineWidth = lineWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'

  if (annotation.type === 'pen') {
    if (annotation.points.length === 1) {
      const point = annotation.points[0]
      context.beginPath()
      context.arc(point.x * canvasWidth, point.y * canvasHeight, lineWidth / 2, 0, Math.PI * 2)
      context.fill()
    } else if (annotation.points.length > 1) {
      context.beginPath()
      annotation.points.forEach((point, index) => {
        const x = point.x * canvasWidth
        const y = point.y * canvasHeight
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
    }
  } else if (annotation.type === 'ellipse') {
    const left = Math.min(annotation.start.x, annotation.end.x) * canvasWidth
    const top = Math.min(annotation.start.y, annotation.end.y) * canvasHeight
    const width = Math.abs(annotation.end.x - annotation.start.x) * canvasWidth
    const height = Math.abs(annotation.end.y - annotation.start.y) * canvasHeight
    context.beginPath()
    context.ellipse(
      left + width / 2,
      top + height / 2,
      Math.max(width / 2, lineWidth),
      Math.max(height / 2, lineWidth),
      0,
      0,
      Math.PI * 2
    )
    context.stroke()
  } else {
    const fontSize = Math.max(13, canvasHeight * 0.026)
    const padding = fontSize * 0.55
    const lineHeight = fontSize * 1.28
    const maxTextWidth = canvasWidth * 0.32
    context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    const lines = wrapComment(context, annotation.text, maxTextWidth)
    const textWidth = Math.max(fontSize * 4, ...lines.map((line) => context.measureText(line).width))
    const boxWidth = Math.min(maxTextWidth + padding * 2, textWidth + padding * 2)
    const boxHeight = Math.max(lineHeight + padding * 2, lines.length * lineHeight + padding * 2)
    const requestedX = annotation.point.x * canvasWidth
    const requestedY = annotation.point.y * canvasHeight
    const x = Math.min(requestedX, canvasWidth - boxWidth - lineWidth)
    const y = Math.min(requestedY, canvasHeight - boxHeight - lineWidth)

    roundedRect(context, Math.max(lineWidth, x), Math.max(lineWidth, y), boxWidth, boxHeight, fontSize * 0.35)
    context.fillStyle = 'rgba(255, 250, 225, 0.97)'
    context.fill()
    context.strokeStyle = annotation.color
    context.lineWidth = Math.max(1.5, lineWidth * 0.65)
    context.stroke()
    context.fillStyle = annotation.color
    context.textBaseline = 'top'
    lines.forEach((line, index) => {
      context.fillText(
        line,
        Math.max(lineWidth, x) + padding,
        Math.max(lineWidth, y) + padding + index * lineHeight,
        maxTextWidth
      )
    })
  }
  context.restore()
}

function renderAnnotations(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  annotations: Annotation[]
): void {
  for (const annotation of annotations) {
    drawAnnotation(context, width, height, annotation)
  }
}

function AnnotationToolButton({
  active,
  disabled = false,
  title,
  onClick,
  children
}: {
  active?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-30 ${
        active === true ? 'bg-ink text-white' : 'text-ink-muted hover:bg-black/7 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

export default function DrawingView({
  host,
  cwd,
  onSubmitToAgent
}: DrawingViewProps): JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<PowerPointLiveStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [tool, setTool] = useState<AnnotationTool>('pointer')
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0])
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [draft, setDraft] = useState<DraftAnnotation | null>(null)
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const annotationStore = useRef(new Map<string, Annotation[]>())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await invoke<PowerPointLiveStatus | null>('powerpoint_live_status')
      setStatus((current) =>
        current?.updated_at === next?.updated_at && current?.ready === next?.ready
          ? current
          : next
      )
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const poll = async (): Promise<void> => {
      if (!disposed) await refresh()
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [refresh])

  const targetPath = joinPath(cwd, 'figure.pptx')
  const presentationPath = status?.file_path || targetPath
  const slideIndex = status?.slide_index || 1
  const slideKey = `${presentationPath}\n${slideIndex}`

  useEffect(() => {
    setAnnotations(annotationStore.current.get(slideKey) || [])
    setDraft(null)
    setTextEditor(null)
  }, [slideKey])

  const replaceAnnotations = useCallback(
    (next: Annotation[]): void => {
      annotationStore.current.set(slideKey, next)
      setAnnotations(next)
    },
    [slideKey]
  )

  const updateAnnotations = useCallback(
    (update: (current: Annotation[]) => Annotation[]): void => {
      setAnnotations((current) => {
        const next = update(current)
        annotationStore.current.set(slideKey, next)
        return next
      })
    },
    [slideKey]
  )

  const visibleAnnotations = draft ? [...annotations, draft] : annotations
  const renderVisibleCanvas = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const bounds = canvas.getBoundingClientRect()
    if (bounds.width < 1 || bounds.height < 1) return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const pixelWidth = Math.round(bounds.width * pixelRatio)
    const pixelHeight = Math.round(bounds.height * pixelRatio)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, bounds.width, bounds.height)
    renderAnnotations(context, bounds.width, bounds.height, visibleAnnotations)
  }, [visibleAnnotations])

  useEffect(() => {
    renderVisibleCanvas()
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(renderVisibleCanvas)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [renderVisibleCanvas])

  const activate = async (): Promise<void> => {
    try {
      await invoke('powerpoint_live_activate')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const commitTextEditor = useCallback((): void => {
    if (!textEditor) return
    const value = textEditor.value.trim()
    if (value) {
      updateAnnotations((current) => {
        if (current.some((annotation) => annotation.id === textEditor.id)) return current
        return [
          ...current,
          {
            id: textEditor.id,
            type: 'text',
            point: textEditor.point,
            text: value,
            color: textEditor.color,
            width: ANNOTATION_WIDTH
          }
        ]
      })
    }
    setTextEditor(null)
  }, [textEditor, updateAnnotations])

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || tool === 'pointer') return
    const point = pointerPoint(event)
    if (tool === 'text') {
      event.preventDefault()
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraft(
      tool === 'pen'
        ? {
            id: annotationId(),
            type: 'pen',
            points: [point],
            color,
            width: ANNOTATION_WIDTH
          }
        : {
            id: annotationId(),
            type: 'ellipse',
            start: point,
            end: point,
            color,
            width: ANNOTATION_WIDTH
          }
    )
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!draft) return
    event.preventDefault()
    const point = pointerPoint(event)
    setDraft((current) => {
      if (!current) return null
      if (current.type === 'pen') {
        const previous = current.points[current.points.length - 1]
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0015) {
          return current
        }
        return { ...current, points: [...current.points, point] }
      }
      return { ...current, end: point }
    })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!draft) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const completed = draft
    setDraft(null)
    const meaningful =
      completed.type === 'pen'
        ? completed.points.length > 1
        : Math.abs(completed.end.x - completed.start.x) > 0.006 &&
          Math.abs(completed.end.y - completed.start.y) > 0.006
    if (meaningful) updateAnnotations((current) => [...current, completed])
  }

  const handleCanvasClick = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (tool !== 'text') return
    event.preventDefault()
    commitTextEditor()
    setTextEditor({ id: annotationId(), point: pointerPoint(event), color, value: '' })
  }

  const exportAnnotatedPng = (snapshot: Annotation[]): string => {
    const image = imageRef.current
    const width = status?.preview_pixel_width || image?.naturalWidth || 1600
    const height = status?.preview_pixel_height || image?.naturalHeight || 1011

    const createCanvas = (includePreview: boolean): HTMLCanvasElement => {
      const output = document.createElement('canvas')
      output.width = width
      output.height = height
      const context = output.getContext('2d')
      if (!context) throw new Error('Canvas 2D is unavailable')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      if (includePreview && image?.complete && image.naturalWidth > 0) {
        context.drawImage(image, 0, 0, width, height)
      }
      renderAnnotations(context, width, height, snapshot)
      return output
    }

    try {
      return createCanvas(true).toDataURL('image/png').split(',', 2)[1]
    } catch {
      return createCanvas(false).toDataURL('image/png').split(',', 2)[1]
    }
  }

  const submitToAgent = async (): Promise<void> => {
    if (!onSubmitToAgent || submitting) return
    let snapshot = annotations
    const pendingComment = textEditor?.value.trim()
    if (textEditor && pendingComment && !snapshot.some((item) => item.id === textEditor.id)) {
      snapshot = [
        ...snapshot,
        {
          id: textEditor.id,
          type: 'text',
          point: textEditor.point,
          text: pendingComment,
          color: textEditor.color,
          width: ANNOTATION_WIDTH
        }
      ]
      replaceAnnotations(snapshot)
      setTextEditor(null)
    }

    if (snapshot.length === 0) {
      onSubmitToAgent(t('drawing.powerpoint.agentPrompt', { path: presentationPath }))
      return
    }

    setSubmitting(true)
    try {
      const pngBase64 = exportAnnotatedPng(snapshot)
      const annotationPath = await invoke<string>('powerpoint_live_save_annotation', {
        presentationPath,
        slideIndex,
        pngBase64
      })
      const comments = snapshot
        .filter((annotation): annotation is TextAnnotation => annotation.type === 'text')
        .map((annotation, index) => `${index + 1}. ${annotation.text}`)
        .join('\n')
      const markCount = snapshot.filter((annotation) => annotation.type !== 'text').length
      onSubmitToAgent(
        t('drawing.powerpoint.annotationAgentPrompt', {
          path: presentationPath,
          slide: slideIndex,
          preview: status?.preview_path || '',
          annotation: annotationPath,
          comments: comments || t('drawing.annotation.noTextComments'),
          marks: markCount
        })
      )
      setTool('pointer')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const previewUrl = status?.preview_path
    ? `${convertFileSrc(status.preview_path)}?v=${status.updated_at}`
    : ''
  const canvasSize = status
    ? `${pointsToMillimeters(status.slide_width)} × ${pointsToMillimeters(status.slide_height)} mm`
    : '182 × 115 mm'

  if (host) {
    return (
      <div className="flex h-full items-center justify-center bg-white px-8 text-center text-sm text-ink-muted">
        {t('drawing.powerpoint.remoteUnsupported')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-canvas shadow-card ring-1 ring-black/5">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/8 px-2">
        <Presentation size={16} className="shrink-0 text-ink-muted" />
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('drawing.powerpoint.refresh')}
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={() => void activate()}
          disabled={!status?.ready}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink disabled:opacity-35"
          title={t('drawing.powerpoint.open')}
        >
          <ExternalLink size={15} />
        </button>
        <div className="min-w-0 flex-1 truncate rounded-md border border-black/8 bg-sidebar/70 px-2 py-1 font-mono text-[11px] text-ink-muted">
          {presentationPath}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{canvasSize}</span>
        {status && (
          <span className="shrink-0 text-[11px] text-ink-faint">
            {t('drawing.powerpoint.slideStatus', {
              slide: status.slide_index,
              total: status.slide_count,
              shapes: status.shape_count
            })}
          </span>
        )}
        {onSubmitToAgent && (
          <button
            type="button"
            onClick={() => void submitToAgent()}
            disabled={submitting}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:opacity-45"
            title={t('drawing.submitToAgent.hint')}
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}
            <span>{t('drawing.submitToAgent')}</span>
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto bg-[#f3f4f6] p-5">
        {previewUrl ? (
          <>
            <div className="sticky left-2 top-0 z-20 flex w-max items-center gap-1 rounded-lg bg-white/95 p-1 shadow-md ring-1 ring-black/10 backdrop-blur-sm">
              <AnnotationToolButton
                active={tool === 'pointer'}
                title={t('drawing.annotation.pointer')}
                onClick={() => setTool('pointer')}
              >
                <MousePointer2 size={15} />
              </AnnotationToolButton>
              <AnnotationToolButton
                active={tool === 'pen'}
                title={t('drawing.annotation.pen')}
                onClick={() => setTool('pen')}
              >
                <Pencil size={15} />
              </AnnotationToolButton>
              <AnnotationToolButton
                active={tool === 'ellipse'}
                title={t('drawing.annotation.ellipse')}
                onClick={() => setTool('ellipse')}
              >
                <CircleIcon size={15} />
              </AnnotationToolButton>
              <AnnotationToolButton
                active={tool === 'text'}
                title={t('drawing.annotation.comment')}
                onClick={() => setTool('text')}
              >
                <MessageSquareText size={15} />
              </AnnotationToolButton>
              <div className="mx-0.5 h-5 w-px bg-black/10" />
              {ANNOTATION_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={t('drawing.annotation.color')}
                  aria-pressed={color === value}
                  title={t('drawing.annotation.color')}
                  onClick={() => setColor(value)}
                  className={`h-4 w-4 rounded-full ring-offset-1 transition-shadow ${
                    color === value ? 'ring-2 ring-ink/70' : 'ring-1 ring-black/15 hover:ring-black/40'
                  }`}
                  style={{ backgroundColor: value }}
                />
              ))}
              <div className="mx-0.5 h-5 w-px bg-black/10" />
              <AnnotationToolButton
                disabled={annotations.length === 0}
                title={t('drawing.annotation.undo')}
                onClick={() => updateAnnotations((current) => current.slice(0, -1))}
              >
                <Undo2 size={15} />
              </AnnotationToolButton>
              <AnnotationToolButton
                disabled={annotations.length === 0}
                title={t('drawing.annotation.clear')}
                onClick={() => replaceAnnotations([])}
              >
                <Trash2 size={15} />
              </AnnotationToolButton>
            </div>
            <div className="flex min-h-full items-center justify-center pt-3">
              <div className="relative inline-block max-h-full max-w-full leading-none shadow-md ring-1 ring-black/10">
                <img
                  ref={imageRef}
                  src={previewUrl}
                  crossOrigin="anonymous"
                  alt={t('drawing.powerpoint.previewAlt')}
                  className="block max-h-full max-w-full bg-white object-contain"
                  style={{ aspectRatio: `${status?.slide_width || 516} / ${status?.slide_height || 326}` }}
                  onLoad={renderVisibleCanvas}
                  onError={() => setError(t('drawing.powerpoint.previewError'))}
                />
                <canvas
                  ref={canvasRef}
                  data-testid="powerpoint-annotation-canvas"
                  className={`absolute inset-0 h-full w-full ${
                    tool === 'pointer' ? 'pointer-events-none' : 'cursor-crosshair'
                  }`}
                  style={{ touchAction: tool === 'pointer' ? 'auto' : 'none' }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onClick={handleCanvasClick}
                />
                {textEditor && (
                  <textarea
                    autoFocus
                    value={textEditor.value}
                    aria-label={t('drawing.annotation.commentPlaceholder')}
                    placeholder={t('drawing.annotation.commentPlaceholder')}
                    onChange={(event) =>
                      setTextEditor((current) =>
                        current ? { ...current, value: event.target.value } : null
                      )
                    }
                    onBlur={commitTextEditor}
                    onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setTextEditor(null)
                      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault()
                        commitTextEditor()
                      }
                    }}
                    className="absolute z-10 min-h-20 w-[min(240px,38%)] resize-none rounded-md border-2 bg-[#fffbe8] px-2 py-1.5 text-[13px] leading-5 text-ink shadow-lg outline-none placeholder:text-ink-faint"
                    style={{
                      left: `${Math.min(textEditor.point.x, 0.6) * 100}%`,
                      top: `${Math.min(textEditor.point.y, 0.72) * 100}%`,
                      borderColor: textEditor.color
                    }}
                  />
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex min-h-full flex-col items-center justify-center gap-3 text-center text-ink-muted">
            <Presentation size={36} strokeWidth={1.5} />
            <div className="text-sm font-medium text-ink">{t('drawing.powerpoint.waiting')}</div>
            <div className="max-w-md text-xs leading-5">{t('drawing.powerpoint.waitingHint')}</div>
          </div>
        )}
        {error && (
          <div className="absolute bottom-3 left-1/2 z-30 max-w-[80%] -translate-x-1/2 rounded-md bg-red-50 px-3 py-2 text-center text-[11px] text-red-700 shadow-sm ring-1 ring-red-200">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
