import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Archive, ArrowRight, Check, ChevronDown, FileText, FolderOpen, LayoutGrid, MessageSquare, MoreHorizontal, Plus, RotateCw, Search, Sparkles, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import {
  appendWorkboardEvent, discoverPreviewArtifacts, loadWorkboard, workboardAgentPrompt,
  type WorkboardEvent, type WorkboardStatus, type WorkboardTask
} from '@/lib/previewWorkboard'
import { createWorkboardAction, ensureWorkboardActionArtifact } from '@/lib/workboardActionArtifact'
import { ensureWorkboardProject, getWorkboardSetup, subscribeWorkboardSetup } from '@/lib/workboardProject'
import './previewWorkboard.css'

interface PreviewWorkboardProps {
  cwd?: string
  host?: string
  onOpenArtifact: (relativePath: string) => void
  onSubmitToAgent?: (prompt: string) => void | boolean
}

const words = {
  en: {
    board: 'Project workboard', heading: 'Work in view', eyebrow: 'LINCO', subtitle: 'A little space for the work that matters.',
    trackingReady: 'Session tracking ready', trackingPreparing: 'Preparing session tracking…', trackingError: 'Could not prepare session tracking', trackingHint: 'Agent sessions in this project receive instructions to create and update actions.', viewAction: 'View action',
    newOutcome: 'New action', planned: 'Planned', progress: 'In progress', review: 'Needs review', done: 'Done',
    current: 'CURRENT FOCUS', next: 'UP NEXT', noCurrent: 'No work in progress', noNext: 'Your next action goes here',
    currentHint: 'Choose an action when work begins.', nextHint: 'Keep future actions in Planned.',
    search: 'Search actions', filter: 'Filter actions', all: 'All actions', active: 'Active', archived: 'Archived',
    title: 'Title', titlePlaceholder: 'What should be different when this is done?', outcome: 'Expected outcome', action: 'Action',
    outcomePlaceholder: 'Describe the result and why it matters.', status: 'Status', create: 'Create action', cancel: 'Cancel',
    save: 'Save changes', saving: 'Saving…', latest: 'Latest progress', nextStep: 'Next step', acceptance: 'Acceptance checks',
    acceptanceHint: 'One check per line', progressPlaceholder: 'A concise account of the current state.', nextPlaceholder: 'The next concrete action or decision.',
    emptyTitle: 'Good work starts with an intention.', emptyBody: 'Ask your agent to begin. Each action keeps its progress and results together. You can also create an action here.',
    emptyPlanned: 'Nothing planned yet', emptyProgress: 'Nothing in progress', emptyReview: 'Nothing to review', emptyDone: 'Completed work lives here',
    noMatches: 'No matching actions', unassigned: 'Link existing artifact', unassignedBody: 'Attach an existing HTML file as a supporting result for an action. Its file stays where it is.',
    noUnassigned: 'All discovered HTML files are linked, or no HTML files have been created yet.', limited: 'Discovery reached its limit. You can also attach a project-relative file path in action details.',
    open: 'Open', attach: 'Attach', attachFile: 'Attach file', attachTo: 'Attach to an action', newInstead: 'New action instead',
    artifacts: 'Supporting results', primary: 'Primary result', makePrimary: 'Set as primary', remove: 'Unlink', noFiles: 'No supporting results linked yet.',
    relativePath: 'Project-relative HTML path', addPath: 'Link preview', openPreview: 'Open preview',
    actionArtifact: 'Action artifact', openAction: 'Open action artifact', actionDetails: 'Action details', actionArtifactHint: 'The living record of this action: context, progress, adjustments, and next steps.', createHint: 'An HTML artifact is created and linked to this action automatically.', saveBeforeOpen: 'Save your changes before opening the action artifact.',
    activity: 'Progress & adjustments', addUpdate: 'Add update', updatePlaceholder: 'Record what changed, what you learned, or a decision.',
    recordUpdate: 'Record update', recordDecision: 'Record decision', history: 'History', earlier: 'Recent entries, in chronological order.', moreHistory: 'Show earlier history',
    created: 'Created action', updated: 'Updated', note: 'Progress update', decision: 'Decision recorded', user: 'You', agent: 'Agent',
    request: 'Request agent work', requested: 'Requested agent work for this action.', requestHint: 'Sends this action to the current agent session. The board records progress as the work is updated.',
    requestUnavailable: 'Could not send this request. Check that an agent session is ready, then try again.',
    saveFirst: 'Save your changes before requesting agent work.', archive: 'Archive action', restore: 'Restore action', markDone: 'Mark done', markedDone: 'Marked this action done.',
    archiveNote: 'Archived this action.', restoreNote: 'Restored this action.', close: 'Close',
    loading: 'Loading project workboard…', noProject: 'Open a project to keep its work and previews together.', retry: 'Retry', refresh: 'Refresh workboard',
    error: 'Could not update the workboard', warnings: 'Some project records need attention', saved: 'Saved in this project',
    changedElsewhere: 'This action has new updates. Your draft is preserved; saving changes only the fields you edited.',
    needsTitle: 'Give this action a title.', invalidPath: 'Use a project-relative .html or .htm file path without .. segments.',
    chooseOutcome: 'Choose an action', linked: 'Linked preview', attachment: 'Preview attached',
    runningCount: 'in progress', reviewCount: 'need review', doneCount: 'done', totalCount: 'actions',
    noHistory: 'Progress and decisions will appear here.', deleted: 'This action is no longer available. Close and refresh the workboard.',
    archiveHint: 'Archived actions remain in project history.', optional: 'Optional', noUpdate: 'No progress update yet', changeDetails: 'View changes',
  },
  zh: {
    board: '项目工作看板', heading: '让进展清晰可见', eyebrow: 'LINCO', subtitle: '留一点空间，专注重要的事。',
    trackingReady: '会话追踪已就绪', trackingPreparing: '正在准备会话追踪…', trackingError: '无法准备会话追踪', trackingHint: '此项目中的 Agent 会话将收到创建和更新行动的指引。', viewAction: '查看行动',
    newOutcome: '新建行动', planned: '待开始', progress: '进行中', review: '待审阅', done: '已完成',
    current: '当前重点', next: '下一步', noCurrent: '暂无进行中的工作', noNext: '在这里规划下一项行动',
    currentHint: '开始工作时，将行动移至进行中。', nextHint: '将后续行动放在待开始列。',
    search: '搜索行动', filter: '筛选行动', all: '全部行动', active: '未完成', archived: '已归档',
    title: '标题', titlePlaceholder: '完成后，你希望看到什么变化？', outcome: '预期结果', action: '行动',
    outcomePlaceholder: '描述预期结果及其意义。', status: '状态', create: '创建行动', cancel: '取消',
    save: '保存修改', saving: '保存中…', latest: '最新进展', nextStep: '下一步', acceptance: '验收条件',
    acceptanceHint: '每行一项条件', progressPlaceholder: '简要记录当前状态。', nextPlaceholder: '下一项具体行动或需要做出的决定。',
    emptyTitle: '从一个想法，开始一项行动。', emptyBody: '让 Agent 开始工作，每项行动会收纳自己的进展与成果。也可以在这里创建行动。',
    emptyPlanned: '暂无待开始的行动', emptyProgress: '暂无进行中的行动', emptyReview: '暂无待审阅的行动', emptyDone: '完成的工作会留在这里',
    noMatches: '没有匹配的行动', unassigned: '关联已有文档', unassignedBody: '将已有 HTML 文件关联为行动的相关成果。文件仍保留在原位置。',
    noUnassigned: '已发现的 HTML 文件均已关联，或项目尚未创建 HTML 文件。', limited: '文件发现已达到数量上限。也可在行动详情内输入项目相对路径进行关联。',
    open: '打开', attach: '关联', attachFile: '关联文件', attachTo: '关联到行动', newInstead: '改为新建行动',
    artifacts: '相关成果', primary: '主要成果', makePrimary: '设为主要成果', remove: '取消关联', noFiles: '暂无关联的成果。',
    relativePath: 'HTML 文件的项目相对路径', addPath: '关联预览', openPreview: '打开预览',
    actionArtifact: '行动文档', openAction: '打开行动文档', actionDetails: '行动详情', actionArtifactHint: '持续记录此行动的背景、进展、调整和下一步。', createHint: '将自动创建 HTML 文档并关联到此行动。', saveBeforeOpen: '请先保存修改，再打开行动文档。',
    activity: '进展与调整', addUpdate: '添加更新', updatePlaceholder: '记录调整、收获或决策。',
    recordUpdate: '记录更新', recordDecision: '记录决策', history: '历史记录', earlier: '按时间顺序显示最近的记录。', moreHistory: '查看更早记录',
    created: '创建行动', updated: '更新', note: '进展更新', decision: '记录决策', user: '你', agent: 'Agent',
    request: '请求 Agent 执行', requested: '已请求 Agent 执行此行动。', requestHint: '将此行动发送至当前 Agent 会话。工作更新后，看板会记录进展。',
    requestUnavailable: '无法发送此请求。请确认 Agent 会话已就绪后重试。',
    saveFirst: '请先保存修改，再请求 Agent 执行。', archive: '归档行动', restore: '恢复行动', markDone: '标记完成', markedDone: '将此行动标记为已完成。',
    archiveNote: '归档此行动。', restoreNote: '恢复此行动。', close: '关闭',
    loading: '正在加载项目看板…', noProject: '打开一个项目，集中管理其工作与预览。', retry: '重试', refresh: '刷新看板',
    error: '无法更新看板', warnings: '部分项目记录需要检查', saved: '已保存在此项目中',
    changedElsewhere: '此行动有新更新。你的草稿已保留；保存时仅更新你编辑过的字段。',
    needsTitle: '请填写行动标题。', invalidPath: '请输入不含 .. 路径段的项目相对 .html 或 .htm 文件路径。',
    chooseOutcome: '选择行动', linked: '已关联预览', attachment: '关联预览',
    runningCount: '进行中', reviewCount: '待审阅', doneCount: '已完成', totalCount: '项行动',
    noHistory: '进展与决策将在此显示。', deleted: '此行动已不可用。请关闭并刷新看板。',
    archiveHint: '归档行动仍保留在项目历史中。', optional: '选填', noUpdate: '暂无进展更新', changeDetails: '查看修改',
  }
}

