import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { WorkboardEvent } from '@/lib/previewWorkboard'

const fs = vi.hoisted(() => ({
  listDir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), createDir: vi.fn(), renamePath: vi.fn(),
}))
vi.mock('@/lib/fs', () => fs)

const files = new Map<string, string>()
const directories = new Set<string>()
const key = (path: string, host?: string) => `${host || 'local'}|${path}`
const eventsPath = '/project/.linco/workboard/events'

function mkdir(path: string, host?: string) {
  const parts = path.split('/')
  for (let i = 2; i <= parts.length; i++) directories.add(key(parts.slice(0, i).join('/'), host))
}

function seed(event: WorkboardEvent, root = '/project', host?: string) {
  const path = `${root}/.linco/workboard/events`
  mkdir(path, host)
  files.set(key(`${path}/${event.id}.json`, host), JSON.stringify(event))
}

const event = (id: string, type: WorkboardEvent['type'], options: Partial<WorkboardEvent> = {}): WorkboardEvent => ({
  version: 1, id, taskId: 'task-1', at: '2026-09-12T12:00:00.000Z', actor: 'agent', type,
  ...(type === 'create' ? { patch: { title: 'Redesign Live preview' } } : {}), ...options,
})

describe('living action notebooks', () => {
  const notebookPath = '/project/artifacts/actions/action-1/action.html'
  const seedCells = (html: string) => JSON.parse(html.match(/<script id="seed" type="application\/json">([\s\S]*?)<\/script>/)![1]) as Array<{ type: string; html?: string; text?: string; rows?: string[][] }>

  it('creates one notebook about the action before publishing its card, separately from the output preview', async () => {
    const { createWorkboardAction } = await import('@/lib/workboardActionArtifact')
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    const created = await createWorkboardAction('/project', {
      taskId: 'action-1', actor: 'user', type: 'create',
      patch: { title: 'Redesign Live preview', description: 'Organize work into durable actions.', summary: 'The native board keeps project progress together.', nextAction: 'Inspect existing preview', acceptance: ['Every action has a living record'], primaryArtifact: 'artifacts/prototype.html', artifacts: ['artifacts/evidence.html'] },
    })
    expect(created.patch).toMatchObject({ actionArtifact: 'artifacts/actions/action-1/action.html', primaryArtifact: 'artifacts/prototype.html' })
    const notebook = files.get(key(notebookPath))!
    const cells = seedCells(notebook)
    expect(cells.every(cell => cell.type === 'html' || cell.type === 'table')).toBe(true)
    expect(JSON.stringify(cells)).toContain('Inspect existing preview')
    expect(JSON.stringify(cells)).toContain('Every action has a living record')
    expect(JSON.stringify(cells)).toContain('Recorded:')
    const content = cells.map(cell => cell.html || '').join('')
    const visible = content.replace(/<details>[\s\S]*?<\/details>/g, '')
    expect(visible).toContain('The native board keeps project progress together.')
    expect(visible).toContain('Inspect existing preview')
    expect(visible).toContain('/artifacts/prototype.html')
    expect(visible).not.toContain('Organize work into durable actions.')
    expect(visible).not.toContain('Every action has a living record')
    expect(visible).not.toContain('/artifacts/evidence.html')
    expect(content).toContain('<details><summary>Brief and plan</summary>')
    expect(content).toContain('<details><summary>Validation</summary>')
    expect(content).not.toMatch(/<details\s+open|class="(?:card|grid|summary-band)"/)
    expect(notebook).toContain('/__assets/notebook.css')
    expect(notebook).toContain('/__assets/notebook.js')
    expect(notebook).not.toContain('<style')
    const shell = readFileSync(new URL('../src/assets/action-notebook.html', import.meta.url), 'utf8')
    const removeSeed = (html: string) => html.replace(/(<script id="seed" type="application\/json">)[\s\S]*?(<\/script>)/, '$1$2')
    expect(removeSeed(notebook)).toBe(removeSeed(shell))
    expect(fs.renamePath.mock.calls[0][1]).toBe('action.html')
    expect(fs.renamePath.mock.calls[1][1]).toBe(`${created.id}.json`)
    const task = (await loadWorkboard('/project')).tasks[0]
    expect(task.actionArtifact).toBe('artifacts/actions/action-1/action.html')
    expect(task.primaryArtifact).toBe('artifacts/prototype.html')
  })

  it('escapes HTML and seed terminators while retaining the notebook engine shell', async () => {
    const { createWorkboardAction } = await import('@/lib/workboardActionArtifact')
    await createWorkboardAction('/project', {
      taskId: 'action-1', actor: 'user', type: 'create',
      patch: { title: '</script><img src=x onerror=alert(1)>', description: 'A < B & "C"', acceptance: ['</script><script>alert(1)</script>'] },
    })
    const notebook = files.get(key(notebookPath))!
    expect(notebook).not.toContain('<img src=x')
    expect(notebook).not.toContain('<script>alert(1)')
    const content = JSON.stringify(seedCells(notebook))
    expect(content).toContain('&lt;img src=x')
    expect(content).toContain('A &lt; B &amp;')
    expect(seedCells(notebook)[0].html).toContain('<p class="lede">A &lt; B &amp; &quot;C&quot;</p>')
    expect((notebook.match(/<script id="seed"/g) || []).length).toBe(1)
    expect(notebook).toContain('HtmlVibeNotebook.mount(')
  })

  it('attaches a dated notebook to an existing action with its meaningful history', async () => {
    seed(event('created', 'create', { taskId: 'action-1', patch: { title: 'Existing action' } }))
    seed(event('adjusted', 'decision', { taskId: 'action-1', at: '2026-09-12T12:03:00Z', note: 'Keep all iterations in the same action notebook', patch: { status: 'progress', summary: 'Data model implemented', nextAction: 'Connect native view' } }))
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    const { ensureWorkboardActionArtifact } = await import('@/lib/workboardActionArtifact')
    const board = await loadWorkboard('/project')
    const result = await ensureWorkboardActionArtifact('/project', board.tasks[0], board.events)
    expect(result.path).toBe('artifacts/actions/action-1/action.html')
    expect(result.event?.patch).toEqual({ actionArtifact: result.path })
    const cells = seedCells(files.get(key(notebookPath))!)
    expect(JSON.stringify(cells)).toContain('2026-09-12T12:03:00.000Z')
    expect(JSON.stringify(cells)).toContain('Data model implemented')
    expect(JSON.stringify(cells)).toContain('Connect native view')
    const history = cells.find(cell => cell.html?.includes('<summary>Adjustments and decisions</summary>'))?.html
    expect(history).toContain('Keep all iterations in the same action notebook')
    expect(history).toMatch(/^<details><summary>/)
    expect(history).not.toContain('open')
    expect(cells.some(cell => cell.type === 'table')).toBe(false)
  })

  it('preserves user notebook cells on reopen and after later native status changes', async () => {
    const { createWorkboardAction, ensureWorkboardActionArtifact } = await import('@/lib/workboardActionArtifact')
    const { loadWorkboard, appendWorkboardEvent } = await import('@/lib/previewWorkboard')
    await createWorkboardAction('/project', { taskId: 'action-1', actor: 'user', type: 'create', patch: { title: 'Editable narrative' } })
    const original = files.get(key(notebookPath))!
    const cells = [...seedCells(original), { type: 'md', text: 'Please preserve my requirement exactly.' }]
    const edited = original.replace(/(<script id="seed" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => `${open}${JSON.stringify(cells)}${close}`)
    files.set(key(notebookPath), edited)
    await appendWorkboardEvent('/project', { taskId: 'action-1', actor: 'user', type: 'update', patch: { status: 'done', summary: 'Native task status updated' } })
    const board = await loadWorkboard('/project')
    fs.writeFile.mockClear()
    fs.listDir.mockClear()
    expect(await ensureWorkboardActionArtifact('/project', board.tasks[0], board.events)).toEqual({ path: 'artifacts/actions/action-1/action.html' })
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.listDir).not.toHaveBeenCalled()
    expect(files.get(key(notebookPath))).toBe(edited)
    expect(seedCells(edited).at(-1)).toEqual({ type: 'md', text: 'Please preserve my requirement exactly.' })
  })

  it('coalesces simultaneous first opens so only one scaffold is written', async () => {
    seed(event('created', 'create', { taskId: 'action-1' }))
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    const { ensureWorkboardActionArtifact } = await import('@/lib/workboardActionArtifact')
    const board = await loadWorkboard('/project')
    const [first, second] = await Promise.all([
      ensureWorkboardActionArtifact('/project', board.tasks[0], board.events),
      ensureWorkboardActionArtifact('/project/', board.tasks[0], board.events),
    ])
    expect(first.path).toBe(second.path)
    expect(fs.renamePath.mock.calls.filter(call => call[1] === 'action.html')).toHaveLength(1)
    expect([...files.keys()].filter(path => path.endsWith('/action.html'))).toHaveLength(1)
  })

  it('recovers a failed event publish by attaching the canonical notebook without overwriting edits', async () => {
    const rename = fs.renamePath.getMockImplementation()!
    let failPublish = true
    fs.renamePath.mockImplementation(async (path: string, name: string, host?: string) => {
      if (name.endsWith('.json') && failPublish) { failPublish = false; throw new Error('Event publish failed') }
      return rename(path, name, host)
    })
    const { createWorkboardAction } = await import('@/lib/workboardActionArtifact')
    const input = { taskId: 'action-1', actor: 'user' as const, type: 'create' as const, patch: { title: 'Recover this action' } }
    await expect(createWorkboardAction('/project', input)).rejects.toThrow('Event publish failed')
    expect(files.has(key(notebookPath))).toBe(true)
    files.set(key(notebookPath), 'User edits made after the interrupted publication')
    const recovered = await createWorkboardAction('/project', input)
    expect(recovered.patch?.actionArtifact).toBe('artifacts/actions/action-1/action.html')
    expect(files.get(key(notebookPath))).toBe('User edits made after the interrupted publication')
    expect(fs.renamePath.mock.calls.filter(call => call[1] === 'action.html')).toHaveLength(1)
  })

  it('creates independent action notebooks on different hosts and rejects invalid input before any writes', async () => {
    mkdir('/project', 'ssh-server')
    const { createWorkboardAction } = await import('@/lib/workboardActionArtifact')
    await createWorkboardAction('/project', { taskId: 'action-1', actor: 'user', type: 'create', patch: { title: 'Local action' } })
    await createWorkboardAction('/project', { taskId: 'action-1', actor: 'user', type: 'create', patch: { title: '远程行动' } }, 'ssh-server', 'zh')
    expect(JSON.stringify(seedCells(files.get(key(notebookPath))!))).toContain('Local action')
    expect(JSON.stringify(seedCells(files.get(key(notebookPath, 'ssh-server'))!))).toContain('远程行动')
    expect(JSON.stringify(seedCells(files.get(key(notebookPath, 'ssh-server'))!))).toContain('记录于')
    fs.writeFile.mockClear()
    await expect(createWorkboardAction('/project', { taskId: '../escape', actor: 'user', type: 'create', patch: { title: 'Unsafe' } })).rejects.toThrow()
    await expect(createWorkboardAction('/project', { actor: 'user', type: 'create', patch: { title: 'x'.repeat(241) } })).rejects.toThrow('Title')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('validates action artifact paths and asks agents to maintain the same narrative and user md cells', async () => {
    const { appendWorkboardEvent, loadWorkboard, workboardAgentPrompt } = await import('@/lib/previewWorkboard')
    await expect(appendWorkboardEvent('/project', { actor: 'user', type: 'create', patch: { title: 'Unsafe', actionArtifact: '../action.html' } })).rejects.toThrow('safe project-relative')
    seed(event('valid', 'create', { patch: { title: 'Living record', actionArtifact: 'artifacts/actions/action-1/action.html' } }))
    const prompt = workboardAgentPrompt((await loadWorkboard('/project')).tasks[0])
    expect(prompt).toContain('Living action notebook: artifacts/actions/action-1/action.html')
    expect(prompt).toContain('SAME notebook in place')
    expect(prompt).toContain('Preserve every user md cell verbatim')
    expect(prompt).toContain('Do not generate a new report for each iteration')
    expect(prompt).toContain('Lead the notebook with the result or concise current state')
    expect(prompt).toContain('closed details/summary disclosures')
  })
})

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  files.clear()
  directories.clear()
  mkdir('/project')
  fs.listDir.mockImplementation(async (path: string, host?: string) => {
    if (!directories.has(key(path, host))) throw new Error(`Cannot list ${path}`)
    const prefix = `${key(path, host)}/`
    const entries = new Map<string, { name: string; path: string; isDir: boolean }>()
    for (const item of directories) {
      if (item.startsWith(prefix) && !item.slice(prefix.length).includes('/')) {
        const name = item.slice(prefix.length)
        entries.set(name, { name, path: `${path}/${name}`, isDir: true })
      }
    }
    for (const item of files.keys()) {
      if (item.startsWith(prefix) && !item.slice(prefix.length).includes('/')) {
        const name = item.slice(prefix.length)
        entries.set(name, { name, path: `${path}/${name}`, isDir: false })
      }
    }
    return [...entries.values()]
  })
  fs.readFile.mockImplementation(async (path: string, host?: string) => {
    const content = files.get(key(path, host))
    if (content === undefined) throw new Error(`Cannot read ${path}`)
    return content
  })
  fs.writeFile.mockImplementation(async (path: string, content: string, host?: string) => {
    if (!directories.has(key(path.slice(0, path.lastIndexOf('/')), host))) throw new Error('Missing parent directory')
    files.set(key(path, host), content)
  })
  fs.createDir.mockImplementation(async (parent: string, name: string, host?: string) => {
    const path = `${parent}/${name}`
    if (!directories.has(key(parent, host))) throw new Error('Missing parent directory')
    if (directories.has(key(path, host)) || files.has(key(path, host))) throw new Error('Already exists')
    directories.add(key(path, host))
    return path
  })
  fs.renamePath.mockImplementation(async (path: string, name: string, host?: string) => {
    const content = files.get(key(path, host))
    const target = `${path.slice(0, path.lastIndexOf('/'))}/${name}`
    if (content === undefined || files.has(key(target, host))) throw new Error('Cannot rename')
    files.set(key(target, host), content)
    files.delete(key(path, host))
    return target
  })
})

