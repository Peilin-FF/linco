// 后台任务监控冒烟:连到 tauri dev(--config tests/tauri-cdp.conf.json 开 CDP 9223)的 WebView,
// 切到终端视图,等待 agent 后台任务 tab 出现,点开并确认 xterm 里真的滚出了日志。
//
// 前置:项目目录(config.cwd)下已用 `python -u main.py > main.log 2>&1 &` 起了一个任务。
// 用法:node tests/tauri-task-monitor-smoke.mjs [http://127.0.0.1:9223] [tabLabel=main.py]
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9223'
const wantLabel = process.argv[3] ?? 'main.py'
const browser = await chromium.connectOverCDP(endpoint)

let page
for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
  const pages = browser.contexts().flatMap((context) => context.pages())
  for (const candidate of pages) {
    const href = await candidate.evaluate(() => location.href).catch(() => candidate.url())
    if (/localhost:1420|tauri:\/\//.test(href)) {
      page = candidate
      break
    }
  }
  if (!page) await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!page) throw new Error(`No Linco WebView found at ${endpoint}`)

await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, {
  timeout: 60000
})
await mkdir('artifacts', { recursive: true })

// 切到终端视图(侧栏按钮 title/文本含 terminal/终端)
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('button')].some((b) =>
      /terminal|终端/i.test(`${b.title} ${b.getAttribute('aria-label') ?? ''}`)
    ),
  undefined,
  { timeout: 60000, polling: 500 }
)
const switched = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /terminal|终端/i.test(`${b.title} ${b.getAttribute('aria-label') ?? ''}`)
  )
  btn?.click()
  return Boolean(btn)
})
if (!switched) throw new Error('Terminal view button not found')

// 等任务 tab(轮询 8s 一次,给足 40s)
const tabInfo = await page.waitForFunction(
  (label) => {
    const tabs = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.includes(label) && b.title && /\n/.test(b.title)
    )
    if (tabs.length === 0) return null
    return tabs.map((b) => ({ text: b.textContent, title: b.title }))
  },
  wantLabel,
  { timeout: 45000, polling: 1000 }
)
const tabs = await tabInfo.jsonValue()
console.log('task tabs:', JSON.stringify(tabs, null, 2))

// 点第一个任务 tab,等 xterm 里出现日志内容
await page.evaluate((label) => {
  const tab = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(label) && b.title && /\n/.test(b.title)
  )
  tab?.click()
}, wantLabel)

const rows = await page.waitForFunction(
  () => {
    // 只看可见(opacity-100)的任务面板
    const panels = [...document.querySelectorAll('.xterm-rows')]
    for (const r of panels) {
      const host = r.closest('[class*="opacity-0"]')
      if (host) continue
      const text = r.textContent ?? ''
      if (/step \d+\//.test(text)) return text
    }
    return null
  },
  undefined,
  { timeout: 20000, polling: 500 }
)
const text = await rows.jsonValue()
const lines = text
  .split(/(?=step \d+\/)/)
  .map((s) => s.trim())
  .filter(Boolean)
console.log(`xterm shows ${lines.length} log lines; last: ${lines[lines.length - 1]?.slice(0, 60)}`)

const header = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('span.font-mono[title]')]
  return spans.map((s) => s.textContent?.trim()).filter(Boolean)
})
console.log('panel header (output file):', header)

const shot = 'artifacts/linco-task-monitor-smoke.png'
await page.screenshot({ path: shot })
console.log('screenshot:', shot)

if (tabs.length !== 1) {
  console.error(`FAIL: expected exactly 1 "${wantLabel}" tab, got ${tabs.length}`)
  process.exit(1)
}
if (lines.length < 2) {
  console.error('FAIL: log did not render in xterm')
  process.exit(1)
}
console.log('PASS')
await browser.close()
