import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9223'
const browser = await chromium.connectOverCDP(endpoint)

let page
for (let attempt = 0; attempt < 20 && !page; attempt += 1) {
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
  timeout: 30000
})
await mkdir('artifacts', { recursive: true })

const originalTheme = await page.evaluate(
  () => document.documentElement.dataset.theme || 'vscode-light'
)

async function openSettings() {
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button[title]')].find((candidate) =>
      /settings|设置/i.test(candidate.title)
    )
    button?.click()
    return Boolean(button)
  })
  if (!opened) throw new Error('Settings button was not found')
  await page.waitForFunction(() => document.body.innerText.includes('VS Code Dark Modern'))
}

async function closeSettings() {
  const closed = await page.evaluate(() => {
    const button = document.querySelector('aside button')
    button?.click()
    return Boolean(button)
  })
  if (!closed) throw new Error('Settings back button was not found')
  await page.waitForFunction(() => !document.body.innerText.includes('VS Code Dark Modern'))
}

async function selectTheme(id) {
  const label = id === 'vscode-dark' ? 'VS Code Dark Modern' : 'VS Code Light Modern'
  const selected = await page.evaluate((name) => {
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(name)
    )
    button?.click()
    return Boolean(button)
  }, label)
  if (!selected) throw new Error(`Theme card ${label} was not found`)
  await page.waitForFunction(
    (themeId) => document.documentElement.dataset.theme === themeId,
    id
  )
  await page.waitForTimeout(250)
}

async function inspectTheme() {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const read = (name) => root.getPropertyValue(name).trim()
    const viewport = document.querySelector('.xterm-viewport')
    const rows = document.querySelector('.xterm-rows')
    return {
      theme: document.documentElement.dataset.theme,
      colorScheme: document.documentElement.style.colorScheme,
      vars: {
        canvas: read('--canvas'),
        sidebar: read('--sidebar'),
        ink: read('--ink'),
        accent: read('--accent'),
        border: read('--border'),
        input: read('--input-background'),
        inputBorder: read('--input-border'),
        widget: read('--widget'),
        editorSelection: read('--editor-selection'),
        link: read('--link'),
        error: read('--error')
      },
      body: {
        background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color
      },
      terminal: {
        count: document.querySelectorAll('.xterm').length,
        viewportBackground: viewport ? getComputedStyle(viewport).backgroundColor : null,
        rowColor: rows ? getComputedStyle(rows).color : null,
        renderer: [...document.querySelectorAll('[data-terminal-renderer]')].map(
          (element) => element.dataset.terminalRenderer
        )
      }
    }
  })
}

async function openFileEditor(themeId) {
  const openedFiles = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button[title]')].find((candidate) =>
      /files|文件/i.test(candidate.title)
    )
    button?.click()
    return Boolean(button)
  })
  if (!openedFiles) return { available: false, reason: 'Files navigation not found' }

  await page.waitForTimeout(750)
  const clickedFile = await page.evaluate(() => {
    const preferred = ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml']
    const labels = [...document.querySelectorAll('span')]
    let label = preferred
      .map((name) => labels.find((candidate) => candidate.textContent?.trim() === name))
      .find(Boolean)
    if (!label) {
      label = labels.find((candidate) =>
        /\.(?:md|ts|tsx|js|jsx|json|py|rs|css|html|ya?ml)$/i.test(
          candidate.textContent?.trim() || ''
        )
      )
    }
    const row = label?.closest('div.cursor-pointer')
    row?.click()
    return label?.textContent?.trim() || null
  })
  if (!clickedFile) return { available: false, reason: 'No source file found in tree' }

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.cm-editor')].some((editor) => {
        const rect = editor.getBoundingClientRect()
        return rect.width > 200 && rect.height > 200
      }),
    undefined,
    { timeout: 15000 }
  )
  const result = await page.evaluate(() => {
    const editor = [...document.querySelectorAll('.cm-editor')].find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.width > 200 && rect.height > 200
    })
    const gutter = editor?.querySelector('.cm-gutters')
    const tokens = editor
      ? [...editor.querySelectorAll('[class*="tok-"]')]
          .slice(0, 20)
          .map((token) => ({
            className: token.className,
            text: token.textContent?.slice(0, 40),
            color: getComputedStyle(token).color
          }))
      : []
    return {
      available: Boolean(editor),
      background: editor ? getComputedStyle(editor).backgroundColor : null,
      color: editor ? getComputedStyle(editor).color : null,
      gutterBackground: gutter ? getComputedStyle(gutter).backgroundColor : null,
      gutterColor: gutter ? getComputedStyle(gutter).color : null,
      tokens
    }
  })
  await page.screenshot({ path: `artifacts/linco-${themeId}-files.png` })
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button[title]')].find((candidate) =>
      /chat|对话/i.test(candidate.title)
    )
    button?.click()
  })
  await page.waitForTimeout(250)
  return { file: clickedFile, ...result }
}

const results = {}
await openSettings()

for (const id of ['vscode-dark', 'vscode-light']) {
  await selectTheme(id)
  await page.screenshot({ path: `artifacts/linco-${id}-settings.png` })
  await closeSettings()
  results[id] = await inspectTheme()
  await page.screenshot({ path: `artifacts/linco-${id}-chat.png` })
  results[id].editor = await openFileEditor(id)
  await openSettings()
}

await selectTheme(originalTheme === 'vscode-dark' ? 'vscode-dark' : 'vscode-light')
await closeSettings()

console.log(JSON.stringify({ originalTheme, results }, null, 2))
await browser.close()
