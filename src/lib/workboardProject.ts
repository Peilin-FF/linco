/// <reference types="vite/client" />
import notebookTemplate from '../assets/action-notebook.html?raw'
import { createDir, listDir, readFile, renamePath, writeFile } from './fs'
import type { DirEntry } from './fs'

export interface WorkboardSetup {
  readonly status: 'idle' | 'preparing' | 'ready' | 'error'
  readonly message?: string
}

const idle: WorkboardSetup = Object.freeze({ status: 'idle' })
const setupStates = new Map<string, WorkboardSetup>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const begin = '<!-- LINCO:WORKBOARD:BEGIN -->'
const end = '<!-- LINCO:WORKBOARD:END -->'
const instructionsPath = '.linco/workboard/INSTRUCTIONS.md'
const maxDocumentLength = 1024 * 1024

const pointer = `${begin}
## Linco project workboard
Before substantive project work, read and follow [the project workboard instructions](.linco/workboard/INSTRUCTIONS.md). Reuse the matching action or create one before working, and maintain its same living HTML action artifact and meaningful progress events. All sessions in this project on this host share the board. Questions, greetings, and opening a terminal alone do not create actions.
${end}`

const instructions = `${begin}
# Linco project workboard instructions

The native Live preview board organizes independently useful project outcomes as actions. Its records belong to this project on this host, shared by all agent sessions. A different host or project folder has a separate board unless its files are explicitly synchronized. Session startup installs these instructions; the app does not invent actions or infer their status from terminal activity.

## Before substantive work

1. For implementation, design, investigation, research, or another substantive project outcome, read the existing files in .linco/workboard/events/ and identify the action that matches the current request BEFORE starting work. If the directory is absent, the board has no recorded actions yet. A read or connection error is not an empty board: report it and retry when access is available.
2. Reuse the matching action and read its actionArtifact notebook. A new session, a new iteration, a changed approach, or a resumed request normally continues the same action. Create a new task ID only for a separate, independently useful outcome. Do not create cards for greetings, ordinary questions, acknowledgments, opening a terminal, or session startup alone.
3. If this request continues substantive work that has no action record, create its action now using the current conversation and inspected project evidence. Reuse or link existing relevant artifacts without duplicating them. Label prior context as reconstructed, dated when recorded; do not invent historical timestamps, prior status, work performed, or completion claims.
4. For a new action, create its living HTML notebook at artifacts/actions/<task-id>/action.html before publishing its create event, and set patch.actionArtifact to that project-relative path. If this is a reconstruction and an existing notebook already describes the action, retain that notebook as actionArtifact instead. Link existing output previews through primaryArtifact and artifacts. Then publish the create event with a brief, truthful current status, next step, and acceptance criteria when known.
5. Proceed with work already authorized by the user. Routine progress does not require approval. Use review only when a concrete user decision or review is needed; record the specific question and the next step after the decision.

## One living action notebook

Keep the SAME actionArtifact throughout the action. Lead with the result or a concise, truthful current state, a useful result link when available, and the next concrete step. Keep the first view quiet: a clear title, short prose, generous space, and a small dated status note. Put supporting context, plans, meaningful adjustments, decisions, validation, and procedural detail inside closed details/summary disclosures. These are reading priorities, not a mandatory heavy template: omit empty or redundant sections, use a diagram only when it clarifies the result, and avoid repeated cards, status grids, counters, and tables of every trial. Update the current summary and next step in place; keep useful dated decisions accessible without expanding the main reading surface. Do not generate a new report per iteration or list every low-level trial as an action. Put supporting outputs under artifacts/actions/<task-id>/ and link them from the notebook; existing linked outputs may stay where they are. primaryArtifact is the output preview and can differ from actionArtifact, which explains the action itself.

Use the html-kit skill when available. If that skill is absent in this session or on this host, copy this project's .linco/workboard/notebook.html as the notebook shell, replacing ONLY the JSON array in its script element with id="seed". Keep the notebook CSS/JS references and mount code unchanged. Agent-authored content uses html cells ({"type":"html","html":"..."}) and editable table cells ({"type":"table","head":["..."],"rows":[["..."]]}), with no default md cells and no custom render engine. Escape dynamic HTML and JSON seed terminators. Tables belong in table cells rather than an HTML table.

Preserve every existing user md cell verbatim and in its original order. Answer a new md requirement immediately after it in an html cell wrapped in <div class="answer">. Read the current notebook before editing; never overwrite user changes with a fresh scaffold. Clearly date status snapshots; a snapshot is not an automatic live status feed.

## Append-only event protocol (version 1)

Publish each event to project-relative .linco/workboard/events/<event-id>.json. Create missing directories as needed. Write the complete JSON to a unique temporary filename in that SAME directory, then rename it to <event-id>.json to publish. Use a fresh UUID for every event id; the filename must match it. Published events are immutable: never rewrite, truncate, delete, or replace them. Avoid overwriting another writer's files. Read current events before publishing an update and patch only the fields that changed; array patches replace that field, so preserve its current items when appending links or criteria.

The event object has only these fields:
- version: exactly 1.
- id: unique event ID; taskId: the existing action ID, or a new action ID for create. Both IDs are 1–100 characters, start with an ASCII letter or digit, and contain only ASCII letters, digits, underscore, or hyphen. Fresh UUIDs fit this format.
- at: a UTC ISO timestamp ending in Z, such as 2026-09-12T12:00:00.001Z. Choose a timestamp later than the latest event you observed when recording a subsequent change; do not backdate reconstructed context.
- actor: "agent" for agent-authored events ("user" is also a valid stored actor).
- type: "create", "update", "note", or "decision".
- patch: optional object containing only the editable fields listed below.
- note: optional concise text, at most 16000 characters. A note or decision event requires a nonempty note.

A create event requires patch.title. An update event requires a nonempty patch. A note or decision may also include a patch, for example a resolved decision with a new status. Keep the serialized event under 64 KB (the reader rejects strings longer than 65536 characters).

Allowed patch fields and limits:
- title: nonempty text, at most 240 characters.
- description: the intended outcome, at most 12000 characters.
- summary: concise current progress and evidence, at most 6000 characters.
- nextAction: the next concrete step or decision, at most 3000 characters.
- status: "planned", "progress", "review", or "done".
- actionArtifact: the safe, nonempty project-relative path of the living action notebook.
- primaryArtifact: the safe project-relative path of the output preview; an empty string clears it.
- artifacts: at most 100 nonempty safe project-relative paths, each at most 1000 characters.
- acceptance: at most 100 nonempty criteria, each at most 2000 characters.
- archived: boolean. Archived actions remain in history.

All artifact paths are at most 1000 characters and relative to this project root, not to the notebook or instruction file. Use forward slashes. Reject absolute paths, drive letters, URLs, colon, query strings, fragments, control characters, percent-encoded paths, empty segments, dot or dot-dot segments, and segments ending in a dot or space. Paths such as artifacts/actions/<task-id>/result.html are valid after substituting a real task ID. Do not put createdAt, updatedAt, a session ID, or unknown fields in an event or patch.

Example create event (substitute real UUIDs, timestamp, and current task details):

\`\`\`json
{"version":1,"id":"<fresh-event-UUID>","taskId":"<new-task-UUID>","at":"<current-UTC-ISO-timestamp>","actor":"agent","type":"create","patch":{"title":"Concrete action outcome","description":"What this action should achieve","status":"planned","nextAction":"First concrete step","actionArtifact":"artifacts/actions/<new-task-UUID>/action.html","artifacts":[],"acceptance":[]}}
\`\`\`

## Meaningful progress across sessions

Record progress when meaningful work starts, an outcome or approach changes, a decision is made, or verification completes. Keep adjustments within the matching action using note or decision events and its same notebook. Summaries and nextAction should explain what has been done, what is currently happening, and what comes next. Mark progress only when work actually starts; mark done only after the requested outcome is achieved and relevant verification is recorded. An open terminal, a new session, a process exit, a timeout, or silence alone proves neither running work nor completion. Do not infer or fabricate actions or status from those signals.

At a pause or handoff, leave a concise current summary, next concrete step, and dated notebook snapshot so another session can resume the same action. Preserve every published event and existing artifact. Questions and routine conversation that do not perform substantive work need no new action or event.
${end}
`

