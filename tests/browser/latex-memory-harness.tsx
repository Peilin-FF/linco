import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/lib/i18n'
import LatexVisualEditor from '../../src/components/latex/LatexVisualEditor'
import { reviewScope } from '../../src/lib/latexReviewMemory'
import '../../src/index.css'

const initial = 'We is testing a method.\n\nThese result are preliminary.'
let calls = 0
Object.assign(window, { writingCalls: () => calls })

function Harness() {
  const [host, setHost] = useState('remote-a')
  const [visible, setVisible] = useState(true)
  const [researchContext, setResearchContext] = useState('')
  const [value, setValue] = useState(localStorage.getItem('test-manuscript') || initial)
  return <I18nProvider initial="en"><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div><button onClick={() => setVisible(v => !v)}>Toggle paper</button> <button onClick={() => setHost(h => h === 'remote-a' ? 'remote-b' : 'remote-a')}>Switch host</button> <button onClick={() => { setValue(initial + '\n\nNew external paragraph.'); localStorage.setItem('test-manuscript', initial + '\n\nNew external paragraph.') }}>External edit</button></div>
    <button onClick={() => setResearchContext(c => c === 'evidence-a' ? 'evidence-b' : 'evidence-a')}>Change research evidence</button>
    {visible && <LatexVisualEditor key={host} memoryScope={reviewScope(host, '/paper', '/paper/main.tex')} contextIdentity={researchContext}
      value={value} fileName="main.tex" isMainDocument={false} mode="source" dirty={false} saving={false}
      active repositoryLabel="paper" onMode={() => {}} onSave={() => {}}
      onChange={text => { setValue(text); localStorage.setItem('test-manuscript', text) }}
      onReviewSegments={async segments => {
        calls += 1
        return { agent: 'fixture', model: 'no-network', filesConsidered: researchContext ? 1 : 0,
          context: researchContext ? [{ path: 'results.csv', sha256: 'a'.repeat(64), bytes: 30, excerpt: 'Synthetic captured evidence for this review.' }] : [],
          issues: segments.flatMap(segment => [
          { original: 'We is', replacement: 'We are' }, { original: 'These result', replacement: 'These results' }
        ].filter(item => segment.text.includes(item.original)).map(item => ({ ...item, segmentId: segment.id, reason: 'Subject and verb agreement.', category: 'grammar' as const, evidence: researchContext ? ['results.csv'] : [] }))) }
      }} />}
  </div></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>)
