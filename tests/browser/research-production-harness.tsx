import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC, mockConvertFileSrc } from '@tauri-apps/api/mocks'
import ResearchProduction, { usePaperResearch } from '../../src/components/ResearchProduction'
import type { ResearchPacket } from '../../src/lib/researchProduction'
import '../../src/index.css'

const calls: { command: string; args: Record<string, unknown> }[] = []
let resultText = 'method,score\nbaseline,12\nours,15\n'
let holdCapture = false
let release: (() => void) | undefined
Object.assign(window, {
  researchCalls: () => calls,
  changeResults: (text: string) => { resultText = text },
  holdCapture: () => { holdCapture = true },
  releaseCapture: () => { release?.(); holdCapture = false }
})
mockConvertFileSrc('windows')
mockIPC(async (command, raw) => {
  const args = (raw || {}) as Record<string, unknown>
  if (command === 'load_config') {
    return {
      agents: [], default_agent: '', auto_start: false, cwd: '', recent_dirs: [],
      connections: [
        { id: 'conn-remote-a', name: 'remote-a', host: 'remote-a', cwd: '/research', identity: '', recentDirs: [], httpProxy: '' },
        { id: 'conn-remote-b', name: 'remote-b', host: 'remote-b', cwd: '/research', identity: '', recentDirs: [], httpProxy: '' }
      ],
      active_connection: 'conn-remote-a', language: 'en'
    }
  }
  calls.push({ command, args })
  if (command === 'research_capture') {
    if (holdCapture) await new Promise<void>(resolve => { release = resolve })
    const paths = args.paths as string[]
    const sources = await Promise.all(paths.map(async path => {
      const text = path.endsWith('.csv') ? resultText : 'learning_rate = 0.001\n'
      const bytes = new TextEncoder().encode(text)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return { path, text, bytes: bytes.length, sha256: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') }
    }))
    const packet: ResearchPacket = { version: 1, directory: 'C:/fixture/research-1', repo: String(args.repo), host: String(args.host), capturedAt: 1788960000, sources }
    localStorage.setItem('test-research-packet', JSON.stringify(packet))
    return packet
  }
  if (command === 'research_load') return JSON.parse(localStorage.getItem('test-research-packet') || 'null')
  if (command === 'research_save_figure') return 'C:/fixture/figure-1'
  if (command === 'research_powerpoint') return { previewPath: 'C:/fixture/figure-preview.png', presentationPath: 'C:/fixture/figure.pptx', saved: args.save }
  throw new Error(`Unexpected test command: ${command}`)
})

function Harness() {
  const [host, setHost] = useState('remote-a')
  const [visible, setVisible] = useState(true)
  const { context, update } = usePaperResearch(host, '/paper', '/research')
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 8, fontSize: 12 }}>Local interaction test · synthetic values, no network or model calls. <button onClick={() => setHost(h => h === 'remote-a' ? 'remote-b' : 'remote-a')}>Switch host</button> <button onClick={() => setVisible(v => !v)}>Toggle workbench</button></div>
    <div style={{ flex: 1, minHeight: 0, maxWidth: 760, width: '100%', margin: '0 auto' }}>
      {visible && <ResearchProduction context={context} onContext={update} passage="Our method improves the measured score." />}
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>)
