import { ArrowUpRight, FolderOpen, Settings2, Folder } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { baseName } from '@/lib/fs'

export default function WelcomeView({ recentDirs, onPickProject, onOpenRecent, onSettings }: {
  recentDirs: string[]
  onPickProject: () => void
  onOpenRecent: (path: string) => void
  onSettings: () => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <section className="welcome-view">
      <div className="welcome-content">
        <h1>{t('workspace.welcomeTitle')}</h1>
        <p className="welcome-description">{t('workspace.welcomeDescription')}</p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={onPickProject}><FolderOpen size={15} />{t('workspace.openProject')}</button>
          <button className="secondary-button" onClick={onSettings}><Settings2 size={14} />{t('workspace.configureAgent')}</button>
        </div>
        {recentDirs.length > 0 && <div className="welcome-recents">
          <div className="sidebar-section-label">{t('workspace.recentProjects')}</div>
          {recentDirs.slice(0, 3).map((path) => <button className="recent-project" key={path} onClick={() => onOpenRecent(path)} title={path}><Folder size={17} /><span className="min-w-0 flex-1 text-left"><span className="block truncate font-medium">{baseName(path.replace(/[\\/]+$/, ''))}</span><span className="block truncate text-[11px] text-ink-muted">{path}</span></span><ArrowUpRight size={15} /></button>)}
        </div>}
      </div>
    </section>
  )
}
