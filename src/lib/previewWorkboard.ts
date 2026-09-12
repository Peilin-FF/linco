import { createDir, listDir, readFile, renamePath, writeFile } from './fs'

export type WorkboardStatus = 'planned' | 'progress' | 'review' | 'done'

export interface WorkboardTask {
  id: string
  title: string
  description: string
  summary: string
  nextAction: string
  status: WorkboardStatus
  actionArtifact?: string
  primaryArtifact?: string
  artifacts: string[]
  acceptance: string[]
  archived: boolean
  createdAt: string
  updatedAt: string
}

export type WorkboardPatch = Partial<Pick<WorkboardTask,
  'title' | 'description' | 'summary' | 'nextAction' | 'status' |
  'actionArtifact' | 'primaryArtifact' | 'artifacts' | 'acceptance' | 'archived'>>

export interface WorkboardEvent {
  version: 1
  id: string
  taskId: string
  at: string
  actor: 'user' | 'agent'
  type: 'create' | 'update' | 'note' | 'decision'
  patch?: WorkboardPatch
  note?: string
}

export interface WorkboardEventInput {
  taskId?: string
  actor: WorkboardEvent['actor']
  type: WorkboardEvent['type']
  patch?: WorkboardPatch
  note?: string
}

const EVENT_DIRECTORY = '.linco/workboard/events'
const MAX_EVENT_LENGTH = 64 * 1024
const MAX_EVENT_FILES = 10_000
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const statuses: WorkboardStatus[] = ['planned', 'progress', 'review', 'done']
const editable = new Set(['title', 'description', 'summary', 'nextAction', 'status', 'actionArtifact', 'primaryArtifact', 'artifacts', 'acceptance', 'archived'])
const eventKeys = new Set(['version', 'id', 'taskId', 'at', 'actor', 'type', 'patch', 'note'])
const eventCache = new Map<string, Map<string, WorkboardEvent>>()
const lastWrite = new Map<string, number>()

function projectRoot(cwd: string): string {
  if (!cwd || !cwd.trim()) throw new Error('Choose a project before opening the workboard.')
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

function join(root: string, relative: string): string {
  return `${root === '/' ? '' : root}/${relative}`
}

function scope(root: string, host?: string): string {
  return JSON.stringify([host || '', root])
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown, label: string, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) {
    throw new Error(`${label} must be ${nonempty ? 'nonempty ' : ''}text of at most ${max} characters.`)
  }
  return value
}

