import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ listDir: vi.fn(), readFile: vi.fn(), createDir: vi.fn(), writeFile: vi.fn(), renamePath: vi.fn() }))
vi.mock('@/lib/fs', () => fs)

const files = new Map<string, string>()
const directories = new Set<string>()
const key = (path: string, host?: string) => JSON.stringify([host || '', path])
const begin = '<!-- LINCO:WORKBOARD:BEGIN -->'
const end = '<!-- LINCO:WORKBOARD:END -->'

function mkdir(path: string, host?: string) {
  const parts = path.split('/')
  for (let i = 2; i <= parts.length; i++) directories.add(key(parts.slice(0, i).join('/'), host))
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  files.clear()
  directories.clear()
  mkdir('/project')
  fs.listDir.mockImplementation(async (path: string, host?: string) => {
    if (!directories.has(key(path, host))) throw new Error(`Cannot list ${path}`)
    const entries: Array<{ name: string; path: string; isDir: boolean }> = []
    for (const item of directories) {
      const [itemHost, itemPath] = JSON.parse(item) as string[]
      if (itemHost !== (host || '') || !itemPath.startsWith(`${path}/`)) continue
      const name = itemPath.slice(path.length + 1)
      if (name && !name.includes('/')) entries.push({ name, path: itemPath, isDir: true })
    }
    for (const item of files.keys()) {
      const [itemHost, itemPath] = JSON.parse(item) as string[]
      if (itemHost !== (host || '') || !itemPath.startsWith(`${path}/`)) continue
      const name = itemPath.slice(path.length + 1)
      if (name && !name.includes('/')) entries.push({ name, path: itemPath, isDir: false })
    }
    return entries
  })
  fs.readFile.mockImplementation(async (path: string, host?: string) => {
    const content = files.get(key(path, host))
    if (content === undefined) throw new Error(`Cannot read ${path}`)
    return content
  })
  fs.createDir.mockImplementation(async (parent: string, name: string, host?: string) => {
    if (!directories.has(key(parent, host))) throw new Error('Missing parent directory')
    const path = `${parent}/${name}`
    if (directories.has(key(path, host)) || files.has(key(path, host))) throw new Error('Already exists')
    directories.add(key(path, host))
    return path
  })
  fs.writeFile.mockImplementation(async (path: string, content: string, host?: string) => {
    if (!directories.has(key(path.slice(0, path.lastIndexOf('/')), host))) throw new Error('Missing parent directory')
    files.set(key(path, host), content)
  })
  fs.renamePath.mockImplementation(async (path: string, name: string, host?: string) => {
    const target = `${path.slice(0, path.lastIndexOf('/'))}/${name}`
    const content = files.get(key(path, host))
    if (content === undefined || files.has(key(target, host)) || directories.has(key(target, host))) throw new Error('Cannot rename')
    files.set(key(target, host), content)
    files.delete(key(path, host))
    return target
  })
})

