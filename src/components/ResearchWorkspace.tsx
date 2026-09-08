import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, BookOpenText, Check, ChevronRight, ClipboardList, Copy, FlaskConical, FolderKanban, Layers3, Loader2, Milestone, Plus, RefreshCw, Search, Send, X } from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useI18n } from '@/lib/i18n'
import { notionPageUrl } from '@/lib/notion'
import { safeAgentText } from '@/lib/notionWorkbench'
import { blankCheckpoint, buildResearchBrief, checkpointPrompt, connectResearchSpace, createMilestone, createResearchProject, parseCheckpoint, projectRecords, projectResearchConfig, readCheckpointInbox, readResearchSpace, researchProjects, rowText, saveCheckpoint, saveResearchSpace, type Checkpoint, type ResearchModule, type ResearchRow, type ResearchRows, type ResearchSpace } from '@/lib/researchMemory'
import './researchWorkspace.css'

interface Props {
  active: boolean; projectKey: string; cwd?: string; host?: string; linked: string | null
  canUseAgent: boolean; onSubmitToAgent: (text: string) => void
  onNavigate: (url: string) => void; onLinked: (url: string) => void; onNotebook: () => void
}
const modules: { id: ResearchModule; icon: typeof Search }[] = [
  { id: 'overview', icon: Layers3 }, { id: 'milestones', icon: Milestone },
  { id: 'explorations', icon: FlaskConical }, { id: 'literature', icon: BookOpenText },
  { id: 'knowledge', icon: Check }, { id: 'runs', icon: ClipboardList },
]
const emptyRows = (): ResearchRows => ({ rows: [], limited: false, fetchedAt: '' })