/** Artifact references always stay relative to the selected project. */
function artifactPath(value: unknown): string {
  const path = string(value, 'Artifact path', 1000, true).replace(/\\/g, '/')
  if (path.startsWith('/') || /[:?#\x00-\x1f\x7f]/.test(path) || /%[0-9a-f]{2}/i.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Artifact paths must be safe project-relative paths without URLs or traversal.')
  }
  return path
}

function stringArray(value: unknown, label: string, maxItem: number): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must contain at most 100 items.`)
  return value.map(item => string(item, label, maxItem, true))
}

function parsePatch(value: unknown): WorkboardPatch {
  if (!object(value) || Object.keys(value).some(key => !editable.has(key))) throw new Error('Invalid workboard task fields.')
  const patch: WorkboardPatch = {}
  if ('title' in value) patch.title = string(value.title, 'Title', 240, true)
  if ('description' in value) patch.description = string(value.description, 'Description', 12_000)
  if ('summary' in value) patch.summary = string(value.summary, 'Summary', 6000)
  if ('nextAction' in value) patch.nextAction = string(value.nextAction, 'Next action', 3000)
  if ('status' in value) {
    if (!statuses.includes(value.status as WorkboardStatus)) throw new Error('Invalid workboard status.')
    patch.status = value.status as WorkboardStatus
  }
  if ('archived' in value) {
    if (typeof value.archived !== 'boolean') throw new Error('Archived must be true or false.')
    patch.archived = value.archived
  }
  if ('primaryArtifact' in value) patch.primaryArtifact = value.primaryArtifact === '' ? '' : artifactPath(value.primaryArtifact)
  if ('actionArtifact' in value) patch.actionArtifact = artifactPath(value.actionArtifact)
  if ('artifacts' in value) patch.artifacts = [...new Set(stringArray(value.artifacts, 'Artifacts', 1000).map(artifactPath))]
  if ('acceptance' in value) patch.acceptance = stringArray(value.acceptance, 'Acceptance criteria', 2000)
  return patch
}

function parseEvent(value: unknown): WorkboardEvent {
  if (!object(value) || Object.keys(value).some(key => !eventKeys.has(key)) || value.version !== 1 ||
    typeof value.id !== 'string' || !ID.test(value.id) || typeof value.taskId !== 'string' || !ID.test(value.taskId) ||
    typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at)) ||
    (value.actor !== 'user' && value.actor !== 'agent') || !['create', 'update', 'note', 'decision'].includes(String(value.type))) {
    throw new Error('Invalid workboard event metadata.')
  }
  const event: WorkboardEvent = {
    version: 1, id: value.id, taskId: value.taskId, at: new Date(value.at).toISOString(),
    actor: value.actor, type: value.type as WorkboardEvent['type'],
  }
  if ('patch' in value) event.patch = parsePatch(value.patch)
  if ('note' in value) event.note = string(value.note, 'History note', 16_000)
  if (event.type === 'create' && !event.patch?.title) throw new Error('A new task needs a title.')
  if (event.type === 'update' && !Object.keys(event.patch || {}).length) throw new Error('An update needs task fields.')
  if ((event.type === 'note' || event.type === 'decision') && !event.note?.trim()) throw new Error('A history entry needs a note.')
  return event
}

/** Validate before a caller creates associated files, keeping failed forms free of side effects. */
export function validateWorkboardEventInput(input: WorkboardEventInput): WorkboardEventInput {
  const event = parseEvent({
    version: 1, id: 'validation', taskId: input.taskId || (input.type === 'create' ? 'validation' : ''),
    at: new Date().toISOString(), actor: input.actor, type: input.type,
    ...(input.patch ? { patch: input.patch } : {}), ...(input.note !== undefined ? { note: input.note } : {}),
  })
  if (JSON.stringify(event).length > MAX_EVENT_LENGTH - 256) throw new Error('Event exceeds the 64 KB size limit.')
  return { ...input, ...(event.patch ? { patch: event.patch } : {}) }
}

/** Verify absence by listing parents: permission/connection failures must never look like an empty board. */
async function directory(root: string, segments: string[], host?: string, create = false): Promise<string | null> {
  let parent = root
  for (const name of segments) {
    const entries = await listDir(parent, host)
    let entry = entries.find(item => item.name === name)
    if (!entry && create) {
      try {
        await createDir(parent, name, host)
      } catch (error) {
        // Another writer may have created the same directory since our listing.
        entry = (await listDir(parent, host)).find(item => item.name === name)
        if (!entry?.isDir) throw error
      }
    } else if (!entry) {
      return null
    }
    if (entry && !entry.isDir) throw new Error(`${join(parent, name)} is a file; the workboard needs a directory.`)
    parent = join(parent, name)
  }
  return parent
}

function cachedEvents(key: string): Map<string, WorkboardEvent> {
  let cache = eventCache.get(key)
  if (!cache) {
    cache = new Map()
    eventCache.set(key, cache)
    if (eventCache.size > 8) eventCache.delete(eventCache.keys().next().value!)
  }
  return cache
}

function cloneEvent(event: WorkboardEvent): WorkboardEvent {
  return { ...event, ...(event.patch ? { patch: { ...event.patch,
    ...(event.patch.artifacts ? { artifacts: [...event.patch.artifacts] } : {}),
    ...(event.patch.acceptance ? { acceptance: [...event.patch.acceptance] } : {}),
  } } : {}) }
}

export async function loadWorkboard(cwd: string, host?: string): Promise<{
  tasks: WorkboardTask[]; events: WorkboardEvent[]; warnings: string[]
}> {
  const root = projectRoot(cwd)
  const path = await directory(root, EVENT_DIRECTORY.split('/'), host)
  if (!path) return { tasks: [], events: [], warnings: [] }
  const warnings: string[] = []
  const files = (await listDir(path, host)).filter(entry => !entry.isDir && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))
  if (files.length > MAX_EVENT_FILES) warnings.push(`The board contains more than ${MAX_EVENT_FILES} events; some history is not loaded.`)
  const cache = cachedEvents(scope(root, host))
  const names = new Set(files.map(file => file.name))
  for (const name of cache.keys()) if (!names.has(name)) cache.delete(name)
  const events: WorkboardEvent[] = []
  // Bound concurrent SSH reads and isolate unreadable events so the remaining history survives.
  for (let i = 0; i < Math.min(files.length, MAX_EVENT_FILES); i += 16) {
    await Promise.all(files.slice(i, Math.min(i + 16, MAX_EVENT_FILES)).map(async file => {
      try {
        let event = cache.get(file.name)
        if (!event) {
          if (!ID.test(file.name.slice(0, -5))) throw new Error('Invalid event filename.')
          const content = await readFile(join(path, file.name), host)
          if (content.length > MAX_EVENT_LENGTH) throw new Error('Event exceeds the 64 KB size limit.')
          event = parseEvent(JSON.parse(content))
          if (`${event.id}.json` !== file.name) throw new Error('Event ID does not match its filename.')
          cache.set(file.name, event)
        }
        events.push(cloneEvent(event))
      } catch (error) {
        warnings.push(`${file.name}: ${message(error)}`)
      }
    }))
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  if (events.length) {
    const key = scope(root, host)
    lastWrite.set(key, Math.max(lastWrite.get(key) || 0, Date.parse(events[events.length - 1].at)))
  }
  const tasks = new Map<string, WorkboardTask>()
  const creates = new Map<string, string>()
  // Materialize creates first so a clock-skewed update cannot disappear permanently.
  for (const event of events) {
    if (event.type !== 'create') continue
    if (tasks.has(event.taskId)) {
      warnings.push(`${event.id}: duplicate task creation was ignored.`)
      continue
    }
    creates.set(event.taskId, event.id)
    tasks.set(event.taskId, {
      id: event.taskId, title: event.patch!.title!, description: '', summary: '', nextAction: '',
      status: 'planned', artifacts: [], acceptance: [], archived: false,
      createdAt: event.at, updatedAt: event.at, ...event.patch,
    })
  }
  for (const event of events) {
    const task = tasks.get(event.taskId)
    if (!task) {
      warnings.push(`${event.id}: task ${event.taskId} has no creation event.`)
      continue
    }
    if (event.type === 'create' && creates.get(event.taskId) !== event.id) continue
    if (event.type !== 'create' && event.patch) Object.assign(task, event.patch)
    if (task.primaryArtifact && !task.artifacts.includes(task.primaryArtifact)) task.artifacts = [...task.artifacts, task.primaryArtifact]
    if (!task.primaryArtifact) delete task.primaryArtifact
    task.updatedAt = task.updatedAt > event.at ? task.updatedAt : event.at
  }
  return { tasks: [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), events, warnings: warnings.sort() }
}

/** Publish one immutable event; separate unique files prevent UI and agent writes from replacing history. */
export async function appendWorkboardEvent(cwd: string, input: WorkboardEventInput, host?: string): Promise<WorkboardEvent> {
  const root = projectRoot(cwd)
  if (input.type !== 'create' && !input.taskId) throw new Error('Choose a task before adding an update.')
  const key = scope(root, host)
  const at = Math.max(Date.now(), (lastWrite.get(key) || 0) + 1)
  const event = parseEvent({
    version: 1, id: crypto.randomUUID(), taskId: input.taskId || crypto.randomUUID(), at: new Date(at).toISOString(),
    actor: input.actor, type: input.type,
    ...(input.patch ? { patch: input.patch } : {}), ...(input.note !== undefined ? { note: input.note } : {}),
  })
  const content = `${JSON.stringify(event, null, 2)}\n`
  if (content.length > MAX_EVENT_LENGTH) throw new Error('Event exceeds the 64 KB size limit.')
  lastWrite.set(key, at)
  const path = (await directory(root, EVENT_DIRECTORY.split('/'), host, true))!
  const temporary = join(path, `.${event.id}.tmp`)
  await writeFile(temporary, content, host)
  await renamePath(temporary, `${event.id}.json`, host)
  cachedEvents(key).set(`${event.id}.json`, event)
  return cloneEvent(event)
}

export async function discoverPreviewArtifacts(cwd: string, host?: string): Promise<{ artifacts: string[]; limited: boolean }> {
  const root = projectRoot(cwd)
  const artifacts: string[] = []
  const rootEntries = await listDir(root, host)
  for (const entry of rootEntries) {
    if (!entry.isDir && !entry.name.startsWith('.') && /\.html?$/i.test(entry.name)) {
      try { artifacts.push(artifactPath(entry.name)) } catch { /* Ignore unsafe filenames. */ }
    }
  }
  const artifactDirectory = rootEntries.find(entry => entry.name === 'artifacts' && entry.isDir)
  const queue = artifactDirectory ? [{ path: join(root, 'artifacts'), relative: 'artifacts', depth: 0 }] : []
  if (artifacts.length > 500) return { artifacts: artifacts.sort().slice(0, 500), limited: true }
  let visited = 0
  let limited = false
  while (queue.length && visited < 100 && artifacts.length < 500) {
    const current = queue.shift()!
    visited++
    const entries = (await listDir(current.path, host)).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      let relative: string
      try { relative = artifactPath(`${current.relative}/${entry.name}`) } catch { continue }
      if (entry.isDir) {
        if (current.depth < 5) queue.push({ path: join(root, relative), relative, depth: current.depth + 1 })
        else limited = true
      } else if (/\.html?$/i.test(entry.name)) {
        if (artifacts.length === 500) { limited = true; break }
        artifacts.push(relative)
      }
    }
  }
  return { artifacts: artifacts.sort(), limited: limited || queue.length > 0 }
}

export function workboardAgentPrompt(task: WorkboardTask): string {
  return [
    `Continue this Linco workboard task: ${task.title}`,
    `Task ID: ${task.id}`,
    task.description && `Outcome: ${task.description}`,
    task.summary && `Progress so far: ${task.summary}`,
    task.nextAction && `Next action: ${task.nextAction}`,
    task.actionArtifact && `Living action notebook: ${task.actionArtifact}`,
    task.primaryArtifact && `Current deliverable: ${task.primaryArtifact}`,
    task.acceptance.length ? `Acceptance criteria:\n${task.acceptance.map(item => `- ${item}`).join('\n')}` : '',
    task.artifacts.length ? `Linked project artifacts: ${task.artifacts.join(', ')}` : '',
    '',
    'Keep the native Live preview workboard current as you work. Proceed with work already authorized by this task; routine progress does not require approval. Use review only when a concrete user decision or review is needed.',
    `This action owns one living HTML notebook about its plan, adjustments, progress, decisions, and results: ${task.actionArtifact || `artifacts/actions/${task.id}/action.html`}. Read and update that SAME notebook in place throughout the action. Read the html-kit skill when creating or editing notebook content. Preserve the notebook shell and edit only its seed JSON, using html and table cells for your narrative. Preserve every user md cell verbatim and in its original order; answer immediately after each new requirement in an html cell wrapped in <div class="answer">. Date progress snapshots and keep the plan, meaningful changes, and results readable. Do not generate a new report for each iteration.`,
    'Lead the notebook with the result or concise current state and the next concrete step. Keep its first view quiet: a clear title, brief prose, a useful result link, and a small dated status note. Put plans, adjustments, decisions, validation, and procedural detail inside closed details/summary disclosures. Omit empty or repetitive sections; avoid repeated cards, status grids, counters, or a dump of every trial. Let the content determine the structure instead of filling a heavy template.',
    `Keep supporting outputs for this action under artifacts/actions/${task.id}/ and link them from the action notebook. actionArtifact identifies this living narrative; primaryArtifact identifies the output preview and may be a different file. Existing linked outputs can remain at their current paths.`,
    `Persistence protocol: project-relative ${EVENT_DIRECTORY}/<event-id>.json. Read the existing events to preserve current context. Never edit or replace published events. For each meaningful outcome, adjustment, decision, or next step, write one new version 1 event to a unique temporary file in that directory, then rename it to <event-id>.json to publish atomically. Create missing directories one level at a time. Use a fresh UUID for each event ID and a UTC ISO timestamp.`,
    `Event shape: ${JSON.stringify({ version: 1, id: '<fresh-UUID>', taskId: task.id, at: '<UTC ISO timestamp>', actor: 'agent', type: 'update', patch: { status: 'progress', summary: '<current outcome and evidence>', nextAction: '<next concrete step>' }, note: '<concise meaningful change, if any>' })}`,
    'Types: create (requires patch.title), update (requires a nonempty patch), note or decision (requires note). Allowed patch fields: title, description, summary, nextAction, status, actionArtifact, primaryArtifact, artifacts, acceptance, archived. Status: planned, progress, review, done. Keep alternative approaches and adjustments within the same outcome using note or decision events and the same action notebook. Create a new taskId and a create event only for a separate, independently useful outcome, with its own actionArtifact notebook. Keep low-level trial logs outside the board.',
    'Artifact links must be safe project-relative paths such as artifacts/result.html; no absolute paths, URLs, traversal, query strings, or encoded paths. artifacts and acceptance are arrays (at most 100 entries). Limits: title 240, description 12000, summary 6000, nextAction 3000, note 16000 characters; each event at most 64 KB. Keep task summaries concise and link deliverables. Mark done only after the task outcome is achieved and relevant verification is recorded.',
  ].filter(Boolean).join('\n\n')
}
