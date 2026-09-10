// Opt-in real desktop integration tests. Never edits the user's source project.
// --compile-copy <captured-source-directory> <main.tex>: edits a disposable local copy.
// --read-paper <pdf>: supplies PDF text only to LOCAL AI. No project/SSH access.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { chromium } from '@playwright/test'

const mode = process.argv[2]
assert(['--compile-copy', '--read-paper'].includes(mode), 'Choose an explicit test mode')
const browser = await chromium.connectOverCDP(process.env.LINCO_PAPER_DEV_CDP || 'http://127.0.0.1:9229')
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => /localhost:1420|127\.0\.0\.1:1420/.test(p.url()))
  assert(page, 'Open Linco — Fast Paper Dev first')
  assert.equal(await page.evaluate(() => window.isTauri), true)
  const invoke = (command, args) => page.evaluate(async ({ command, args }) => {
    const { invoke } = await import('/node_modules/@tauri-apps/api/core.js')
    return invoke(command, args)
  }, { command, args })
  assert.equal(await invoke('latex_ai_pdf_progress', { requestId: 'smoke-registration-probe' }), null)

  if (mode === '--compile-copy') {
    const [capture, main] = process.argv.slice(3)
    assert(capture && main && !main.includes('..') && !path.isAbsolute(main))
    await mkdir(path.resolve('tmp'), { recursive: true })
    const copy = path.join(await mkdtemp(path.resolve('tmp/latex-incremental-')), 'paper')
    await cp(capture, copy, { recursive: true, errorOnExist: true, force: false })
    const source = path.join(copy, main)
    const original = await readFile(source, 'utf8')
    assert(original.includes('\\end{document}'))
    const compile = async (label, force = false) => {
      const started = Date.now()
      const result = await invoke('latex_compile', { repo: copy, mainFile: main, engine: 'pdflatex', host: null, force })
      assert.equal(result.success, true, result.log)
      assert.equal(result.cached, false, 'An actual edited-source build, not whole-PDF reuse')
      const record = JSON.parse(await readFile(result.provenance_path, 'utf8'))
      const bytes = await readFile(result.pdf_path)
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
      assert.equal(record.pdf_sha256, createHash('sha256').update(bytes).digest('hex'))
      const texPasses = (result.log.match(/Run number \d+ of rule 'pdflatex'/g) || []).length
      const bibPasses = (result.log.match(/Run number \d+ of rule 'bibtex/g) || []).length
      console.log(JSON.stringify({ label, elapsedMs: Date.now() - started, durationMs: result.duration_ms, compilerMs: record.compiler_ms, prepareMs: record.prepare_ms, incremental: record.build_state_reused, texPasses, bibPasses, pdf: result.pdf_path, fixture: copy }))
      return { result, record, bytes, texPasses, bibPasses }
    }
    const cold = await compile('cold', true)
    await writeFile(source, original.replace('\\end{document}', '\\par Linco compilation benchmark text, not part of the author\'s paper.\n\\end{document}'))
    const edited = await compile('small-edit')
    assert.equal(edited.record.build_state_reused, true)
    assert.equal(edited.record.build_directory, cold.record.build_directory)
    assert.notDeepEqual(edited.bytes, cold.bytes)
    assert(edited.texPasses <= cold.texPasses)
    assert.equal(edited.bibPasses, 0, 'An ordinary prose edit must not rerun BibTeX')
    assert.deepEqual(await readFile(cold.result.pdf_path), cold.bytes, 'Published PDFs are immutable')
    await writeFile(source, original.replace('\\end{document}', '\\LincoDeliberatelyInvalidBenchmarkCommand\n\\end{document}'))
    const failed = await invoke('latex_compile', { repo: copy, mainFile: main, engine: 'pdflatex', host: null, force: false })
    assert.equal(failed.success, false, 'Invalid source must fail, not expose the previous build PDF')
    await assert.rejects(readFile(failed.pdf_path), /ENOENT/)
    assert.deepEqual(await readFile(edited.result.pdf_path), edited.bytes)
    console.log(JSON.stringify({ failedBuildNeverServesStalePdf: true, remoteSourceUnmodified: true }))
  } else {
    const [pdf] = process.argv.slice(3)
    assert(pdf && process.argv.length === 4, 'PDF-only reading accepts one PDF path, not project context')
    const pages = await page.evaluate(async pdfPath => {
      const { convertFileSrc } = await import('/node_modules/@tauri-apps/api/core.js')
      const pdfjs = await import('/node_modules/.vite/deps/pdfjs-dist.js')
      pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
      const task = pdfjs.getDocument({ url: convertFileSrc(pdfPath), enableXfa: false })
      try {
        const document = await task.promise
        const pages = []
        for (let index = 1; index <= document.numPages; index++) {
          const content = await (await document.getPage(index)).getTextContent()
          pages.push({ page: index, text: content.items.filter(item => 'str' in item).map(item => item.str.replace(/\s+/gu, ' ').trim()).filter(Boolean).join(' ') })
        }
        return pages
      } finally { await task.destroy() }
    }, pdf)
    const requestId = crypto.randomUUID()
    const args = { pages, force: false, requestId }
    const started = Date.now()
    const timer = setInterval(() => {
      void invoke('latex_ai_pdf_progress', { requestId }).then(progress => { if (progress) console.log(JSON.stringify({ progress })) }).catch(() => {})
    }, 2000)
    let result
    try { result = await invoke('latex_ai_pdf_highlights', args) } finally { clearInterval(timer) }
    assert.equal(result.execution, 'local')
    assert.equal(result.scope, 'pdf-only')
    assert(!('context' in result), 'PDF highlights must not include project evidence')
    for (const highlight of result.highlights) {
      assert(pages.find(page => page.page === highlight.page).text.includes(highlight.quote))
      assert(highlight.reason)
    }
    console.log(JSON.stringify({ scope: result.scope, execution: result.execution, elapsedMs: Date.now() - started, pages: pages.length, highlights: result.highlights.length, cached: result.cached, summary: result.summary }))
    const again = Date.now()
    const restored = await invoke('latex_ai_pdf_highlights', { ...args, requestId: crypto.randomUUID() })
    assert(restored.cached)
    console.log(JSON.stringify({ restored: true, elapsedMs: Date.now() - again }))
  }
} finally { await browser.close() }
