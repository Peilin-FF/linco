import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  FilePlus2,
  FolderOpen,
  Loader2,
  RefreshCw,
  Save
} from 'lucide-react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { baseName, readFile, writeFile } from '@/lib/fs'
import { onRemoteFsChange } from '@/lib/watch'
import { useI18n } from '@/lib/i18n'

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

  const [path, setPath] = useState(() => initialPath(host, cwd))
  const [pathDraft, setPathDraft] = useState(path)
  const [frameKey, setFrameKey] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [error, setError] = useState('')

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

  const loadEditorDocument = (): void => {
    if (!editorReadyRef.current || !documentReadyRef.current) return
    postToEditor({
      action: 'load',
      autosave: 1,
      saveAndExit: '0',
      modified: 'unsavedChanges',
      title: baseName(pathRef.current) || 'diagram.drawio',
      xml: xmlRef.current
    })
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
    return () => window.removeEventListener('message', onMessage)
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
