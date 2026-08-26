import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { chromium } from 'playwright'

const execFileAsync = promisify(execFile)
const endpoint = process.argv[2] ?? 'http://127.0.0.1:9223'
const session = `linco-tmux-smoke-${process.pid}`
const browser = await chromium.connectOverCDP(endpoint)
const pages = browser.contexts().flatMap((context) => context.pages())
const page = pages.find((candidate) => /localhost:1420|tauri:\/\//.test(candidate.url()))

if (!page) throw new Error(`No Linco WebView found at ${endpoint}`)

const connectionButton = page.getByTitle('Switch connection')
const host = (await connectionButton.innerText({ timeout: 90000 })).trim()
if (!host) throw new Error('No active remote connection')

const ssh = async (command) => {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ConnectTimeout=12', host, command],
        { maxBuffer: 4 * 1024 * 1024 }
      )
      return stdout.trim()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }
  throw lastError
}

const paneState = async () => {
  const output = await ssh(
    `tmux display-message -p -t ${session}:0.0 ` +
      `'#{pane_width}|#{pane_height}|#{history_size}|#{pane_in_mode}|` +
      `#{alternate_on}|#{pane_current_command}|#{scroll_position}'`
  )
  const [width, height, history, inMode, alternate, command, scrollPosition] =
    output.split('|')
  return {
    width: Number(width),
    height: Number(height),
    history: Number(history),
    inMode: Number(inMode),
    alternate: Number(alternate),
    command,
    scrollPosition: Number(scrollPosition)
  }
}

const clientState = async () => {
  const rows = await ssh(
    `tmux list-clients -F '#{session_name}|#{client_width}|#{client_height}'`
  )
  const row = rows
    .split(/\r?\n/)
    .map((line) => line.split('|'))
    .find(([name]) => name === session)
  if (!row) return null
  return { width: Number(row[1]), height: Number(row[2]) }
}

try {
  await ssh(
    `tmux new-session -d -s ${session} -x 120 -y 40 ` +
      `"bash -lc 'seq -f LINCO_TMUX_%06g 1 6000; exec bash -l'"` +
      ` && tmux set-option -t ${session} mouse on` +
      ` && tmux set-window-option -t ${session}:0 window-size smallest`
  )

  const terminal = page.locator('[data-terminal-kind="dock"]:visible').last()
  if ((await terminal.count()) === 0) {
    await page.getByTitle('Open terminal', { exact: true }).click()
  }
  await terminal.waitFor({ state: 'visible', timeout: 30000 })
  const textarea = terminal.locator('.xterm-helper-textarea')
  // Remote terminals inject cwd/environment after the first shell output.
  // Wait beyond that startup window so test input cannot interleave with it.
  await page.waitForTimeout(4000)
  await textarea.click()
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(300)
  await page.keyboard.type(`tmux attach-session -t ${session}`)
  await page.keyboard.press('Enter')

  await page.waitForTimeout(1500)
  let client = await clientState()
  if (!client) {
    await page.waitForTimeout(1500)
    client = await clientState()
  }
  if (!client) throw new Error('Linco did not attach to the tmux test session')
  const historyBeforeCodex = await paneState()

  await textarea.click()
  await page.keyboard.type('env WT_SESSION=linco-xterm codex')
  await page.keyboard.press('Enter')

  await page.waitForTimeout(5000)
  const beforeWheel = await paneState()
  if (beforeWheel.command !== 'node') {
    throw new Error(`Codex did not start in tmux (command=${beforeWheel.command})`)
  }

  const renderer = await terminal.getAttribute('data-terminal-renderer')
  const xtermSize = {
    cols: Number(await terminal.getAttribute('data-terminal-cols')),
    rows: Number(await terminal.getAttribute('data-terminal-rows'))
  }
  const box = await terminal.boundingBox()
  if (!box) throw new Error('Visible terminal has no bounding box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let step = 0; step < 3; step += 1) {
    await page.mouse.wheel(0, -720)
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(400)
  const afterWheel = await paneState()

  console.log(
    JSON.stringify(
      {
        host,
        renderer,
        xtermSize,
        client,
        historyBeforeCodex,
        beforeWheel,
        afterWheel,
        terminalSize: { width: Math.round(box.width), height: Math.round(box.height) }
      },
      null,
      2
    )
  )

  if (renderer !== 'webgl') throw new Error(`Expected WebGL, received ${renderer}`)
  if (historyBeforeCodex.history < 5900) {
    throw new Error(`tmux history was truncated (${historyBeforeCodex.history} lines)`)
  }
  if (client.width !== xtermSize.cols || client.height !== xtermSize.rows) {
    throw new Error(
      `tmux client ${client.width}x${client.height} differs from xterm ` +
        `${xtermSize.cols}x${xtermSize.rows}`
    )
  }
  if (beforeWheel.width > client.width || beforeWheel.height >= client.height) {
    throw new Error(
      `tmux pane ${beforeWheel.width}x${beforeWheel.height} exceeds client ` +
        `${client.width}x${client.height}`
    )
  }
  if (afterWheel.inMode !== 1 || afterWheel.scrollPosition <= 0) {
    throw new Error('Mouse wheel did not scroll tmux copy mode')
  }
} finally {
  await ssh(`tmux kill-session -t ${session}`).catch(() => {})
  await browser.close()
}