describe('project-scoped workboard tracking bootstrap', () => {
  it('installs instructions and the bundled notebook without manufacturing actions on startup', async () => {
    const { ensureWorkboardProject, getWorkboardSetup } = await import('@/lib/workboardProject')
    await ensureWorkboardProject('/project')
    const paths = [...files.keys()].map(item => (JSON.parse(item) as string[])[1]).sort()
    expect(paths).toEqual(['/project/.linco/workboard/INSTRUCTIONS.md', '/project/.linco/workboard/notebook.html', '/project/AGENTS.md', '/project/CLAUDE.md'])
    expect(directories.has(key('/project/.linco/workboard/events'))).toBe(false)
    expect(directories.has(key('/project/artifacts'))).toBe(false)
    expect(files.get(key('/project/.linco/workboard/notebook.html'))).toBe(readFileSync(new URL('../src/assets/action-notebook.html', import.meta.url), 'utf8'))
    expect(files.get(key('/project/AGENTS.md'))).toContain('.linco/workboard/INSTRUCTIONS.md')
    expect(files.get(key('/project/CLAUDE.md'))).toContain(begin)
    expect(getWorkboardSetup('/project').status).toBe('ready')
    expect(fs.renamePath.mock.calls.map(call => call[1])).toEqual(['INSTRUCTIONS.md', 'notebook.html', 'AGENTS.md', 'CLAUDE.md'])
  })

  it('preserves existing user text, older Linco conventions, and unrelated managed blocks exactly', async () => {
    const userPrefix = '# Team rules\r\nKeep this wording.\r\n<!-- LINCO:BEGIN -->\r\nOriginal Linco environment conventions\r\n<!-- LINCO:END -->\r\n'
    const userSuffix = '\r\n<!-- OTHER:BEGIN -->other automation<!-- OTHER:END -->\r\nFinal user note.\r\n'
    files.set(key('/project/AGENTS.md'), `${userPrefix}${begin}\nObsolete workboard pointer\n${end}${userSuffix}`)
    files.set(key('/project/CLAUDE.md'), 'Personal project guidance without a managed block.')
    const { ensureWorkboardProject } = await import('@/lib/workboardProject')
    await ensureWorkboardProject('/project')
    const agents = files.get(key('/project/AGENTS.md'))!
    expect(agents.startsWith(userPrefix)).toBe(true)
    expect(agents.endsWith(userSuffix)).toBe(true)
    expect(agents).not.toContain('Obsolete workboard pointer')
    expect(agents.split(begin)).toHaveLength(2)
    expect(files.get(key('/project/CLAUDE.md'))).toMatch(/^Personal project guidance without a managed block\.\n\n/)
  })

  it('leaves existing artifacts, published events, and a user-edited fallback template untouched', async () => {
    mkdir('/project/.linco/workboard/events')
    mkdir('/project/artifacts/actions/old-action')
    files.set(key('/project/.linco/workboard/events/old-event.json'), '{"keep":"published history"}')
    files.set(key('/project/artifacts/actions/old-action/action.html'), '<html>User notebook edits</html>')
    files.set(key('/project/.linco/workboard/notebook.html'), '<html>Custom project template</html>')
    files.set(key('/project/.linco/workboard/INSTRUCTIONS.md'), 'Project-specific tracking note.\n')
    const { ensureWorkboardProject } = await import('@/lib/workboardProject')
    await ensureWorkboardProject('/project')
    expect(files.get(key('/project/.linco/workboard/events/old-event.json'))).toBe('{"keep":"published history"}')
    expect(files.get(key('/project/artifacts/actions/old-action/action.html'))).toBe('<html>User notebook edits</html>')
    expect(files.get(key('/project/.linco/workboard/notebook.html'))).toBe('<html>Custom project template</html>')
    expect(files.get(key('/project/.linco/workboard/INSTRUCTIONS.md'))).toMatch(/^Project-specific tracking note\.\n\n/)
    expect(fs.readFile.mock.calls.some(call => call[0].includes('/events/') || call[0].includes('/artifacts/'))).toBe(false)
    expect(fs.writeFile.mock.calls.some(call => call[0].includes('/events/') || call[0].includes('/artifacts/'))).toBe(false)
  })

  it('coalesces simultaneous sessions and returns stable immutable setup snapshots', async () => {
    const { ensureWorkboardProject, getWorkboardSetup, subscribeWorkboardSetup } = await import('@/lib/workboardProject')
    const empty = getWorkboardSetup('')
    expect(getWorkboardSetup('', 'server')).toBe(empty)
    expect(getWorkboardSetup('/project')).toBe(empty)
    const statuses: string[] = []
    const unsubscribe = subscribeWorkboardSetup(() => statuses.push(getWorkboardSetup('/project').status))
    const first = ensureWorkboardProject('/project')
    const second = ensureWorkboardProject('/project/')
    expect(first).toBe(second)
    expect(getWorkboardSetup('/project').status).toBe('preparing')
    await Promise.all([first, second])
    expect(statuses).toEqual(['preparing', 'ready'])
    const ready = getWorkboardSetup('/project')
    expect(Object.isFrozen(ready)).toBe(true)
    fs.listDir.mockClear()
    fs.writeFile.mockClear()
    await ensureWorkboardProject('/project')
    expect(getWorkboardSetup('/project')).toBe(ready)
    expect(fs.listDir).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
    unsubscribe()
    mkdir('/other')
    await ensureWorkboardProject('/other')
    expect(statuses).toEqual(['preparing', 'ready'])
  })

  it('does not rewrite already-current setup files after an app restart', async () => {
    let project = await import('@/lib/workboardProject')
    await project.ensureWorkboardProject('/project')
    files.set(key('/project/.linco/workboard/notebook.html'), 'Custom notebook template kept across restarts')
    vi.resetModules()
    project = await import('@/lib/workboardProject')
    fs.writeFile.mockClear()
    fs.renamePath.mockClear()
    await project.ensureWorkboardProject('/project')
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.renamePath).not.toHaveBeenCalled()
    expect(files.get(key('/project/.linco/workboard/notebook.html'))).toBe('Custom notebook template kept across restarts')
  })

  it('isolates preparation and failures by host and project root', async () => {
    mkdir('/project', 'remote')
    mkdir('/other')
    files.set(key('/project/AGENTS.md', 'remote'), 'Remote-only user guidance')
    const { ensureWorkboardProject, getWorkboardSetup } = await import('@/lib/workboardProject')
    await ensureWorkboardProject('/project')
    expect(getWorkboardSetup('/project', 'remote').status).toBe('idle')
    await Promise.all([ensureWorkboardProject('/project', 'remote'), ensureWorkboardProject('/other')])
    expect(files.get(key('/project/AGENTS.md', 'remote'))).toMatch(/^Remote-only user guidance/)
    expect(files.get(key('/project/AGENTS.md'))).not.toContain('Remote-only')
    expect(getWorkboardSetup('/other').status).toBe('ready')
    await expect(ensureWorkboardProject('/project', 'offline')).rejects.toThrow('Cannot list')
    expect(getWorkboardSetup('/project', 'offline').status).toBe('error')
    expect(getWorkboardSetup('/project').status).toBe('ready')
  })

  it('surfaces access failures and retries instead of treating an unavailable project as empty', async () => {
    const { ensureWorkboardProject, getWorkboardSetup } = await import('@/lib/workboardProject')
    fs.listDir.mockRejectedValueOnce(new Error('SSH connection interrupted'))
    await expect(ensureWorkboardProject('/project')).rejects.toThrow('SSH connection interrupted')
    expect(getWorkboardSetup('/project')).toEqual({ status: 'error', message: 'SSH connection interrupted' })
    expect(fs.writeFile).not.toHaveBeenCalled()
    await ensureWorkboardProject('/project')
    expect(getWorkboardSetup('/project').status).toBe('ready')
  })

  it('retries partial installation without duplicating pointers or losing existing instructions', async () => {
    files.set(key('/project/AGENTS.md'), 'User-authored rule')
    const rename = fs.renamePath.getMockImplementation()!
    let fail = true
    fs.renamePath.mockImplementation(async (path: string, name: string, host?: string) => {
      if (name === 'CLAUDE.md' && fail) { fail = false; throw new Error('Save disconnected') }
      return rename(path, name, host)
    })
    const { ensureWorkboardProject, getWorkboardSetup } = await import('@/lib/workboardProject')
    await expect(ensureWorkboardProject('/project')).rejects.toThrow('Save disconnected')
    expect(getWorkboardSetup('/project').status).toBe('error')
    await ensureWorkboardProject('/project')
    expect(files.get(key('/project/AGENTS.md'))).toMatch(/^User-authored rule/)
    expect(files.get(key('/project/AGENTS.md'))!.split(begin)).toHaveLength(2)
    expect(getWorkboardSetup('/project').status).toBe('ready')
  })

  it.each([
    `${begin}\nmissing end`, `${end}\nmissing beginning`, `${end}\nreversed\n${begin}`,
    `${begin}\n${begin}\n${end}`, '<!-- LINCO:WORKBOARD:BEGIN', '<!-- LINCO:WORKBOARD:BEGIN -->\n<!-- LINCO:WORKBOARD:END-->',
  ])('rejects malformed own markers before writing any setup files: %s', async malformed => {
    const original = `User content above\n${malformed}\nUser content below`
    files.set(key('/project/CLAUDE.md'), original)
    const { ensureWorkboardProject, getWorkboardSetup } = await import('@/lib/workboardProject')
    await expect(ensureWorkboardProject('/project')).rejects.toThrow('malformed Linco workboard markers')
    expect(getWorkboardSetup('/project').status).toBe('error')
    expect(files.get(key('/project/CLAUDE.md'))).toBe(original)
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.createDir).not.toHaveBeenCalled()
  })

  it('preflights malformed existing protocol markers and directory collisions', async () => {
    mkdir('/project/.linco/workboard')
    files.set(key('/project/.linco/workboard/INSTRUCTIONS.md'), `${begin}\nIncomplete manual edit`)
    const { ensureWorkboardProject } = await import('@/lib/workboardProject')
    await expect(ensureWorkboardProject('/project')).rejects.toThrow('malformed')
    expect(fs.writeFile).not.toHaveBeenCalled()
    files.delete(key('/project/.linco/workboard/INSTRUCTIONS.md'))
    mkdir('/project/.linco/workboard/notebook.html')
    await expect(ensureWorkboardProject('/project')).rejects.toThrow('template path is a directory')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('reads the latest user document before updating and preserves a file created by a racing writer', async () => {
    files.set(key('/project/AGENTS.md'), 'Original guidance')
    const read = fs.readFile.getMockImplementation()!
    let agentsReads = 0
    fs.readFile.mockImplementation(async (path: string, host?: string) => {
      if (path === '/project/AGENTS.md' && ++agentsReads === 2) files.set(key(path, host), 'New user guidance after preflight')
      return read(path, host)
    })
    const rename = fs.renamePath.getMockImplementation()!
    let appeared = false
    fs.renamePath.mockImplementation(async (path: string, name: string, host?: string) => {
      if (name === 'CLAUDE.md' && !appeared) {
        appeared = true
        files.set(key('/project/CLAUDE.md', host), 'Created concurrently by the user')
      }
      return rename(path, name, host)
    })
    const { ensureWorkboardProject } = await import('@/lib/workboardProject')
    await ensureWorkboardProject('/project')
    expect(files.get(key('/project/AGENTS.md'))).toMatch(/^New user guidance after preflight/)
    expect(files.get(key('/project/CLAUDE.md'))).toMatch(/^Created concurrently by the user/)
    expect(files.get(key('/project/CLAUDE.md'))!.split(begin)).toHaveLength(2)
  })

  it('provides the semantic workflow, reconstruction rules, schema limits, and portable notebook fallback', async () => {
    const { ensureWorkboardProject, workboardSessionReminder } = await import('@/lib/workboardProject')
    await ensureWorkboardProject('/project')
    const instructions = files.get(key('/project/.linco/workboard/INSTRUCTIONS.md'))!
    expect(instructions).toContain('Lead with the result or a concise, truthful current state')
    expect(instructions).toContain('closed details/summary disclosures')
    expect(instructions).toContain('omit empty or redundant sections')
    for (const phrase of ['BEFORE starting work', 'reconstructed', 'do not invent historical timestamps', 'Do not create cards for greetings', 'same action', 'same notebook', 'routine progress does not require approval', '.linco/workboard/notebook.html', 'Preserve every existing user md cell verbatim', 'Published events are immutable', 'title:', 'actionArtifact:', 'primaryArtifact:', '16000', '6000', '3000', '1000', '2000', '65536']) expect(instructions.toLowerCase()).toContain(phrase.toLowerCase())
    const reminder = workboardSessionReminder('session\r\n123\u001b[31m')
    expect(reminder).not.toMatch(/[\r\n\u001b]/)
    expect(reminder).toContain('.linco/workboard/INSTRUCTIONS.md')
    expect(reminder).toContain('reuse the matching action')
    expect(reminder).toContain('session startup alone require no new action')
    expect(reminder).toContain('without inventing history')
  })
})
