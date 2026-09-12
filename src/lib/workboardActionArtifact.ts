/// <reference types="vite/client" />
import notebookShell from '../assets/action-notebook.html?raw'
import { createDir, listDir, renamePath, writeFile } from './fs'
import { appendWorkboardEvent, validateWorkboardEventInput } from './previewWorkboard'
import type { WorkboardEvent, WorkboardEventInput, WorkboardTask } from './previewWorkboard'

type Language = 'en' | 'zh'
type NotebookCell = { type: 'html'; html: string } | { type: 'table'; head: string[]; rows: string[][] }
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const notebookWrites = new Map<string, Promise<string>>()

const text = {
  en: {
    artifact: 'Action artifact', briefEmpty: 'The brief has not been recorded.', recorded: 'Recorded',
    noProgress: 'No summary recorded yet.', next: 'Next step', noNext: 'No next step recorded.',
    plan: 'Brief and plan', changes: 'Adjustments and decisions', changesEmpty: 'No adjustments recorded.',
    validation: 'Validation', validationEmpty: 'No validation details recorded.', acceptance: 'Acceptance criteria',
    viewResult: 'View result', outputs: 'Supporting outputs', user: 'User', agent: 'Agent',
    planned: 'Planned', progress: 'In progress', review: 'Needs review', done: 'Done', historyLimit: 'Earlier entries remain in the action history.',
  },
  zh: {
    artifact: '行动记录', briefEmpty: '尚未记录目标。', recorded: '记录于',
    noProgress: '尚未记录进展摘要。', next: '下一步', noNext: '尚未记录下一步。',
    plan: '目标与计划', changes: '调整与决定', changesEmpty: '尚未记录调整。',
    validation: '验证', validationEmpty: '尚未记录验证详情。', acceptance: '验收标准',
    viewResult: '查看结果', outputs: '相关产出', user: '用户', agent: 'Agent',
    planned: '待开展', progress: '进行中', review: '待审阅', done: '已完成', historyLimit: '更早的记录保留在行动历史中。',
  },
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const prose = (value: string) => escapeHtml(value).replace(/\r?\n/g, '<br>')

function canonicalPath(taskId: string): string {
  if (!validId.test(taskId)) throw new Error('Invalid workboard action ID.')
  return `artifacts/actions/${taskId}/action.html`
}

function rootPath(cwd: string): string {
  if (!cwd.trim()) throw new Error('Choose a project before creating an action artifact.')
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

const join = (root: string, relative: string) => `${root === '/' ? '' : root}/${relative}`

/** A scaffold is written once. Later narrative edits belong to the action's existing notebook. */
export function renderWorkboardActionNotebook(task: WorkboardTask, events: WorkboardEvent[], lang: Language = 'en'): string {
  const copy = text[lang]
  const ownPath = task.actionArtifact || canonicalPath(task.id)
  const outputs = [...new Set([task.primaryArtifact, ...task.artifacts].filter((path): path is string => !!path && path !== ownPath))]
  // Validate links even when this renderer is called with a task that did not come from loadWorkboard.
  validateWorkboardEventInput({ taskId: task.id, actor: 'user', type: 'update', patch: { actionArtifact: ownPath, artifacts: outputs } })
  const snapshotAt = task.updatedAt || new Date().toISOString()
  const href = (path: string) => `/${path.split('/').map(encodeURIComponent).join('/')}`
  const result = outputs[0]
  const cells: NotebookCell[] = [
    { type: 'html', html: `<header><div class="eyebrow">${copy.artifact}</div><h1>${escapeHtml(task.title)}</h1><p class="lede">${prose(task.summary || task.description || copy.noProgress)}</p>${result ? `<p><a href="${href(result)}">${copy.viewResult}</a></p>` : ''}<p class="note">${copy[task.status]} · ${copy.recorded}: <time datetime="${escapeHtml(snapshotAt)}">${escapeHtml(snapshotAt)}</time></p></header>` },
    { type: 'html', html: `<section><h2>${copy.next}</h2><p>${prose(task.nextAction || copy.noNext)}</p></section>` },
    { type: 'html', html: `<details><summary>${copy.plan}</summary><p>${prose(task.description || copy.briefEmpty)}</p></details>` },
  ]
  const changes = events.filter(event => event.taskId === task.id && event.type !== 'create' && (event.note || event.patch?.summary))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const history = changes.slice(-5).map(event => `<li><p>${prose(event.note || event.patch!.summary!)}</p><p class="note"><time datetime="${escapeHtml(event.at)}">${escapeHtml(event.at)}</time> · ${event.actor === 'user' ? copy.user : copy.agent}</p></li>`).join('')
  cells.push({ type: 'html', html: `<details><summary>${copy.changes}</summary>${history ? `<ol>${history}</ol>${changes.length > 5 ? `<p class="note">${copy.historyLimit}</p>` : ''}` : `<p>${copy.changesEmpty}</p>`}</details>` })
  cells.push({ type: 'html', html: `<details><summary>${copy.validation}</summary><p>${copy.validationEmpty}</p>${task.acceptance.length ? `<h3>${copy.acceptance}</h3><ul>${task.acceptance.map(item => `<li>${prose(item)}</li>`).join('')}</ul>` : ''}${outputs.length > 1 ? `<h3>${copy.outputs}</h3><ul>${outputs.slice(1).map(path => `<li><a href="${href(path)}">${escapeHtml(path)}</a></li>`).join('')}</ul>` : ''}</details>` })
  const seed = JSON.stringify(cells, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return notebookShell.replace(/(<script id="seed" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open: string, close: string) => `${open}\n${seed}\n${close}`)
}

function createNotebookOnce(cwd: string, task: WorkboardTask, events: WorkboardEvent[], host?: string, lang: Language = 'en'): Promise<string> {
  const key = JSON.stringify([host || '', rootPath(cwd), task.id])
  const existing = notebookWrites.get(key)
  if (existing) return existing
  const pending = writeNotebookIfMissing(cwd, task, events, host, lang)
  notebookWrites.set(key, pending)
  const release = () => { if (notebookWrites.get(key) === pending) notebookWrites.delete(key) }
  void pending.then(release, release)
  return pending
}

async function writeNotebookIfMissing(cwd: string, task: WorkboardTask, events: WorkboardEvent[], host?: string, lang: Language = 'en'): Promise<string> {
  const relative = canonicalPath(task.id)
  const segments = relative.split('/')
  const fileName = segments.pop()!
  let directory = rootPath(cwd)
  for (const name of segments) {
    let existing = (await listDir(directory, host)).find(entry => entry.name === name)
    if (!existing) {
      try { await createDir(directory, name, host) } catch (error) {
        existing = (await listDir(directory, host)).find(entry => entry.name === name)
        if (!existing?.isDir) throw error
      }
    }
    if (existing && !existing.isDir) throw new Error(`${join(directory, name)} is a file; the action needs a directory.`)
    directory = join(directory, name)
  }
  const existing = (await listDir(directory, host)).find(entry => entry.name === fileName)
  if (existing?.isDir) throw new Error('The action notebook path is occupied by a directory.')
  if (existing) return relative
  const content = renderWorkboardActionNotebook({ ...task, actionArtifact: relative }, events, lang)
  const temporary = join(directory, `.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, content, host)
  try { await renamePath(temporary, fileName, host) } catch (error) {
    // If another writer published first, retain their notebook including any user edits.
    const published = (await listDir(directory, host)).find(entry => entry.name === fileName)
    if (!published || published.isDir) throw error
  }
  return relative
}

export async function createWorkboardAction(
  cwd: string, input: WorkboardEventInput & { type: 'create' }, host?: string, lang: Language = 'en',
): Promise<WorkboardEvent> {
  const validated = validateWorkboardEventInput(input)
  const taskId = validated.taskId || crypto.randomUUID()
  const path = canonicalPath(taskId)
  const at = new Date().toISOString()
  const task: WorkboardTask = {
    id: taskId, title: validated.patch!.title!, description: '', summary: '', nextAction: '', status: 'planned',
    artifacts: [], acceptance: [], archived: false, createdAt: at, updatedAt: at,
    ...validated.patch, actionArtifact: path,
  }
  await createNotebookOnce(cwd, task, [], host, lang)
  return appendWorkboardEvent(cwd, { ...validated, taskId, type: 'create', patch: { ...validated.patch, actionArtifact: path } }, host)
}

export async function ensureWorkboardActionArtifact(
  cwd: string, task: WorkboardTask, events: WorkboardEvent[], host?: string, lang: Language = 'en',
): Promise<{ path: string; event?: WorkboardEvent }> {
  if (task.actionArtifact) {
    const validated = validateWorkboardEventInput({ taskId: task.id, actor: 'user', type: 'update', patch: { actionArtifact: task.actionArtifact } })
    return { path: validated.patch!.actionArtifact! }
  }
  const path = await createNotebookOnce(cwd, task, events, host, lang)
  const event = await appendWorkboardEvent(cwd, { taskId: task.id, actor: 'user', type: 'update', patch: { actionArtifact: path } }, host)
  return { path, event }
}
