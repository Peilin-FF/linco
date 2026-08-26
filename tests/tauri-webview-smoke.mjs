import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9223'
const browser = await chromium.connectOverCDP(endpoint)
const pages = browser.contexts().flatMap((context) => context.pages())
let page
for (const candidate of pages) {
  const href = await candidate.evaluate(() => location.href).catch(() => candidate.url())
  if (/localhost:1420|tauri:\/\//.test(href)) {
    page = candidate
    break
  }
}

if (!page) {
  console.error(`No Linco WebView found at ${endpoint}`)
  process.exit(1)
}

await page.waitForFunction(
  () => document.querySelectorAll('[data-terminal-renderer]').length > 0,
  undefined,
  { timeout: 30000 }
)

const navTitles = await page.evaluate(() =>
  [...document.querySelectorAll('button[title]')].map(
    (button) => button.title
  )
)
const previewTitle = navTitles.find((title) => /^(预览|Preview)$/i.test(title))
const chatTitle = navTitles.find((title) => /^(对话|Chat)$/i.test(title))
let pageSwitchMs = null

if (previewTitle && chatTitle) {
  await page.evaluate((title) => {
    const button = [...document.querySelectorAll('button[title]')].find(
      (candidate) => candidate.title === title
    )
    button?.click()
  }, previewTitle)
  await page.waitForTimeout(500)

  const startedAt = Date.now()
  await page.evaluate((title) => {
    const button = [...document.querySelectorAll('button[title]')].find(
      (candidate) => candidate.title === title
    )
    button?.click()
  }, chatTitle)
  await page.waitForTimeout(75)
  await page.waitForFunction(() => {
    const terminals = [...document.querySelectorAll('[data-terminal-renderer]')]
    return terminals.some((terminal) => terminal.style.visibility !== 'hidden')
  })
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  pageSwitchMs = Date.now() - startedAt
}

const result = await page.evaluate(() => {
  const terminals = [...document.querySelectorAll('[data-terminal-renderer]')]
  const canvases = [...document.querySelectorAll('.xterm canvas')]
  return {
    url: location.href,
    renderers: terminals.map((terminal) => terminal.dataset.terminalRenderer),
    hiddenTerminals: terminals.filter((terminal) => terminal.style.visibility === 'hidden')
      .length,
    canvasCount: canvases.length,
    canvasSizes: canvases.map((canvas) => [canvas.width, canvas.height]),
    bodySize: [document.body.clientWidth, document.body.clientHeight]
  }
})

await mkdir('test-results', { recursive: true })
await page.screenshot({ path: 'test-results/tauri-webgl.png' })
console.log(JSON.stringify({ ...result, pageSwitchMs }, null, 2))

const failed =
  result.renderers.length === 0 ||
  result.renderers.some((renderer) => renderer !== 'webgl') ||
  result.canvasCount === 0 ||
  result.canvasSizes.some(([width, height]) => width <= 0 || height <= 0)
process.exit(failed ? 1 : 0)
