// Full desktop React app, with a browser-only persistent filesystem layered over
// the existing workspace fixture. The public demo never imports this module.
await import('../../demo/mock-workspace')

type Disk = { directories: string[]; files: Record<string, string> }
type Call = { command: string; args: Record<string, any> }
const params = new URLSearchParams(location.search)
const storageKey = 'fixture:workboard-sessions:disk:v1'
const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')
const key = (path: string, host = '') => `${host}|${normalize(path)}`
const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))
const diskNow = (): Disk => JSON.parse(localStorage.getItem(storageKey) || '{"directories":[],"files":{}}')
const saveDisk = (disk: Disk) => localStorage.setItem(storageKey, JSON.stringify(disk))
const existingAgents = 'Project-owned instructions: preserve the audit trail.\n<!-- LINCO:BEGIN -->\nExisting Linco notebook convention.\n<!-- LINCO:END -->\nKeep this final user rule.\n'
for (const [host, root] of [['', 'C:/Projects/linco'], ['', 'C:/Projects/website'], ['lab-a', '/work/shared'], ['lab-b', '/work/shared']]) {
  const disk = diskNow()
  if (disk.directories.includes(key(root, host))) continue
  disk.directories.push(key(root, host))
  disk.files[key(root + '/AGENTS.md', host)] = existingAgents
  if (host === 'lab-b') disk.files[key(root + '/CLAUDE.md', host)] = 'Existing Claude-specific project rule.\n'
  saveDisk(disk)
}

const fixtureWindow = window as any
const isSessionFixture = location.pathname.endsWith('/workboard-sessions.html')
const config = fixtureWindow.__workbench.getConfig()
if (isSessionFixture) config.connections = [
  { id: 'remote-a', name: 'Lab A', host: 'lab-a', cwd: '/work/shared', identity: '', recentDirs: ['/work/shared'] },
  { id: 'remote-b', name: 'Lab B', host: 'lab-b', cwd: '/work/shared', identity: '', recentDirs: ['/work/shared'] },
]
if (isSessionFixture && params.has('remote-a')) config.active_connection = 'remote-a'
if (isSessionFixture && params.has('plain-shell')) config.auto_start = false
const pendingWrites: (() => void)[] = []
const pendingStarts: (() => void)[] = []
const state = {
  calls: [] as Call[],
  starts: [] as { id: string; host: string; cwd: string; files: string[] }[],
  failWrites: params.has('bootstrap-fail'),
  holdWrites: false,
  holdStarts: params.has('hold-start'),
  ready: { 'lab-a': !params.has('await-ssh'), 'lab-b': true } as Record<string, boolean>,
  disk: diskNow,
  existingAgents,
  releaseWrites: () => { state.holdWrites = false; pendingWrites.splice(0).forEach(resolve => resolve()) },
  releaseStarts: () => { state.holdStarts = false; pendingStarts.splice(0).forEach(resolve => resolve()) },
  makeRemoteReady: (host: string) => { state.ready[host] = true },
}
fixtureWindow.workboardSessionsTest = state
const originalInvoke = fixtureWindow.__TAURI_INTERNALS__.invoke
fixtureWindow.__TAURI_INTERNALS__.invoke = async (command: string, payload: Record<string, any> = {}, options?: unknown) => {
  const args = payload || {}
  state.calls.push({ command, args })
  const host = String(args.host || '')
  const path = normalize(String(args.path || ''))
  if (command === 'term_start') {
    const root = normalize(String(args.cwd || ''))
    state.starts.push({ id: args.id, host, cwd: root, files: Object.keys(diskNow().files).filter(entry => entry.startsWith(key(root, host) + '/')) })
    if (state.holdStarts) await new Promise<void>(resolve => pendingStarts.push(resolve))
  }
  if (command === 'ssh_check') return !!state.ready[host]
  if (command === 'ssh_connect') {
    if (!state.ready[host]) throw new Error('Fixture SSH is waiting for interactive authentication')
    return null
  }
  if (command === 'fs_list_dir') {
    if (host && !state.ready[host]) throw new Error('Fixture remote filesystem is not ready')
    const disk = diskNow()
    const managed = /\/(?:\.linco|artifacts)(?:\/|$)/.test(path)
    if (!disk.directories.includes(key(path, host))) {
      if (managed) throw new Error(`Directory does not exist: ${path}`)
      return originalInvoke(command, payload, options)
    }
    const entries = [
      ...disk.directories.filter(entry => entry.startsWith(`${host}|`)).map(entry => ({ path: entry.slice(host.length + 1), is_dir: true })),
      ...Object.keys(disk.files).filter(entry => entry.startsWith(`${host}|`)).map(entry => ({ path: entry.slice(host.length + 1), is_dir: false })),
    ].filter(entry => parent(entry.path) === path).map(entry => ({ ...entry, name: entry.path.slice(path.length + 1) }))
    if (managed) return entries
    const original = await originalInvoke(command, payload, options)
    return [...new Map([...(Array.isArray(original) ? original : []), ...entries].map(entry => [entry.name, entry])).values()]
  }
  if (command === 'fs_read_file') {
    const content = diskNow().files[key(path, host)]
    if (content === undefined) {
      if (/\/(?:\.linco|artifacts)(?:\/|$)/.test(path) || /\/(?:AGENTS|CLAUDE)\.md$/.test(path)) throw new Error(`File does not exist: ${path}`)
      return originalInvoke(command, payload, options)
    }
    return content
  }
  if (['fs_write_file', 'fs_create_dir', 'fs_rename'].includes(command)) {
    const affected = command === 'fs_create_dir' ? `${normalize(String(args.parent))}/${args.name}` : path
    if (!/\/(?:\.linco|artifacts)(?:\/|$)/.test(affected) && !/\/(?:AGENTS\.md|CLAUDE\.md|\.[a-f0-9-]+\.tmp)$/.test(affected)) {
      return originalInvoke(command, payload, options)
    }
    if (state.holdWrites) await new Promise<void>(resolve => pendingWrites.push(resolve))
    if (state.failWrites) throw new Error('Fixture workboard storage is read-only')
    const disk = diskNow()
    if (command === 'fs_create_dir') {
      const directory = `${normalize(String(args.parent))}/${args.name}`
      if (!disk.directories.includes(key(normalize(String(args.parent)), host))) throw new Error('Parent directory does not exist')
      if (disk.directories.includes(key(directory, host))) throw new Error('Directory already exists')
      disk.directories.push(key(directory, host))
      saveDisk(disk)
      return directory
    }
    if (command === 'fs_write_file') {
      if (!disk.directories.includes(key(parent(path), host))) throw new Error('Parent directory does not exist')
      disk.files[key(path, host)] = args.content
      saveDisk(disk)
      return null
    }
    const destination = `${parent(path)}/${args.newName}`
    const content = disk.files[key(path, host)]
    if (content === undefined) throw new Error('Source file does not exist')
    if (disk.files[key(destination, host)] !== undefined) throw new Error('Destination file already exists')
    disk.files[key(destination, host)] = content
    delete disk.files[key(path, host)]
    saveDisk(disk)
    return destination
  }
  return originalInvoke(command, payload, options)
}

export {}
