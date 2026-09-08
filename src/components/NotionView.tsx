import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpenText, Check, Copy, ExternalLink, Link2, Loader2, RefreshCw, Unlink, X } from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useI18n } from '@/lib/i18n'
import { layoutNotion, normalizeNotionUrl, notionAction, notionPageUrl,
  notionProjectKey, notionStatus, NOTION_HOME, NOTION_MCP_LOGIN, NOTION_MCP_SETUP,
  openNotion, readNotionLink, saveNotionLink, type NotionStatus } from '@/lib/notion'
import { discoverWorkbench, fetchNotionPage, safeAgentText, saveWorkbench, snapshotForAgent } from '@/lib/notionWorkbench'
import NotionNotebookTools from './NotionNotebookTools'
import ResearchWorkspace from './ResearchWorkspace'
import { readResearchSpace } from '@/lib/researchMemory'

interface Props {
  active: boolean
  cwd?: string
  host?: string
  canUseAgent: boolean
  onSubmitToAgent: (text: string) => void
  onOpenTerminal: () => void
}

export default function NotionView({ active, cwd, host, canUseAgent, onSubmitToAgent, onOpenTerminal }: Props): JSX.Element {
  const { t } = useI18n()
  const key = notionProjectKey(cwd, host)
  const viewport = useRef<HTMLDivElement>(null)
  const lastProject = useRef<string>()
  const [linked, setLinked] = useState<string | null>(() => readNotionLink(key))
  const [address, setAddress] = useState(linked || NOTION_HOME)
  const editingAddress = useRef(false)
  const [page, setPage] = useState<NotionStatus | null>(null)
  const [ready, setReady] = useState(false)
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<'setup' | 'agent' | null>(null)
  const [copied, setCopied] = useState(false)
  const [reading, setReading] = useState(false)
  const [surface, setSurface] = useState<'notion' | 'research'>(() => readResearchSpace(key) ? 'research' : 'notion')
  const [question, setQuestion] = useState('')
  const readingRef = useRef(false)
  const activeContext = useRef({ key, canUseAgent })
  activeContext.current = { key, canUseAgent }
  const currentPage = notionPageUrl(page?.url || '')

  useEffect(() => {
    let cancelled = false
    const target = readNotionLink(key)
    setLinked(target)
    setAddress(target || NOTION_HOME)
    setPage(null)
    setReady(false)
    setError('')
    setPanel(null)
    setQuestion('')
    setSurface(readResearchSpace(key) ? 'research' : 'notion')
    const changedProject = lastProject.current !== undefined && lastProject.current !== key
    lastProject.current = key
    void openNotion(target || NOTION_HOME, changedProject).then(() => {
      if (!cancelled) setReady(true)
    }).catch((reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [key, retry])

  useEffect(() => {
    if (!active || !ready) return
    let cancelled = false
    const poll = async () => {
      try {
        const status = await notionStatus()
        if (!cancelled && status) {
          setPage(status)
          if (!editingAddress.current) setAddress(status.url)
        }
      } catch (reason) { if (!cancelled) setError(String(reason)) }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1200)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active, ready])

  useLayoutEffect(() => {
    const node = viewport.current
    let frame = 0
    let last = ''
    const sync = () => {
      const rect = node?.getBoundingClientRect()
      const visible = active && surface === 'notion' && ready && !panel && !document.querySelector('dialog[open], [aria-modal="true"], [data-native-overlay="true"]') &&
        !!rect && rect.width > 1 && rect.height > 1
      const layout = { visible, ...(visible && rect ? { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}) }
      const serialized = JSON.stringify(layout)
      if (serialized !== last) {
        last = serialized
        void layoutNotion(layout).catch((reason) => setError(String(reason)))
      }
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync) }
    const observer = new ResizeObserver(schedule)
    if (node) observer.observe(node)
    // Native views paint above HTML, regardless of CSS z-index. Hide them for
    // both modal dialogs and overlapping header popovers such as SSH settings.
    const modals = new MutationObserver(schedule)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal', 'data-native-overlay'] })
    window.addEventListener('resize', schedule)
    sync()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      modals.disconnect()
      window.removeEventListener('resize', schedule)
      void layoutNotion({ visible: false }).catch(() => {})
    }
  }, [active, ready, panel, surface])

  const go = async () => {
    const url = normalizeNotionUrl(address)
    if (!url) { setError(t('notion.invalidUrl')); return }
    setError('')
    setPanel(null)
    try { await openNotion(url, true); setReady(true); editingAddress.current = false } catch (reason) { setError(String(reason)) }
  }
  const action = (kind: 'back' | 'forward' | 'reload') => {
    setError('')
    void notionAction(kind).catch((reason) => setError(String(reason)))
  }
  const link = (value: string | null) => {
    try { saveNotionLink(key, value); setLinked(value); setError('') } catch (reason) { setError(String(reason)) }
  }
  const copy = (text: string) => {
    void writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800) })
      .catch((reason) => setError(String(reason)))
  }
  const linkResearch = (url: string) => {
    const target = key
    link(url)
    // Reuse the existing templates in the newly selected home. This only reads
    // cloud content and changes local bindings, never creates a second journal.
    void discoverWorkbench(url).then(workbench => {
      if (activeContext.current.key !== target || !workbench.journal || readResearchSpace(target)?.home !== workbench.home) return
      saveWorkbench(target, workbench)
      window.dispatchEvent(new CustomEvent('linco-notebook-binding', { detail: { project: target } }))
    }).catch(reason => { if (activeContext.current.key === target) setError(String(reason)) })
  }
  const navigate = (url: string) => {
    setSurface('notion')
    setPanel(null); setAddress(url); setError('')
    void openNotion(url, true).then(() => { setReady(true); setPage({ url, title: 'Notion', loading: false }) }).catch((reason) => setError(String(reason)))
  }
  const readWithAgent = async () => {
    if (!currentPage || !cwd || !canUseAgent || readingRef.current) return
    const target = key
    readingRef.current = true; setReading(true); setError('')
    try {
      const snapshot = await fetchNotionPage(currentPage)
      if (activeContext.current.key !== target || !activeContext.current.canUseAgent) return
      const context = snapshotForAgent(snapshot, cwd, host)
      onSubmitToAgent(context + (question.trim() ? `\n\nMy feedback / question for this discussion:\n${safeAgentText(question.trim())}` : ''))
      setPanel(null); setQuestion('')
    } catch (reason) { if (activeContext.current.key === target) setError(String(reason)) }
    finally { readingRef.current = false; setReading(false) }
  }

  return <section className="notion-view" aria-label={t('notion.title')}>
    <div className="notion-surface" style={{ display: surface === 'research' ? 'flex' : 'none' }}>
      <ResearchWorkspace active={active && surface === 'research'} projectKey={key} cwd={cwd} host={host} linked={linked}
        canUseAgent={canUseAgent} onSubmitToAgent={onSubmitToAgent} onNavigate={navigate}
        onLinked={linkResearch} onNotebook={() => setSurface('notion')} />
    </div>
    <div className="notion-surface" style={{ display: surface === 'notion' ? 'flex' : 'none' }}>
    <div className="notion-toolbar">
      <button className="icon-button" title={t('notion.back')} aria-label={t('notion.back')} disabled={!ready} onClick={() => action('back')}><ArrowLeft /></button>
      <button className="icon-button" title={t('notion.forward')} aria-label={t('notion.forward')} disabled={!ready} onClick={() => action('forward')}><ArrowRight /></button>
      <button className="icon-button" title={t('notion.reload')} aria-label={t('notion.reload')} disabled={!ready} onClick={() => action('reload')}>{page?.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}</button>
      <form className="notion-address" onSubmit={(event) => { event.preventDefault(); void go() }}>
        <input aria-label={t('notion.url')} value={address} onChange={(event) => setAddress(event.target.value)} onFocus={() => { editingAddress.current = true }} onBlur={() => { editingAddress.current = false }} spellCheck={false} />
        <button type="submit">{t('notion.go')}</button>
      </form>
      <button className="icon-button" disabled={!currentPage || !cwd} title={t(linked === currentPage && linked ? 'notion.unlink' : 'notion.link')} aria-label={t(linked === currentPage && linked ? 'notion.unlink' : 'notion.link')} onClick={() => link(linked === currentPage ? null : currentPage)}>{linked && linked === currentPage ? <Check /> : <Link2 />}</button>
      <button className="notion-text-button" disabled={!currentPage || !canUseAgent} onClick={() => setPanel('agent')}>{t('notion.useInAgent')}</button>
      <button className="notion-text-button" onClick={() => setPanel(panel === 'setup' ? null : 'setup')}>{t('notion.setup')}</button>
    </div>
    <NotionNotebookTools active={active && surface === 'notion'} project={key} cwd={cwd} linked={linked} onNavigate={navigate} onLinked={setLinked} onConnect={() => setPanel('setup')} onResearch={() => { setPanel(null); setSurface('research') }} />
    {error && <div className="notion-error" role="alert"><span>{error}</span><button onClick={() => { setError(''); setRetry((n) => n + 1) }}>{t('notion.retry')}</button></div>}
    <div ref={viewport} className="notion-viewport" data-native-notion-viewport>
      {!ready && !error && <div className="notion-placeholder"><Loader2 size={18} className="animate-spin" /><span>{t('notion.opening')}</span></div>}
      {!ready && error && <div className="notion-placeholder"><BookOpenText size={22} /><p>{t('notion.nativeRequired')}</p></div>}
      {panel && <div className="notion-panel">
        <button className="icon-button notion-panel-close" aria-label={t('notion.closePanel')} onClick={() => setPanel(null)}><X /></button>
        {panel === 'agent' ? <>
          <h2>{t('notion.agentTitle')}</h2>
          <p>{t('notion.agentDescription')}</p>
          <code className="notion-page-link">{currentPage}</code>
          <label className="notebook-field">{t('notebook.agentQuestion')}<textarea rows={3} maxLength={4000} value={question} disabled={reading} onChange={(event) => setQuestion(event.target.value)} placeholder={t('notebook.agentPlaceholder')} /></label>
          <p className="notion-muted">{t('notion.agentPermission')}</p>
          <div className="notion-panel-actions"><button className="notion-primary" disabled={!currentPage || !canUseAgent || reading} onClick={() => void readWithAgent()}>{reading && <Loader2 size={13} className="animate-spin" />}{t(reading ? 'notebook.reading' : 'notion.readWithAgent')}</button><button className="notion-text-button" onClick={() => setPanel('setup')}>{t('notion.setup')}</button></div>
        </> : <>
          <h2>{t('notion.setupTitle')}</h2>
          <p>{t('notion.setupDescription')}</p>
          <p className="notion-muted">{t('notion.localSetup')}</p>
          {host && <p className="notion-muted">{t('notebook.remoteBridge', { host })}</p>}
          <ol>
            <li>{t('notion.checkServer')}<code>codex mcp list</code></li>
            <li>{t('notion.addServer')}<code>{NOTION_MCP_SETUP}</code><code>{NOTION_MCP_LOGIN}</code></li>
            <li>{t('notion.restartAgent')}</li>
          </ol>
          <p className="notion-muted">{t('notion.permissions')}</p>
          <div className="notion-panel-actions"><button className="notion-primary" onClick={() => copy(`${NOTION_MCP_SETUP}\n${NOTION_MCP_LOGIN}`)}>{copied ? <Check size={13} /> : <Copy size={13} />}{t(copied ? 'notion.copied' : 'notion.copyCommands')}</button><button className="notion-text-button" onClick={onOpenTerminal}>{t('notion.openTerminal')}</button></div>
          <p className="notion-muted">{t('notion.loginHint')}</p>
          <div className="notion-panel-actions"><a href="https://developers.notion.com/guides/mcp/get-started-with-mcp" target="_blank" rel="noreferrer">{t('notion.notionGuide')} <ExternalLink size={11} /></a><a href="https://developers.openai.com/codex/mcp/" target="_blank" rel="noreferrer">{t('notion.codexGuide')} <ExternalLink size={11} /></a></div>
        </>}
      </div>}
    </div>
    <div className="notion-statusbar"><span>{linked ? t('notion.projectLinked') : t('notion.directEditing')}</span>{linked && <button title={linked} onClick={() => { setAddress(linked); void openNotion(linked, true).catch((reason) => setError(String(reason))) }}>{t('notion.projectPage')}</button>}{linked && <button aria-label={t('notion.unlink')} title={t('notion.unlink')} onClick={() => link(null)}><Unlink size={11} /></button>}<span className="notion-status-tail">{t('notion.storedInNotion')}</span></div>
    </div>
  </section>
}
