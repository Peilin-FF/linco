import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, BookOpenText, Check, FlaskConical, Lightbulb, Loader2, Plus, Search, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { checkNotionConnection, createNotionRecord, readWorkbench, setUpWorkbench, type NotionWorkbench } from '@/lib/notionWorkbench'
import { notionTemplates, type NotionTemplateId } from '@/lib/notionTemplates'

interface Props {
  active: boolean
  project: string
  cwd?: string
  linked: string | null
  onNavigate: (url: string) => void
  onLinked: (url: string) => void
  onConnect: () => void
  onResearch: () => void
}
const icons = { idea: Lightbulb, research: Search, experiment: FlaskConical, conclusion: Check }

export default function NotionNotebookTools({ active, project, cwd, linked, onNavigate, onLinked, onConnect, onResearch }: Props) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const currentProject = useRef(project)
  currentProject.current = project
  const pending = useRef(false)
  const [workbench, setWorkbench] = useState<NotionWorkbench | null>(() => readWorkbench(project))
  const [connection, setConnection] = useState<'checking' | 'connected' | 'disconnected' | 'updateNeeded'>('checking')
  const [connectionError, setConnectionError] = useState('')
  const [check, setCheck] = useState(0)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [home, setHome] = useState(linked || '')
  const [kind, setKind] = useState<NotionTemplateId>('idea')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [source, setSource] = useState('')
  const template = notionTemplates.find((item) => item.id === kind)!
  const complete = !!workbench?.journal && notionTemplates.every((item) => workbench.templates[item.id])

  useEffect(() => {
    setWorkbench(readWorkbench(project)); setHome(linked || ''); setOpened(false)
    setTitle(''); setNote(''); setSource(''); setError('')
  }, [project]) // A changed page link must not discard an in-progress capture.
  useEffect(() => {
    const update = (event: Event) => {
      if ((event as CustomEvent).detail?.project === project) { setWorkbench(readWorkbench(project)); setOpened(false) }
    }
    window.addEventListener('linco-notebook-binding', update)
    return () => window.removeEventListener('linco-notebook-binding', update)
  }, [project])

  useEffect(() => {
    if (!active) { setOpened(false); return }
    let cancelled = false
    setConnection('checking')
    void checkNotionConnection().then((result) => {
      if (!cancelled) { setConnection(result?.connected ? 'connected' : 'disconnected'); setConnectionError('') }
    }).catch((reason) => {
      if (!cancelled) { setConnection(/command.*not found/i.test(String(reason)) ? 'updateNeeded' : 'disconnected'); setConnectionError(String(reason)) }
    })
    return () => { cancelled = true }
  }, [active, check])

  useEffect(() => {
    const node = dialog.current
    if (opened && node && !node.open) node.showModal()
    if (!opened && node?.open) node.close()
  }, [opened])

  const run = async (create: boolean) => {
    if (pending.current || !cwd || connection !== 'connected') return
    const target = project
    pending.current = true
    setError(''); setBusy(t(create ? 'notebook.creating' : 'notebook.preparing'))
    try {
      if (create) {
        const url = await createNotionRecord(target, kind, title, note, source)
        if (currentProject.current === target) {
          setWorkbench(readWorkbench(target)); setOpened(false); setTitle(''); setNote(''); setSource(''); onNavigate(url)
        }
      } else {
        const name = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Project'
        const result = await setUpWorkbench(target, name, home.trim() || null, (step) => {
          if (currentProject.current === target) setBusy(step)
        })
        if (currentProject.current === target) { setWorkbench(result); onLinked(result.home) }
      }
    } catch (reason) {
      if (currentProject.current === target) { setError(String(reason)); setWorkbench(readWorkbench(target)) }
    } finally { pending.current = false; setBusy('') }
  }
  const navigate = (url?: string) => { if (url) { setOpened(false); onNavigate(url) } }

  return <>
    <div className="notebook-bar" aria-label={t('notebook.tools')}>
      <button className="notion-text-button" onClick={onResearch}>{t('research.title')}</button>
      <button className="notion-text-button notebook-home" disabled={!workbench?.home && !linked} onClick={() => navigate(workbench?.home || linked || undefined)}><BookOpenText size={13} />{t('notebook.home')}</button>
      {workbench?.journal && <button className="notion-text-button" onClick={() => navigate(workbench.journal?.url)}>{t('notebook.journal')}</button>}
      {workbench?.progress && <button className="notion-text-button" onClick={() => navigate(workbench.progress)}>{t('notebook.progress')}</button>}
      <span className="notebook-bar-spacer" />
      <button className={`notebook-connection ${connection}`} title={connectionError || t('notebook.localHint')} onClick={() => setCheck((n) => n + 1)} disabled={connection === 'checking'}>{connection === 'checking' ? <Loader2 size={11} className="animate-spin" /> : <span />}{t(`notebook.${connection}`)}</button>
      <button className="notion-text-button" disabled={!cwd} onClick={() => { if (!workbench) setHome(linked || ''); setOpened(true) }}><Plus size={13} />{t('notebook.templates')}</button>
    </div>
    <dialog ref={dialog} className="notebook-dialog" aria-labelledby="notebook-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) setOpened(false) }} onClose={() => setOpened(false)}>
      <header className="notebook-dialog-header"><div><span className="notebook-eyebrow">{t('notebook.eyebrow')}</span><h2 id="notebook-dialog-title">{t(complete ? 'notebook.newNote' : 'notebook.setUp')}</h2></div><button className="icon-button" disabled={!!busy} aria-label={t('notebook.close')} onClick={() => setOpened(false)}><X /></button></header>
      {connection !== 'connected' ? <div className="notebook-setup">
        <p>{t(connection === 'updateNeeded' ? 'notebook.updateDescription' : 'notebook.connectDescription')}</p>
        {connectionError && connection !== 'updateNeeded' && <p className="notion-muted">{connectionError}</p>}
        <div className="notion-panel-actions">{connection !== 'updateNeeded' && <button className="notion-primary" onClick={() => { setOpened(false); onConnect() }}>{t('notion.setup')}</button>}<button className="notion-text-button" disabled={connection === 'checking'} onClick={() => setCheck((n) => n + 1)}>{t('notebook.checkConnection')}</button></div>
      </div> : !complete ? <div className="notebook-setup">
        <p>{t('notebook.setupDescription')}</p>
        <div className="notebook-template-list">{notionTemplates.map((item) => { const Icon = icons[item.id]; return <span key={item.id}><Icon size={15} />{t(`notebook.kind.${item.id}`)}</span> })}</div>
        <label className="notebook-field">{t('notebook.destination')}<input type="url" value={workbench?.home || home} disabled={!!workbench || !!busy} placeholder="https://www.notion.so/…" onChange={(event) => setHome(event.target.value)} /></label>
        <p className="notion-muted">{t('notebook.destinationHint')}</p>
        <button className="notion-primary" disabled={!!busy} onClick={() => void run(false)}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}{t(workbench ? 'notebook.continueSetup' : 'notebook.createNotebook')}</button>
      </div> : <div className="notebook-compose">
        <nav className="notebook-template-nav" aria-label={t('notebook.templates')}>{notionTemplates.map((item) => {
          const Icon = icons[item.id]
          return <button key={item.id} disabled={!!busy} aria-pressed={kind === item.id} onClick={() => setKind(item.id)}><Icon size={16} /><span><strong>{t(`notebook.kind.${item.id}`)}</strong><small>{t(`notebook.short.${item.id}`)}</small></span></button>
        })}<button className="notebook-edit-templates" onClick={() => navigate(workbench?.templatesPage)} disabled={!!busy}>{t('notebook.editTemplates')}<ArrowUpRight size={12} /></button></nav>
        <form className="notebook-capture" onSubmit={(event) => { event.preventDefault(); void run(true) }}>
          <div className={`notebook-outline ${template.color}`}><span className="notebook-eyebrow">{t('notebook.outline')}</span><p>{t(`notebook.description.${kind}`)}</p><div>{template.sections.map((section, i) => <span key={section}><small>0{i + 1}</small>{t(`notebook.sections.${kind}`).split('|')[i]}</span>)}</div></div>
          <label className="notebook-field">{t('notebook.title')}<input autoFocus required maxLength={180} value={title} disabled={!!busy} placeholder={t(`notebook.placeholder.${kind}`)} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="notebook-field">{t('notebook.startingNote')}<textarea rows={3} maxLength={8000} value={note} disabled={!!busy} placeholder={t('notebook.notePlaceholder')} onChange={(event) => setNote(event.target.value)} /></label>
          <label className="notebook-field">{t('notebook.source')}<input type="url" maxLength={2000} value={source} disabled={!!busy} placeholder="https://…" onChange={(event) => setSource(event.target.value)} /></label>
          <footer><span>{t('notebook.draftHint')}</span><button className="notion-primary" type="submit" disabled={!!busy || !title.trim()}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}{t('notebook.createRecord')}</button></footer>
        </form>
      </div>}
      {busy && <p className="notebook-operation" role="status"><Loader2 size={13} className="animate-spin" />{busy}</p>}
      {error && <div className="notebook-operation notebook-operation-error" role="alert">{error}<small>{t('notebook.errorHint')}</small></div>}
    </dialog>
  </>
}
