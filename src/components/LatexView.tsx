import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudDownload,
  CloudUpload,
  Code2,
  Eye,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderGit2,
  FolderOpen,
  ListTree,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  X
} from 'lucide-react'
import LatexVisualEditor, {
  type LatexEditorMode
} from './latex/LatexVisualEditor'
import {
  baseName,
  invalidateFile,
  listDir,
  parentDir,
  readBytes,
  readFile,
  writeFile
} from '@/lib/fs'
import { onRemoteFsChange } from '@/lib/watch'
import {
  compileLatex,
  type LatexPolishMode,
  overleafClone,
  overleafProjectInfo,
  overleafPublish,
  overleafPull,
  overleafStoreToken,
  reviewLatex,
  suggestLatex,
  type LatexReviewSegment,
  type LatexCompileResult,
  type OverleafProjectInfo
} from '@/lib/latex'
import {
  chooseLatexMainDocument,
  type LatexProjectTextFile
} from '@/lib/latexProject'
import { useI18n } from '@/lib/i18n'

interface LatexViewProps {
  host?: string
  cwd?: string
  active?: boolean
  onSubmitToAgent?: (text: string) => void
}

interface ProjectFile {
  name: string
  path: string
  relative: string
  depth: number
  kind: 'tex' | 'bib' | 'style' | 'image'
}

interface ProjectFolderNode {
  type: 'folder'
  name: string
  relative: string
  children: ProjectTreeNode[]
}

interface ProjectFileNode {
  type: 'file'
  file: ProjectFile
}

type ProjectTreeNode = ProjectFolderNode | ProjectFileNode

interface LatexOutlineItem {
  id: string
  title: string
  level: number
  offset: number
}

const ROOT_INSPECTION_LIMIT = 16
const EDITOR_PANE_MIN_WIDTH = 480
const EDITOR_PANE_MAX_WIDTH = 1_200
const PDF_PANE_MIN_WIDTH = 340
const editorPaneWidthMemory = { value: 620 }

type Engine = 'pdflatex' | 'xelatex' | 'lualatex'

const TEXT_EXTENSIONS = new Set(['tex', 'bib', 'sty', 'cls', 'bst'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'svg', 'eps'])
const SKIP_DIRECTORIES = new Set(['.git', '.linco-latex', 'node_modules', 'build', 'dist'])

