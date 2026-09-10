import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/lib/i18n'
import LatexVisualEditor, { type LatexEditorMode } from '../../src/components/latex/LatexVisualEditor'
import '../../src/index.css'

const projectA = ['main.tex', 'sections/intro.tex', 'figures/result.pdf', 'refs/library.bib'].map(relative => ({ relative }))
const projectB = ['other.tex', 'figures/other.png'].map(relative => ({ relative }))
function Harness() {
  const [value, setValue] = useState('')
  const [mode, setMode] = useState<LatexEditorMode>('source')
  const [other, setOther] = useState(false)
  const [compiles, setCompiles] = useState(0)
  return <I18nProvider initial="en"><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div><button onClick={() => { setOther(v => !v); setValue('') }}>Switch project</button><output aria-label="Compile requests">{compiles}</output></div>
    <LatexVisualEditor value={value} onChange={setValue} fileName="main.tex" relativeFile="main.tex"
      projectFiles={other ? projectB : projectA} memoryScope={other ? 'completion-b' : 'completion-a'}
      isMainDocument={false} mode={mode} onMode={setMode} dirty={false} saving={false}
      repositoryLabel="Synthetic completion fixture" onSave={() => {}} onSaveAndCompile={() => setCompiles(v => v + 1)} />
  </div></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>)
