import React from 'react'
import { createRoot } from 'react-dom/client'
import { mockIPC } from '@tauri-apps/api/mocks'
import { I18nProvider } from '../../src/lib/i18n'
import PaperPdfReader from '../../src/components/latex/PaperPdfReader'
import '../../src/index.css'

// A tiny valid text PDF, built in memory; no real research content or network.
const stream = 'BT /F1 12 Tf 50 750 Td (We investigate a synthetic research question.) Tj 0 -30 Td (We propose a synthetic retrieval method.) Tj 0 -30 Td (Our results show a synthetic improvement.) Tj 0 -30 Td (Our method is limited to test fixtures only.) Tj 0 -30 Td (Taken together, these are test sentences.) Tj ET'
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
]
let pdf = '%PDF-1.4\n'
const offsets = [0]
objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
const xref = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const fixture = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }))
const src = new URLSearchParams(location.search).get('src') || fixture
const state = { calls: 0, cancels: 0, pages: [] as { page: number; text: string }[], payloadKeys: [] as string[] }
let failPending: ((reason: Error) => void) | undefined
Object.assign(window, { pdfReadingTest: state })
mockIPC((command, payload) => {
  if (command === 'latex_ai_pdf_progress') return { stage: 'reading', elapsedMs: 1500, timeoutMs: 90000, execution: 'local' }
  if (command === 'latex_ai_pdf_cancel') { state.cancels++; failPending?.(new Error('Paper analysis cancelled.')); return true }
  if (command !== 'latex_ai_pdf_highlights') throw new Error(`Unexpected command: ${command}`)
  state.calls++
  const args = payload as { pages: { page: number; text: string }[]; force: boolean }
  state.payloadKeys = Object.keys(args).sort()
  state.pages = args.pages
  const query = new URLSearchParams(location.search)
  if (query.has('old-backend')) throw new Error('invalid args repo for command latex_ai_pdf_highlights: command latex_ai_pdf_highlights missing required key repo')
  if (query.has('fail') || (args.force && query.has('fail-refresh'))) throw new Error('Synthetic AI connection unavailable')
  if (query.has('slow') || (args.force && query.has('slow-refresh'))) return new Promise((_, reject) => { failPending = reject })
  const key = 'pdf-test-analysis:' + JSON.stringify(args.pages)
  const cached = !args.force && localStorage.getItem(key) === 'saved'
  localStorage.setItem(key, 'saved')
  return {
    summary: 'Synthetic AI response for browser interaction tests, not a real scientific finding.',
    highlights: [
      { page: 1, kind: 'method', quote: 'We propose a synthetic retrieval method.', reason: 'Synthetic rationale: identifies the tested mechanism.' },
      { page: 1, kind: 'result', quote: 'Our results show a synthetic improvement.', reason: 'Synthetic rationale: the reported outcome, not independent verification.' },
      { page: 1, kind: 'limitation', quote: 'Our method is limited to test fixtures only.', reason: 'Synthetic rationale: prevents generalizing the fixture to real research.' },
    ],
    agent: 'Test fixture', model: 'Mock response', createdAt: Date.now(), pages: args.pages.length,
    scope: 'pdf-only', execution: 'local', cached, saveWarning: null,
  }
})
// Deliberately no project or document ID: standalone PDFs must work too.
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider initial="en"><div style={{ height: '100vh', width: 720 }}><PaperPdfReader src={src} /></div></I18nProvider></React.StrictMode>)