const statuses: WorkboardStatus[] = ['planned', 'progress', 'review', 'done']
type TaskPatch = NonNullable<Parameters<typeof appendWorkboardEvent>[1]['patch']>
type Draft = { title: string; description: string; summary: string; nextAction: string; status: WorkboardStatus; acceptance: string }
const emptyDraft = (): Draft => ({ title: '', description: '', summary: '', nextAction: '', status: 'planned', acceptance: '' })
const toDraft = (task: WorkboardTask): Draft => ({ title: task.title, description: task.description, summary: task.summary, nextAction: task.nextAction, status: task.status, acceptance: task.acceptance.join('\n') })
const filename = (path: string): string => path.split(/[\\/]/).pop() || path
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function Modal({ title, children, onClose, busy }: { title: string; children: ReactNode; onClose: () => void; busy: boolean }): JSX.Element {
  const { lang } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog} className="pwb-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="pwb-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="pwb-icon-button" aria-label={words[lang].close} disabled={busy} onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>
}

export default function PreviewWorkboard({ cwd, host, onOpenArtifact, onSubmitToAgent }: PreviewWorkboardProps): JSX.Element {
  const { lang } = useI18n()
  const w = words[lang]
  const tracking = useSyncExternalStore(subscribeWorkboardSetup, useCallback(() => getWorkboardSetup(cwd || '', host), [cwd, host]))
  const [tasks, setTasks] = useState<WorkboardTask[]>([])
  const [events, setEvents] = useState<WorkboardEvent[]>([])
  const [artifacts, setArtifacts] = useState<string[]>([])
  const [limited, setLimited] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [baseDraft, setBaseDraft] = useState<Draft>(emptyDraft)
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [newArtifact, setNewArtifact] = useState('')
  const [attaching, setAttaching] = useState('')
  const [attachTarget, setAttachTarget] = useState('')
  const [pathDraft, setPathDraft] = useState('')
  const [note, setNote] = useState('')
  const [historyLimit, setHistoryLimit] = useState(50)
  const generation = useRef(0)
  const readVersion = useRef(0)
  const writing = useRef(false)
  const createTaskId = useRef('')
  const scope = `${host || ''}\0${cwd || ''}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const refresh = useCallback(async (): Promise<void> => {
    if (!cwd) { setLoading(false); return }
    const currentScope = scope
    const currentGeneration = generation.current
    const version = ++readVersion.current
    try {
      const results = await Promise.allSettled([loadWorkboard(cwd, host), discoverPreviewArtifacts(cwd, host)])
      if (scopeRef.current !== currentScope || generation.current !== currentGeneration || readVersion.current !== version) return
      const [boardResult, filesResult] = results
      if (boardResult.status === 'rejected') throw boardResult.reason
      setTasks(boardResult.value.tasks)
      setEvents(boardResult.value.events)
      setWarnings([...boardResult.value.warnings, ...(filesResult.status === 'rejected' ? [errorText(filesResult.reason)] : [])])
      if (filesResult.status === 'fulfilled') { setArtifacts(filesResult.value.artifacts); setLimited(filesResult.value.limited) }
      setLoadError('')
    } catch (failure) {
      if (scopeRef.current === currentScope && generation.current === currentGeneration && readVersion.current === version) setLoadError(errorText(failure))
    } finally {
      if (scopeRef.current === currentScope && generation.current === currentGeneration && readVersion.current === version) setLoading(false)
    }
  }, [cwd, host, scope])

  useEffect(() => {
    generation.current++
    writing.current = false
    setPending(false); setLoading(true); setTasks([]); setEvents([]); setArtifacts([]); setWarnings([]); setError(''); setLoadError(''); setLimited(false)
    setSelectedId(null); setCreating(false); setAttaching(''); setSearch(''); setFilter('all'); setNote(''); setPathDraft('')
    void refresh()
    const poll = (): void => { if (!writing.current) void refresh() }
    const timer = window.setInterval(poll, 5000)
    window.addEventListener('focus', poll)
    window.addEventListener('linco-workboard-refresh', poll)
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('focus', poll); window.removeEventListener('linco-workboard-refresh', poll) }
  }, [refresh])

  const write = async (input: Parameters<typeof appendWorkboardEvent>[1]): Promise<WorkboardEvent | null> => {
    if (!cwd || writing.current) return null
    const currentScope = scope
    const currentGeneration = generation.current
    writing.current = true
    readVersion.current++
    setPending(true); setError('')
    try {
      const event = input.type === 'create'
        ? await createWorkboardAction(cwd, { ...input, type: 'create' }, host, lang)
        : await appendWorkboardEvent(cwd, input, host)
      if (scopeRef.current !== currentScope || generation.current !== currentGeneration) return null
      await refresh()
      if (scopeRef.current !== currentScope || generation.current !== currentGeneration) return null
      return event
    } catch (failure) {
      if (scopeRef.current === currentScope && generation.current === currentGeneration) setError(errorText(failure))
      return null
    } finally {
      if (scopeRef.current === currentScope && generation.current === currentGeneration) { writing.current = false; setPending(false) }
    }
  }

  const activeTasks = useMemo(() => tasks.filter(task => !task.archived), [tasks])
  const visibleTasks = useMemo(() => tasks.filter(task => {
    if (filter === 'archived' ? !task.archived : task.archived) return false
    if (filter === 'active' && task.status === 'done') return false
    const haystack = [task.title, task.description, task.summary, task.nextAction, task.actionArtifact || '', ...task.artifacts].join(' ').toLowerCase()
    return haystack.includes(search.toLowerCase().trim())
  }), [tasks, filter, search])
  const linkedArtifacts = new Set(tasks.flatMap(task => [...task.artifacts, ...(task.actionArtifact ? [task.actionArtifact] : [])]))
  const unassigned = artifacts.filter(path => !linkedArtifacts.has(path))
  const selected = tasks.find(task => task.id === selectedId)
  const supportingArtifacts = selected?.artifacts.filter(path => path !== selected.actionArtifact) || []
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft)
  const taskEvents = events.filter(event => event.taskId === selectedId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const formatTime = (at: string): string => new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  useEffect(() => {
    if (!selected || dirty) return
    const latest = toDraft(selected)
    if (JSON.stringify(latest) !== JSON.stringify(draft)) {
      setDraft(latest)
      setBaseDraft(latest)
    }
    setBaseUpdatedAt(selected.updatedAt)
  }, [selected, dirty, draft])

  const openTask = (task: WorkboardTask): void => {
    setSelectedId(task.id); setDraft(toDraft(task)); setBaseDraft(toDraft(task)); setBaseUpdatedAt(task.updatedAt); setNote(''); setPathDraft(''); setError(''); setHistoryLimit(50)
  }
  const openFile = (path: string): void => { setSelectedId(null); setCreating(false); setAttaching(''); onOpenArtifact(path) }
  const openAction = async (task: WorkboardTask): Promise<void> => {
    if (!cwd || writing.current) return
    const currentScope = scope
    const currentGeneration = generation.current
    writing.current = true
    readVersion.current++
    setPending(true); setError('')
    try {
      const artifact = await ensureWorkboardActionArtifact(cwd, task, events, host, lang)
      if (scopeRef.current !== currentScope || generation.current !== currentGeneration) return
      if (artifact.event) await refresh()
      if (scopeRef.current !== currentScope || generation.current !== currentGeneration) return
      openFile(artifact.path)
    } catch (failure) {
      if (scopeRef.current === currentScope && generation.current === currentGeneration) setError(errorText(failure))
    } finally {
      if (scopeRef.current === currentScope && generation.current === currentGeneration) { writing.current = false; setPending(false) }
    }
  }
  const beginCreate = (artifact = ''): void => {
    createTaskId.current = crypto.randomUUID()
    setDraft({ ...emptyDraft(), title: artifact ? filename(artifact).replace(/\.html?$/i, '').replace(/[-_]/g, ' ') : '' })
    setNewArtifact(artifact); setCreating(true); setAttaching(''); setError('')
  }
  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft(previous => ({ ...previous, [key]: value }))
  const createOutcome = async (): Promise<void> => {
    if (!draft.title.trim()) { setError(w.needsTitle); return }
    const event = await write({ taskId: createTaskId.current, actor: 'user', type: 'create', patch: {
      title: draft.title.trim(), description: draft.description.trim(), status: draft.status,
      ...(newArtifact ? { artifacts: [newArtifact], primaryArtifact: newArtifact } : {})
    } })
    if (event) setCreating(false)
  }
  const saveDraft = async (): Promise<void> => {
    if (!selected || !dirty) return
    if (!draft.title.trim()) { setError(w.needsTitle); return }
    const patch: TaskPatch = {}
    if (draft.title !== baseDraft.title) patch.title = draft.title.trim()
    if (draft.description !== baseDraft.description) patch.description = draft.description.trim()
    if (draft.summary !== baseDraft.summary) patch.summary = draft.summary.trim()
    if (draft.nextAction !== baseDraft.nextAction) patch.nextAction = draft.nextAction.trim()
    if (draft.status !== baseDraft.status) patch.status = draft.status
    if (draft.acceptance !== baseDraft.acceptance) patch.acceptance = draft.acceptance.split('\n').map(line => line.trim()).filter(Boolean)
    const event = await write({ taskId: selected.id, actor: 'user', type: 'update', patch })
    if (event) { setBaseDraft({ ...draft }); setBaseUpdatedAt(event.at) }
  }
  const attachFile = async (task: WorkboardTask, path: string): Promise<void> => {
    const normalized = path.trim().replace(/\\/g, '/')
    if (!normalized || normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').includes('..') || !/\.html?$/i.test(normalized)) { setError(w.invalidPath); return }
    const event = await write({ taskId: task.id, actor: 'user', type: 'update', patch: {
      artifacts: [...new Set([...task.artifacts, normalized])], primaryArtifact: task.primaryArtifact || normalized
    }, note: `${w.attachment}: ${normalized}` })
    if (event) { setAttaching(''); setPathDraft('') }
  }
  const recordNote = async (type: 'note' | 'decision'): Promise<void> => {
    if (!selected || !note.trim()) return
    if (await write({ taskId: selected.id, actor: 'user', type, note: note.trim() })) setNote('')
  }
  const requestWork = async (): Promise<void> => {
    if (!selected || dirty || !onSubmitToAgent) return
    const event = await write({ taskId: selected.id, actor: 'user', type: 'note', note: w.requested })
    if (event) {
      try { if (onSubmitToAgent(workboardAgentPrompt(selected)) === false) setError(w.requestUnavailable) } catch (failure) { setError(errorText(failure)) }
    }
  }
  const statusOptions = statuses.map(status => <option key={status} value={status}>{w[status]}</option>)
  const visibleError = error || loadError
  const errorNotice = visibleError ? <div className="pwb-error" role="alert"><strong>{w.error}</strong><span>{visibleError}</span>{loadError && <button type="button" onClick={() => void refresh()} disabled={pending}>{w.retry}</button>}</div> : null
  const describeEvent = (event: WorkboardEvent): string => {
    if (event.type === 'create') return w.created
    if (event.type === 'note') return w.note
    if (event.type === 'decision') return w.decision
    const fields: Record<string, string> = { title: w.title, description: w.outcome, summary: w.latest, nextAction: w.nextStep, acceptance: w.acceptance, artifacts: w.artifacts, primaryArtifact: w.primary, actionArtifact: w.actionArtifact, archived: event.patch?.archived ? w.archive : w.restore }
    const changed = Object.keys(event.patch || {}).filter(key => key !== 'status').map(key => fields[key] || key)
    if (event.patch?.status) changed.unshift(w[event.patch.status])
    return `${w.updated}${changed.length ? ` · ${changed.join(', ')}` : ''}`
  }
  const eventChanges = (event: WorkboardEvent): Array<[string, string]> => {
    const fields: Record<string, string> = { title: w.title, description: w.outcome, summary: w.latest, nextAction: w.nextStep, acceptance: w.acceptance, artifacts: w.artifacts, primaryArtifact: w.primary, actionArtifact: w.actionArtifact }
    return Object.entries(event.patch || {}).filter(([key]) => key in fields).map(([key, value]) => [fields[key], Array.isArray(value) ? value.join('\n') || '—' : String(value || '—')])
  }

  if (!cwd) return <div className="pwb-root pwb-project-empty"><LayoutGrid size={28} /><p>{w.noProject}</p></div>

  return <div className="pwb-root preview-workboard" aria-label={w.board}>
    <div className="pwb-scroll">
      <header className="pwb-heading"><div><div className="pwb-eyebrow"><span className="pwb-project-mark" aria-hidden="true" /><span className="pwb-project-name" title={`${host ? `${host}: ` : ''}${cwd}`}>{host ? `${host} / ` : ''}{filename(cwd)}</span></div><h1>{w.heading}</h1></div><button type="button" className="pwb-secondary pwb-new-action" disabled={pending || loading} onClick={() => beginCreate()}><Plus size={15} />{w.newOutcome}</button></header>
      {!creating && !selectedId && !attaching && errorNotice}
      {warnings.length > 0 && <details className="pwb-warning"><summary>{w.warnings} ({warnings.length})</summary>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      {loading ? <div className="pwb-loading" role="status"><RotateCw size={17} />{w.loading}</div> : <>
        <div className="pwb-toolbar"><label className="pwb-search"><Search size={14} /><input aria-label={w.search} placeholder={w.search} value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label={w.filter} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{w.all}</option><option value="active">{w.active}</option><option value="archived">{w.archived}</option></select><button type="button" className="pwb-icon-button" aria-label={w.refresh} title={w.refresh} disabled={pending} onClick={() => void refresh()}><RotateCw size={14} /></button></div>
        {tasks.length === 0 && !visibleError && <div className="pwb-onboarding"><div className="pwb-onboarding-icon"><LayoutGrid size={22} /></div><div><h2>{w.emptyTitle}</h2><p>{w.emptyBody}</p></div></div>}
        {tasks.length > 0 && visibleTasks.length === 0 && <p className="pwb-muted pwb-no-matches">{w.noMatches}</p>}
        <div className="pwb-lanes">{statuses.map(status => <section className={`pwb-lane pwb-lane-${status}`} key={status} aria-label={w[status]}>
          <div className="pwb-lane-heading"><h2><span className={`pwb-dot pwb-dot-${status}`} />{w[status]}</h2><span className="pwb-count">{visibleTasks.filter(task => task.status === status).length}</span></div>
          <div className="pwb-lane-cards">{visibleTasks.filter(task => task.status === status).map(task => <article className="pwb-card" key={task.id}>
            <button type="button" className="pwb-card-main" aria-label={`${w.viewAction}: ${task.title}`} disabled={pending} onClick={() => void openAction(task)}><span className="pwb-card-title">{task.title}</span>{(task.summary || task.description) && <span className="pwb-card-summary">{task.summary || task.description}</span>}{task.nextAction && task.status !== 'done' && <span className="pwb-card-next"><span><strong>{w.nextStep} · </strong>{task.nextAction}</span></span>}</button>
            <div className="pwb-card-footer"><button type="button" className="pwb-card-preview" aria-label={w.openAction} disabled={pending} onClick={() => void openAction(task)} title={w.actionArtifactHint}><span>{w.viewAction}</span><ArrowRight size={12} /></button><button type="button" className="pwb-icon-button" disabled={pending} onClick={() => openTask(task)} aria-label={`${w.actionDetails}: ${task.title}`} title={w.actionDetails}><MoreHorizontal size={16} /></button></div>
          </article>)}{!visibleTasks.some(task => task.status === status) && <div className="pwb-lane-empty"><span>{w[({ planned: 'emptyPlanned', progress: 'emptyProgress', review: 'emptyReview', done: 'emptyDone' } as const)[status]]}</span></div>}</div>
        </section>)}</div>
        <details className="pwb-inbox"><summary><FolderOpen size={14} /><strong>{w.unassigned}</strong><ChevronDown size={13} /></summary><p className="pwb-muted">{w.unassignedBody}</p>{unassigned.length === 0 ? <p className="pwb-muted">{w.noUnassigned}</p> : <div className="pwb-inbox-files">{unassigned.map(path => <div className="pwb-file-row" data-artifact-path={path} key={path}><FileText size={15} /><div className="pwb-file-name"><strong>{filename(path)}</strong><span title={path}>{path}</span></div><button type="button" className="pwb-text-button" disabled={pending} onClick={() => openFile(path)}>{w.open}</button><button type="button" className="pwb-secondary" disabled={pending} onClick={() => { setAttaching(path); setAttachTarget(activeTasks[0]?.id || ''); setError('') }}><Plus size={12} />{w.attach}</button></div>)}</div>}{limited && <p className="pwb-muted">{w.limited}</p>}</details>
        <footer className="pwb-footer"><span>{!visibleError && <><Check size={12} />{w.saved}</>}</span><span role="status" title={tracking.status === 'ready' ? w.trackingHint : undefined}>{tracking.status === 'ready' ? w.trackingReady : tracking.status === 'preparing' ? w.trackingPreparing : ''}</span></footer>
        {tracking.status === 'error' && <div className="pwb-error pwb-tracking-error" role="alert"><strong>{w.trackingError}</strong><span>{tracking.message}</span><button type="button" onClick={() => { void ensureWorkboardProject(cwd, host).catch(() => {}) }}>{w.retry}</button></div>}
      </>}
    </div>

    {creating && <Modal title={w.newOutcome} onClose={() => setCreating(false)} busy={pending}><form className="pwb-form" onSubmit={event => { event.preventDefault(); void createOutcome() }}>{errorNotice}<p className="pwb-muted pwb-create-hint"><FileText size={14} />{w.createHint}</p><fieldset disabled={pending}>
      <label>{w.title}<input autoFocus value={draft.title} placeholder={w.titlePlaceholder} onChange={event => updateDraft('title', event.target.value)} required maxLength={240} /></label>
      <label>{w.outcome}<textarea value={draft.description} placeholder={w.outcomePlaceholder} onChange={event => updateDraft('description', event.target.value)} rows={3} /></label>
      <label>{w.status}<select value={draft.status} onChange={event => updateDraft('status', event.target.value as WorkboardStatus)}>{statusOptions}</select></label>
      {newArtifact && <div className="pwb-attached-hint"><FileText size={14} /><span>{newArtifact}</span></div>}
    </fieldset><div className="pwb-dialog-actions"><button type="button" className="pwb-secondary" disabled={pending} onClick={() => setCreating(false)}>{w.cancel}</button><button className="pwb-primary" type="submit" disabled={pending || !draft.title.trim()}>{pending ? w.saving : w.create}</button></div></form></Modal>}

    {attaching && <Modal title={w.attachTo} onClose={() => setAttaching('')} busy={pending}><form className="pwb-form" onSubmit={event => { event.preventDefault(); const target = activeTasks.find(task => task.id === attachTarget); if (target) void attachFile(target, attaching) }}>{errorNotice}<div className="pwb-attached-hint"><FileText size={15} /><span>{attaching}</span></div><label>{w.action}<select disabled={pending} value={attachTarget} onChange={event => setAttachTarget(event.target.value)}><option value="">{w.chooseOutcome}</option>{activeTasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><div className="pwb-dialog-actions"><button type="button" className="pwb-secondary" disabled={pending} onClick={() => beginCreate(attaching)}>{w.newInstead}</button><button type="submit" className="pwb-primary" disabled={pending || !attachTarget}>{pending ? w.saving : w.attachFile}</button></div></form></Modal>}

    {selectedId && <Modal title={selected?.title || w.action} onClose={() => setSelectedId(null)} busy={pending}>
      {!selected ? <p className="pwb-muted pwb-form">{w.deleted}</p> : <div className="pwb-detail">
        {errorNotice}
        {dirty && selected.updatedAt !== baseUpdatedAt && <p className="pwb-warning">{w.changedElsewhere}</p>}
        <section className="pwb-action-artifact"><div><FileText size={21} /><div><h3>{w.actionArtifact}</h3><p>{dirty ? w.saveBeforeOpen : w.actionArtifactHint}</p>{selected.actionArtifact && <span title={selected.actionArtifact}>{selected.actionArtifact}</span>}</div></div><button type="button" className="pwb-primary" disabled={pending || dirty} onClick={() => void openAction(selected)}>{w.openAction}<ArrowRight size={13} /></button></section>
        <form className="pwb-form" onSubmit={event => { event.preventDefault(); void saveDraft() }}><fieldset disabled={pending}>
          <div className="pwb-detail-top"><label className="pwb-title-field">{w.title}<input value={draft.title} onChange={event => updateDraft('title', event.target.value)} required maxLength={240} /></label><label>{w.status}<select value={draft.status} onChange={event => updateDraft('status', event.target.value as WorkboardStatus)}>{statusOptions}</select></label></div>
          <label>{w.outcome}<textarea value={draft.description} onChange={event => updateDraft('description', event.target.value)} rows={2} placeholder={w.outcomePlaceholder} /></label>
          <div className="pwb-progress-fields"><label>{w.latest}<textarea value={draft.summary} onChange={event => updateDraft('summary', event.target.value)} rows={3} placeholder={w.progressPlaceholder} /></label><label>{w.nextStep}<textarea value={draft.nextAction} onChange={event => updateDraft('nextAction', event.target.value)} rows={3} placeholder={w.nextPlaceholder} /></label></div>
          <label>{w.acceptance}<textarea value={draft.acceptance} onChange={event => updateDraft('acceptance', event.target.value)} rows={2} placeholder={w.acceptanceHint} /></label>
        </fieldset><div className="pwb-dialog-actions"><button type="submit" className="pwb-primary" disabled={pending || !dirty || !draft.title.trim()}>{pending ? w.saving : w.save}</button></div></form>

        <section className="pwb-detail-section"><div className="pwb-section-heading"><h3><FileText size={14} />{w.artifacts}</h3>{selected.primaryArtifact && selected.primaryArtifact !== selected.actionArtifact && <button type="button" className="pwb-secondary" disabled={pending} onClick={() => openFile(selected.primaryArtifact!)}>{w.openPreview}<ArrowRight size={12} /></button>}</div>
          {supportingArtifacts.length === 0 && <p className="pwb-muted">{w.noFiles}</p>}
          {supportingArtifacts.map(path => <div className="pwb-linked-file" key={path}><button type="button" className="pwb-file-link" disabled={pending} title={path} onClick={() => openFile(path)}><FileText size={13} /><span>{path}</span></button><div>{path === selected.primaryArtifact ? <span className="pwb-primary-badge">{w.primary}</span> : <button type="button" className="pwb-text-button" disabled={pending} onClick={() => void write({ taskId: selected.id, actor: 'user', type: 'update', patch: { primaryArtifact: path } })}>{w.makePrimary}</button>}<button type="button" className="pwb-icon-button" disabled={pending} aria-label={`${w.remove}: ${path}`} title={w.remove} onClick={() => { const remaining = selected.artifacts.filter(item => item !== path); void write({ taskId: selected.id, actor: 'user', type: 'update', patch: { artifacts: remaining, primaryArtifact: selected.primaryArtifact === path ? remaining.find(item => item !== selected.actionArtifact) || '' : selected.primaryArtifact } }) }}><X size={12} /></button></div></div>)}
          <form className="pwb-link-form" onSubmit={event => { event.preventDefault(); void attachFile(selected, pathDraft) }}><input aria-label={w.relativePath} placeholder="artifacts/preview.html" value={pathDraft} onChange={event => setPathDraft(event.target.value)} disabled={pending} /><button type="submit" className="pwb-secondary" disabled={pending || !pathDraft.trim()}>{w.addPath}</button></form>
        </section>

        <section className="pwb-detail-section"><h3><MessageSquare size={14} />{w.activity}</h3><label className="pwb-note-label"><span className="pwb-sr-only">{w.addUpdate}</span><textarea aria-label={w.addUpdate} value={note} onChange={event => setNote(event.target.value)} placeholder={w.updatePlaceholder} rows={3} disabled={pending} /></label><div className="pwb-note-actions"><button type="button" className="pwb-secondary" disabled={pending || !note.trim()} onClick={() => void recordNote('note')}>{w.recordUpdate}</button><button type="button" className="pwb-secondary" disabled={pending || !note.trim()} onClick={() => void recordNote('decision')}>{w.recordDecision}</button></div>
          <h4 className="pwb-history-heading">{w.history} <span>{taskEvents.length}</span></h4>{taskEvents.length === 0 && <p className="pwb-muted">{w.noHistory}</p>}{taskEvents.length > historyLimit && <div className="pwb-history-pagination"><p className="pwb-muted">{w.earlier} {historyLimit} / {taskEvents.length}</p><button type="button" className="pwb-secondary" onClick={() => setHistoryLimit(limit => limit + 50)}>{w.moreHistory}</button></div>}
          <ol className="pwb-history">{taskEvents.slice(-historyLimit).map(event => <li key={event.id}><span className={`pwb-history-marker ${event.type === 'decision' ? 'pwb-history-decision' : ''}`} /><div className="pwb-history-meta"><strong>{event.actor === 'agent' ? w.agent : w.user}</strong><span>{describeEvent(event)}</span><time dateTime={event.at}>{formatTime(event.at)}</time></div>{event.note && <p>{event.note}</p>}{eventChanges(event).length > 0 && <details className="pwb-event-changes"><summary>{w.changeDetails}</summary><dl>{eventChanges(event).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}</dl></details>}</li>)}</ol>
        </section>

        <section className="pwb-agent-action"><div><Sparkles size={17} /><p>{dirty ? w.saveFirst : w.requestHint}</p></div>{onSubmitToAgent && <button type="button" className="pwb-primary" disabled={pending || dirty || selected.archived} onClick={() => void requestWork()}><ArrowRight size={14} />{w.request}</button>}</section>
        <div className="pwb-detail-bottom"><button type="button" className="pwb-text-button" disabled={pending || dirty} title={w.archiveHint} onClick={async () => { if (await write({ taskId: selected.id, actor: 'user', type: 'update', patch: { archived: !selected.archived }, note: selected.archived ? w.restoreNote : w.archiveNote })) setSelectedId(null) }}><Archive size={13} />{selected.archived ? w.restore : w.archive}</button>{selected.status !== 'done' && <button type="button" className="pwb-secondary" disabled={pending || dirty} onClick={async () => { if (await write({ taskId: selected.id, actor: 'user', type: 'update', patch: { status: 'done' }, note: w.markedDone })) { setDraft(previous => ({ ...previous, status: 'done' })); setBaseDraft(previous => ({ ...previous, status: 'done' })) } }}><Check size={14} />{w.markDone}</button>}</div>
      </div>}
    </Modal>}
  </div>
}
