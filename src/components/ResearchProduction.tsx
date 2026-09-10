import { useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { BookOpen, Download, Loader2, X } from 'lucide-react'
import { loadConfig } from '@/lib/config'
import { useI18n } from '@/lib/i18n'
import { captureResearch, loadResearchContext, parseResults, renderFigure, researchContextKey, writingPacket,
  type ResearchContext, type ResearchPacket, type FigureRecipe, type RenderedFigure } from '@/lib/researchProduction'

export function usePaperResearch(host: string | undefined, paper: string, fallback: string) {
  const [context, setContext] = useState<ResearchContext>(() => loadResearchContext(host, paper, fallback))
  useEffect(() => setContext(loadResearchContext(host, paper, fallback)), [host, paper, fallback])
  const update = (next: ResearchContext) => {
    localStorage.setItem(researchContextKey(host, paper), JSON.stringify(next))
    setContext(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }
  return { context, update }
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 证据存放在研究仓库所在主机上,所以捕获记录按研究主机分组,而不是工作区主机。
const captureKey = (context: ResearchContext) =>
  `linco.researchCapture:${JSON.stringify([context.host || 'local', context.repo, context.paths])}`
// A select cannot express “a host that is not in the connection list”; this value opens a text field.
const OTHER_HOST = '__other__'
const captureError = (reason: unknown) => /command .+ not found|not a function|undefined.*invoke/i.test(String(reason))
  ? 'This desktop backend does not include Research production yet. Rebuild and restart the desktop app; a browser-only preview cannot capture remote files or run local production tools.'
  : String(reason)

interface Props {
  context: ResearchContext
  onContext: (context: ResearchContext) => void
  passage?: string
  onClose?: () => void
  onAskAgent?: (text: string) => void
}

export default function ResearchProduction({ context, onContext, passage = '', onClose, onAskAgent }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(context)
  const [pathsText, setPathsText] = useState(context.paths.join('\n'))
  const [packet, setPacket] = useState<ResearchPacket | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [changed, setChanged] = useState<string[]>([])
  const [sourcePath, setSourcePath] = useState('')
  const [recipe, setRecipe] = useState({ kind: 'bar' as 'bar' | 'line', x: '', y: '', title: '', yLabel: '' })
  const [figure, setFigure] = useState<{ rendered: RenderedFigure; recipe: FigureRecipe; directory: string } | null>(null)
  const [powerpoint, setPowerpoint] = useState<{ previewPath: string; presentationPath: string; saved: boolean } | null>(null)
  const [hosts, setHosts] = useState<{ host: string; label: string }[]>([])
  const [otherHost, setOtherHost] = useState(false)
  const generation = useRef(0)
  const displayedScope = useRef('')
  useEffect(() => {
    // 面板不接收工作区主机:证据主机独立于论文所在机器,这里直接读连接表给出可选项。
    void loadConfig().then(config => {
      const active = config.connections.find(c => c.id === config.activeConnection)?.host.trim() || ''
      const seen = new Set<string>()
      const options: { host: string; label: string }[] = []
      for (const candidate of [active, ...config.connections.map(c => c.host)]) {
        const value = candidate.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        options.push({ host: value, label: value === active ? `${value} · connected` : value })
      }
      setHosts(options)
    }).catch(() => { /* Without the connection list a host name can still be typed. */ })
  }, [])
  useEffect(() => {
    const ticket = ++generation.current
    setDraft(context); setPathsText(context.paths.join('\n')); setPacket(null); setFigure(null); setPowerpoint(null); setError(''); setBusy(''); setOtherHost(false)
    const scope = captureKey(context)
    if (scope !== displayedScope.current) setChanged([])
    displayedScope.current = scope
    setSourcePath('')
    let directory: string | null = null
    try { directory = localStorage.getItem(captureKey(context)) } catch { /* Editing remains available. */ }
    if (directory) {
      setBusy('Restoring the saved evidence capture…')
      void invoke<ResearchPacket>('research_load', { directory }).then(saved => {
        if (ticket !== generation.current) return
        if (saved.repo !== context.repo || (saved.host || '') !== (context.host || '')
          || JSON.stringify(saved.sources.map(s => s.path).sort()) !== JSON.stringify([...context.paths].sort())) throw new Error('Saved evidence belongs to a different context. Capture the selected files again.')
        setPacket(saved)
        const table = saved.sources.find(s => /\.(csv|tsv)$/i.test(s.path))
        setSourcePath(table?.path || '')
        if (table) {
          try { const [head] = parseResults(table.text, /\.tsv$/i.test(table.path) ? '\t' : ','); setRecipe(r => ({ ...r, x: head[0], y: head[1] || '', title: r.title || 'Experimental results' })) } catch { /* Validate when rendering. */ }
        }
      }).catch(reason => { if (ticket === generation.current) setError(captureError(reason)) })
        .finally(() => { if (ticket === generation.current) setBusy('') })
    }
    return () => { generation.current++ }
  }, [context])
  const currentContext = (): ResearchContext => ({ ...draft, repo: draft.repo.trim(), host: draft.host.trim(), paths: pathsText.split(/\r?\n/).map(s => s.trim()).filter(Boolean) })
  const field = 'w-full rounded-md border border-black/10 bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent'
  const button = 'rounded-md border border-black/10 px-2.5 py-1.5 text-[12px] hover:bg-black/5 disabled:opacity-40'
  const source = packet?.sources.find(s => s.path === sourcePath)
  // 主机也参与比对:同一路径在另一台机器上是另一份文件,不能沿用旧指纹。
  const packetMatches = packet && packet.repo === draft.repo.trim() && (packet.host || '') === draft.host.trim()
    && JSON.stringify(packet.sources.map(s => s.path).sort()) === JSON.stringify(currentContext().paths.sort())
  // 存量上下文里的主机可能已不在连接表中,补进去才不会被下拉框悄悄改掉。
  const hostChoices = !otherHost && draft.host.trim() && !hosts.some(option => option.host === draft.host.trim())
    ? [...hosts, { host: draft.host.trim(), label: draft.host.trim() }] : hosts
  let columns: string[] = []
  try { if (source) columns = parseResults(source.text, source.path.endsWith('.tsv') ? '\t' : ',')[0] } catch { /* Show parsing error when the user renders. */ }

  const capture = async () => {
    const ticket = generation.current
    setBusy('Capturing selected evidence…'); setError('')
    try {
      const settings = currentContext()
      const next = await captureResearch(settings)
      if (ticket !== generation.current) return
      setChanged(packet ? next.sources.filter(s => packet.sources.find(old => old.path === s.path)?.sha256 !== s.sha256).map(s => s.path) : [])
      setPacket(next); setFigure(null); setPowerpoint(null)
      try { localStorage.setItem(captureKey(settings), next.directory) } catch { setError('Evidence is saved on disk, but its reopen shortcut could not be saved. Keep the local record path below.') }
      // A changed captured fingerprint invalidates active paper findings through
      // contextIdentity, while their saved checkpoints remain available.
      onContext({ ...settings, fingerprints: Object.fromEntries(next.sources.map(s => [s.path, s.sha256])) })
      const table = next.sources.find(s => /\.(csv|tsv)$/i.test(s.path))
      setSourcePath(table?.path || '')
      if (table) {
        try { const [head] = parseResults(table.text, table.path.endsWith('.tsv') ? '\t' : ','); setRecipe(r => ({ ...r, x: head[0], y: head[1] || '', title: r.title || 'Experimental results' })) } catch { /* User sees validation in the figure section. */ }
      }
    } catch (reason) { if (ticket === generation.current) setError(captureError(reason)) }
    finally { if (ticket === generation.current) setBusy('') }
  }

  const makeFigure = async () => {
    if (!packet || !source || !packetMatches) return
    const ticket = generation.current
    setBusy('Rendering locally and saving the reproduction record…'); setError('')
    try {
      const spec: FigureRecipe = { ...recipe, version: 1, sourcePath: source.path, sourceSha256: source.sha256, sourceRepo: packet.repo, sourceHost: packet.host }
      const rendered = renderFigure(source, spec)
      const directory = await invoke<string>('research_save_figure', { packetDirectory: packet.directory, recipe: spec, svg: rendered.svg, marks: rendered.marks })
      if (ticket !== generation.current) return
      setFigure({ rendered, recipe: spec, directory }); setPowerpoint(null)
    } catch (reason) { if (ticket === generation.current) setError(captureError(reason)) }
    finally { if (ticket === generation.current) setBusy('') }
  }

  const makePowerpoint = async (save: boolean) => {
    if (!figure) return
    const ticket = generation.current
    setBusy(save ? 'Saving the reviewed PowerPoint figure…' : 'Drawing native objects in local PowerPoint…'); setError('')
    try {
      const result = await invoke<{ previewPath: string; presentationPath: string; saved: boolean }>('research_powerpoint', { directory: figure.directory, save })
      if (ticket === generation.current) setPowerpoint(result)
    } catch (reason) { if (ticket === generation.current) setError(captureError(reason)) }
    finally { if (ticket === generation.current) setBusy('') }
  }

  return <section aria-label="Research production" className="flex h-full min-h-0 flex-col bg-canvas text-ink">
    <header className="flex shrink-0 items-center justify-between border-b border-black/10 px-4 py-3 text-[12px]"><span className="flex items-center gap-2 font-semibold"><BookOpen size={15} />Research context & figures</span>{onClose && <button aria-label="Close research production" onClick={onClose}><X size={15} /></button>}</header>
    <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px] leading-5"><fieldset disabled={!!busy} className="min-w-0 space-y-4">
      <p className="text-ink-muted">Context: <b>{draft.host || 'local'}</b> · Production: <b>this computer</b>. Your paper remains in its original repository.</p>
      <label className="block">Research host<select aria-label="Research host" className={field} value={otherHost ? OTHER_HOST : draft.host.trim()}
        onChange={e => { const value = e.target.value; setOtherHost(value === OTHER_HOST); if (value !== OTHER_HOST) setDraft({ ...draft, host: value }) }}>
        <option value="">{t('common.local')}</option>
        {hostChoices.length > 0 && <optgroup label={t('conn.group')}>{hostChoices.map(option => <option key={option.host} value={option.host}>{option.label}</option>)}</optgroup>}
        <option value={OTHER_HOST}>Other host…</option>
      </select></label>
      {otherHost && <label className="block">Host name<input aria-label="Research host name" value={draft.host} onChange={e => setDraft({ ...draft, host: e.target.value })} placeholder="user@server or an ~/.ssh/config alias; empty = this computer" className={field} /></label>}
      <p className="text-ink-muted">{t('latex.ai.localExecution')}</p>
      <label className="block">Research repository <span className="text-ink-muted">— path on {draft.host.trim() || t('common.local')}</span><input aria-label="Research repository" value={draft.repo} onChange={e => setDraft({ ...draft, repo: e.target.value })} className={field} /></label>
      <label className="block">Evidence files <span className="text-ink-muted">— relative paths, one per line</span><textarea aria-label="Evidence files" rows={4} value={pathsText} onChange={e => setPathsText(e.target.value)} placeholder={'training/model.py\nresults/summary.csv\nnotes/conclusions.md'} className={`${field} font-mono`} /></label>
      <p className="text-ink-muted">Select code, run configuration, measured results and relevant notes. Only these files are captured (16 files, 1 MiB each, 8 MiB total). Hidden files and symlinks are excluded. Review selected files for private information before sharing.</p>
      <label className="block">Paper brief<textarea aria-label="Paper brief" rows={3} maxLength={4000} value={draft.brief} onChange={e => setDraft({ ...draft, brief: e.target.value })} placeholder="Research question, contribution, venue, terminology and limits. These are author instructions, not verified findings." className={field} /></label>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={!!busy} onClick={() => { try { const next = currentContext(); if (next.host && !next.repo) { setError('Enter the research repository path on that host.'); return } onContext(next); setError('') } catch (e) { setError(String(e)) } }}>Use for paper reviews</button><button className={button} disabled={!!busy || !pathsText.trim()} onClick={() => void capture()}>{packet ? 'Refresh source fingerprints' : 'Capture selected evidence'}</button></div>
      {busy && <p role="status" className="flex items-center gap-2"><Loader2 size={13} className="animate-spin" />{busy}</p>}
      {error && <p role="alert" className="rounded-md bg-red-500/10 p-3 text-red-600">{error}</p>}
      {packet && <>
        <div className="rounded-lg border border-black/10 p-3"><h3 className="font-semibold">Captured evidence · {new Date(packet.capturedAt * 1000).toLocaleString()}</h3>
          <p className="break-all text-ink-muted">{packet.host || 'local'}:{packet.repo}</p>
          {!packetMatches && <p role="alert" className="my-2 rounded bg-amber-500/10 p-2">The selected repository or files have changed. Capture them before exporting context or rendering a figure.</p>}
          <p className="text-ink-muted">A fingerprint records captured bytes, not proof that this code produced an earlier run. Re-capture to check for changes.</p>
          {changed.length > 0 && <p className="my-2 rounded bg-amber-500/10 p-2">Changed sources: {changed.join(', ')}. Recheck affected claims before using older analysis.</p>}
          {packet.sources.map(s => <details key={s.path} className="mt-2"><summary className="cursor-pointer break-all">{s.path} · {s.bytes} bytes · {s.sha256.slice(0, 12)}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/5 p-2 text-[10px]">{s.text.slice(0, 4000)}{s.text.length > 4000 ? '\n[Preview truncated]' : ''}</pre></details>)}
          <p className="mt-2 break-all text-[10px] text-ink-muted">Local evidence record: {packet.directory}</p>
          <button className={`${button} mt-2`} disabled={!packetMatches} onClick={() => download('linco-writing-packet.txt', writingPacket(packet, draft.brief, passage), 'text/plain')}><Download size={12} className="mr-1 inline" />Export context for ChatGPT</button>
          <p className="mt-1 text-ink-muted">Download does not upload anything. You choose what to share in ChatGPT. There is no automatic browser-chat synchronization.</p>
        </div>
        <div className="space-y-3 rounded-lg border border-black/10 p-3"><h3 className="font-semibold">Publication figure · local rendering</h3>
          <label className="block">Measured result table<select aria-label="Result table" className={field} value={sourcePath} onChange={e => { setSourcePath(e.target.value); setFigure(null); setPowerpoint(null) }}><option value="">Select CSV or TSV</option>{packet.sources.filter(s => /\.(csv|tsv)$/i.test(s.path)).map(s => <option key={s.path}>{s.path}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-2">{(['x', 'y'] as const).map(key => <label key={key}>{key === 'x' ? 'Category column' : 'Value column'}<select aria-label={key === 'x' ? 'Category column' : 'Value column'} className={field} value={recipe[key]} onChange={e => setRecipe({ ...recipe, [key]: e.target.value })}><option value="">Select column</option>{columns.map(c => <option key={c}>{c}</option>)}</select></label>)}</div>
          <label className="block">Title<input aria-label="Figure title" className={field} value={recipe.title} onChange={e => setRecipe({ ...recipe, title: e.target.value })} /></label>
          <label className="block">Metric and units<input aria-label="Metric and units" className={field} value={recipe.yLabel} onChange={e => setRecipe({ ...recipe, yLabel: e.target.value })} placeholder="Accuracy (%) · higher is better" /></label>
          <label className="block">Chart type<select aria-label="Chart type" className={field} value={recipe.kind} onChange={e => setRecipe({ ...recipe, kind: e.target.value as 'bar' | 'line' })}><option value="bar">Bars · zero-inclusive scale</option><option value="line">Line · table order, equal category spacing</option></select></label>
          <p className="text-ink-muted">Every supplied row is used. No silent filtering, averaging, smoothing or invented error bars. This first layout supports up to 20 short category labels; line spacing is categorical, not a numeric x-axis.</p>
          <button className={button} disabled={!!busy || !source || !packetMatches} onClick={() => void makeFigure()}>Render and save a new figure revision</button>
          {figure && <><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(figure.rendered.svg)}`} alt="Figure rendered from captured experiment data" className="w-full rounded border border-black/10 bg-white" /><p className="text-ink-muted">Preview uses the saved recipe below; changed controls take effect only when you render a new revision.</p><div className="flex flex-wrap gap-2"><button className={button} onClick={() => download('figure.svg', figure.rendered.svg, 'image/svg+xml')}>Export SVG</button><button className={button} disabled={!!busy || figure.recipe.kind !== 'bar' || !!powerpoint} onClick={() => void makePowerpoint(false)}>Open editable PowerPoint</button>{onAskAgent && <button className={button} onClick={() => onAskAgent(`Review the scientific presentation of this figure against the remote project. Do not run local PowerPoint on the server or invent values. Source: ${packet.repo}/${figure.recipe.sourcePath}; SHA256 ${figure.recipe.sourceSha256}. Recipe: ${JSON.stringify(figure.recipe)}. Explain any misleading labels, missing comparisons, provenance or uncertainty. Propose changes for my review; rendering stays local.`)}>Discuss with agent</button>}</div><p className="break-all text-[10px] text-ink-muted">Local SVG, data and recipe: {figure.directory}</p><p className="text-ink-muted">PowerPoint requires Windows PowerPoint and Node.js on this computer. Remote Linux does not need either. Nothing is automatically written back to the remote paper.</p></>}
          {powerpoint && <><img src={`${convertFileSrc(powerpoint.previewPath)}?v=${Date.now()}`} className="w-full bg-white" alt="Editable PowerPoint preview for approval" /><p className="text-ink-muted">Inspect labels and geometry before saving. This is a new presentation; your existing presentations are untouched.</p><button className={button} disabled={!!busy || powerpoint.saved} onClick={() => void makePowerpoint(true)}>{powerpoint.saved ? 'PowerPoint saved' : 'Approve preview and save PowerPoint'}</button><p className="break-all text-[10px]">{powerpoint.presentationPath}</p></>}
        </div>
      </>}
    </fieldset></div>
  </section>
}