export default function ResearchWorkspace({ active, projectKey, cwd, host, linked, canUseAgent, onSubmitToAgent, onNavigate, onLinked, onNotebook }: Props) {
  const { t } = useI18n()
  const [space, setSpace] = useState<ResearchSpace | null>(() => readResearchSpace(projectKey))
  const [home, setHome] = useState(linked || '')
  const [projects, setProjects] = useState<ResearchRows>(emptyRows)
  const [records, setRecords] = useState<ResearchRows>(emptyRows)
  const [milestones, setMilestones] = useState<ResearchRows>(emptyRows)
  const [module, setModule] = useState<ResearchModule>('overview')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [brief, setBrief] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [dialogMode, setDialogMode] = useState<'project' | 'milestone' | 'checkpoint' | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState('')
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null)
  const [json, setJson] = useState('')
  const [inbox, setInbox] = useState<Checkpoint[]>([])
  const [watch, setWatch] = useState(false)
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const lock = useRef(false)
  const inboxLock = useRef(false)
  const epoch = useRef(0)
  const current = useRef({ projectKey, selected: space?.selected, active, canUseAgent })
  current.current = { projectKey, selected: space?.selected, active, canUseAgent }
  const project = projects.rows.find(row => row.url === space?.selected)
  const draftKey = `${projectKey}:research-draft:${space?.selected || ''}`
  const status = (row: ResearchRow) => rowText(row.values.Status || row.values.Stage)
  const shown = records.rows.filter(row => `${row.name} ${rowText(row.values['Next step'])} ${status(row)}`.toLowerCase().includes(query.toLowerCase()))
  const milestoneGroups = [...new Set(['Planned', 'Active', 'Needs review', 'Completed', 'Deferred', ...shown.map(row => status(row) || t('research.unspecified'))])]
  const collection = module === 'literature' || module === 'runs' ? space?.sources[module] : null
  const valid = (token: number) => epoch.current === token && current.current.active

  useEffect(() => {
    if (!active || space || !cwd) return
    let cancelled = false
    void (async () => {
      const config = await projectResearchConfig(cwd, host)
      if (!config || cancelled || readResearchSpace(projectKey) || lock.current) return
      lock.current = true; setHome(config.home); setBusy(t('research.connecting')); setError('')
      try {
        const result = await connectResearchSpace(config.home)
        if (!cancelled && current.current.projectKey === projectKey) {
          const value = { ...result, selected: config.selected, opened: config.selected ? [config.selected] : [] }
          saveResearchSpace(projectKey, value); setSpace(value); onLinked(value.home)
        }
      } catch (reason) { if (!cancelled) setError(String(reason)) }
      finally { lock.current = false; setBusy('') }
    })()
    return () => { cancelled = true }
  }, [active, projectKey, cwd, host, space?.home])

  useEffect(() => {
    epoch.current++
    setSpace(readResearchSpace(projectKey)); setHome(linked || ''); setProjects(emptyRows()); setRecords(emptyRows())
    setBrief(''); setSelected([]); setInbox([]); setCheckpoint(null); setDialogMode(null); setWatch(false); setError('')
  }, [projectKey])
  useEffect(() => {
    epoch.current++
    setRecords(emptyRows()); setMilestones(emptyRows()); setSelected([]); setBrief(''); setQuery(''); setInbox([]); setWatch(false); setError(''); setNotice('')
    setDialogMode(null); setCheckpoint(null)
  }, [space?.selected, space?.home])
  useEffect(() => {
    epoch.current++
    if (!active) { setDialogMode(null); setBrief('') }
    return () => { epoch.current++ }
  }, [active])
  useEffect(() => {
    if (!active || !space) return
    let cancelled = false
    setLoading(true); setError('')
    void researchProjects(space).then(result => { if (!cancelled) setProjects(result) })
      .catch(reason => { if (!cancelled) { setProjects(emptyRows()); setError(String(reason)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, space?.home, revision])
  useEffect(() => {
    if (!active || !space || !project) return
    let cancelled = false
    setLoading(true); setRecords(emptyRows()); setMilestones(emptyRows()); setSelected([]); setBrief(''); setError('')
    void Promise.all([projectRecords(space, project.url, module), module === 'overview' && space.sources.milestones ? projectRecords(space, project.url, 'milestones') : Promise.resolve(emptyRows())])
      .then(([rows, goals]) => { if (!cancelled) { setRecords(rows); setMilestones(goals) } })
      .catch(reason => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, space?.home, project?.url, module, revision])
  useEffect(() => {
    const node = dialog.current
    if (dialogMode && node && !node.open) node.showModal()
    if (!dialogMode && node?.open) node.close()
  }, [dialogMode])
  useEffect(() => {
    if (!checkpoint || checkpoint.project !== space?.selected) return
    try { localStorage.setItem(draftKey, JSON.stringify(checkpoint)) }
    catch { setError(t('research.draftStorageError')) }
  }, [checkpoint, draftKey])

  const persist = (value: ResearchSpace) => { saveResearchSpace(projectKey, value); setSpace(value) }
  const choose = (row?: ResearchRow) => {
    if (!space || busy) return
    epoch.current++
    persist({ ...space, selected: row?.url, opened: row ? [...new Set([...space.opened, row.url])].slice(-12) : space.opened })
    setModule('overview')
  }
  const run = async (label: string, operation: (token: number) => Promise<void>) => {
    if (lock.current) return
    const token = epoch.current
    lock.current = true; setBusy(label); setError('')
    try { await operation(token) }
    catch (reason) { if (valid(token)) setError(String(reason)) }
    finally { lock.current = false; setBusy('') }
  }
  const connect = () => void run(t('research.connecting'), async token => {
    const result = await connectResearchSpace(home)
    if (valid(token)) { persist(result); onLinked(result.home) }
  })
  const openCreate = (mode: 'project' | 'milestone') => { setName(''); setDescription(''); setDate(''); setError(''); setDialogMode(mode) }
  const editCheckpoint = (value?: Checkpoint) => {
    if (!project) return
    let draft = blankCheckpoint(project.url)
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null')
      if (saved?.project === project.url && typeof saved.title === 'string' && typeof saved.id === 'string') draft = { ...draft, ...saved }
    } catch { /* Keep the new empty draft. */ }
    setCheckpoint(value || draft); setJson(''); setError(''); setDialogMode('checkpoint')
  }
  const checkInbox = async () => {
    if (!project || !cwd || inboxLock.current) return
    const token = epoch.current
    inboxLock.current = true
    try {
      const result = await readCheckpointInbox(cwd, project.url, host)
      if (valid(token)) { setInbox(result.checkpoints); setNotice(result.warnings.join('\n') || (result.checkpoints.length ? t('research.inboxReady') : t('research.inboxEmpty'))) }
    } catch (reason) { if (valid(token)) setNotice(`${t('research.inboxUnavailable')} ${String(reason)}`) }
    finally { inboxLock.current = false }
  }
  useEffect(() => {
    if (!active || !watch || !project || !cwd) return
    void checkInbox()
    const timer = window.setInterval(() => void checkInbox(), 15000)
    return () => window.clearInterval(timer)
  }, [active, watch, project?.url, cwd, host])

  const submit = () => void run(t('research.saving'), async token => {
    if (!space) return
    if (dialogMode === 'project') {
      const row = await createResearchProject(space, name, description)
      if (valid(token)) { setProjects(old => ({ ...old, rows: [...old.rows, row] })); persist({ ...space, selected: row.url, opened: [...space.opened, row.url].slice(-12) }); setModule('overview'); setDialogMode(null) }
    } else if (dialogMode === 'milestone' && project) {
      const url = await createMilestone(space, project.url, name, description, date)
      if (valid(token)) { setDialogMode(null); setRevision(n => n + 1); setNotice(t('research.saved')); onNavigate(url) }
    } else if (dialogMode === 'checkpoint' && checkpoint && project) {
      if (notionPageUrl(checkpoint.project) !== project.url) throw new Error(t('research.wrongProject'))
      const url = await saveCheckpoint(space, projectKey, checkpoint)
      if (valid(token)) { localStorage.removeItem(draftKey); setCheckpoint(null); setDialogMode(null); setRevision(n => n + 1); setNotice(t('research.savedDraft')); onNavigate(url) }
    }
  })
  const recordRow = (row: ResearchRow, checkable = false) => <div className="research-record" key={row.url}>
    {checkable && <input type="checkbox" aria-label={t('research.include', { name: row.name })} checked={selected.includes(row.url)} disabled={!!busy || (!selected.includes(row.url) && selected.length >= 6)} onChange={event => { setBrief(''); setSelected(old => event.target.checked ? [...old, row.url] : old.filter(url => url !== row.url)) }} />}
    <button className="research-record-main" onClick={() => onNavigate(row.url)}><strong>{row.name}</strong><span>{rowText(row.values['Next step'] || row.values.Outcome || row.values['Reading question'] || row.values.Observation) || t('research.openRecord')}</span></button>
    <span className="research-state" data-state={status(row)}>{status(row) === 'Validated' ? t('research.reviewed') : status(row) || rowText(row.values.Kind)}</span>
    <button className="icon-button" aria-label={t('research.openNamed', { name: row.name })} onClick={() => onNavigate(row.url)}><ArrowUpRight size={14} /></button>
  </div>

  return <section className="research-workspace" aria-label={t('research.title')}>
    <header className="research-topbar"><button className="research-link" disabled={!space || !!busy} onClick={() => choose()}><FolderKanban size={15} />{t('research.projects')}</button><span className="research-topbar-spacer" /><button className="research-link" onClick={onNotebook}><BookOpenText size={14} />{t('research.notion')}</button><button className="icon-button" disabled={loading || !!busy || !space} aria-label={t('research.refresh')} onClick={() => { epoch.current++; setBrief(''); setRevision(n => n + 1) }}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button></header>
    {space && <div className="research-project-tabs" aria-label={t('research.projectTabs')}>{space.opened.map(url => {
      const item = projects.rows.find(row => row.url === url)
      return item ? <button key={url} disabled={!!busy} aria-pressed={space.selected === url} onClick={() => choose(item)}>{item.name}</button> : null
    })}<button disabled={!!busy} aria-label={t('research.newProject')} onClick={() => openCreate('project')}><Plus size={13} /></button></div>}
    {!dialogMode && error && <div className="research-message" role="alert">{error}</div>}
    {busy && !dialogMode && <div className="research-message" role="status"><Loader2 size={13} className="animate-spin" />{busy}</div>}
    {!space ? <div className="research-body research-connect"><span className="research-eyebrow">{t('research.eyebrow')}</span><h1>{t('research.connectTitle')}</h1><p>{t('research.connectHint')}</p><form onSubmit={event => { event.preventDefault(); connect() }}><label className="notebook-field">{t('research.homeUrl')}<input type="url" required value={home} onChange={event => setHome(event.target.value)} placeholder="https://www.notion.so/…" /></label><button className="research-primary" disabled={!!busy || !home.trim()}>{t('research.connect')}</button></form><p className="research-muted">{t('research.connectReadOnly')}</p></div>
    : !project ? <div className="research-body"><div className="research-section-heading"><div><span className="research-eyebrow">{t('research.eyebrow')}</span><h1>{t('research.yourProjects')}</h1></div><button className="research-primary" disabled={!!busy} onClick={() => openCreate('project')}><Plus size={14} />{t('research.newProject')}</button></div><p className="research-muted">{t('research.projectsHint')}</p><label className="research-checkbox"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />{t('research.showArchived')}</label>{loading && <p role="status">{t('research.loading')}</p>}<div className="research-project-grid">{projects.rows.filter(row => showArchived || rowText(row.values.Stage) !== 'Archived').map(row => <button className="research-project-card" key={row.url} onClick={() => choose(row)}><span className="research-card-top"><FolderKanban size={18} /><span className="research-state">{rowText(row.values.Stage)}</span></span><h2>{row.name}</h2><p>{rowText(row.values.Question) || t('research.noQuestion')}</p><span className="research-project-enter">{t('research.openProject')}<ChevronRight size={13} /></span></button>)}</div>{!loading && !projects.rows.length && !error && <p>{t('research.noProjects')}</p>}{projects.limited && <p className="research-muted">{t('research.limited')}</p>}<details className="research-details"><summary>{t('research.changeSpace')}</summary><form onSubmit={event => { event.preventDefault(); connect() }}><label className="notebook-field">{t('research.homeUrl')}<input type="url" required value={home} onChange={event => setHome(event.target.value)} /></label><button className="research-primary" disabled={!!busy}>{t('research.connect')}</button></form></details></div>
    : <><div className="research-project-heading"><button className="icon-button" aria-label={t('research.allProjects')} disabled={!!busy} onClick={() => choose()}><ArrowLeft size={15} /></button><div><span className="research-eyebrow">{t('research.projectSpace')}</span><h1>{project.name}</h1></div><button className="research-link" onClick={() => onNavigate(project.url)}>{t('research.openNotion')}<ArrowUpRight size={13} /></button></div>
      <nav className="research-modules" aria-label={t('research.modules')}>{modules.map(item => <button key={item.id} disabled={!!busy} aria-current={module === item.id ? 'page' : undefined} onClick={() => { epoch.current++; setModule(item.id) }}><item.icon size={14} />{t(`research.module.${item.id}`)}</button>)}</nav>
      <div className="research-body">
        {module === 'overview' && <><div className="research-question"><span className="research-eyebrow">{t('research.currentQuestion')}</span><h2>{rowText(project.values.Question) || t('research.noQuestion')}</h2><p><span>{t('research.nextDecision')}</span> {rowText(project.values['Next decision']) || t('research.noDecision')}</p></div><div className="research-section-heading"><h2>{t('research.module.milestones')}</h2><button className="research-link" onClick={() => setModule('milestones')}>{t('research.viewAll')}<ChevronRight size={13} /></button></div>{milestones.rows.slice(0, 3).map(row => recordRow(row))}{!loading && !milestones.rows.length && <p className="research-muted">{t('research.noMilestones')}</p>}<div className="research-section-heading"><h2>{t('research.resume')}</h2><button className="research-primary" disabled={!cwd || !!busy || loading} onClick={() => void run(t('research.preparing'), async token => { const text = await buildResearchBrief(space, project, selected, cwd!, host); if (valid(token)) setBrief(text) })}>{t('research.prepareBrief', { count: selected.length })}</button></div><p className="research-muted">{t('research.briefHint')}</p></>}
        <div className="research-section-heading"><label className="research-search"><Search size={14} /><input aria-label={t('research.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('research.search')} /></label>{module === 'literature' || module === 'runs' ? <button className="research-link" disabled={!collection} onClick={() => collection && onNavigate(collection.url)}><ArrowUpRight size={14} />{t('research.editCollection')}</button> : <button className="research-link" disabled={!!busy || (module === 'milestones' && !space.sources.milestones)} onClick={() => module === 'milestones' ? openCreate('milestone') : editCheckpoint()}><Plus size={14} />{t(module === 'milestones' ? 'research.addMilestone' : 'research.checkpoint')}</button>}</div>
        {(module === 'literature' || module === 'runs') && <p className="research-muted">{t('research.collectionHint', { name: project.name })}</p>}
        {loading && <p className="research-muted" role="status"><Loader2 size={13} className="animate-spin inline" /> {t('research.loading')}</p>}
        {module === 'milestones' ? <div className="research-milestone-board">{milestoneGroups.map(group => <section key={group}><h3>{group}<span>{shown.filter(row => (status(row) || t('research.unspecified')) === group).length}</span></h3>{shown.filter(row => (status(row) || t('research.unspecified')) === group).map(row => <button className="research-milestone" key={row.url} onClick={() => onNavigate(row.url)}><strong>{row.name}</strong><p>{rowText(row.values.Outcome)}</p><small>{rowText(row.values['date:Target dates:start']) || t('research.noDate')}</small></button>)}</section>)}</div> : <div className="research-records">{shown.map(row => recordRow(row, module === 'overview'))}</div>}
        {!loading && !shown.length && !error && <p className="research-empty">{t('research.noRecords')}</p>}
        {records.limited && <p className="research-muted">{t('research.limited')}</p>}
        {records.fetchedAt && <p className="research-freshness">{t('research.readAt')} {new Date(records.fetchedAt).toLocaleString()} · {t('research.onlyThisProject')}</p>}
        {brief && <section className="research-brief"><div className="research-section-heading"><h2>{t('research.contextPreview')}</h2><button className="icon-button" aria-label={t('research.closeBrief')} onClick={() => setBrief('')}><X size={14} /></button></div><p>{t('research.contextHint')}</p><textarea aria-label={t('research.contextPreview')} value={brief} onChange={event => setBrief(event.target.value)} spellCheck={false} /><footer><button className="research-link" onClick={() => void writeText(brief).catch(reason => setError(String(reason)))}><Copy size={13} />{t('research.copy')}</button><button className="research-primary" disabled={!canUseAgent || !brief.trim() || loading || !!busy} onClick={() => { if (current.current.active && current.current.canUseAgent) onSubmitToAgent(safeAgentText(brief)) }}><Send size={13} />{t('research.continueAgent')}</button></footer></section>}
        <details className="research-details"><summary>{t('research.agentCheckpoints')}</summary><p>{t('research.checkpointHint')}</p><div className="research-inline-actions"><button className="research-primary" disabled={!canUseAgent || !cwd || !!busy} onClick={() => onSubmitToAgent(checkpointPrompt(project, cwd!, host))}><Send size={13} />{t('research.askCheckpoint')}</button><button className="research-link" disabled={!cwd} onClick={() => void checkInbox()}><RefreshCw size={13} />{t('research.checkInbox')}</button><button className="research-link" onClick={() => editCheckpoint()}>{t('research.pasteJson')}</button></div><label className="research-checkbox"><input type="checkbox" checked={watch} onChange={event => setWatch(event.target.checked)} />{t('research.watchInbox')}</label>{inbox.map(item => <button className="research-inbox-item" key={item.id} onClick={() => editCheckpoint(item)}><span>{item.title}</span><small>{t('research.reviewDraft')}<ChevronRight size={12} /></small></button>)}{notice && <p className="research-muted" role="status">{notice}</p>}</details>
      </div></>}
    <dialog ref={dialog} className="research-dialog" aria-labelledby="research-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) setDialogMode(null) }} onClose={() => setDialogMode(null)}>
      <header><div><span className="research-eyebrow">{project?.name || t('research.projects')}</span><h2 id="research-dialog-title">{t(dialogMode === 'project' ? 'research.newProject' : dialogMode === 'milestone' ? 'research.addMilestone' : 'research.reviewCheckpoint')}</h2></div><button className="icon-button" disabled={!!busy} aria-label={t('research.close')} onClick={() => setDialogMode(null)}><X size={16} /></button></header>
      <form onSubmit={event => { event.preventDefault(); submit() }}>
        {dialogMode === 'checkpoint' && checkpoint ? <><p className="research-muted">{t('research.draftHint')}</p><label className="notebook-field">{t('research.kind')}<select value={checkpoint.kind} disabled={!!busy} onChange={event => setCheckpoint({ ...checkpoint, kind: event.target.value as Checkpoint['kind'] })}>{['Idea', 'Research', 'Experiment', 'Conclusion'].map(kind => <option key={kind}>{kind}</option>)}</select></label>{(['title', 'question', 'tried', 'observed', 'interpretation', 'limits', 'evidence', 'next'] as const).map(field => <label className="notebook-field" key={field}>{t(`research.field.${field}`)}{field === 'title' ? <input required maxLength={180} value={checkpoint[field]} disabled={!!busy} onChange={event => setCheckpoint({ ...checkpoint, [field]: event.target.value })} /> : <textarea rows={field === 'evidence' ? 3 : 2} maxLength={6000} disabled={!!busy} value={checkpoint[field]} onChange={event => setCheckpoint({ ...checkpoint, [field]: event.target.value })} />}</label>)}<details className="research-details"><summary>{t('research.pasteJson')}</summary><textarea aria-label={t('research.json')} value={json} maxLength={40000} rows={5} onChange={event => setJson(event.target.value)} /><button className="research-link" type="button" onClick={() => { try { setCheckpoint(parseCheckpoint(json, project!.url)); setError('') } catch (reason) { setError(String(reason)) } }}>{t('research.importJson')}</button></details></>
        : <><label className="notebook-field">{t('research.name')}<input required maxLength={180} value={name} disabled={!!busy} onChange={event => setName(event.target.value)} /></label><label className="notebook-field">{t(dialogMode === 'project' ? 'research.currentQuestion' : 'research.outcome')}<textarea rows={3} maxLength={4000} value={description} disabled={!!busy} onChange={event => setDescription(event.target.value)} /></label>{dialogMode === 'milestone' && <label className="notebook-field">{t('research.targetDate')}<input type="date" value={date} disabled={!!busy} onChange={event => setDate(event.target.value)} /></label>}<p className="research-muted">{t(dialogMode === 'project' ? 'research.newProjectHint' : 'research.milestoneHint')}</p></>}
        {error && <p className="research-message" role="alert">{error}</p>}
        <footer><span className="research-muted">{busy || t('research.directEditing')}</span><button className="research-primary" disabled={!!busy} type="submit">{busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}{t(dialogMode === 'checkpoint' ? 'research.saveDraft' : 'research.create')}</button></footer>
      </form>
    </dialog>
  </section>
}
