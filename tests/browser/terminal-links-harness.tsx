import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { I18nProvider } from '../../src/lib/i18n'
import TerminalView from '../../src/components/TerminalView'
import '../../src/index.css'

const state = {
  opened: [] as string[], copied: '', failOpen: false, failCopy: false,
  columns: 0, rows: 0, ready: false, starts: 0, writes: [] as string[]
}
const output = [
  'Links in agent conversations',
  'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
  '\x1b]8;;https://visualstudio.microsoft.com/visual-cpp-build-tools/\x07Microsoft installer\x1b]8;;\x07',
  '[Markdown](https://example.com/paper?q=alpha&n=1).',
  '\x1b]8;;file:///C:/Windows/notepad.exe\x07Unsupported file link\x1b]8;;\x07',
  'Unicode before link: \u7814\u7a76 \ud83d\udd2c https://example.com/unicode',
  'https://example.com/' + 'long-path/'.repeat(18) + '?q=wrapped',
  'Select this text without opening a browser.'
].join('\r\n')
Object.assign(window, {
  isTauri: true,
  terminalLinkTest: state,
  enableAgentMouseReporting: async () => {
    await emit('term-output', { id: 'chat:link-test', gen: 1, data: btoa('\x1b[?1000h\x1b[?1006h') })
  },
  rewriteTerminalLinks: async () => {
    await emit('term-output', { id: 'chat:link-test', gen: 1, data: btoa(unescape(encodeURIComponent('\x1b[2J\x1b[H' + output))) })
  }
})
mockIPC((command, payload) => {
  const args = payload as Record<string, unknown>
  if (command === 'term_start') {
    state.starts++
    state.columns = Number(args.cols)
    state.rows = Number(args.rows)
    window.setTimeout(() => {
      void emit('term-output', { id: 'chat:link-test', gen: 1, data: btoa(unescape(encodeURIComponent(output))) })
      state.ready = true
    }, 100)
    return 1
  }
  if (command === 'term_resize') { state.columns = Number(args.cols); state.rows = Number(args.rows); return }
  if (command === 'term_write') { state.writes.push(String(args.data)); return }
  if (command === 'plugin:shell|open') {
    if (state.failOpen) throw new Error('Simulated browser-opening failure')
    state.opened.push(String(args.path))
    return
  }
  if (command === 'plugin:clipboard-manager|write_text') {
    if (state.failCopy) throw new Error('Simulated clipboard failure')
    state.copied = String(args.text)
  }
}, { shouldMockEvents: true })

function Harness() {
  const [visible, setVisible] = useState(true)
  const [narrow, setNarrow] = useState(false)
  return <I18nProvider initial="en"><main>
    <div className="flex h-10 gap-4 px-3"><button onClick={() => setVisible(v => !v)}>Toggle conversation</button><button onClick={() => setNarrow(v => !v)}>Resize conversation</button></div>
    <div style={{ width: narrow ? 490 : 1000, height: 540, display: visible ? undefined : 'none' }}>
      <TerminalView id="chat:link-test" cwd="C:/test-fixture" visible={visible} />
    </div>
  </main></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>)