describe('native Live preview workboard persistence', () => {
  it('recognizes a missing board without creating files, but surfaces inaccessible projects', async () => {
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    await expect(loadWorkboard('/project')).resolves.toEqual({ tasks: [], events: [], warnings: [] })
    expect(fs.createDir).not.toHaveBeenCalled()
    await expect(loadWorkboard('/unavailable')).rejects.toThrow('Cannot list')
    fs.listDir.mockRejectedValueOnce(new Error('SSH connection lost'))
    await expect(loadWorkboard('/project', 'server')).rejects.toThrow('SSH connection lost')
  })

  it('publishes concurrent user and agent changes as separate immutable events', async () => {
    const { appendWorkboardEvent, loadWorkboard } = await import('@/lib/previewWorkboard')
    const created = await appendWorkboardEvent('/project', { actor: 'user', type: 'create', patch: { title: 'A durable board' } })
    const [user, agent] = await Promise.all([
      appendWorkboardEvent('/project', { taskId: created.taskId, actor: 'user', type: 'update', patch: { nextAction: 'Review layout' } }),
      appendWorkboardEvent('/project', { taskId: created.taskId, actor: 'agent', type: 'update', patch: { status: 'progress', summary: 'Storage added' } }),
    ])
    const board = await loadWorkboard('/project')
    expect(board.tasks).toHaveLength(1)
    expect(board.tasks[0]).toMatchObject({ title: 'A durable board', nextAction: 'Review layout', status: 'progress', summary: 'Storage added' })
    expect(new Set([created.id, user.id, agent.id]).size).toBe(3)
    expect(board.events).toHaveLength(3)
    expect([...files.keys()].every(path => path.endsWith('.json'))).toBe(true)
    expect(fs.writeFile.mock.calls.every(call => /\/\.[\w-]+\.tmp$/.test(call[0]))).toBe(true)
    expect(fs.renamePath).toHaveBeenCalledTimes(3)
    expect(JSON.parse(files.get(key(`${eventsPath}/${created.id}.json`))!)).toEqual(created)
  })

  it('handles racing directory creation without hiding non-directory collisions', async () => {
    const { appendWorkboardEvent, loadWorkboard } = await import('@/lib/previewWorkboard')
    await Promise.all([
      appendWorkboardEvent('/project', { actor: 'user', type: 'create', patch: { title: 'User task' } }),
      appendWorkboardEvent('/project', { actor: 'agent', type: 'create', patch: { title: 'Agent task' } }),
    ])
    expect((await loadWorkboard('/project')).tasks).toHaveLength(2)
    mkdir('/blocked')
    files.set(key('/blocked/.linco'), 'not a directory')
    await expect(appendWorkboardEvent('/blocked', { actor: 'user', type: 'create', patch: { title: 'Cannot save' } })).rejects.toThrow('is a file')
  })

  it('never treats a failed publish as a saved update', async () => {
    const { appendWorkboardEvent, loadWorkboard } = await import('@/lib/previewWorkboard')
    fs.renamePath.mockRejectedValueOnce(new Error('Disk disconnected'))
    await expect(appendWorkboardEvent('/project', { actor: 'user', type: 'create', patch: { title: 'Unpublished' } })).rejects.toThrow('Disk disconnected')
    expect([...files.keys()][0]).toMatch(/\.tmp$/)
    expect((await loadWorkboard('/project')).tasks).toEqual([])
  })

  it('replays deterministic status, decision, artifact, and archive history', async () => {
    seed(event('z-create', 'create', { patch: { title: 'Outcome', acceptance: ['Preview opens'] } }))
    seed(event('b-progress', 'update', { at: '2026-09-12T12:01:00Z', patch: { status: 'progress', primaryArtifact: 'artifacts\\result.html' } }))
    seed(event('c-decision', 'decision', { at: '2026-09-12T12:02:00Z', note: 'Approved the compact layout', patch: { status: 'done', summary: 'Browser validation passed', nextAction: '' } }))
    seed(event('d-archive', 'update', { at: '2026-09-12T12:03:00Z', patch: { archived: true } }))
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    const board = await loadWorkboard('/project')
    expect(board.warnings).toEqual([])
    expect(board.tasks[0]).toMatchObject({ title: 'Outcome', status: 'done', primaryArtifact: 'artifacts/result.html', artifacts: ['artifacts/result.html'], archived: true, acceptance: ['Preview opens'], updatedAt: '2026-09-12T12:03:00.000Z' })
    expect(board.events.map(item => item.id)).toEqual(['z-create', 'b-progress', 'c-decision', 'd-archive'])
    expect(board.events[2].note).toBe('Approved the compact layout')
  })

  it('preserves updates that precede a creation timestamp and warns for missing tasks', async () => {
    seed(event('creation', 'create'))
    seed(event('skewed', 'update', { at: '2026-09-12T11:59:00Z', patch: { summary: 'Agent clock was behind' } }))
    seed(event('orphan', 'note', { taskId: 'missing', note: 'Needs context' }))
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    const board = await loadWorkboard('/project')
    expect(board.tasks[0].summary).toBe('Agent clock was behind')
    expect(board.warnings.join(' ')).toContain('has no creation event')
    expect(board.events).toHaveLength(3)
  })

  it('caches immutable valid files, retries malformed files, and reports partial read failures', async () => {
    seed(event('valid', 'create'))
    files.set(key(`${eventsPath}/broken.json`), '{partial')
    files.set(key(`${eventsPath}/.unpublished.tmp`), '{partial')
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    let board = await loadWorkboard('/project')
    expect(board.tasks).toHaveLength(1)
    expect(board.warnings).toHaveLength(1)
    board.tasks[0].title = 'Caller mutation'
    board.events[0].patch!.title = 'Caller event mutation'
    fs.readFile.mockClear()
    files.set(key(`${eventsPath}/broken.json`), JSON.stringify(event('broken', 'note', { note: 'Recovered after interrupted write' })))
    board = await loadWorkboard('/project')
    expect(board.tasks[0].title).toBe('Redesign Live preview')
    expect(board.warnings).toEqual([])
    expect(board.events).toHaveLength(2)
    expect(fs.readFile).toHaveBeenCalledTimes(1)
    expect(fs.readFile).toHaveBeenCalledWith(`${eventsPath}/broken.json`, undefined)
  })

  it('isolates cached state by project and SSH host', async () => {
    seed(event('same-file', 'create', { patch: { title: 'Local' } }))
    seed(event('same-file', 'create', { patch: { title: 'Other project' } }), '/other')
    seed(event('same-file', 'create', { patch: { title: 'Remote host' } }), '/project', 'ssh-server')
    const { loadWorkboard } = await import('@/lib/previewWorkboard')
    expect((await loadWorkboard('/project')).tasks[0].title).toBe('Local')
    expect((await loadWorkboard('/other')).tasks[0].title).toBe('Other project')
    expect((await loadWorkboard('/project', 'ssh-server')).tasks[0].title).toBe('Remote host')
    expect((await loadWorkboard('/project/')).tasks[0].title).toBe('Local')
  })

  it('orders a user save after the observed agent update when the agent clock is ahead', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    seed(event('create', 'create'))
    seed(event('agent-update', 'update', { at: future, patch: { status: 'progress' } }))
    const { loadWorkboard, appendWorkboardEvent } = await import('@/lib/previewWorkboard')
    await loadWorkboard('/project')
    const saved = await appendWorkboardEvent('/project', { taskId: 'task-1', actor: 'user', type: 'update', patch: { status: 'done' } })
    expect(Date.parse(saved.at)).toBeGreaterThan(Date.parse(future))
    expect((await loadWorkboard('/project')).tasks[0].status).toBe('done')
  })

  it.each(['../secret.html', '/absolute.html', 'C:\\secret.html', 'https://example.com/a.html', 'artifacts/../secret.html', 'artifacts\\..\\secret.html', 'artifacts/%2e%2e/secret.html', 'artifacts/a.html?path=secret', 'artifacts//a.html'])('rejects unsafe artifact path %s before writing', async path => {
    const { appendWorkboardEvent } = await import('@/lib/previewWorkboard')
    await expect(appendWorkboardEvent('/project', { actor: 'user', type: 'create', patch: { title: 'Unsafe', primaryArtifact: path } })).rejects.toThrow('safe project-relative')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('rejects malformed and oversized incoming events while retaining valid history', async () => {
    seed(event('valid', 'create'))
    files.set(key(`${eventsPath}/wrong-id.json`), JSON.stringify(event('another-id', 'create')))
    files.set(key(`${eventsPath}/bad-schema.json`), JSON.stringify({ ...event('bad-schema', 'create'), patch: { title: 'Bad', injectedField: 'oops' } }))
    files.set(key(`${eventsPath}/oversized.json`), ' '.repeat(65 * 1024))
    const { loadWorkboard, appendWorkboardEvent } = await import('@/lib/previewWorkboard')
    const board = await loadWorkboard('/project')
    expect(board.tasks).toHaveLength(1)
    expect(board.warnings).toHaveLength(3)
    await expect(appendWorkboardEvent('/project', { actor: 'user', type: 'create', patch: { title: 'x'.repeat(241) } })).rejects.toThrow('Title')
    await expect(appendWorkboardEvent('/project', { actor: 'user', type: 'update', patch: { status: 'done' } })).rejects.toThrow('Choose a task')
    await expect(appendWorkboardEvent('/project', { actor: 'user', taskId: 'task-1', type: 'decision', note: '' })).rejects.toThrow('needs a note')
  })

  it('discovers relative HTML artifacts recursively without enrolling or changing them', async () => {
    mkdir('/project/artifacts/nested')
    files.set(key('/project/index.html'), '<html/>')
    files.set(key('/project/artifacts/overview.html'), '<html/>')
    files.set(key('/project/artifacts/nested/detail.HTM'), '<html/>')
    files.set(key('/project/artifacts/notes.md'), '# Notes')
    const { discoverPreviewArtifacts } = await import('@/lib/previewWorkboard')
    expect(await discoverPreviewArtifacts('/project')).toEqual({ artifacts: ['artifacts/nested/detail.HTM', 'artifacts/overview.html', 'index.html'], limited: false })
    expect(fs.writeFile).not.toHaveBeenCalled()
    fs.listDir.mockRejectedValueOnce(new Error('Read denied'))
    await expect(discoverPreviewArtifacts('/project')).rejects.toThrow('Read denied')
  })

  it('signals a bounded artifact listing instead of silently claiming it is complete', async () => {
    mkdir('/project/artifacts')
    for (let i = 0; i < 501; i++) files.set(key(`/project/artifacts/${i}.html`), '<html/>')
    const { discoverPreviewArtifacts } = await import('@/lib/previewWorkboard')
    const discovery = await discoverPreviewArtifacts('/project')
    expect(discovery.artifacts).toHaveLength(500)
    expect(discovery.limited).toBe(true)
  })

  it('includes the persistent protocol and scoped task in agent handoff', async () => {
    seed(event('valid', 'create', { patch: { title: 'Native board', nextAction: 'Implement persistence' } }))
    const { loadWorkboard, workboardAgentPrompt } = await import('@/lib/previewWorkboard')
    const prompt = workboardAgentPrompt((await loadWorkboard('/project')).tasks[0])
    expect(prompt).toContain('Task ID: task-1')
    expect(prompt).toContain('.linco/workboard/events/<event-id>.json')
    expect(prompt).toContain('Never edit or replace published events')
    expect(prompt).toContain('routine progress does not require approval')
    expect(prompt).toContain('Implement persistence')
  })
})
