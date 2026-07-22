import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  FilePlus2,
  FolderOpen,
  Loader2,
  Radio,
  RefreshCw,
  Save
} from 'lucide-react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { baseName, readFile, writeFile } from '@/lib/fs'
import { onRemoteFsChange } from '@/lib/watch'
import { useI18n } from '@/lib/i18n'
import {
  onDrawioLiveCommand,
  respondDrawioLive,
  type DrawioLiveCommand,
  type DrawioLiveCommandEvent,
  type DrawioLiveOperation
} from '@/lib/drawioLive'

interface DrawingViewProps {
  host?: string
  cwd?: string
  onSubmitToAgent?: (text: string) => void
}

type SaveState = 'loading' | 'ready' | 'dirty' | 'saving' | 'saved' | 'error'

interface DrawioMessage {
  event?: string
  xml?: string
  exit?: boolean
  error?: string | null
  data?: unknown
  bounds?: unknown
  modelBounds?: unknown
  scale?: number
  message?: unknown
}

interface PendingEditorRequest {
  event: string
  resolve: (message: DrawioMessage) => void
  reject: (reason: Error) => void
  timer: number
}

interface PendingSave {
  host?: string
  path: string
  revision: number
  xml: string
}

const EMPTY_DIAGRAM =
  '<mxfile host="Linco"><diagram id="linco-page-1" name="Page-1"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'

const pathKey = (host?: string, cwd?: string): string =>
  `linco:drawing:${host || 'local'}:${cwd || ''}`

