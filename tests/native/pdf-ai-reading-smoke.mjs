import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

// The registration check is read-only and deliberately sends no paper to AI.
// --analyze exercises the configured account with clearly synthetic paper text.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9228')
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /localhost:1420|127\.0\.0\.1:1420/.test(page.url()))
  assert(page, 'AI Paper Dev webview missing')
  const registered = await page.evaluate(async () => {
    const { invoke } = await import('/node_modules/@tauri-apps/api/core.js')
    try {
      await invoke('latex_ai_pdf_highlights', { pages: [], force: false })
      return 'unexpected success'
    } catch (error) { return String(error) }
  })
  assert.match(registered, /1–80 pages/)
  console.log(JSON.stringify({ nativeCommandRegistered: true, validation: registered }))
  if (process.argv.includes('--analyze')) {
    const input = {
      pages: [{ page: 1, text: 'Synthetic paper for a software test, NOT a real scientific finding. We investigate whether a cache changes repeated compilation latency. The proposed system hashes every source before reusing a saved PDF. In this fictional test, median repeated compilation fell from 8 seconds to 0.2 seconds across ten identical inputs. These fabricated numbers must not be treated as empirical evidence. The study is limited to synthetic inputs and has not been tested on real projects. The conclusion is that real measurements are still required before claiming a performance improvement.' }],
      force: false,
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      const start = Date.now()
      const result = await page.evaluate(async args => {
        const { invoke } = await import('/node_modules/@tauri-apps/api/core.js')
        return invoke('latex_ai_pdf_highlights', args)
      }, input)
      assert(result.summary)
      assert.equal(result.scope, 'pdf-only')
      assert.equal(result.execution, 'local')
      for (const highlight of result.highlights) {
        assert.equal(highlight.page, 1)
        assert(input.pages[0].text.includes(highlight.quote), 'Unanchored AI quote')
        assert(highlight.reason)
      }
      if (repeat) assert(result.cached, 'AI reading memory should be reused')
      console.log(JSON.stringify({ realConfiguredAi: true, repeat, elapsedMs: Date.now() - start, ...result }))
    }
  }
} finally { await browser.close() }