function rootPath(cwd: string): string {
  if (!cwd.trim()) throw new Error('Choose a project before preparing workboard tracking.')
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

const keyFor = (root: string, host?: string) => JSON.stringify([host || '', root])
const join = (root: string, relative: string) => `${root === '/' ? '' : root}/${relative}`

function setSetup(key: string, state: WorkboardSetup): void {
  setupStates.set(key, Object.freeze(state))
  for (const listener of listeners) listener()
}

/** Suitable for useSyncExternalStore: unchanged scopes return the same immutable snapshot. */
export function getWorkboardSetup(cwd: string, host?: string): WorkboardSetup {
  if (!cwd.trim()) return idle
  return setupStates.get(keyFor(rootPath(cwd), host)) || idle
}

export function subscribeWorkboardSetup(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function managedDocument(content: string, block: string, name: string): string {
  const starts = content.split(begin).length - 1
  const ends = content.split(end).length - 1
  const markers = content.match(/<!--\s*LINCO:WORKBOARD\b/g)?.length || 0
  if (!starts && !ends && !markers) return content ? `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${block}\n` : `${block}\n`
  if (starts !== 1 || ends !== 1 || markers !== 2 || content.indexOf(begin) > content.indexOf(end)) {
    throw new Error(`${name} has malformed Linco workboard markers. Repair the LINCO:WORKBOARD block before retrying; existing content was preserved.`)
  }
  return content.slice(0, content.indexOf(begin)) + block + content.slice(content.indexOf(end) + end.length)
}

async function readOptional(parent: string, name: string, host?: string, entries?: DirEntry[]): Promise<string | undefined> {
  const entry = (entries || await listDir(parent, host)).find(item => item.name === name)
  if (!entry) return undefined
  if (entry.isDir) throw new Error(`${join(parent, name)} is a directory; workboard tracking needs a file.`)
  const content = await readFile(join(parent, name), host)
  if (content.length > maxDocumentLength) throw new Error(`${join(parent, name)} is too large to update safely.`)
  return content
}

async function findWorkboardDirectory(root: string, host: string | undefined, rootEntries: DirEntry[]): Promise<string | null> {
  let directory = root
  let entries = rootEntries
  for (const name of ['.linco', 'workboard']) {
    const entry = entries.find(item => item.name === name)
    if (!entry) return null
    if (!entry.isDir) throw new Error(`${join(directory, name)} is a file; workboard tracking needs a directory.`)
    directory = join(directory, name)
    entries = await listDir(directory, host)
  }
  return directory
}

async function ensureDirectory(root: string, host?: string): Promise<string> {
  let directory = root
  for (const name of ['.linco', 'workboard']) {
    let entry = (await listDir(directory, host)).find(item => item.name === name)
    if (!entry) {
      try { await createDir(directory, name, host) } catch (error) {
        entry = (await listDir(directory, host)).find(item => item.name === name)
        if (!entry?.isDir) throw error
      }
    }
    if (entry && !entry.isDir) throw new Error(`${join(directory, name)} is a file; workboard tracking needs a directory.`)
    directory = join(directory, name)
  }
  return directory
}

async function publishNew(parent: string, name: string, content: string, host?: string): Promise<void> {
  const temporary = join(parent, `.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, content, host)
  await renamePath(temporary, name, host)
}

async function installManaged(parent: string, name: string, block: string, host?: string): Promise<void> {
  // Re-read just before updating so preflight reads do not replace newer user edits.
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await readOptional(parent, name, host)
    const next = managedDocument(previous || '', block, join(parent, name))
    if (previous === next) return
    if (previous !== undefined) {
      await writeFile(join(parent, name), next, host)
      return
    }
    try { await publishNew(parent, name, next, host); return } catch (error) {
      // Another writer may have created this document; preserve it and merge our block on retry.
      const appeared = await readOptional(parent, name, host)
      if (appeared === undefined) throw error
    }
  }
  throw new Error(`${join(parent, name)} changed repeatedly while tracking was being prepared. Retry setup.`)
}

async function installProject(root: string, host?: string): Promise<void> {
  const rootEntries = await listDir(root, host)
  const [agents, claude, existingDirectory] = await Promise.all([
    readOptional(root, 'AGENTS.md', host, rootEntries), readOptional(root, 'CLAUDE.md', host, rootEntries),
    findWorkboardDirectory(root, host, rootEntries),
  ])
  // Check all existing managed documents before the first write; malformed markers never truncate content.
  managedDocument(agents || '', pointer, 'AGENTS.md')
  managedDocument(claude || '', pointer, 'CLAUDE.md')
  if (existingDirectory) {
    const current = await readOptional(existingDirectory, 'INSTRUCTIONS.md', host)
    managedDocument(current || '', instructions.trimEnd(), instructionsPath)
    const template = (await listDir(existingDirectory, host)).find(item => item.name === 'notebook.html')
    if (template?.isDir) throw new Error('The project workboard notebook template path is a directory.')
  }
  const directory = existingDirectory || await ensureDirectory(root, host)
  await installManaged(directory, 'INSTRUCTIONS.md', instructions.trimEnd(), host)
  const existingTemplate = (await listDir(directory, host)).find(item => item.name === 'notebook.html')
  if (existingTemplate?.isDir) throw new Error('The project workboard notebook template path is a directory.')
  if (!existingTemplate) {
    try { await publishNew(directory, 'notebook.html', notebookTemplate, host) } catch (error) {
      const appeared = (await listDir(directory, host)).find(item => item.name === 'notebook.html')
      if (!appeared || appeared.isDir) throw error
    }
  }
  // Agent entry points are installed last, after the instructions and fallback template are available.
  await installManaged(root, 'AGENTS.md', pointer, host)
  await installManaged(root, 'CLAUDE.md', pointer, host)
}

/** Install only project instructions. Actions remain semantic records authored by the agent or user. */
export function ensureWorkboardProject(cwd: string, host?: string): Promise<void> {
  let root: string
  try { root = rootPath(cwd) } catch (error) { return Promise.reject(error) }
  const key = keyFor(root, host)
  const existing = inFlight.get(key)
  if (existing) return existing
  if (setupStates.get(key)?.status === 'ready') return Promise.resolve()
  const pending = Promise.resolve().then(() => installProject(root, host)).then(() => {
    setSetup(key, { status: 'ready' })
  }).catch(error => {
    setSetup(key, { status: 'error', message: error instanceof Error ? error.message : String(error) })
    throw error
  }).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  })
  inFlight.set(key, pending)
  setSetup(key, { status: 'preparing' })
  return pending
}

export function workboardSessionReminder(sessionId?: string): string {
  const session = sessionId?.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 120)
  return `Linco project workboard${session ? ` (session ${session})` : ''}: For substantive project work, read ${instructionsPath} in this project's current host and folder before working; reuse the matching action or create one and its living action notebook, then maintain the SAME notebook and meaningful progress events. Reconstruct untracked prior work only from current context and inspected evidence, without inventing history. All sessions in this project on this host share its board. Greetings, ordinary questions, and session startup alone require no new action. Proceed with authorized work; routine progress does not require approval.`
}