function joinPath(root: string | undefined, name: string, remote: boolean): string {
  if (!root) return name
  const separator = remote ? '/' : root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`
}

function initialPath(host?: string, cwd?: string): string {
  const fallback = joinPath(cwd, 'diagram.drawio', !!host)
  try {
    return window.localStorage.getItem(pathKey(host, cwd)) || fallback
  } catch {
    return fallback
  }
}

function comparablePath(path: string, remote: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return remote ? normalized : normalized.toLowerCase()
}

function decodeMessage(data: unknown): DrawioMessage | null {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as DrawioMessage
    } catch {
      return null
    }
  }
  return data && typeof data === 'object' ? (data as DrawioMessage) : null
}

function requestIdFromMessage(message: DrawioMessage): string | null {
  if (!message.message || typeof message.message !== 'object') return null
  const echoed = message.message as {
    requestId?: unknown
    message?: { requestId?: unknown }
  }
  const requestId = echoed.requestId ?? echoed.message?.requestId
  return typeof requestId === 'string' ? requestId : null
}

function parseExportPayload(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object') return data as Record<string, unknown>
  if (typeof data !== 'string') throw new Error('draw.io returned no export data')
  let text = data
  if (text.startsWith('data:')) {
    const comma = text.indexOf(',')
    if (comma < 0) throw new Error('draw.io returned an invalid data URI')
    const header = text.slice(0, comma)
    const payload = text.slice(comma + 1)
    text = header.includes(';base64') ? window.atob(payload) : decodeURIComponent(payload)
  }
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object') throw new Error('draw.io returned invalid JSON')
  return parsed as Record<string, unknown>
}

function graphRoot(document: XMLDocument): Element {
  if (document.querySelector('parsererror')) throw new Error('The drawing XML is invalid')
  const model = document.querySelector('mxGraphModel')
  const root = model?.querySelector('root')
  if (!root) throw new Error('The drawing has no editable mxGraphModel')
  return root
}

function directCell(root: Element, id: string): Element | null {
  return (
    Array.from(root.querySelectorAll('mxCell')).find(
      (cell) => cell.getAttribute('id') === id
    ) || null
  )
}

function defaultParentId(root: Element): string {
  const layer = Array.from(root.children).find(
    (child) =>
      child.tagName === 'mxCell' &&
      child.getAttribute('parent') === '0' &&
      child.getAttribute('id') !== '0'
  )
  return layer?.getAttribute('id') || '1'
}

function geometryFor(document: XMLDocument, cell: Element): Element {
  let geometry = Array.from(cell.children).find((child) => child.tagName === 'mxGeometry')
  if (!geometry) {
    geometry = document.createElement('mxGeometry')
    geometry.setAttribute('as', 'geometry')
    cell.appendChild(geometry)
  }
  return geometry
}

function mutateDrawingXml(xml: string, operation: DrawioLiveOperation): string {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const root = graphRoot(document)

  if (operation.type === 'clear') {
    for (const child of Array.from(root.children)) {
      const cell = child.tagName === 'mxCell' ? child : child.querySelector('mxCell')
      const keep =
        cell?.getAttribute('id') === '0' ||
        (cell?.getAttribute('parent') === '0' && !cell.hasAttribute('vertex'))
      if (!keep) child.remove()
    }
  } else if (operation.type === 'shape') {
    if (!operation.id) throw new Error('A live shape requires an id')
    if (directCell(root, operation.id)) throw new Error(`Cell id already exists: ${operation.id}`)
    const cell = document.createElement('mxCell')
    cell.setAttribute('id', operation.id)
    cell.setAttribute('value', operation.label || '')
    cell.setAttribute('style', operation.style || '')
    cell.setAttribute('vertex', '1')
    cell.setAttribute('parent', defaultParentId(root))
    const geometry = geometryFor(document, cell)
    geometry.setAttribute('x', String(operation.x ?? 0))
    geometry.setAttribute('y', String(operation.y ?? 0))
    geometry.setAttribute('width', String(operation.width ?? 120))
    geometry.setAttribute('height', String(operation.height ?? 60))
    root.appendChild(cell)
  } else if (operation.type === 'edge') {
    if (!operation.id || !operation.source || !operation.target) {
      throw new Error('A live edge requires id, source, and target')
    }
    if (directCell(root, operation.id)) throw new Error(`Cell id already exists: ${operation.id}`)
    if (!directCell(root, operation.source) || !directCell(root, operation.target)) {
      throw new Error(`Missing edge endpoint: ${operation.source} -> ${operation.target}`)
    }
    const cell = document.createElement('mxCell')
    cell.setAttribute('id', operation.id)
    cell.setAttribute('value', operation.label || '')
    cell.setAttribute('style', operation.style || '')
    cell.setAttribute('edge', '1')
    cell.setAttribute('parent', defaultParentId(root))
    cell.setAttribute('source', operation.source)
    cell.setAttribute('target', operation.target)
    const geometry = geometryFor(document, cell)
    geometry.setAttribute('relative', '1')
    if (operation.waypoints?.length) {
      const points = document.createElement('Array')
      points.setAttribute('as', 'points')
      for (const waypoint of operation.waypoints) {
        const point = document.createElement('mxPoint')
        point.setAttribute('x', String(waypoint.x))
        point.setAttribute('y', String(waypoint.y))
        points.appendChild(point)
      }
      geometry.appendChild(points)
    }
    root.appendChild(cell)
  } else if (operation.type === 'update') {
    if (!operation.id) throw new Error('A live update requires an id')
    const cell = directCell(root, operation.id)
    if (!cell) throw new Error(`Cell not found: ${operation.id}`)
    if (operation.label !== undefined) cell.setAttribute('value', operation.label)
    if (operation.style !== undefined) cell.setAttribute('style', operation.style)
    if (
      operation.x !== undefined ||
      operation.y !== undefined ||
      operation.width !== undefined ||
      operation.height !== undefined
    ) {
      const geometry = geometryFor(document, cell)
      if (operation.x !== undefined) geometry.setAttribute('x', String(operation.x))
      if (operation.y !== undefined) geometry.setAttribute('y', String(operation.y))
      if (operation.width !== undefined) geometry.setAttribute('width', String(operation.width))
      if (operation.height !== undefined) geometry.setAttribute('height', String(operation.height))
    }
  }

  return new XMLSerializer().serializeToString(document)
}

function drawingLayout(xml: string): Array<Record<string, unknown>> {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const root = graphRoot(document)
  const cells: Array<Record<string, unknown>> = []
  for (const child of Array.from(root.children)) {
    const cell =
      child.tagName === 'mxCell'
        ? child
        : Array.from(child.children).find((item) => item.tagName === 'mxCell')
    const id = cell?.getAttribute('id')
    if (!cell || !id || id === '0') continue
    const geometry = Array.from(cell.children).find(
      (item) => item.tagName === 'mxGeometry'
    )
    const points = geometry
      ? Array.from(geometry.querySelectorAll('Array[as="points"] > mxPoint')).map(
          (point) => ({
            x: Number(point.getAttribute('x') || 0),
            y: Number(point.getAttribute('y') || 0)
          })
        )
      : []
    const style = cell.getAttribute('style') || ''
    const styleRotation = style.match(/(?:^|;)rotation=([-+]?\d+(?:\.\d+)?)(?:;|$)/)
    const rotation = Number(styleRotation?.[1] || 0)
    const x = Number(geometry?.getAttribute('x') || 0)
    const y = Number(geometry?.getAttribute('y') || 0)
    const width = Number(geometry?.getAttribute('width') || 0)
    const height = Number(geometry?.getAttribute('height') || 0)
    const radians = (rotation * Math.PI) / 180
    const visualWidth = Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))
    const visualHeight = Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))
    const visualGeometry = {
      x: x + (width - visualWidth) / 2,
      y: y + (height - visualHeight) / 2,
      width: visualWidth,
      height: visualHeight
    }
    cells.push({
      id,
      type:
        cell.getAttribute('edge') === '1'
          ? 'edge'
          : cell.getAttribute('vertex') === '1'
            ? 'node'
            : 'layer',
      label: child.getAttribute('label') || cell.getAttribute('value') || '',
      parent: cell.getAttribute('parent'),
      source: cell.getAttribute('source'),
      target: cell.getAttribute('target'),
      style,
      rotation,
      visual_geometry: visualGeometry,
      geometry: geometry
        ? {
            x,
            y,
            width,
            height,
            relative: geometry.getAttribute('relative') === '1',
            ...(points.length ? { points } : {})
          }
        : null
    })
  }
  return cells
}

interface LayoutBox {
  x: number
  y: number
  width: number
  height: number
}

function isLayoutBox(value: unknown): value is LayoutBox {
  if (!value || typeof value !== 'object') return false
  const box = value as Partial<LayoutBox>
  return [box.x, box.y, box.width, box.height].every(
    (item) => typeof item === 'number' && Number.isFinite(item)
  )
}

function containsBox(outer: LayoutBox, inner: LayoutBox, tolerance = 1): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  )
}

function overlapArea(left: LayoutBox, right: LayoutBox): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  )
  return width * height
}

function auditDrawingLayout(cells: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = []
  const largeNodes = cells.filter((cell) => {
    if (
      cell.type !== 'node' ||
      !isLayoutBox(cell.geometry) ||
      !isLayoutBox(cell.visual_geometry)
    ) {
      return false
    }
    return cell.geometry.width * cell.geometry.height >= 12000
  })

  for (const cell of largeNodes) {
    const rotation = typeof cell.rotation === 'number' ? cell.rotation : 0
    if (Math.abs(rotation % 180) > 1) {
      warnings.push({
        code: 'rotated-large-shape',
        severity: 'warning',
        cells: [cell.id],
        message: `Large shape ${String(cell.id)} is rotated ${rotation} degrees; verify its visual bounds instead of its raw geometry.`,
        geometry: cell.geometry,
        visual_geometry: cell.visual_geometry
      })
    }
  }

  for (let leftIndex = 0; leftIndex < largeNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < largeNodes.length; rightIndex += 1) {
      const left = largeNodes[leftIndex]
      const right = largeNodes[rightIndex]
      const leftBox = left.visual_geometry as LayoutBox
      const rightBox = right.visual_geometry as LayoutBox
      if (containsBox(leftBox, rightBox) || containsBox(rightBox, leftBox)) continue
      const overlap = overlapArea(leftBox, rightBox)
      const smallerArea = Math.min(
        leftBox.width * leftBox.height,
        rightBox.width * rightBox.height
      )
      if (smallerArea <= 0 || overlap / smallerArea < 0.05) continue
      warnings.push({
        code: 'large-shape-crossing',
        severity: 'warning',
        cells: [left.id, right.id],
        message: `Large shapes ${String(left.id)} and ${String(right.id)} cross without containment.`,
        overlap_area: overlap
      })
    }
  }
  return warnings
}

export default function DrawingView({
  host,
  cwd,
  onSubmitToAgent
}: DrawingViewProps): JSX.Element {
  const { t, lang } = useI18n()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const editorReadyRef = useRef(false)
  const documentReadyRef = useRef(false)
  const xmlRef = useRef(EMPTY_DIAGRAM)
  const pathRef = useRef(initialPath(host, cwd))
  const hostRef = useRef(host)
  const pendingRef = useRef<PendingSave | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const externalTimerRef = useRef<number | null>(null)
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const revisionRef = useRef(0)
  const ownWriteAtRef = useRef(0)
  const loadGenerationRef = useRef(0)
  const editorRequestSeqRef = useRef(0)
  const editorRequestsRef = useRef<Map<string, PendingEditorRequest>>(new Map())
  const liveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const handleLiveCommandRef = useRef<
    (event: DrawioLiveCommandEvent) => Promise<void>
  >(async () => {})

  const [path, setPath] = useState(() => initialPath(host, cwd))
  const [pathDraft, setPathDraft] = useState(path)
  const [frameKey, setFrameKey] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [error, setError] = useState('')
  const [liveActive, setLiveActive] = useState(false)
  const [liveOperation, setLiveOperation] = useState('')
  const [liveOperationCount, setLiveOperationCount] = useState(0)

  const editorUrl = useMemo(() => {
    const params = new URLSearchParams({
      embed: '1',
      proto: 'json',
      spin: '1',
      libraries: '1',
      noSaveBtn: '1',
      noExitBtn: '1',
      suppressNewWindows: '1',
      lang: lang === 'zh' ? 'zh' : 'en'
    })
    return `https://embed.diagrams.net/?${params.toString()}`
  }, [lang])

  const postToEditor = (message: Record<string, unknown>): void => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(message), '*')
  }

  const requestEditor = (
    message: Record<string, unknown>,
    expectedEvent: string,
    timeoutMs = 15000
  ): Promise<DrawioMessage> => {
    const requestId = `linco-drawio-${Date.now()}-${++editorRequestSeqRef.current}`
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        editorRequestsRef.current.delete(requestId)
        reject(new Error(`draw.io did not answer the ${expectedEvent} request`))
      }, timeoutMs)
      editorRequestsRef.current.set(requestId, {
        event: expectedEvent,
        resolve,
        reject,
        timer
      })
      postToEditor({ ...message, requestId })
    })
  }

  const editorLoadMessage = (xml: string): Record<string, unknown> => ({
    action: 'load',
    autosave: 1,
    saveAndExit: '0',
    modified: 'unsavedChanges',
    title: baseName(pathRef.current) || 'diagram.drawio',
    exportProtocol: true,
    xml
  })

  const loadEditorDocument = (): void => {
    if (!editorReadyRef.current || !documentReadyRef.current) return
    postToEditor(editorLoadMessage(xmlRef.current))
  }

  const flushSave = (): void => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    setSaveState('saving')
    writeChainRef.current = writeChainRef.current
      .catch(() => {})
      .then(() => writeFile(pending.path, pending.xml, pending.host))
      .then(() => {
        ownWriteAtRef.current = Date.now()
        if (pending.revision === revisionRef.current && !pendingRef.current) {
          setSaveState('saved')
          setError('')
        }
      })
      .catch((reason: unknown) => {
        setSaveState('error')
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  const queueSave = (xml: string, immediate = false): void => {
    xmlRef.current = xml
    revisionRef.current += 1
    pendingRef.current = {
      host: hostRef.current,
      path: pathRef.current,
      revision: revisionRef.current,
      xml
    }
    setSaveState('dirty')
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    if (immediate) {
      flushSave()
    } else {
      saveTimerRef.current = window.setTimeout(flushSave, 500)
    }
  }

  const openPath = (nextPath: string): void => {
    const trimmed = nextPath.trim()
    if (!trimmed || trimmed === pathRef.current) return
    flushSave()
    pathRef.current = trimmed
    setPath(trimmed)
    setPathDraft(trimmed)
    try {
      window.localStorage.setItem(pathKey(hostRef.current, cwd), trimmed)
    } catch {
      // Local storage is optional; the drawing file remains authoritative.
    }
    documentReadyRef.current = false
    void loadFromDisk(false)
  }

  const loadFromDisk = async (allowBlank: boolean): Promise<void> => {
    const generation = ++loadGenerationRef.current
    const target = pathRef.current
    setSaveState('loading')
    setError('')
    try {
      const xml = await readFile(target, hostRef.current)
      if (generation !== loadGenerationRef.current || target !== pathRef.current) return
      xmlRef.current = xml || EMPTY_DIAGRAM
      documentReadyRef.current = true
      setSaveState('ready')
      loadEditorDocument()
    } catch (reason) {
      if (generation !== loadGenerationRef.current || target !== pathRef.current) return
      if (allowBlank) {
        xmlRef.current = EMPTY_DIAGRAM
        documentReadyRef.current = true
        setSaveState('ready')
        loadEditorDocument()
      } else {
        documentReadyRef.current = false
        setSaveState('error')
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }

  useEffect(() => {
    hostRef.current = host
    const nextPath = initialPath(host, cwd)
    pathRef.current = nextPath
    setPath(nextPath)
    setPathDraft(nextPath)
    documentReadyRef.current = false
    void loadFromDisk(true)
    // loadFromDisk reads all mutable values from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, cwd])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const message = decodeMessage(event.data)
      if (!message?.event) return

      const requestId = requestIdFromMessage(message)
      const pendingEntry = requestId
        ? ([requestId, editorRequestsRef.current.get(requestId)] as const)
        : Array.from(editorRequestsRef.current.entries()).find(
            ([, pending]) => pending.event === message.event
          )
      if (pendingEntry) {
        const [pendingId, pending] = pendingEntry
        if (pending && pending.event === message.event) {
          editorRequestsRef.current.delete(pendingId)
          window.clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message)
        }
      }

      if (message.event === 'init') {
        editorReadyRef.current = true
        loadEditorDocument()
        return
      }

      if ((message.event === 'autosave' || message.event === 'save') && message.xml) {
        queueSave(message.xml, message.event === 'save')
        if (message.event === 'save') {
          postToEditor({ action: 'status', messageKey: 'allChangesSaved', modified: false })
        }
        return
      }

      if (message.event === 'exit' && message.xml) queueSave(message.xml, true)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      for (const pending of editorRequestsRef.current.values()) {
        window.clearTimeout(pending.timer)
        pending.reject(new Error('draw.io editor closed'))
      }
      editorRequestsRef.current.clear()
    }
    // Message handling deliberately uses refs to avoid listener churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    onRemoteFsChange((change) => {
      if (disposed || (change.host || '') !== (hostRef.current || '')) return
      const current = comparablePath(pathRef.current, !!hostRef.current)
      if (!change.paths.some((item) => comparablePath(item, !!hostRef.current) === current)) {
        return
      }
      if (Date.now() - ownWriteAtRef.current < 1200) return
      if (externalTimerRef.current !== null) window.clearTimeout(externalTimerRef.current)
      externalTimerRef.current = window.setTimeout(async () => {
        try {
          const xml = await readFile(pathRef.current, hostRef.current)
          if (xml && xml !== xmlRef.current) {
            xmlRef.current = xml
            revisionRef.current += 1
            setSaveState('ready')
            loadEditorDocument()
          }
        } catch {
          // A rename often arrives as delete + create; the next event retries it.
        }
      }, 250)
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
      if (externalTimerRef.current !== null) window.clearTimeout(externalTimerRef.current)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      const pending = pendingRef.current
      if (pending) {
        void writeChainRef.current
          .catch(() => {})
          .then(() => writeFile(pending.path, pending.xml, pending.host))
          .catch(() => {})
      }
    }
  }, [])

  const chooseFile = async (): Promise<void> => {
    if (host) {
      document.getElementById('drawing-path')?.focus()
      return
    }
    const selected = await openDialog({
      multiple: false,
      directory: false,
      defaultPath: path,
      filters: [{ name: 'draw.io', extensions: ['drawio', 'xml'] }]
    })
    if (typeof selected === 'string') openPath(selected)
  }

  const createDrawing = async (): Promise<void> => {
    let target: string | null
    if (host) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
      target = joinPath(cwd, `diagram-${stamp}.drawio`, true)
    } else {
      target = await saveDialog({
        defaultPath: joinPath(cwd, 'diagram.drawio', false),
        filters: [{ name: 'draw.io', extensions: ['drawio'] }]
      })
    }
    if (!target) return
    flushSave()
    pathRef.current = target
    setPath(target)
    setPathDraft(target)
    try {
      window.localStorage.setItem(pathKey(hostRef.current, cwd), target)
    } catch {
      // Local storage is optional; the drawing file remains authoritative.
    }
    xmlRef.current = EMPTY_DIAGRAM
    documentReadyRef.current = true
    loadEditorDocument()
    queueSave(EMPTY_DIAGRAM, true)
  }

  const reloadEditor = (): void => {
    editorReadyRef.current = false
    documentReadyRef.current = false
    setFrameKey((value) => value + 1)
    void loadFromDisk(true)
  }

  const waitForEditor = async (timeoutMs = 15000): Promise<void> => {
    const started = Date.now()
    while (!editorReadyRef.current || !documentReadyRef.current) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('The draw.io editor is not ready')
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    }
  }

  const exportCanvasModel = async (): Promise<{
    xml: string
    model: Record<string, unknown>
  }> => {
    await waitForEditor()
    const response = await requestEditor(
      {
        action: 'export',
        format: 'json',
        includeData: true,
        compressed: false,
        allPages: true
      },
      'export',
      30000
    )
    const model = parseExportPayload(response.data)
    const exportedXml = typeof model.data === 'string' ? model.data : response.xml
    if (!exportedXml) throw new Error('draw.io did not return editable XML')
    return { xml: exportedXml, model }
  }

  const loadLiveXml = async (xml: string): Promise<void> => {
    await waitForEditor()
    await requestEditor(editorLoadMessage(xml), 'load', 20000)
    xmlRef.current = xml
    queueSave(xml)
  }

  const openLivePath = async (filePath?: string): Promise<void> => {
    const target = filePath?.trim()
    if (target && target !== pathRef.current) {
      flushSave()
      pathRef.current = target
      setPath(target)
      setPathDraft(target)
      try {
        window.localStorage.setItem(pathKey(hostRef.current, cwd), target)
      } catch {
        // The file path is still held by the active drawing session.
      }
      documentReadyRef.current = false
      await loadFromDisk(true)
    }
    await waitForEditor()
  }

  const modelSummary = (
    xml: string,
    model: Record<string, unknown>,
    maxCells = 500
  ): Record<string, unknown> => {
    const pages = Array.isArray(model.pages) ? model.pages : []
    const cells = pages.flatMap((page) => {
      if (!page || typeof page !== 'object') return []
      const pageCells = (page as { cells?: unknown }).cells
      return Array.isArray(pageCells) ? pageCells : []
    })
    const topologyById = new Map(
      cells
        .filter((cell): cell is Record<string, unknown> => !!cell && typeof cell === 'object')
        .map((cell) => [String(cell.id || ''), cell])
    )
    const layout = drawingLayout(xml).map((cell) => ({
      ...topologyById.get(String(cell.id || '')),
      ...cell
    }))
    const layoutWarnings = auditDrawingLayout(layout)
    return {
      path: pathRef.current,
      graph_ready: editorReadyRef.current && documentReadyRef.current,
      pages: pages.length,
      total: layout.length,
      cells: layout.slice(0, maxCells),
      truncated: layout.length > maxCells,
      layout_warnings: layoutWarnings,
      layout_warning_count: layoutWarnings.length,
      control_scope: 'Linco draw.io embed API only'
    }
  }

  const applyLiveOperation = async (
    operation: DrawioLiveOperation
  ): Promise<Record<string, unknown>> => {
    if (operation.type === 'wait') {
      const ms = Math.max(0, Math.min(10000, operation.ms ?? 0))
      await new Promise((resolve) => window.setTimeout(resolve, ms))
      return { type: 'wait', waited_ms: ms }
    }
    if (operation.type === 'fit') {
      const response = await requestEditor(
        {
          action: 'fit',
          border: 24,
          maxScale:
            operation.zoom_percent === undefined
              ? 1
              : Math.max(0.1, Math.min(8, operation.zoom_percent / 100))
        },
        'fit'
      )
      return {
        type: 'fit',
        scale: response.scale,
        bounds: response.modelBounds || response.bounds
      }
    }

    const snapshot = await exportCanvasModel()
    const nextXml = mutateDrawingXml(snapshot.xml, operation)
    await loadLiveXml(nextXml)
    return {
      type: operation.type,
      id: operation.id,
      path: pathRef.current,
      visible: true
    }
  }

  const screenshotLiveCanvas = async (width = 1600): Promise<Record<string, unknown>> => {
    const response = await requestEditor(
      {
        action: 'export',
        format: 'png',
        width: Math.max(200, Math.min(4000, width)),
        border: 16,
        currentPage: true,
        transparent: false
      },
      'export',
      30000
    )
    if (typeof response.data !== 'string') throw new Error('draw.io did not return a PNG')
    const comma = response.data.indexOf(',')
    return {
      data: comma >= 0 ? response.data.slice(comma + 1) : response.data,
      mime_type: 'image/png',
      path: pathRef.current,
      bounds: response.modelBounds || response.bounds,
      scale: response.scale
    }
  }

  const executeLiveCommand = async (
    command: DrawioLiveCommand
  ): Promise<Record<string, unknown>> => {
    if (command.type === 'launch') {
      await openLivePath(command.file_path)
      setLiveActive(true)
      setLiveOperation('ready')
      const snapshot = await exportCanvasModel()
      return modelSummary(snapshot.xml, snapshot.model, 0)
    }
    if (command.type === 'status') {
      const snapshot = await exportCanvasModel()
      return {
        ...modelSummary(snapshot.xml, snapshot.model, 0),
        live: liveActive,
        operations_applied: liveOperationCount
      }
    }
    if (command.type === 'operation') {
      if (!command.operation) throw new Error('Missing live drawing operation')
      setLiveActive(true)
      setLiveOperation(command.operation.type)
      const result = await applyLiveOperation(command.operation)
      setLiveOperationCount((count) => count + 1)
      return result
    }
    if (command.type === 'inspect') {
      const snapshot = await exportCanvasModel()
      return modelSummary(snapshot.xml, snapshot.model, command.max_cells || 500)
    }
    if (command.type === 'screenshot') {
      return screenshotLiveCanvas(command.width)
    }
    if (command.type === 'save') {
      const snapshot = await exportCanvasModel()
      const outputPath = command.output_path?.trim() || pathRef.current
      await writeFile(outputPath, snapshot.xml, hostRef.current)
      ownWriteAtRef.current = Date.now()
      if (outputPath === pathRef.current) {
        xmlRef.current = snapshot.xml
        revisionRef.current += 1
        pendingRef.current = null
        setSaveState('saved')
      }
      setLiveOperation('saved')
      return {
        output_path: outputPath,
        bytes: new TextEncoder().encode(snapshot.xml).byteLength,
        saved_from_visible_session: true
      }
    }
    throw new Error(`Unsupported draw.io Live command: ${command.type}`)
  }

  handleLiveCommandRef.current = async (event: DrawioLiveCommandEvent): Promise<void> => {
    try {
      const result = await executeLiveCommand(event.command)
      setError('')
      await respondDrawioLive(event.id, result)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setLiveOperation('error')
      setError(message)
      await respondDrawioLive(event.id, undefined, message).catch(() => {})
    }
  }

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    onDrawioLiveCommand((event) => {
      if (disposed) return
      liveQueueRef.current = liveQueueRef.current
        .catch(() => {})
        .then(() => handleLiveCommandRef.current(event))
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const submitToAgent = (): void => {
    if (!onSubmitToAgent) return
    onSubmitToAgent(t('drawing.agentPrompt', { path: pathRef.current }))
  }

  const stateLabel = error
    ? t('drawing.status.error')
    : t(`drawing.status.${saveState}`)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-black/8 px-2">
        <button
          onClick={() => void createDrawing()}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('drawing.new')}
        >
          <FilePlus2 size={15} />
        </button>
        <button
          onClick={() => void chooseFile()}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={host ? t('drawing.openRemote') : t('drawing.open')}
        >
          <FolderOpen size={15} />
        </button>
        <button
          onClick={() => queueSave(xmlRef.current, true)}
          disabled={!documentReadyRef.current}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink disabled:opacity-35"
          title={t('common.save')}
        >
          <Save size={15} />
        </button>
        <button
          onClick={reloadEditor}
          className="rounded-md p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink"
          title={t('drawing.reload')}
        >
          <RefreshCw size={15} />
        </button>
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            openPath(pathDraft)
          }}
        >
          <input
            id="drawing-path"
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onBlur={() => openPath(pathDraft)}
            spellCheck={false}
            aria-label={t('drawing.path')}
            className="h-7 w-full min-w-0 rounded-md border border-black/8 bg-sidebar/70 px-2 font-mono text-[11px] text-ink outline-none focus:border-accent/40 focus:bg-canvas"
          />
        </form>
        {liveActive && (
          <span
            className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-emerald-50 px-1.5 text-[11px] text-emerald-700 ring-1 ring-emerald-200"
            title={t('drawing.live.hint')}
          >
            <Radio
              size={12}
              className={
                liveOperation !== 'ready' &&
                liveOperation !== 'saved' &&
                liveOperation !== 'error'
                  ? 'animate-pulse'
                  : ''
              }
            />
            <span>{t('drawing.live')}</span>
            <span className="font-mono text-[10px] text-emerald-600">
              {liveOperationCount}
            </span>
          </span>
        )}
        <span
          className={`flex shrink-0 items-center gap-1 text-[11px] ${
            error ? 'text-red-500' : 'text-ink-faint'
          }`}
          title={error || stateLabel}
        >
          {(saveState === 'loading' || saveState === 'saving') && (
            <Loader2 size={12} className="animate-spin" />
          )}
          <span className="hidden 2xl:inline">{stateLabel}</span>
        </span>
        {onSubmitToAgent && (
          <button
            onClick={submitToAgent}
            className="ml-1 flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/10"
            title={t('drawing.submitToAgent.hint')}
          >
            <Bot size={15} />
            <span>{t('drawing.submitToAgent')}</span>
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white [contain:strict]">
        <iframe
          key={`${frameKey}:${editorUrl}`}
          ref={iframeRef}
          title={t('drawing.editorTitle')}
          src={editorUrl}
          className="absolute inset-0 h-full w-full border-0 bg-white [backface-visibility:hidden] [transform:translateZ(0)]"
          allow="clipboard-read; clipboard-write"
        />
        {saveState === 'error' && error && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 rounded-md bg-red-50 px-3 py-2 text-center text-[11px] text-red-700 shadow-sm ring-1 ring-red-200">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