function joinPath(root: string, child: string, remote: boolean): string {
  const separator = remote ? '/' : root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${child}`
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = path.replace(/\\/g, '/')
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : baseName(path)
}

function normalizedPath(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function isPathInside(
  root: string,
  candidate: string,
  caseInsensitive: boolean,
  allowRoot = true
): boolean {
  const normalizedRoot = normalizedPath(root, caseInsensitive)
  const normalizedCandidate = normalizedPath(candidate, caseInsensitive)
  return (
    (allowRoot && normalizedCandidate === normalizedRoot) ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  )
}

function projectIdFromUrl(value: string): string {
  const match = value.trim().match(/(?:\/project\/|\/)([a-zA-Z0-9_-]{8,})(?:[/?#]|$)/)
  return match?.[1] || 'overleaf-paper'
}

function fileKind(name: string): ProjectFile['kind'] | null {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : ''
  if (extension === 'tex') return 'tex'
  if (extension === 'bib') return 'bib'
  if (extension === 'sty' || extension === 'cls' || extension === 'bst') return 'style'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return null
}

async function collectProjectFiles(root: string, host?: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5 || files.length >= 500) return
    const entries = await listDir(directory, host)
    for (const entry of entries) {
      if (entry.isDir) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
          await visit(entry.path, depth + 1)
        }
        continue
      }
      const kind = fileKind(entry.name)
      if (!kind) continue
      files.push({
        name: entry.name,
        path: entry.path,
        relative: relativePath(root, entry.path),
        depth,
        kind
      })
    }
  }
  await visit(root, 0)
  return files.sort((a, b) => {
    const weight = (file: ProjectFile): number =>
      file.name.toLowerCase() === 'main.tex' ? 0 : file.kind === 'tex' ? 1 : file.kind === 'bib' ? 2 : 3
    return weight(a) - weight(b) || a.relative.localeCompare(b.relative)
  })
}

async function inspectTexSources(
  files: ProjectFile[],
  host?: string
): Promise<Map<string, string>> {
  const texFiles = files
    .filter((file) => file.kind === 'tex')
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.relative.localeCompare(b.relative)
    )
    .slice(0, ROOT_INSPECTION_LIMIT)
  const sources = new Map<string, string>()
  const batchSize = 8
  for (let index = 0; index < texFiles.length; index += batchSize) {
    await Promise.all(
      texFiles.slice(index, index + batchSize).map(async (file) => {
        try {
          sources.set(file.path, await readFile(file.path, host))
        } catch {
          // An unreadable file should not prevent the rest of the project from opening.
        }
      })
    )
  }
  return sources
}

function storageKey(host: string | undefined, root: string, field: string): string {
  return `linco:latex:${host || 'local'}:${root}:${field}`
}

function compactError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function compilerHighlights(log: string): string[] {
  const results: string[] = []
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/\.tex:\d+:/.test(trimmed) || trimmed.startsWith('! ')) {
      results.push(trimmed)
      if (results.length === 4) break
    }
  }
  return results
}

function buildProjectTree(files: ProjectFile[]): ProjectTreeNode[] {
  const root: ProjectFolderNode = {
    type: 'folder',
    name: '',
    relative: '',
    children: []
  }
  for (const file of files) {
    const parts = file.relative.replace(/\\/g, '/').split('/').filter(Boolean)
    let folder = root
    let relative = ''
    for (const name of parts.slice(0, -1)) {
      relative = relative ? `${relative}/${name}` : name
      let child = folder.children.find(
        (node): node is ProjectFolderNode =>
          node.type === 'folder' && node.relative === relative
      )
      if (!child) {
        child = { type: 'folder', name, relative, children: [] }
        folder.children.push(child)
      }
      folder = child
    }
    folder.children.push({ type: 'file', file })
  }

  const sortNodes = (nodes: ProjectTreeNode[]): ProjectTreeNode[] =>
    nodes
      .map((node) =>
        node.type === 'folder'
          ? { ...node, children: sortNodes(node.children) }
          : node
      )
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
        const leftName = left.type === 'folder' ? left.name : left.file.name
        const rightName = right.type === 'folder' ? right.name : right.file.name
        if (left.type === 'file' && right.type === 'file') {
          const leftMain = leftName.toLowerCase() === 'main.tex' ? 0 : 1
          const rightMain = rightName.toLowerCase() === 'main.tex' ? 0 : 1
          if (leftMain !== rightMain) return leftMain - rightMain
        }
        return leftName.localeCompare(rightName)
      })

  return sortNodes(root.children)
}

function isCommentedAt(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  for (let index = lineStart; index < offset; index += 1) {
    if (source[index] !== '%') continue
    let slashes = 0
    for (let cursor = index - 1; cursor >= lineStart && source[cursor] === '\\'; cursor -= 1) {
      slashes += 1
    }
    if (slashes % 2 === 0) return true
  }
  return false
}

function bracedArgument(source: string, openBrace: number): string | null {
  let depth = 0
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '{') depth += 1
    if (character !== '}') continue
    depth -= 1
    if (depth === 0) return source.slice(openBrace + 1, index)
  }
  return null
}

function outlineTitle(value: string): string {
  let title = value
  for (let pass = 0; pass < 3; pass += 1) {
    title = title.replace(
      /\\[A-Za-z@]+\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}/g,
      '$1'
    )
  }
  return title
    .replace(/\\(?:label|index)\s*\{[^{}]*\}/g, '')
    .replace(/\\[A-Za-z@]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function latexOutline(source: string): LatexOutlineItem[] {
  const items: LatexOutlineItem[] = []
  const pattern =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\s*\[[^\]]*\])?\s*\{/g
  const levels: Record<string, number> = {
    part: 0,
    chapter: 0,
    section: 0,
    subsection: 1,
    subsubsection: 2,
    paragraph: 3,
    subparagraph: 4
  }
  for (const match of source.matchAll(pattern)) {
    const offset = match.index ?? 0
    if (isCommentedAt(source, offset)) continue
    const openBrace = offset + match[0].lastIndexOf('{')
    const title = outlineTitle(bracedArgument(source, openBrace) || '')
    if (!title) continue
    items.push({
      id: `${offset}:${items.length}`,
      title,
      level: levels[match[1]] ?? 0,
      offset
    })
  }
  return items
}

function FileIcon({ kind }: { kind: ProjectFile['kind'] }): JSX.Element {
  if (kind === 'image') return <FileImage size={14} />
  if (kind === 'bib') return <FileText size={14} />
  if (kind === 'style') return <Code2 size={14} />
  return <FileCode2 size={14} />
}

export default function LatexView({
  host,
  cwd,
  active = true,
  onSubmitToAgent
}: LatexViewProps): JSX.Element {
  const { t } = useI18n()
  const [paperRoot, setPaperRoot] = useState('')
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [fileRailOpen, setFileRailOpen] = useState(true)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState('')
  const [mainPath, setMainPath] = useState('')
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [externalConflict, setExternalConflict] = useState(false)
  const [editorMode, setEditorMode] = useState<LatexEditorMode>('source')
  const [editorPaneWidth, setEditorPaneWidth] = useState(editorPaneWidthMemory.value)
  const [engine, setEngine] = useState<Engine>('pdflatex')
  const [compiling, setCompiling] = useState(false)
  const [compileResult, setCompileResult] = useState<LatexCompileResult | null>(null)
  const [pdfSrc, setPdfSrc] = useState('')
  const [previewOpen, setPreviewOpen] = useState(true)
  const [logOpen, setLogOpen] = useState(false)
  const [projectInfo, setProjectInfo] = useState<OverleafProjectInfo | null>(null)
  const [syncing, setSyncing] = useState<'pull' | 'publish' | ''>('')
  const [syncError, setSyncError] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectUrl, setConnectUrl] = useState('')
  const [connectToken, setConnectToken] = useState('')
  const [connectDestination, setConnectDestination] = useState('')
  const [rememberToken, setRememberToken] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [pendingSync, setPendingSync] = useState<'pull' | 'publish' | ''>('')
  const [editorNavigation, setEditorNavigation] = useState<{
    offset: number
    revision: number
  } | null>(null)

  const contentRef = useRef(content)
  const dirtyRef = useRef(dirty)
  const selectedPathRef = useRef(selectedPath)
  const hostRef = useRef(host)
  const saveTimerRef = useRef<number | null>(null)
  const ownWriteAtRef = useRef(0)
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const loadGenerationRef = useRef(0)
  const refreshGenerationRef = useRef(0)
  const outlineNavigationRevisionRef = useRef(0)
  const editorPreviewRef = useRef<HTMLElement | null>(null)

  contentRef.current = content
  dirtyRef.current = dirty
  selectedPathRef.current = selectedPath
  hostRef.current = host

  const refreshProject = useCallback(async (preferredRoot?: string): Promise<void> => {
    if (!cwd) return
    const generation = ++refreshGenerationRef.current
    setFilesLoading(true)
    try {
      const caseInsensitive = !host
      const rememberedRoot =
        window.localStorage.getItem(storageKey(host, cwd, 'paperRoot')) || ''
      let nextRoot =
        preferredRoot && isPathInside(cwd, preferredRoot, caseInsensitive)
          ? preferredRoot
          : rememberedRoot && isPathInside(cwd, rememberedRoot, caseInsensitive)
            ? rememberedRoot
            : ''
      let nextFiles = await collectProjectFiles(nextRoot || cwd, host)
      if (nextRoot && !nextFiles.some((file) => file.kind === 'tex')) {
        nextRoot = ''
        nextFiles = await collectProjectFiles(cwd, host)
      }

      if (!nextRoot) {
        const repositoryTexFiles = nextFiles.filter((file) => file.kind === 'tex')
        const detectedMain =
          repositoryTexFiles.find((file) => file.name.toLowerCase() === 'main.tex')?.path ||
          chooseLatexMainDocument(
            repositoryTexFiles as LatexProjectTextFile[],
            '',
            await inspectTexSources(nextFiles, host),
            !host
          )
        nextRoot = detectedMain ? parentDir(detectedMain) || cwd : cwd
        if (normalizedPath(nextRoot, caseInsensitive) !== normalizedPath(cwd, caseInsensitive)) {
          nextFiles = await collectProjectFiles(nextRoot, host)
        }
      }

      if (generation !== refreshGenerationRef.current) return
      setPaperRoot(nextRoot)
      setFiles(nextFiles)
      const rememberedMain = window.localStorage.getItem(storageKey(host, cwd, 'main')) || ''
      const texFiles = nextFiles.filter((file) => file.kind === 'tex')
      const validRemembered = texFiles.find((file) => file.path === rememberedMain)?.path
      const conventionalMain = texFiles.find(
        (file) => file.name.toLowerCase() === 'main.tex'
      )?.path
      const nextMain =
        validRemembered ||
        conventionalMain ||
        chooseLatexMainDocument(
          texFiles as LatexProjectTextFile[],
          '',
          await inspectTexSources(nextFiles, host),
          !host
        )
      window.localStorage.setItem(storageKey(host, cwd, 'paperRoot'), nextRoot)
      setMainPath(nextMain)
      setSelectedPath((current) =>
        nextFiles.some((file) => file.path === current && TEXT_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() || ''))
          ? current
          : nextMain
      )
    } catch (reason) {
      setSaveError(compactError(reason))
    } finally {
      if (generation === refreshGenerationRef.current) setFilesLoading(false)
    }
  }, [cwd, host])

  useEffect(() => {
    if (!paperRoot) {
      setProjectInfo(null)
      return
    }
    let cancelled = false
    overleafProjectInfo(paperRoot, host)
      .then((info) => {
        if (!cancelled) setProjectInfo(info)
      })
      .catch(() => {
        if (!cancelled) setProjectInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [host, paperRoot])

  useEffect(() => {
    setFiles([])
    setCollapsedFolders(new Set())
    setPaperRoot('')
    setSelectedPath('')
    setMainPath('')
    setContent('')
    setLoaded(false)
    setCompileResult(null)
    setPdfSrc('')
    setProjectInfo(null)
    setSyncError('')
    if (cwd) {
      setConnectDestination(joinPath(cwd, 'overleaf-paper', !!host))
      void refreshProject()
    }
  }, [cwd, host, refreshProject])

  const loadFile = useCallback(async (path: string, force = false): Promise<void> => {
    if (!path || (!force && path === selectedPathRef.current && loaded)) return
    const generation = ++loadGenerationRef.current
    setLoaded(false)
    setSaveError('')
    try {
      const next = await readFile(path, hostRef.current)
      if (generation !== loadGenerationRef.current) return
      selectedPathRef.current = path
      setSelectedPath(path)
      setEditorNavigation(null)
      contentRef.current = next
      setContent(next)
      dirtyRef.current = false
      setDirty(false)
      setExternalConflict(false)
      setLoaded(true)
    } catch (reason) {
      if (generation === loadGenerationRef.current) {
        setSaveError(compactError(reason))
        setLoaded(true)
      }
    }
  }, [loaded])

  useEffect(() => {
    if (selectedPath) void loadFile(selectedPath, true)
    // loadFile intentionally reads host and selection from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath])

  const saveNow = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const path = selectedPathRef.current
    if (!path || !dirtyRef.current) return
    const snapshot = contentRef.current
    const targetHost = hostRef.current
    setSaving(true)
    writeChainRef.current = writeChainRef.current
      .catch(() => {})
      .then(() => writeFile(path, snapshot, targetHost))
      .then(() => {
        ownWriteAtRef.current = Date.now()
        invalidateFile(path, targetHost)
        if (contentRef.current === snapshot) {
          dirtyRef.current = false
          setDirty(false)
        }
        setSaveError('')
      })
      .catch((reason: unknown) => setSaveError(compactError(reason)))
      .finally(() => setSaving(false))
    await writeChainRef.current
  }, [])

  const onEditorChange = (next: string): void => {
    contentRef.current = next
    setContent(next)
    dirtyRef.current = true
    setDirty(true)
    setExternalConflict(false)
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => void saveNow(), 700)
  }

  const startEditorResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = editorPaneWidth
    const onMove = (moveEvent: MouseEvent): void => {
      const availableWidth =
        editorPreviewRef.current?.getBoundingClientRect().width || window.innerWidth
      const maximum = Math.max(
        EDITOR_PANE_MIN_WIDTH,
        Math.min(EDITOR_PANE_MAX_WIDTH, availableWidth - PDF_PANE_MIN_WIDTH - 1)
      )
      const width = Math.min(
        maximum,
        Math.max(EDITOR_PANE_MIN_WIDTH, startWidth + moveEvent.clientX - startX)
      )
      editorPaneWidthMemory.value = width
      setEditorPaneWidth(width)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    const element = editorPreviewRef.current
    if (!element || !previewOpen) return
    const observer = new ResizeObserver(([entry]) => {
      const maximum = Math.max(
        EDITOR_PANE_MIN_WIDTH,
        Math.min(
          EDITOR_PANE_MAX_WIDTH,
          entry.contentRect.width - PDF_PANE_MIN_WIDTH - 1
        )
      )
      setEditorPaneWidth((current) => {
        const width = Math.min(current, maximum)
        editorPaneWidthMemory.value = width
        return width
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [previewOpen])

  const selectFile = async (path: string): Promise<void> => {
    if (path === selectedPathRef.current) return
    await saveNow()
    setSelectedPath(path)
  }

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    onRemoteFsChange((change) => {
      if (disposed || (change.host || '') !== (hostRef.current || '')) return
      const current = selectedPathRef.current
      if (current && change.paths.some((path) => path === current)) {
        if (Date.now() - ownWriteAtRef.current < 1200) return
        if (dirtyRef.current) setExternalConflict(true)
        else void loadFile(current, true)
      }
      if (cwd && change.paths.some((path) => fileKind(baseName(path)) !== null)) {
        window.setTimeout(() => void refreshProject(), 250)
      }
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
  }, [cwd, loadFile, refreshProject])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (dirtyRef.current && selectedPathRef.current) {
        void writeFile(selectedPathRef.current, contentRef.current, hostRef.current)
      }
    },
    []
  )

  const compile = async (): Promise<void> => {
    if (!paperRoot || !mainPath || compiling) return
    await saveNow()
    setCompiling(true)
    setSaveError('')
    try {
      const result = await compileLatex(paperRoot, mainPath, engine, host)
      setCompileResult(result)
      setLogOpen(!result.success)
      setPreviewOpen(true)
      if (result.success) {
        const src = host
          ? `data:application/pdf;base64,${await readBytes(result.pdf_path, host)}`
          : `${convertFileSrc(result.pdf_path)}?v=${Date.now()}`
        setPdfSrc(src)
      }
    } catch (reason) {
      setCompileResult({
        success: false,
        pdf_path: '',
        log: compactError(reason),
        duration_ms: 0,
        tool_missing: false
      })
      setLogOpen(true)
      setPreviewOpen(true)
    } finally {
      setCompiling(false)
    }
  }

  const sync = async (kind: 'pull' | 'publish'): Promise<void> => {
    if (!paperRoot || syncing) return
    await saveNow()
    setSyncing(kind)
    setSyncError('')
    try {
      const next =
        kind === 'pull'
          ? await overleafPull(paperRoot, connectToken, host)
          : await overleafPublish(
              paperRoot,
              `Update manuscript from Linco (${new Date().toLocaleString()})`,
              connectToken,
              host
            )
      setProjectInfo(next)
      await refreshProject()
      if (selectedPathRef.current) await loadFile(selectedPathRef.current, true)
    } catch (reason) {
      const message = compactError(reason)
      setSyncError(message)
      if (message.includes('OVERLEAF_AUTH_REQUIRED')) {
        setPendingSync(kind)
        setConnectOpen(true)
      }
    } finally {
      setSyncing('')
    }
  }

  const connect = async (): Promise<void> => {
    if (!cwd || !connectUrl.trim() || !connectToken.trim() || !connectDestination.trim()) return
    if (!isPathInside(cwd, connectDestination, !host, false)) {
      setSyncError(t('latex.destinationInsideRepository'))
      return
    }
    setConnecting(true)
    setSyncError('')
    try {
      await overleafClone({
        gitUrl: connectUrl,
        destination: connectDestination,
        token: connectToken,
        remember: rememberToken,
        host
      })
      setConnectOpen(false)
      window.localStorage.setItem(storageKey(host, cwd, 'paperRoot'), connectDestination)
      await refreshProject(connectDestination)
    } catch (reason) {
      setSyncError(compactError(reason))
    } finally {
      setConnecting(false)
    }
  }

  const authenticate = async (): Promise<void> => {
    if (!paperRoot || !connectToken.trim()) return
    setConnecting(true)
    setSyncError('')
    try {
      await overleafStoreToken(paperRoot, connectToken, rememberToken, host)
      const retry = pendingSync
      setPendingSync('')
      setConnectOpen(false)
      if (retry) await sync(retry)
    } catch (reason) {
      setSyncError(compactError(reason))
    } finally {
      setConnecting(false)
    }
  }

  const chooseCloneParent = async (): Promise<void> => {
    if (host || !cwd) return
    const selected = await openDialog({ directory: true, multiple: false, defaultPath: cwd })
    if (typeof selected === 'string') {
      if (!isPathInside(cwd, selected, true)) {
        setSyncError(t('latex.destinationInsideRepository'))
        return
      }
      setSyncError('')
      setConnectDestination(joinPath(selected, projectIdFromUrl(connectUrl), false))
    }
  }

  const setMainDocument = (path: string): void => {
    setMainPath(path)
    if (cwd) window.localStorage.setItem(storageKey(host, cwd, 'main'), path)
  }

  const diagnostics = useMemo(
    () => compilerHighlights(compileResult?.log || ''),
    [compileResult?.log]
  )
  const selectedFile = files.find((file) => file.path === selectedPath)
  const projectTree = useMemo(() => buildProjectTree(files), [files])
  const outline = useMemo(
    () => (selectedFile?.kind === 'tex' ? latexOutline(content) : []),
    [content, selectedFile?.kind]
  )
  const paperLabel =
    cwd && paperRoot && normalizedPath(paperRoot, !host) !== normalizedPath(cwd, !host)
      ? relativePath(cwd, paperRoot)
      : ''
  const requestLatexSuggestion = useCallback(
    ({
      before,
      selection,
      after,
      mode
    }: {
      before: string
      selection: string
      after: string
      mode: LatexPolishMode
    }) => {
      if (!cwd || !selectedPath) return Promise.reject(new Error(t('latex.selectFile')))
      return suggestLatex({
        repo: cwd,
        currentFile: selectedPath,
        before,
        selection,
        after,
        mode,
        host
      })
    },
    [cwd, host, selectedPath, t]
  )
  const reviewLatexSegments = useCallback(
    (segments: LatexReviewSegment[]) => {
      if (!cwd || !selectedPath) return Promise.reject(new Error(t('latex.selectFile')))
      return reviewLatex({
        repo: cwd,
        currentFile: selectedPath,
        segments,
        host
      })
    },
    [cwd, host, selectedPath, t]
  )

  const toggleFolder = (relative: string): void => {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(relative)) next.delete(relative)
      else next.add(relative)
      return next
    })
  }

  const revealOutlineItem = (item: LatexOutlineItem): void => {
    outlineNavigationRevisionRef.current += 1
    setEditorNavigation({
      offset: item.offset,
      revision: outlineNavigationRevisionRef.current
    })
  }

  const renderProjectNodes = (
    nodes: ProjectTreeNode[],
    level = 0
  ): JSX.Element[] =>
    nodes.map((node) => {
      if (node.type === 'folder') {
        const collapsed = collapsedFolders.has(node.relative)
        return (
          <div key={`folder:${node.relative}`}>
            <button
              type="button"
              onClick={() => toggleFolder(node.relative)}
              className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md pr-1.5 text-left text-[11px] text-ink-muted hover:bg-black/5 hover:text-ink"
              style={{ paddingLeft: 5 + level * 10 }}
              title={node.relative}
            >
              {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <Folder size={13} className="shrink-0 text-[#6f91c8]" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </button>
            {!collapsed && renderProjectNodes(node.children, level + 1)}
          </div>
        )
      }
      const file = node.file
      const selectable = file.kind !== 'image'
      return (
        <button
          key={`file:${file.relative}`}
          type="button"
          onClick={() => {
            if (selectable) void selectFile(file.path)
          }}
          disabled={!selectable}
          className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-left text-[11px] ${
            selectedPath === file.path
              ? 'bg-canvas text-ink shadow-sm'
              : selectable
                ? 'text-ink-muted hover:bg-black/5 hover:text-ink'
                : 'cursor-default text-ink-faint'
          }`}
          style={{ paddingLeft: 17 + level * 10 }}
          title={file.relative}
        >
          <span className="shrink-0 text-ink-faint"><FileIcon kind={file.kind} /></span>
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          {file.path === mainPath && <Check size={11} className="shrink-0 text-emerald-600" />}
        </button>
      )
    })

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl bg-canvas text-[13px] text-ink-faint shadow-card ring-1 ring-black/5">
        {t('app.pickWorkDir')}
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/8 px-2">
        <button
          onClick={() => setFileRailOpen((value) => !value)}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            fileRailOpen ? 'bg-sidebar text-ink' : 'text-ink-muted hover:bg-black/5'
          }`}
          title={t('latex.files')}
        >
          <FolderGit2 size={15} />
        </button>
        <div className="min-w-0 max-w-[260px] truncate px-1 text-[12px] font-medium text-ink">
          <span>{baseName(cwd)}</span>
          {paperLabel && <span className="text-ink-faint"> / {paperLabel}</span>}
        </div>
        {projectInfo?.connected ? (
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
            <span className="mr-1 flex items-center gap-1 text-[10px] text-emerald-600">
              <Cloud size={12} />
              {projectInfo.behind > 0
                ? t('latex.sync.behind', { n: projectInfo.behind })
                : projectInfo.ahead > 0 || projectInfo.dirty
                  ? t('latex.sync.localChanges')
                  : t('latex.sync.synced')}
            </span>
            <button
              onClick={() => void sync('pull')}
              disabled={!!syncing}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-ink-muted hover:bg-black/5 disabled:opacity-45"
              title={t('latex.sync.pullHint')}
            >
              {syncing === 'pull' ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
              {t('latex.sync.pull')}
            </button>
            <button
              onClick={() => void sync('publish')}
              disabled={!!syncing}
              className="flex h-7 items-center gap-1 rounded-md bg-[#e8f5ec] px-2 text-[11px] font-medium text-[#237a43] hover:bg-[#dff0e5] disabled:opacity-45"
              title={t('latex.sync.publishHint')}
            >
              {syncing === 'publish' ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />}
              {t('latex.sync.publish')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConnectOpen(true)}
            className="ml-1 flex h-7 shrink-0 items-center gap-1 rounded-md bg-[#e8f5ec] px-2 text-[11px] font-medium text-[#237a43] hover:bg-[#dff0e5]"
          >
            <Cloud size={13} />
            {t('latex.connect')}
          </button>
        )}
        <div className="flex-1" />
        <select
          value={mainPath}
          onChange={(event) => setMainDocument(event.target.value)}
          className="h-7 max-w-[150px] rounded-md border border-black/8 bg-sidebar px-2 text-[11px] text-ink outline-none"
          title={t('latex.mainFile')}
        >
          {files
            .filter((file) => file.kind === 'tex')
            .map((file) => (
              <option key={file.path} value={file.path}>
                {file.relative}
              </option>
            ))}
        </select>
        <select
          value={engine}
          onChange={(event) => setEngine(event.target.value as Engine)}
          className="h-7 w-[88px] rounded-md border border-black/8 bg-sidebar px-1 text-[11px] text-ink outline-none"
          title={t('latex.engine')}
        >
          <option value="pdflatex">pdfLaTeX</option>
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX</option>
        </select>
        <button
          onClick={() => void compile()}
          disabled={compiling || !mainPath}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-ink px-2.5 text-[11px] font-medium text-canvas hover:opacity-85 disabled:opacity-40"
        >
          {compiling ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {t(compiling ? 'latex.compiling' : 'latex.compile')}
        </button>
        <button
          onClick={() => setPreviewOpen((value) => !value)}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            previewOpen ? 'bg-sidebar text-ink' : 'text-ink-muted hover:bg-black/5'
          }`}
          title={previewOpen ? t('latex.preview.close') : t('latex.preview.open')}
        >
          {previewOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
        {onSubmitToAgent && (
          <button
            onClick={() =>
              onSubmitToAgent(
                t('latex.agentPrompt', {
                  path: selectedPath || mainPath,
                  root: paperRoot || cwd,
                  repository: cwd,
                  main: mainPath
                })
              )
            }
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-accent hover:bg-accent/10"
            title={t('latex.askAgentHint')}
          >
            <Bot size={14} />
            {t('latex.askAgent')}
          </button>
        )}
      </div>

      {(syncError || saveError || externalConflict) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
          <AlertCircle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {externalConflict ? t('latex.externalConflict') : syncError || saveError}
          </span>
          {externalConflict && (
            <button
              onClick={() => void loadFile(selectedPathRef.current, true)}
              className="rounded px-2 py-1 font-medium hover:bg-red-100"
            >
              {t('latex.reloadDisk')}
            </button>
          )}
          <button
            onClick={() => {
              setSyncError('')
              setSaveError('')
              setExternalConflict(false)
            }}
            className="rounded p-1 hover:bg-red-100"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {fileRailOpen && (
          <aside className="flex w-[190px] shrink-0 flex-col border-r border-black/8 bg-sidebar/60">
            <section className="flex min-h-0 flex-[3] flex-col">
              <div className="flex h-9 shrink-0 items-center gap-2 px-2.5 text-[10px] font-medium uppercase text-ink-faint">
                <span>{t('latex.files')}</span>
                <div className="flex-1" />
                <button
                  onClick={() => void refreshProject()}
                  className="rounded p-1 hover:bg-black/5 hover:text-ink"
                  title={t('latex.refreshFiles')}
                >
                  <RefreshCw size={12} className={filesLoading ? 'animate-spin' : ''} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {renderProjectNodes(projectTree)}
                {files.length === 0 && !filesLoading && (
                  <div className="px-2 py-5 text-center text-[11px] text-ink-faint">
                    {t('latex.noTexFiles')}
                  </div>
                )}
              </div>
            </section>
            <section className="flex min-h-[108px] flex-[2] flex-col border-t border-black/8">
              <div className="flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-[10px] font-medium uppercase text-ink-faint">
                <ListTree size={12} />
                <span>{t('latex.outline')}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {outline.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => revealOutlineItem(item)}
                    className="flex h-7 w-full min-w-0 items-center rounded-md pr-1.5 text-left text-[11px] text-ink-muted hover:bg-black/5 hover:text-ink"
                    style={{ paddingLeft: 8 + Math.min(item.level, 4) * 12 }}
                    title={item.title}
                  >
                    <span className="truncate">{item.title}</span>
                  </button>
                ))}
                {outline.length === 0 && (
                  <div className="px-2 py-4 text-center text-[10px] text-ink-faint">
                    {t('latex.noOutline')}
                  </div>
                )}
              </div>
            </section>
          </aside>
        )}

        <main ref={editorPreviewRef} className="relative flex min-w-0 flex-1 overflow-hidden">
          <div
            className={previewOpen ? 'min-w-[480px] shrink-0' : 'min-w-[480px] flex-1'}
            style={previewOpen ? { width: editorPaneWidth } : undefined}
          >
            {!loaded ? (
              <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
                {filesLoading ? <Loader2 size={15} className="animate-spin" /> : t('latex.selectFile')}
              </div>
            ) : selectedFile ? (
              <LatexVisualEditor
                key={selectedFile.path}
                value={content}
                fileName={selectedFile.name}
                isMainDocument={selectedFile.path === mainPath}
                mode={editorMode}
                dirty={dirty}
                saving={saving}
                active={active}
                repositoryLabel={baseName(cwd)}
                navigationTarget={editorNavigation}
                onMode={setEditorMode}
                onChange={onEditorChange}
                onSave={() => void saveNow()}
                onRequestSuggestion={requestLatexSuggestion}
                onReviewSegments={reviewLatexSegments}
              />
            ) : null}
          </div>

          {previewOpen && (
            <div
              onMouseDown={startEditorResize}
              className="group relative w-px shrink-0 cursor-col-resize bg-black/8 hover:bg-[#5c8bd6]/50"
              title={t('files.resizeHint')}
            >
              <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
            </div>
          )}

          {previewOpen && (
            <section className="flex min-w-[340px] flex-1 flex-col bg-[#e7e7e4]">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/8 bg-canvas px-2.5 text-[11px]">
                <Eye size={14} className="text-ink-muted" />
                <span className="font-medium text-ink">{t('latex.pdfPreview')}</span>
                {compileResult && (
                  <span className={compileResult.success ? 'text-emerald-600' : 'text-red-600'}>
                    {compileResult.success
                      ? t('latex.compileSuccess', { seconds: (compileResult.duration_ms / 1000).toFixed(1) })
                      : t('latex.compileFailed')}
                  </span>
                )}
                <div className="flex-1" />
                {compileResult?.log && (
                  <button
                    onClick={() => setLogOpen((value) => !value)}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-ink-muted hover:bg-black/5"
                  >
                    {logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t('latex.log')}
                  </button>
                )}
              </div>
              <div className="relative min-h-0 flex-1">
                {pdfSrc ? (
                  <embed src={pdfSrc} type="application/pdf" className="absolute inset-0 h-full w-full" />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-ink-faint">
                    <FileText size={28} strokeWidth={1.4} />
                    <span>{t('latex.previewEmpty')}</span>
                  </div>
                )}
                {logOpen && compileResult?.log && (
                  <div className="absolute inset-x-2 bottom-2 max-h-[45%] overflow-auto rounded-md border border-black/10 bg-[#181818] p-3 font-mono text-[10px] leading-5 text-[#deded8] shadow-xl">
                    <button
                      onClick={() => setLogOpen(false)}
                      className="sticky float-right top-0 rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
                    >
                      <X size={12} />
                    </button>
                    {compileResult.tool_missing ? (
                      <div className="font-sans text-[11px] text-amber-300">
                        {t(host ? 'latex.remoteToolMissing' : 'latex.toolMissing')}
                      </div>
                    ) : diagnostics.length > 0 ? (
                      <div className="mb-2 space-y-1 border-b border-white/10 pb-2 text-red-300">
                        {diagnostics.map((line) => <div key={line}>{line}</div>)}
                      </div>
                    ) : null}
                    <pre className="whitespace-pre-wrap">{compileResult.log}</pre>
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      {connectOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/25 p-5 backdrop-blur-[1px]">
          <div className="w-full max-w-[460px] rounded-lg bg-canvas p-4 shadow-2xl ring-1 ring-black/10">
            <div className="flex items-center gap-2">
              <Cloud size={18} className="text-[#2f8a50]" />
              <h2 className="text-[15px] font-semibold text-ink">
                {projectInfo?.connected ? t('latex.authTitle') : t('latex.connectTitle')}
              </h2>
              <div className="flex-1" />
              <button onClick={() => setConnectOpen(false)} className="rounded p-1 text-ink-faint hover:bg-black/5">
                <X size={15} />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {!projectInfo?.connected && <label className="block text-[11px] text-ink-muted">
                <span className="mb-1 block">{t('latex.projectUrl')}</span>
                <input
                  value={connectUrl}
                  onChange={(event) => {
                    const value = event.target.value
                    setConnectUrl(value)
                    if (cwd) setConnectDestination(joinPath(cwd, projectIdFromUrl(value), !!host))
                  }}
                  placeholder="https://www.overleaf.com/project/..."
                  spellCheck={false}
                  className="h-9 w-full rounded-md border border-black/10 bg-sidebar px-2.5 text-[12px] text-ink outline-none focus:border-[#58a878]"
                />
              </label>}
              {!projectInfo?.connected && <label className="block text-[11px] text-ink-muted">
                <span className="mb-1 block">{t('latex.gitToken')}</span>
                <input
                  type="password"
                  value={connectToken}
                  onChange={(event) => setConnectToken(event.target.value)}
                  placeholder={t('latex.gitTokenPlaceholder')}
                  className="h-9 w-full rounded-md border border-black/10 bg-sidebar px-2.5 text-[12px] text-ink outline-none focus:border-[#58a878]"
                />
              </label>}
              <label className="block text-[11px] text-ink-muted">
                <span className="mb-1 block">{t('latex.destination')}</span>
                <div className="flex gap-1">
                  <input
                    value={connectDestination}
                    onChange={(event) => setConnectDestination(event.target.value)}
                    spellCheck={false}
                    className="h-9 min-w-0 flex-1 rounded-md border border-black/10 bg-sidebar px-2.5 font-mono text-[11px] text-ink outline-none focus:border-[#58a878]"
                  />
                  {!host && (
                    <button
                      onClick={() => void chooseCloneParent()}
                      className="flex h-9 w-9 items-center justify-center rounded-md border border-black/10 text-ink-muted hover:bg-black/5"
                      title={t('latex.chooseDestination')}
                    >
                      <FolderOpen size={15} />
                    </button>
                  )}
                </div>
              </label>
              <label className="flex items-center gap-2 text-[11px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={rememberToken}
                  onChange={(event) => setRememberToken(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[#368a56]"
                />
                {t('latex.rememberToken')}
              </label>
              <div className="rounded-md bg-sidebar px-2.5 py-2 text-[10px] leading-4 text-ink-faint">
                {t('latex.gitRequirement')}
              </div>
              {syncError && <div className="text-[11px] text-red-600">{syncError}</div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConnectOpen(false)}
                className="h-8 rounded-md px-3 text-[12px] text-ink-muted hover:bg-black/5"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void (projectInfo?.connected ? authenticate() : connect())}
                disabled={
                  connecting ||
                  !connectToken.trim() ||
                  (!projectInfo?.connected && (!connectUrl.trim() || !connectDestination.trim()))
                }
                className="flex h-8 items-center gap-1.5 rounded-md bg-[#277a48] px-3 text-[12px] font-medium text-white hover:bg-[#216b3f] disabled:opacity-45"
              >
                {connecting ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
                {projectInfo?.connected ? t('latex.authenticate') : t('latex.clone')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
