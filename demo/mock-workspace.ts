// Synthetic workspace shared by the public demo and browser regression tests.
// Imported only by their separate entry points, never by the desktop app.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { editGarden, readGarden, saveGarden } from './garden'
import { demoFiles, listDemoFiles, readDemoFile } from './files'
import { DemoChanges } from './changes'
import { invalidateShadowDiff } from '../src/lib/shadow'
import { invalidateFile } from '../src/lib/fs'

const isDemo = import.meta.env.MODE === 'demo'
const params = new URLSearchParams(isDemo ? 'research&files&logs' : location.search)
const project = 'C:\\Projects\\linco'
let config = {
  agents: [{ id: 'codex', name: 'Codex', provider: 'openai', command: 'codex', api_key: '', base_url: '', model: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'], permission: 'default', effort: 'high', auth_mode: 'subscription' }],
  default_agent: 'codex', auto_start: true, cwd: params.has('empty') ? '' : project,
  recent_dirs: [project, 'C:\\Projects\\website'], connections: [], active_connection: '',
  language: params.get('lang') || 'en', plugin_agent: 'skip', theme: params.get('theme') || '',
  ui_font_size: Number(params.get('font-size') || 0),
}
const calls: { cmd: string; args: any }[] = []
if (params.has('persist-theme')) config.theme = localStorage.getItem('fixture:saved-theme') || config.theme
if (isDemo) {
  try { config.theme = localStorage.getItem('linco:demo:theme:v1') || '' } catch { /* Optional preference. */ }
}
let failConfigSave = false
let finishDirectory: ((path: string) => void) | undefined
let historyHeld = params.has('delay-history')
const historyWaiters: (() => void)[] = []
let taskLog = [
  '=== Baseline experiment ===',
  '[INFO] Reading dataset',
  'step=40 loss: 0.194 reward=0.81',
  '[WARNING] Evaluation set contains only 12 examples',
  '\x1b[31m[ERROR] Worker retry required\x1b[0m',
  '[state-dump] CoreWorkerService time: 0.00ms total=200',
  'Downloading 10%\rDownloading 80%\rDownloading 100%',
  '<img src=x onerror=alert(1)>',
  'Completed baseline evaluation',
  '',
].join('\n')
const notionPages = new Map<string, { title: string; content: string; properties?: Record<string, any> }>()
const researchRows = new Map<string, Record<string, any>[]>()
let nextNotionId = 1
const newNotionId = () => (nextNotionId++).toString(16).padStart(32, '0')
const journalSource = '12345678-1234-1234-1234-123456789abc'
const journalSchema = JSON.stringify({ schema: { Name: { type: 'title' }, Kind: { type: 'select', options: [{ name: 'Idea' }, { name: 'Research' }, { name: 'Experiment' }, { name: 'Conclusion' }] }, Status: { type: 'select', options: [{ name: 'Draft' }] }, Recorded: { type: 'date' } } })
if (params.has('research')) {
  const url = (n: number) => `https://www.notion.so/${n.toString(16).padStart(32, '0')}`
  const sources: Record<string, { url: string; source: string }> = {}
  const titles: Record<string, string> = { projects: 'Projects', journal: 'Research journal', milestones: 'Milestones', literature: 'Literature', runs: 'Runs' }
  for (const [index, name] of Object.keys(titles).entries()) {
    const id = (101 + index).toString(16).padStart(32, '0')
    const source = `12345678-1234-1234-1234-${(101 + index).toString(16).padStart(12, '0')}`
    sources[name] = { url: url(101 + index), source }
    const schema = { Name: { type: 'title' }, Question: { type: 'text' }, Outcome: { type: 'text' }, 'Next step': { type: 'text' }, Project: { type: 'relation' }, 'Checkpoint ID': { type: 'text' }, 'Scope and limits': { type: 'text' }, Recorded: { type: 'date' }, 'Target dates': { type: 'date' }, Kind: { type: 'select', options: ['Idea', 'Research', 'Experiment', 'Conclusion'].map(name => ({ name })) }, Status: { type: 'select', options: ['Draft', 'Planned', 'Active', 'Needs review', 'Validated', 'Disputed', 'Superseded'].map(name => ({ name })) }, Stage: { type: 'select', options: [{ name: 'Framing' }] }, Scope: { type: 'select', options: [{ name: 'Research' }] } }
    notionPages.set(id, { title: titles[name], content: `<database><data-source-state>${JSON.stringify({ url: `collection://${source}`, schema })}</data-source-state></database>` })
    researchRows.set(source, [])
  }
  const add = (source: string, n: number, properties: Record<string, any>, content: string) => {
    const value = { ...properties, url: url(n) }
    researchRows.get(sources[source].source)!.push(value)
    notionPages.set(n.toString(16).padStart(32, '0'), { title: properties.Name, content, properties })
  }
  add('projects', 201, { Name: 'Memory study', Question: 'Can a new agent resume our experiments?', 'Next decision': 'Compare a fresh session against the saved evidence.', Stage: 'Investigating' }, 'Current understanding: evidence must stay linked to conclusions.')
  add('projects', 202, { Name: 'Reading tools', Question: 'How can annotations become useful ideas?', Stage: 'Framing' }, 'This is a separate project.')
  add('milestones', 301, { Name: 'Reproduce the baseline', Status: 'Active', Outcome: 'A rerunnable command and a verified log.', Project: JSON.stringify([url(201)]) }, 'Baseline protocol')
  add('milestones', 302, { Name: 'Compare annotation workflows', Status: 'Planned', Project: JSON.stringify([url(202)]) }, 'Reading project milestone')
  add('journal', 401, { Name: 'Baseline exploration', Kind: 'Experiment', Status: 'Draft', Project: JSON.stringify([url(201)]), 'Next step': 'Inspect the log before drawing a conclusion.', 'date:Recorded:start': '2026-09-07' }, 'We ran a baseline. The log is missing; this is not validated evidence.')
  add('journal', 402, { Name: 'Keep scope with the evidence', Kind: 'Conclusion', Status: 'Validated', Project: JSON.stringify([url(201)]), 'Next step': 'Revisit when the dataset changes.' }, 'Reviewed for this dataset only. No universal claim.')
  add('journal', 403, { Name: 'Private reading-project note', Kind: 'Research', Status: 'Draft', Project: JSON.stringify([url(202)]) }, 'This content must not enter the other project briefing.')
  add('journal', 404, { Name: 'Old interpretation', Kind: 'Conclusion', Status: 'Superseded', Project: JSON.stringify([url(201)]) }, 'This conclusion is superseded, not current knowledge.')
  add('literature', 501, { Name: 'How to Read a Paper', Status: 'Reading', Project: JSON.stringify([url(201)]) }, 'A reading note.')
  add('runs', 601, { Name: 'Baseline run', Status: 'Inconclusive', Project: JSON.stringify([url(201)]), Observation: 'Missing log; no conclusion.' }, 'Agent reported, not independently verified.')
  notionPages.set((100).toString(16).padStart(32, '0'), { title: 'Research Studio', content: Object.entries(sources).map(([key, value]) => `<database url="${value.url}" data-source-url="collection://${value.source}">${titles[key]}</database>`).join('\n') })
  const researchKey = `linco:notion:page:v1:${JSON.stringify(['local', project])}`
  if (!params.has('research-config') && !localStorage.getItem(`${researchKey}:research:v1`)) localStorage.setItem(`${researchKey}:research:v1`, JSON.stringify({ version: 1, home: url(100), sources, opened: [] }))
}
const savedFiles = new Map<string, string>()
const demoInput = new Map<string, string>()
export function demoNotice(message: string) { window.dispatchEvent(new CustomEvent('linco:demo-notice', { detail: message })) }
let notion: { url: string; title: string; loading: boolean } | null = null
const generations = new Map<string, number>()
Object.assign(window, { __terminalOutput: (id: string, text: string) => emit('term-output', {
  id, gen: generations.get(id), data: btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}) })
const fileContent = 'export function Welcome() {\n  return <h1>Make something wonderful.</h1>\n}\n'
const fileFixtures: Record<string, string[]> = {
  '': ['scripts/', 'tests/', 'experiments/', 'docs/', 'data/', 'src/', '.gitignore', 'README.md', 'index.html', 'requirements_qwen3.5.txt', 'package.json', 'config.yaml', 'plot.png'],
  scripts: ['train.py', 'evaluate.py', 'run.sh'],
  tests: ['unit/', 'test_causal_event_order.py', 'test_consensus_guard.py'],
  'tests/unit': ['test_state.py'],
  experiments: ['baseline.ipynb', 'conclusions.md'],
  docs: ['thesis.tex', 'references.bib', 'paper.pdf'],
  data: ['results.csv', 'events.jsonl'],
  src: ['Welcome.tsx', 'app.ts', 'main.py'],
}
const normalizedProject = project.replaceAll('\\', '/')
const relativeFile = (path: string) => path.replaceAll('\\', '/').replace(normalizedProject, '').replace(/^\/+/, '')
const snapshot = () => {
  const files = Object.fromEntries(Object.keys(demoFiles).map(path => [path, readDemoFile(path)]))
  for (const [path, text] of savedFiles) files[relativeFile(path)] = text
  return files
}
const demoChanges = new DemoChanges(snapshot(), snapshot)
export const getDemoReview = () => Object.keys(demoChanges.changes()).map(path => ({ path, diff: demoChanges.diff(path) }))
function notifyFiles(paths: string[]) {
  invalidateShadowDiff(project)
  for (const path of paths) {
    invalidateFile(`${project}/${path}`)
    invalidateFile(`${normalizedProject}/${path}`)
  }
  void emit('remote-fs-change', { host: '', paths: paths.map(path => `${normalizedProject}/${path}`) })
  window.dispatchEvent(new Event('linco:demo-changes'))
}
const pythonContent = '# Reproducible experiment\nfrom pathlib import Path\n\nSEED = 42\nOUTPUT = Path("results")\n\ndef run_experiment(seed: int = SEED):\n    """Record a baseline before changing the method."""\n    OUTPUT.mkdir(exist_ok=True)\n    print(f"Running baseline with seed {seed}")\n\nif __name__ == "__main__":\n    run_experiment()\n'
Object.assign(window, { __workbench: { calls, getConfig: () => config, notionPages, researchRows,
  failConfigSaves: (fail: boolean) => { failConfigSave = fail },
  finishDirectory: (path: string) => { finishDirectory?.(path) },
  holdHistory: () => { historyHeld = true },
  releaseHistory: () => { historyHeld = false; historyWaiters.splice(0).forEach(resolve => resolve()) },
  setTaskLog: (text: string) => { taskLog = text } } })
mockWindows('main')
mockIPC(async (cmd, payload) => {
  const args = (payload || {}) as Record<string, any>
  calls.push({ cmd, args })
  switch (cmd) {
    case 'notion_connection':
      if (params.has('notion-old-backend')) throw new Error('Command notion_connection not found')
      return { connected: !params.has('notion-disconnected'), toolCount: 42, host: 'local' }
    case 'notion_tool': {
      if (params.has('notion-disconnected')) throw new Error('Local Notion connection is unavailable')
      const input = args.arguments
      let result: any
      switch (args.tool) {
        case 'notion-fetch': {
          const id = String(input.id).replaceAll('-', '').match(/[a-f0-9]{32}/i)?.[0]
          const saved = notionPages.get(id || '')
          result = { title: saved?.title || 'Project feedback', text: saved?.content.startsWith('<database>') ? saved.content : `${saved?.properties ? `<properties>${JSON.stringify(saved.properties)}</properties>` : ''}<content>${saved?.content || 'Saved feedback: keep the notebook compact.'}</content>` }
          break
        }
        case 'notion-create-pages':
          if (params.has('notion-write-error') && input.parent?.data_source_id) throw new Error('Creation timed out. Check Notion before retrying.')
          result = { pages: input.pages.map((item: any) => {
            const id = newNotionId()
            notionPages.set(id, { title: item.properties.title || item.properties.Name, content: item.content, properties: item.properties })
            if (researchRows.has(input.parent?.data_source_id)) researchRows.get(input.parent.data_source_id)!.push({ ...item.properties, url: `https://www.notion.so/${id}` })
            return { id, url: `https://www.notion.so/${id}` }
          }) }
          break
        case 'notion-create-database': {
          const id = newNotionId()
          notionPages.set(id, { title: 'Research journal', content: `<database><data-source-state>${journalSchema}</data-source-state></database>` })
          result = { result: `<database url="https://www.notion.so/${id}"><data-source url="collection://${journalSource}" /></database>` }
          break
        }
        case 'notion-create-view': result = { result: `view://12345678-1234-1234-1234-${newNotionId().slice(-12)}` }; break
        case 'notion-query-data-sources': {
          let rows = researchRows.get(input.data.data_source_url.replace('collection://', '')) || []
          for (const filter of input.data.filter?.filters || []) {
            if (filter.operator === 'relation_contains') {
              const id = filter.value.value.replaceAll('-', '').match(/[a-f0-9]{32}/i)?.[0]
              rows = rows.filter(row => id && String(row[filter.property]).replaceAll('-', '').includes(id))
            }
            if (filter.operator === 'string_is') rows = rows.filter(row => row[filter.property] === filter.value.value)
          }
          result = { results: rows.slice(0, input.data.limit), has_more: rows.length > input.data.limit }
          break
        }
        default: throw new Error('Unexpected Notion tool in test')
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
    case 'notion_open':
      if (params.has('notion-error')) throw new Error('Native browser unavailable')
      if (!notion || args.navigate) notion = { url: args.url, title: 'Notion', loading: false }
      return null
    case 'notion_status': return notion
    case 'notion_layout': case 'notion_action': return null
    case 'load_config': return config
    case 'save_config':
      if (failConfigSave) throw new Error('Test settings disk unavailable')
      config = args.config
      if (params.has('persist-theme')) localStorage.setItem('fixture:saved-theme', config.theme)
      if (isDemo) {
        try { localStorage.setItem('linco:demo:theme:v1', config.theme) } catch { /* Optional preference. */ }
      }
      return null
    case 'plugin:dialog|open':
      if (params.has('delay-directory')) return new Promise<string>(resolve => { finishDirectory = resolve })
      return 'C:\\Projects\\website'
    case 'plugin:window|is_maximized': return false
    case 'agent_tasks': return params.has('logs') ? [{ pid: 42001, args: 'python -u train.py', file: 'C:/Projects/linco/runs/train.log', etime: '02:10' }] : []
    case 'tail_file': {
      if (params.has('log-error')) throw new Error('Output file temporarily unavailable')
      const bytes = new TextEncoder().encode(taskLog)
      const start = args.offset > bytes.length ? 0 : args.offset
      return { data: new TextDecoder().decode(bytes.slice(start)), start, size: bytes.length }
    }
    case 'ssh_config_hosts': case 'agent_processes':
    case 'git_branches': case 'git_log': case 'git_stash_list': case 'list_plugins': return []
    case 'agent_sessions':
      if (historyHeld) await new Promise<void>(resolve => historyWaiters.push(resolve))
      if (params.has('history-error')) throw new Error('History unavailable')
      if (params.has('history-empty')) return []
      return [
      { id: 'session-a', title: 'Build the project workspace', mtime: Date.now() / 1000 - 1800, size: 1000 },
      { id: 'session-b', title: 'Polish the preview experience', mtime: Date.now() / 1000 - 7200, size: 1000 },
      { id: 'session-c', title: 'Explore the codebase', mtime: Date.now() / 1000 - 86400, size: 1000 },
    ]
    case 'fs_list_dir': {
      if (params.has('files')) {
        const relative = String(args.path).replaceAll('\\', '/').replace(normalizedProject, '').replace(/^\/+|\/+$/g, '')
        return (isDemo ? listDemoFiles(relative) : fileFixtures[relative] || []).map((entry) => {
          const name = entry.replace(/\/$/, '')
          return { name, path: `${args.path}/${name}`, is_dir: entry.endsWith('/') }
        })
      }
      return [
      { name: 'Welcome.tsx', path: `${args.path}/Welcome.tsx`, is_dir: false },
      { name: 'package.json', path: `${args.path}/package.json`, is_dir: false },
      ]
    }
    case 'fs_write_file':
      savedFiles.set(args.path, args.content)
      if (isDemo) notifyFiles([relativeFile(String(args.path))])
      if (isDemo && String(args.path).endsWith('/garden.json')) {
        try { saveGarden(args.content) } catch {
          demoNotice('Sample file saved, but its JSON is invalid. The preview keeps the last valid garden; fix the file and save again.')
          return null
        }
      }
      if (isDemo) demoNotice('Saved to demo memory only. Reload to reset; no files on your computer were changed.' + (String(args.path).endsWith('/garden.json') ? '' : ' Only src/garden.json updates the preview; source examples are not compiled or executed.'))
      return null
    case 'fs_read_file':
      if (savedFiles.has(args.path)) return savedFiles.get(args.path)
      if (isDemo && String(args.path).endsWith('/garden.json')) return JSON.stringify(readGarden(), null, 2) + '\n'
      if (params.has('research-config') && String(args.path).endsWith('/.linco/research/workspace.json')) return JSON.stringify({ version: 1, home: `https://www.notion.so/${(100).toString(16).padStart(32, '0')}`, project: `https://www.notion.so/${(201).toString(16).padStart(32, '0')}` })
      if (isDemo) return readDemoFile(relativeFile(String(args.path)))
      if (params.has('files') && String(args.path).endsWith('.sh')) return '# Baseline experiment\nexport SEED=42\nif [ -d outputs ]; then\n  echo "Checkpoint ready"\nfi\n'
      return params.has('files') && String(args.path).endsWith('.py') ? pythonContent : fileContent
    case 'search_content': return params.has('files') ? ['scripts/train.py', 'index.html', 'README.md'].map((file) => ({ path: `${normalizedProject}/${file}`, matches: [{ line: 1, text: 'baseline checkpoint', ranges: [[0, 8]] }] })) : []
    case 'git_status': return { is_repo: true, branch: 'main', ahead: 0, behind: 0, files: (isDemo ? Object.keys(demoChanges.changes('git')) : params.has('files') ? ['scripts/train.py', 'index.html', 'README.md'] : []).map(path => ({ path, work: 'M', index: ' ', staged: false, unstaged: true, untracked: false })) }
    case 'git_is_repo': return true
    case 'git_remote_url': return { url: '', slug: '' }
    case 'shadow_begin_turn':
      if (isDemo) { demoChanges.beginTurn(); notifyFiles(Object.keys(demoFiles)) }
      return null
    case 'git_diff_file': case 'shadow_diff': return isDemo ? demoChanges.diff(relativeFile(String(args.path)), cmd === 'git_diff_file' ? 'git' : 'turn') : ''
    case 'shadow_changed': return isDemo ? Object.fromEntries(Object.entries(demoChanges.changes()).map(([path, status]) => [`${normalizedProject}/${path}`, status])) : params.has('files') ? { [`${normalizedProject}/scripts/train.py`]: 'M', [`${normalizedProject}/tests/test_causal_event_order.py`]: 'A' } : {}
    case 'preview_start': return 1431
    case 'preview_default_target': return null
    case 'term_write': {
      if (!isDemo) return null
      const text = String(args.data).replace(/\x1b\[20[01]~/g, '')
      const prompt = (demoInput.get(args.id) || '') + text
      demoInput.set(args.id, prompt.slice(-8000))
      if (!text.includes('\r')) return null
      demoInput.set(args.id, '')
      const result = editGarden(prompt)
      if (result.startsWith('Updated')) for (const path of savedFiles.keys()) if (path.endsWith('/garden.json')) savedFiles.delete(path)
      notifyFiles(['src/garden.json'])
      setTimeout(() => {
        void emit('term-output', { id: args.id, gen: generations.get(args.id), data: btoa(
          '\r\n\x1b[36m[Scripted demo response]\x1b[0m\r\n' +
          result + '\r\n' +
          '\x1b[32m1.\x1b[0m Open Code > Files and inspect src/garden.json.\r\n' +
          '\x1b[32m2.\x1b[0m Switch to Terminal to scan a sample run log.\r\n' +
          '\x1b[32m3.\x1b[0m Open Notes to explore projects and milestones.\r\n\r\n' +
          'The desktop app runs your configured CLI agent for real work.\r\n'
        ) })
        demoNotice('Scripted response shown. No AI model was called and no commands were executed.')
      }, 300)
      return null
    }
    case 'ssh_connect': case 'ssh_add_host': case 'git_push': case 'git_pull': case 'git_apply_credentials':
      if (isDemo) throw new Error('Desktop-only action: the demo does not connect to servers or accounts.')
      return null
    case 'term_start': {
      const gen = (generations.get(args.id) || 0) + 1
      generations.set(args.id, gen)
      setTimeout(() => void emit('term-output', { id: args.id, gen, data: btoa(
        isDemo ? '\r\n  \x1b[1mLet\'s build Pocket Garden.\x1b[0m\r\n\r\n' +
          '  \x1b[32mCompleted\x1b[0m  Set up the little garden\r\n' +
          '  \x1b[32mCompleted\x1b[0m  Connect its live preview\r\n\r\n' +
          '  Try: Add a sunflower\r\n' +
          '  Or:  Make it midnight\r\n\r\n' +
          '  Prefer a precise change?\r\n' +
          '  Open Code > src/garden.json.\r\n\r\n' +
          '  This agent is a scripted demo.\r\n' :
        '\r\n  \x1b[1mLinco workspace\x1b[0m\r\n\r\n' +
        '  Build the project workspace\r\n\r\n' +
        '  I will start by exploring the app structure.\r\n' +
        '  Then we can shape the interface together.\r\n\r\n' +
        '  \x1b[32mCompleted\x1b[0m  Read the project files\r\n' +
        '  \x1b[32mCompleted\x1b[0m  Identify the main components\r\n\r\n' +
        '  Your workspace is ready. What would you like to build?\r\n\r\n'
      ) }), 80)
      return gen
    }
    default: return null
  }
}, { shouldMockEvents: true })
