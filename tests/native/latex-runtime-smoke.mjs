// Opt-in integration test against the actual rebuilt desktop backend.
// Start paper-workbench (CDP 9226), then:
//   node tests/native/latex-runtime-smoke.mjs --local
//   node tests/native/latex-runtime-smoke.mjs --remote <user@host> <paper-repo> <main.tex>
// Remote sources are read only. This invokes the compiler, not editor autosave.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mode = process.argv[2]
if (!['--local', '--remote'].includes(mode)) throw new Error('Choose --local or --remote explicitly.')
const [host, repo, main] = mode === '--remote'
  ? process.argv.slice(3)
  : [undefined, path.join(root, 'tests/fixtures/latex'), 'bundled-runtime.tex']
if (!repo || !main || (mode === '--remote' && !host)) throw new Error('Supply host, paper folder, and main TeX file.')

const browser = await chromium.connectOverCDP(process.env.LINCO_PAPER_DEV_CDP || 'http://127.0.0.1:9226')
try {
  const page = browser.contexts().flatMap(c => c.pages())
    .find(p => p.url().startsWith('http://localhost:1420/'))
  if (!page) throw new Error('The Research & Paper Dev desktop window is not running.')
  assert.equal(await page.evaluate(() => window.isTauri), true, 'Must test the native backend, not a browser mock.')
  for (const engine of mode === '--local' ? ['pdflatex', 'xelatex', 'lualatex'] : ['pdflatex']) {
   for (let attempt = 0; attempt < (process.argv.includes('--repeat') ? 2 : 1); attempt++) {
    console.log(`Compiling ${mode === '--remote' ? 'read-only SSH paper snapshot' : 'synthetic local fixture'} using ${engine}...`)
    const result = await page.evaluate(async ({ repo, main, engine, host }) => {
      const { compileLatex } = await import('/src/lib/latex.ts')
      return compileLatex(repo, main, engine, host)
    }, { repo, main, engine, host })
    assert.equal(result.pdf_is_local, true, 'Old backend: remote papers must compile locally.')
    assert.equal(result.tool_missing, false, result.log)
    assert.equal(result.success, true, result.log)
    if (attempt > 0) assert.equal(result.cached, true, 'An unchanged paper must reuse its verified PDF.')
    const pdf = await readFile(result.pdf_path)
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'Compiler must produce a real PDF.')
    const manifest = JSON.parse(await readFile(result.provenance_path, 'utf8'))
    assert.equal(manifest.execution, 'local')
    assert.equal(manifest.engine, engine)
    assert.equal(manifest.source_host, host || null)
    assert.equal(manifest.shell_escape, false)
    assert.equal(manifest.project_rc, false)
    assert.equal(manifest.exit_code, 0)
    assert.match(manifest.compiler_path.replaceAll('\\', '/'), /ai\.linco\.app\.paper-dev\/tex\/[^/]+\/TinyTeX\/bin\//,
      'Must use the private app-owned bundle, not a system TeX installation.')
    const pdfHash = createHash('sha256').update(pdf).digest('hex')
    assert.equal(manifest.pdf_sha256, pdfHash)
    if (host) {
      assert.ok(manifest.files.length > 0, 'Remote inputs must have a reproduction manifest.')
      const sourceRoot = path.join(path.dirname(result.provenance_path), 'source')
      for (const file of manifest.files) {
        const bytes = await readFile(path.join(sourceRoot, file.path))
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
      }
    }
    console.log(JSON.stringify({
      engine, success: result.success, execution: manifest.execution, cached: result.cached,
      milliseconds: result.duration_ms, pdf: result.pdf_path, pdfBytes: pdf.length,
      provenance: result.provenance_path, sourceFiles: manifest.files?.length,
      privateCompiler: manifest.compiler_path, sha256: pdfHash,
    }))
   }
  }
} finally {
  // With connectOverCDP, close disconnects this client; it does not stop Linco.
  await browser.close()
}
