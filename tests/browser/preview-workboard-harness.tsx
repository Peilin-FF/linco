// This test entry point mounts the native component; its filesystem mock is
// deliberately persistent so a page reload exercises reading saved events.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { I18nProvider } from '../../src/lib/i18n'
import { applyTheme } from '../../src/lib/theme'
import { appendWorkboardEvent } from '../../src/lib/previewWorkboard'
import PreviewWorkboard from '../../src/components/PreviewWorkboard'
import ScreenView from '../../src/components/ScreenView'
import '../../src/index.css'

type Disk = { directories: string[]; files: Record<string, string> }
type Call = { command: string; args: Record<string, string> }
const query = new URLSearchParams(location.search)
const storageKey = 'fixture:preview-workboard:disk:v1'
const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')
const key = (path: string, host = '') => `${host}|${normalize(path)}`
const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))
const readDisk = (): Disk => JSON.parse(localStorage.getItem(storageKey) || '{"directories":[],"files":{}}')
const saveDisk = (disk: Disk) => localStorage.setItem(storageKey, JSON.stringify(disk))
const state = {
  calls: [] as Call[],
  opened: [] as string[],
  submitted: [] as string[],
  failWrites: false,
  failEventWrites: false,
  disk: readDisk,
  addNotebookCell: (relativePath: string, cell: Record<string, unknown>) => {
    const disk = readDisk()
    const fileKey = key(`C:/Projects/alpha/${relativePath}`)
    const source = disk.files[fileKey]
    if (!source) throw new Error('The action notebook does not exist')
    const seed = /(<script\b[^>]*\bid=["']seed["'][^>]*>)([\s\S]*?)(<\/script>)/i
    if (!seed.test(source)) throw new Error('The action notebook has no editable seed')
    disk.files[fileKey] = source.replace(seed, (_match, start, content, end) => {
      const cells = JSON.parse(content)
      cells.push(cell)
      return `${start}\n${JSON.stringify(cells, null, 2)}\n${end}`
    })
    saveDisk(disk)
    return disk.files[fileKey]
  },
  publishHistory: async (count: number) => {
    const created = Object.entries(readDisk().files)
      .filter(([path]) => path.startsWith('|C:/Projects/alpha/.linco/workboard/events/') && path.endsWith('.json'))
      .map(([, content]) => JSON.parse(content)).find(event => event.type === 'create')
    if (!created) throw new Error('Create a fixture outcome before publishing history')
    for (let index = 1; index <= count; index++) {
      await appendWorkboardEvent('C:\\Projects\\alpha', { taskId: created.taskId, actor: 'agent', type: 'note', note: `Persisted adjustment ${index}` })
    }
  },
  publishAgentProgress: async (summary: string) => {
    const disk = readDisk()
    const directory = 'C:/Projects/alpha/.linco/workboard/events'
    const saved = Object.entries(disk.files).filter(([path]) => path.startsWith(key(directory) + '/') && path.endsWith('.json'))
      .map(([, content]) => JSON.parse(content))
    const taskId = saved.find(event => event.type === 'create')?.taskId
    if (!taskId) throw new Error('Create a fixture outcome before publishing external progress')
    const id = crypto.randomUUID()
    const at = new Date(Math.max(Date.now(), ...saved.map(event => Date.parse(event.at) + 1))).toISOString()
    disk.files[key(`${directory}/${id}.json`)] = JSON.stringify({ version: 1, id, taskId, at, actor: 'agent', type: 'update', patch: { summary } })
    saveDisk(disk)
    await emit('remote-fs-change', { host: '', paths: [`${directory}/${id}.json`] })
  },
}
for (const host of ['', 'remote-a']) {
  for (const root of ['C:/Projects/alpha', 'C:/Projects/beta']) {
    const disk = readDisk()
    if (disk.directories.includes(key(root, host))) continue
    disk.directories.push(key(root, host), key(`${root}/artifacts`, host), key(`${root}/artifacts/nested`, host))
    disk.files[key(`${root}/index.html`, host)] = '<!doctype html><title>Project home</title><h1>Current project preview</h1>'
    disk.files[key(`${root}/artifacts/first-proposal.html`, host)] = '<!doctype html><title>First proposal</title><h1>A useful project result</h1>'
    disk.files[key(`${root}/artifacts/nested/experiment.html`, host)] = '<!doctype html><title>Experiment</title><h1>Alternative approach</h1>'
    disk.files[key(`${root}/artifacts/notes.md`, host)] = 'An ordinary note, not a preview artifact.'
    saveDisk(disk)
  }
}

Object.assign(window, { previewWorkboardTest: state })
mockIPC(async (command, payload) => {
  const args = (payload || {}) as Record<string, string>
  state.calls.push({ command, args })
  const host = args.host || ''
  const path = normalize(args.path || '')
  const disk = readDisk()
  if (command === 'preview_start') return Number(location.port)
  if (command === 'preview_set_target' || command === 'preview_prefetch_assets' || command === 'preview_prefetch_file') return null
  if (command === 'fs_list_dir') {
    if (!disk.directories.includes(key(path, host))) throw new Error(`Directory does not exist: ${path}`)
    return [
      ...disk.directories.filter(entry => entry.startsWith(`${host}|`)).map(entry => ({ path: entry.slice(host.length + 1), is_dir: true })),
      ...Object.keys(disk.files).filter(entry => entry.startsWith(`${host}|`)).map(entry => ({ path: entry.slice(host.length + 1), is_dir: false })),
    ].filter(entry => parent(entry.path) === path).map(entry => ({ ...entry, name: entry.path.slice(path.length + 1) }))
  }
  if (command === 'fs_read_file') {
    const content = disk.files[key(path, host)]
    if (content === undefined) throw new Error(`File does not exist: ${path}`)
    return content
  }
  if (command === 'fs_create_dir') {
    const directory = `${normalize(args.parent)}/${args.name}`
    if (!disk.directories.includes(key(normalize(args.parent), host))) throw new Error('Parent directory does not exist')
    if (disk.directories.includes(key(directory, host))) throw new Error('Directory already exists')
    disk.directories.push(key(directory, host))
    saveDisk(disk)
    return directory
  }
  if (command === 'fs_write_file') {
    if (state.failWrites) throw new Error('Fixture disk is read-only')
    if (state.failEventWrites && path.includes('/.linco/workboard/events/')) throw new Error('Fixture event publication failed')
    if (!disk.directories.includes(key(parent(path), host))) throw new Error('Parent directory does not exist')
    disk.files[key(path, host)] = args.content
    saveDisk(disk)
    return null
  }
  if (command === 'fs_rename') {
    if (state.failWrites) throw new Error('Fixture disk is read-only')
    const destination = `${parent(path)}/${args.newName}`
    const content = disk.files[key(path, host)]
    if (content === undefined) throw new Error('Source file does not exist')
    if (disk.files[key(destination, host)] !== undefined) throw new Error('Destination file already exists')
    disk.files[key(destination, host)] = content
    delete disk.files[key(path, host)]
    saveDisk(disk)
    return destination
  }
  if (command === 'fs_search') {
    const root = `${normalize(args.root)}/`
    return Object.keys(disk.files).filter(entry => entry.startsWith(`${host}|${root}`)).map(entry => entry.slice(host.length + 1))
      .filter(entry => entry.toLowerCase().includes(args.query.toLowerCase()))
      .map(entry => ({ path: entry, name: entry.slice(entry.lastIndexOf('/') + 1), is_dir: false }))
  }
  throw new Error(`Unexpected workboard command: ${command}`)
}, { shouldMockEvents: true })

function Harness() {
  const [cwd, setCwd] = useState('C:\\Projects\\alpha')
  const [host, setHost] = useState<string | undefined>()
  const [opened, setOpened] = useState('')
  return <I18nProvider initial={query.get('lang') || 'en'}>
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <nav aria-label="Fixture controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 8 }}>
        <button onClick={() => setCwd(value => value.endsWith('alpha') ? 'C:\\Projects\\beta' : 'C:\\Projects\\alpha')}>Switch fixture project</button>
        <button onClick={() => setHost(value => value ? undefined : 'remote-a')}>Switch fixture host</button>
        <button onClick={() => void emit('remote-fs-change', { host: host || '', paths: [normalize(cwd) + '/.linco/workboard/events'] })}>Notify external change</button>
        <output aria-label="Opened artifact">{opened}</output>
      </nav>
      {query.has('screen') ? <ScreenView cwd={cwd} host={host} onSubmitToAgent={prompt => { state.submitted.push(prompt) }} /> :
        <PreviewWorkboard cwd={cwd} host={host} onOpenArtifact={path => { state.opened.push(path); setOpened(path) }}
          onSubmitToAgent={prompt => { state.submitted.push(prompt) }} />}
    </main>
  </I18nProvider>
}
applyTheme(query.get('theme') || 'linco-light')
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>)
