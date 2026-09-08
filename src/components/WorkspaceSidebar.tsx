import { useEffect, useRef, type ReactNode } from 'react'
import {
  MessagesSquare, FolderTree, Eye, TerminalSquare, GitBranch, PencilRuler,
  BookOpenText, FolderOpen, ChevronsUpDown, Settings, Sun, Moon, X, PanelsTopLeft, Code2,
} from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { baseName } from '@/lib/fs'

export type ViewId = 'chat' | 'terminal' | 'preview' | 'drawing' | 'latex' | 'files' | 'git' | 'notion'
export const WORKSPACE_VIEWS: { id: ViewId; labelKey: string; icon: typeof Eye }[] = [
  { id: 'chat', labelKey: 'view.chat', icon: MessagesSquare },
  { id: 'files', labelKey: 'view.files', icon: FolderTree },
  { id: 'preview', labelKey: 'view.preview', icon: Eye },
  { id: 'terminal', labelKey: 'view.terminal', icon: TerminalSquare },
  { id: 'git', labelKey: 'view.git', icon: GitBranch },
  { id: 'drawing', labelKey: 'view.drawing', icon: PencilRuler },
  { id: 'latex', labelKey: 'view.latex', icon: BookOpenText },
  { id: 'notion', labelKey: 'view.notion', icon: BookOpenText },
]

export type WorkspaceMode = 'vibe' | 'code' | 'visual'
export const WORKSPACE_MODES: { id: WorkspaceMode; icon: typeof Eye; views: ViewId[]; initial: ViewId }[] = [
  { id: 'vibe', icon: PanelsTopLeft, views: ['preview', 'notion', 'chat'], initial: 'preview' },
  { id: 'code', icon: Code2, views: ['files', 'git', 'terminal'], initial: 'files' },
  { id: 'visual', icon: PencilRuler, views: ['drawing', 'latex'], initial: 'drawing' },
]
export const modeForView = (view: ViewId) => WORKSPACE_MODES.find((mode) => mode.views.includes(view))!

interface Props {
  cwd?: string
  dark: boolean
  onClose: () => void
  onPickProject: () => void
  recentDirs: string[]
  onOpenRecent: (path: string) => void
  onSettings: () => void
  onToggleTheme: () => void
  history: ReactNode
}

export default function WorkspaceSidebar({
  cwd, dark, onClose, onPickProject, recentDirs, onOpenRecent,
  onSettings, onToggleTheme, history,
}: Props): JSX.Element {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); previous?.focus({ preventScroll: true }) }
  }, [])
  const project = cwd ? baseName(cwd.replace(/[\\/]+$/, '')) : t('workspace.noProject')
  return (
    <dialog ref={dialog} id="workspace-sidebar" className="workspace-drawer" aria-label={t('workflow.projects')} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="workspace-drawer-content">
      <div className="drawer-heading"><span>{t('workflow.projects')}</span><button className="icon-button" aria-label={t('workflow.closeProjects')} onClick={onClose}><X size={16} /></button></div>
      <button className="workspace-project" onClick={() => { onClose(); onPickProject() }} title={cwd || t('workspace.openProject')} aria-label={t('workspace.openProject')}>
        <span className="project-monogram" aria-hidden="true">{cwd ? project.slice(0, 1).toUpperCase() : <FolderOpen size={18} />}</span>
        <span className="sidebar-label min-w-0 flex-1 text-left">
          <span className="block truncate font-semibold">{project}</span>
          <span className="block text-[11px] text-ink-muted">{t('workspace.project')}</span>
        </span>
        <ChevronsUpDown size={14} className="sidebar-label shrink-0 text-ink-faint" />
      </button>
      {recentDirs.some((path) => path !== cwd) && <div className="drawer-recents">
        <div className="sidebar-section-label">{t('workflow.recentProjects')}</div>
        {recentDirs.filter((path) => path !== cwd).slice(0, 4).map((path) => <button key={path} className="workspace-nav-item" title={path} onClick={() => { onClose(); onOpenRecent(path) }}><FolderOpen size={15} /><span className="truncate">{baseName(path.replace(/[\\/]+$/, ''))}</span></button>)}
      </div>}
      <div className="sidebar-context"><div className="sidebar-history">{history}</div></div>
      <div className="sidebar-footer">
        <button className="workspace-nav-item flex-1" onClick={() => { onClose(); onSettings() }} title={t('common.settings')} aria-label={t('common.settings')}>
          <Settings size={18} strokeWidth={1.65} /><span className="sidebar-label">{t('common.settings')}</span>
        </button>
        <button className="icon-button" onClick={onToggleTheme} title={t(dark ? 'workspace.lightMode' : 'workspace.darkMode')} aria-label={t(dark ? 'workspace.lightMode' : 'workspace.darkMode')}>
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>
      </div>
    </dialog>
  )
}
