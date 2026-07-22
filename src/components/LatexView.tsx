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
  FolderGit2,
  FolderOpen,
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
import { baseName, invalidateFile, listDir, readBytes, readFile, writeFile } from '@/lib/fs'
import { onRemoteFsChange } from '@/lib/watch'
import {
  compileLatex,
  overleafClone,
  overleafProjectInfo,
  overleafPublish,
  overleafPull,
  overleafStoreToken,
  type LatexCompileResult,
  type OverleafProjectInfo
} from '@/lib/latex'
import { useI18n } from '@/lib/i18n'

interface LatexViewProps {
  host?: string
  cwd?: string
  onOpenProject: (path: string) => void
  onSubmitToAgent?: (text: string) => void
}

interface ProjectFile {
  name: string
  path: string
  relative: string
  depth: number
  kind: 'tex' | 'bib' | 'style' | 'image'
}

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

function FileIcon({ kind }: { kind: ProjectFile['kind'] }): JSX.Element {
  if (kind === 'image') return <FileImage size={14} />
  if (kind === 'bib') return <FileText size={14} />
  if (kind === 'style') return <Code2 size={14} />
  return <FileCode2 size={14} />
}

export default function LatexView({
  host,
  cwd,
  onOpenProject,
  onSubmitToAgent
}: LatexViewProps): JSX.Element {
  const { t } = useI18n()
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [fileRailOpen, setFileRailOpen] = useState(true)
  const [selectedPath, setSelectedPath] = useState('')
  const [mainPath, setMainPath] = useState('')
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [externalConflict, setExternalConflict] = useState(false)
  const [editorMode, setEditorMode] = useState<LatexEditorMode>('visual')
  const [engine, setEngine] = useState<Engine>('pdflatex')
  const [compiling, setCompiling] = useState(false)
  const [compileResult, setCompileResult] = useState<LatexCompileResult | null>(null)
  const [pdfSrc, setPdfSrc] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
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

  const contentRef = useRef(content)
  const dirtyRef = useRef(dirty)
  const selectedPathRef = useRef(selectedPath)
  const hostRef = useRef(host)
  const saveTimerRef = useRef<number | null>(null)
  const ownWriteAtRef = useRef(0)
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const loadGenerationRef = useRef(0)

  contentRef.current = content
  dirtyRef.current = dirty
  selectedPathRef.current = selectedPath
  hostRef.current = host

  const refreshProject = useCallback(async (): Promise<void> => {
    if (!cwd) return
    setFilesLoading(true)
    try {
      const nextFiles = await collectProjectFiles(cwd, host)
      setFiles(nextFiles)
      const rememberedMain = window.localStorage.getItem(storageKey(host, cwd, 'main')) || ''
      const nextMain =
        nextFiles.find((file) => file.path === rememberedMain && file.kind === 'tex')?.path ||
        nextFiles.find((file) => file.name.toLowerCase() === 'main.tex')?.path ||
        nextFiles.find((file) => file.kind === 'tex')?.path ||
        ''
      setMainPath(nextMain)
      setSelectedPath((current) =>
        nextFiles.some((file) => file.path === current && TEXT_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() || ''))
          ? current
          : nextMain
      )
    } catch (reason) {
      setSaveError(compactError(reason))
    } finally {
      setFilesLoading(false)
    }
    overleafProjectInfo(cwd, host)
      .then(setProjectInfo)
      .catch(() => setProjectInfo(null))
  }, [cwd, host])

  useEffect(() => {
    setFiles([])
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
    if (!cwd || !mainPath || compiling) return
    await saveNow()
    setCompiling(true)
    setSaveError('')
    try {
      const result = await compileLatex(cwd, mainPath, engine, host)
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
    if (!cwd || syncing) return
    await saveNow()
    setSyncing(kind)
    setSyncError('')
    try {
      const next =
        kind === 'pull'
          ? await overleafPull(cwd, connectToken, host)
          : await overleafPublish(
              cwd,
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
    if (!connectUrl.trim() || !connectToken.trim() || !connectDestination.trim()) return
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
      onOpenProject(connectDestination)
    } catch (reason) {
      setSyncError(compactError(reason))
    } finally {
      setConnecting(false)
    }
  }

  const authenticate = async (): Promise<void> => {
    if (!cwd || !connectToken.trim()) return
    setConnecting(true)
    setSyncError('')
    try {
      await overleafStoreToken(cwd, connectToken, rememberToken, host)
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
    if (host) return
    const selected = await openDialog({ directory: true, multiple: false, defaultPath: cwd })
    if (typeof selected === 'string') {
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
  const editableFiles = files.filter((file) => file.kind !== 'image')
  const selectedFile = files.find((file) => file.path === selectedPath)

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
        <div className="min-w-0 max-w-[220px] truncate px-1 text-[12px] font-medium text-ink">
          {projectInfo?.connected
            ? `Overleaf · ${projectInfo.project_id}`
            : baseName(cwd)}
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
                t('latex.agentPrompt', { path: selectedPath || mainPath, root: cwd })
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
              {editableFiles.map((file) => (
                <button
                  key={file.path}
                  onClick={() => void selectFile(file.path)}
                  className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-left text-[11px] ${
                    selectedPath === file.path
                      ? 'bg-canvas text-ink shadow-sm'
                      : 'text-ink-muted hover:bg-black/5 hover:text-ink'
                  }`}
                  style={{ paddingLeft: 7 + Math.min(file.depth, 3) * 9 }}
                  title={file.relative}
                >
                  <span className="shrink-0 text-ink-faint"><FileIcon kind={file.kind} /></span>
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  {file.path === mainPath && <Check size={11} className="shrink-0 text-emerald-600" />}
                </button>
              ))}
              {editableFiles.length === 0 && !filesLoading && (
                <div className="px-2 py-5 text-center text-[11px] text-ink-faint">
                  {t('latex.noTexFiles')}
                </div>
              )}
              {files.some((file) => file.kind === 'image') && (
                <div className="mt-2 border-t border-black/8 pt-2">
                  <div className="px-2 pb-1 text-[9px] font-medium uppercase text-ink-faint">
                    {t('latex.assets')}
                  </div>
                  {files
                    .filter((file) => file.kind === 'image')
                    .map((file) => (
                      <div
                        key={file.path}
                        className="flex h-6 items-center gap-1.5 truncate px-2 text-[10px] text-ink-faint"
                        title={file.relative}
                      >
                        <FileImage size={12} />
                        <span className="truncate">{file.name}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </aside>
        )}

        <main className="relative flex min-w-0 flex-1">
          <div className="min-w-[360px] flex-1">
            {!loaded ? (
              <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
                {filesLoading ? <Loader2 size={15} className="animate-spin" /> : t('latex.selectFile')}
              </div>
            ) : selectedFile ? (
              <LatexVisualEditor
                value={content}
                fileName={selectedFile.name}
                mode={editorMode}
                dirty={dirty}
                saving={saving}
                onMode={setEditorMode}
                onChange={onEditorChange}
                onSave={() => void saveNow()}
              />
            ) : null}
          </div>

          {previewOpen && (
            <section className="absolute inset-y-0 right-0 z-20 flex w-[min(520px,100%)] min-w-[340px] flex-col border-l border-black/8 bg-[#e7e7e4] shadow-2xl min-[1180px]:static min-[1180px]:z-auto min-[1180px]:w-auto min-[1180px]:flex-[0.92] min-[1180px]:shadow-none">
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
