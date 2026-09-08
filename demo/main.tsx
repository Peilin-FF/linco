import './mock-workspace'
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { I18nProvider } from '../src/lib/i18n'
import { applyTheme, DEFAULT_THEME_ID } from '../src/lib/theme'
import '../src/index.css'
import '../src/workbench.css'
import './site.css'

function Demo() {
  const [notice, setNotice] = useState('A real interface with synthetic data. No AI calls, shell execution, or account connections.')
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const listener = (event: Event) => setNotice((event as CustomEvent<string>).detail)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('linco:demo-notice', listener)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('linco:demo-notice', listener); window.removeEventListener('keydown', escape) }
  }, [])
  function fillPrompt(text: string) {
    const input = document.getElementById('agent-composer') as HTMLTextAreaElement | null
    if (!input || !input.getBoundingClientRect().width) {
      setNotice('Open Vibe Working → Live preview, then use this prompt button.')
      return
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    setNotice('Press Enter or Send to run this scripted example.')
  }
  return <div className={`demo-shell ${expanded ? 'demo-expanded' : ''}`}>
    <div className="demo-controls"><span className="demo-label">PLAYGROUND · SIMULATED</span><button onClick={() => fillPrompt('Add a sunflower')}>＋ Add a sunflower</button><button onClick={() => fillPrompt('Make it midnight')}>☾ Make it midnight</button><button className="demo-expand" onClick={() => setExpanded(!expanded)}>{expanded ? 'Exit full screen' : 'Expand ↗'}</button></div>
    <div className="demo-app"><I18nProvider><App /></I18nProvider></div>
    <div className="demo-notice" role="status">{notice}</div>
  </div>
}

applyTheme(DEFAULT_THEME_ID)
async function mount() {
  await Promise.race([document.fonts.load('12px "JetBrains Mono"').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))])
  createRoot(document.getElementById('demo-root')!).render(<React.StrictMode><Demo /></React.StrictMode>)
}
void mount()
