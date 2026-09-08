import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './lib/i18n'
import './index.css'
import './workbench.css'

// xterm measures cells once when it opens. Resolve the bundled face first so
// a cold start doesn't retain fallback-font columns after the glyphs change.
// A missing font must not prevent the app from opening.
async function mount(): Promise<void> {
  let fontTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      document.fonts.load('13.5px "JetBrains Mono"'),
      new Promise<void>((resolve) => { fontTimeout = setTimeout(resolve, 1000) })
    ])
  } catch {
    // The terminal can use its system-monospace fallback.
  } finally {
    clearTimeout(fontTimeout)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>
  )
}
void mount()
