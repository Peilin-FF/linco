import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { I18nProvider } from '../../src/lib/i18n'
import LatexView from '../../src/components/LatexView'
import '../../src/index.css'

const query = new URLSearchParams(location.search)
let text = '\\documentclass{article}\n\\begin{document}\nBatch 8; seed 1.\n\\end{document}\n'
const info = { connected: true, remote_name: 'overleaf', remote_url: 'https://overleaf.example.invalid/test', project_id: 'test', branch: 'main', dirty: false, ahead: 1, behind: 1 }
const state = { pulls: 0, publishes: 0, polls: 0, remoteHead: 'b'.repeat(40), resolve: false, commands: [] as string[] }
Object.assign(window, { paperSyncTest: state })
localStorage.setItem('linco:latex:local:/paper:liveCollaboration', query.has('live') ? 'on' : 'off')
mockIPC(async (command, payload) => {
  const args = payload as Record<string, string>
  state.commands.push(command)
  if (command === 'fs_list_dir') return [{ name: 'main.tex', path: args.path + '/main.tex', is_dir: false }]
  if (command === 'fs_read_file') return args.path.startsWith('/another') ? 'Another paper.' : text
  if (command === 'fs_write_file') { text = args.content; return null }
  if (command === 'overleaf_project_info') return args.repo === '/another' ? { ...info, connected: false } : { ...info }
  if (command === 'plugin:event|listen') return 1
  if (command === 'plugin:event|unlisten') return null
  if (command === 'overleaf_sync_capabilities') {
    if (query.has('old')) throw new Error('Command overleaf_sync_capabilities not found')
    return 1
  }
  if (command === 'overleaf_collaboration_poll') {
    state.polls++
    return { remote_head: state.remoteHead, remote_updated: true, incoming: info.behind > 0, applied: false, pending: info.behind > 0, info: { ...info } }
  }
  if (command === 'overleaf_collaboration_apply') return { remote_head: state.remoteHead, remote_updated: false, incoming: true, applied: false, pending: true, info: { ...info } }
  if (command === 'overleaf_pull' || command === 'overleaf_publish') {
    if (command === 'overleaf_pull') state.pulls++; else state.publishes++
    if (query.has('slow')) await new Promise(resolve => setTimeout(resolve, 1500))
    if (query.has('auth')) throw new Error('OVERLEAF_AUTH_REQUIRED: Enter your token')
    if (!state.resolve && query.has('pending')) throw new Error(`OVERLEAF_SYNC_PENDING: ${'a'.repeat(40)} ${state.remoteHead}. Both versions are saved.`)
    text = text.replace('seed 1', 'seed 2')
    info.behind = 0
    if (command === 'overleaf_publish') info.ahead = 0
    return { ...info }
  }
  throw new Error(`Unexpected test command: ${command}`)
})

function Harness() {
  const [cwd, setCwd] = useState('/paper')
  return <I18nProvider initial="en"><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => setCwd('/another')}>Switch fixture project</button>
    <LatexView cwd={cwd} active />
  </div></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>)
