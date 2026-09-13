import { expect, test } from '@playwright/test'

test.setTimeout(180000)
test.use({ actionTimeout: 15000 })
test.beforeEach(async ({ page }) => {
  await page.route('**/__index__', route => route.fulfill({ body: '<p>Preview</p>' }))
})

test('returning to a conversation never hides the existing terminal during a delayed redraw', async ({ page }) => {
  await page.goto('/tests/browser/workbench.html')
  const terminal = page.locator('[data-terminal-kind="chat"]')
  await expect(terminal.locator('.xterm-screen')).toBeVisible({ timeout: 120000 })
  await page.evaluate(async () => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    await (window as any).__terminalOutput(host.dataset.terminalId, '\r\nOpenAI Codex\r\nExisting conversation remains here.\r\n')
  })
  await page.waitForTimeout(400) // Let the initial output batch parse.
  await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-kind="chat"]')!
    ;(window as any).__hiddenReplays = []
    new MutationObserver(() => {
      if ((host as HTMLElement).style.visibility === 'hidden') (window as any).__hiddenReplays.push(performance.now())
    }).observe(host, { attributes: true, attributeFilter: ['style'] })
    ;(window as any).__originalTerminal = host
  })
  const starts = await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_start').length)
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page.locator('.context-agent-toggle').filter({ hasText: 'Agent' }).click()
  await expect(terminal).toBeVisible()
  await page.getByRole('button', { name: 'Vibe Working', exact: true }).click()
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  // Mock PTY never sends a resize redraw: the old content must remain visible.
  await page.waitForTimeout(1400)
  expect(await page.evaluate(() => (window as any).__hiddenReplays)).toEqual([])
  expect(await terminal.evaluate(host => host === (window as any).__originalTerminal)).toBe(true)
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_start').length)).toBe(starts)
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_resize').length)).toBeGreaterThan(0)
})

test('history has an initial loading state and reopens immediately while refreshing', async ({ page }) => {
  await page.goto('/tests/browser/workbench.html?delay-history')
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeVisible({ timeout: 120000 })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  const history = page.locator('.sidebar-history')
  await expect(history.getByRole('status')).toHaveText('Loading conversations…')
  await page.evaluate(() => (window as any).__workbench.releaseHistory())
  await expect(history.getByText('Build the project workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close projects', exact: true }).click()
  await page.evaluate(() => (window as any).__workbench.holdHistory())
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(history.getByText('Build the project workspace', { exact: true })).toBeVisible()
  await expect(history.getByRole('status')).toHaveCount(0)
  await page.locator('.workspace-drawer').getByRole('button', { name: 'website', exact: true }).click()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(history.getByRole('status')).toHaveText('Loading conversations…')
  await expect(history.getByText('Build the project workspace', { exact: true })).toHaveCount(0)
})

test('font defaults and the reset control use 12px', async ({ page }) => {
  // Invalid older configuration must not pin the range input to its maximum.
  await page.goto('/tests/browser/workbench.html?font-size=100')
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 120000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('slider')).toHaveValue('12')
  await page.getByRole('slider').fill('20')
  await page.getByRole('button', { name: 'Reset to 12px', exact: true }).click()
  await expect(page.getByRole('slider')).toHaveValue('12')
  await expect.poll(() => page.evaluate(() => (window as any).__workbench.getConfig().ui_font_size)).toBe(12)
})

for (const eventName of ['visibilitychange', 'focus', 'pageshow']) {
  test(`window return repaints cached conversation on ${eventName} without a PTY replay`, async ({ page }) => {
    await page.goto('/tests/browser/workbench.html')
    const terminal = page.locator('[data-terminal-kind="chat"]')
    await expect(terminal.locator('.xterm-screen')).toBeVisible({ timeout: 120000 })
    await page.waitForTimeout(500)
    await page.evaluate(async () => {
      const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
      await (window as any).__terminalOutput(host.dataset.terminalId,
        Array.from({ length: 120 }, (_, i) => `\r\nCached conversation line ${i}`).join(''))
    })
    await expect.poll(() => page.evaluate(() => {
      const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
      const term = (window as any).__conversationTerminals.get(host.dataset.terminalId)
      return term.buffer.active.baseY
    })).toBeGreaterThan(50)
    const before = await page.evaluate(() => {
      const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
      const term = (window as any).__conversationTerminals.get(host.dataset.terminalId)
      term.scrollToLine(20)
      term.select(0, 22, 12)
      ;(window as any).__cachedTerminal = term
      return { viewport: term.buffer.active.viewportY, selection: term.getSelection(),
        cols: term.cols, rows: term.rows,
        calls: (window as any).__workbench.calls.filter((c: any) => ['term_start', 'term_resize', 'term_kill'].includes(c.cmd)).length }
    })
    await page.waitForTimeout(150)
    await page.evaluate(() => {
      // No new PTY output: restoring must repaint the existing buffer.
      const term = (window as any).__cachedTerminal
      ;(window as any).__restoreRenders = 0
      term.onRender(() => (window as any).__restoreRenders++)
      term.options.cursorBlink = false
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(150)
    await page.evaluate((eventName) => {
      ;(window as any).__restoreRenders = 0
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      ;(eventName === 'visibilitychange' ? document : window).dispatchEvent(new Event(eventName))
    }, eventName)
    await expect.poll(() => page.evaluate(() => (window as any).__restoreRenders), { timeout: 1500 }).toBeGreaterThan(0)
    expect(await page.evaluate(() => {
      const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
      const term = (window as any).__conversationTerminals.get(host.dataset.terminalId)
      return { viewport: term.buffer.active.viewportY, selection: term.getSelection(),
        cols: term.cols, rows: term.rows,
        calls: (window as any).__workbench.calls.filter((c: any) => ['term_start', 'term_resize', 'term_kill'].includes(c.cmd)).length }
    })).toEqual(before)
  })
}

test('minimized output updates the cache with animation frames paused and ignores zero-size layouts', async ({ page }) => {
  await page.goto('/tests/browser/workbench.html')
  const terminal = page.locator('[data-terminal-kind="chat"]')
  await expect(terminal.locator('.xterm-screen')).toBeVisible({ timeout: 120000 })
  await page.waitForTimeout(500)
  const before = await terminal.evaluate(host => ({
    cols: (host as HTMLElement).dataset.terminalCols, rows: (host as HTMLElement).dataset.terminalRows,
    calls: (window as any).__workbench.calls.filter((c: any) => ['term_start', 'term_resize', 'term_kill'].includes(c.cmd)).length
  }))
  await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    const win = window as any
    win.__cachedTerminal = win.__conversationTerminals.get(host.dataset.terminalId)
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    const pending = new Map<number, FrameRequestCallback>()
    let id = 0
    window.requestAnimationFrame = callback => { pending.set(--id, callback); return id }
    window.cancelAnimationFrame = id => { if (id < 0) pending.delete(id); else cancel(id) }
    win.__resumeFrames = () => {
      window.requestAnimationFrame = request
      window.cancelAnimationFrame = cancel
      pending.forEach(callback => request(callback))
      pending.clear()
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    host.style.height = '0px'
    host.style.width = '0px'
    for (let i = 0; i < 30; i++) win.__terminalOutput(host.dataset.terminalId, `\r\nHidden update ${i}`)
  })
  // Inspect real parsed xterm data while all new animation frames remain paused.
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as any).__cachedTerminal.buffer.active
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)
  })).toContain('Hidden update 29')
  expect(await terminal.evaluate(host => ({
    cols: (host as HTMLElement).dataset.terminalCols, rows: (host as HTMLElement).dataset.terminalRows,
    calls: (window as any).__workbench.calls.filter((c: any) => ['term_start', 'term_resize', 'term_kill'].includes(c.cmd)).length
  }))).toEqual(before)
  // A restore notification can precede the layout becoming measurable.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(await terminal.getAttribute('data-terminal-cols')).toBe(before.cols)
  expect(await terminal.getAttribute('data-terminal-rows')).toBe(before.rows)
  await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    host.style.removeProperty('height')
    host.style.removeProperty('width')
    ;(window as any).__resumeFrames()
    window.dispatchEvent(new Event('focus'))
  })
  await expect(terminal.locator('.xterm-screen')).toBeVisible()
  await page.waitForTimeout(150)
  expect(await terminal.evaluate(host => ({
    cols: (host as HTMLElement).dataset.terminalCols, rows: (host as HTMLElement).dataset.terminalRows,
    calls: (window as any).__workbench.calls.filter((c: any) => ['term_start', 'term_resize', 'term_kill'].includes(c.cmd)).length
  }))).toEqual(before)
})

test('a long history replay holds the last painted screen until the final view is ready', async ({ page }, testInfo) => {
  await page.goto('/tests/browser/workbench.html')
  const terminal = page.locator('[data-terminal-kind="chat"]')
  await expect(terminal.locator('.xterm-screen')).toBeVisible({ timeout: 120000 })
  await page.waitForTimeout(600)
  await page.evaluate(async () => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    const term = (window as any).__conversationTerminals.get(host.dataset.terminalId)
    term.options.cursorBlink = false
    const history = Array.from({ length: 6500 }, (_, i) => `Cached long conversation ${i}: ${'history '.repeat(12)}\r\n`).join('')
    await new Promise<void>(resolve => term.write(`\x1b[?25l${history}LAST_COMPLETE_SCREEN`, resolve))
    term.scrollToBottom()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    ;(window as any).__cacheTerm = term
    ;(window as any).__cacheReveals = 0
    new MutationObserver(records => {
      for (const record of records) for (const removed of record.removedNodes) {
        if (removed instanceof HTMLElement && removed.dataset.terminalSnapshot) (window as any).__cacheReveals++
      }
    }).observe(term.element, { childList: true })
    // The clear/banner is at the beginning of a >4 KiB PTY batch.
    await (window as any).__terminalOutput(host.dataset.terminalId,
      '\x1b[2J\x1b[3J\x1b[HOpenAI Codex\r\n' + 'Beginning of replay '.repeat(500) + '\r\n')
  })
  const cache = terminal.locator('[data-terminal-snapshot]')
  await expect(cache).toBeVisible()
  // Assert the cache contains real painted pixels, not an empty cloned WebGL canvas.
  expect(await cache.evaluate(node => [...node.querySelectorAll('canvas')].some(canvas => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const colors = new Set<number>()
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2])
    return colors.size > 10
  }))).toBe(true)
  const cachedImage = await cache.screenshot({ path: testInfo.outputPath('cached-before.png') })
  await testInfo.attach('cached-before.png', { body: cachedImage, contentType: 'image/png' })
  await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    let chunk = 0
    ;(window as any).__replayFinished = false
    const interval = setInterval(() => {
      const text = Array.from({ length: 100 }, (_, line) => `Replay ${chunk}:${line} ${'long history '.repeat(9)}\r\n`).join('')
      ;(window as any).__terminalOutput(host.dataset.terminalId, text)
      if (++chunk === 70) {
        clearInterval(interval)
        ;(window as any).__terminalOutput(host.dataset.terminalId, 'FINAL_RESTORED_CONVERSATION')
        ;(window as any).__replayFinished = true
      }
    }, 100)
  })
  // The previous 5-second deadline exposed ongoing replays. The same cached
  // pixels must still be on screen six seconds into this longer transcript.
  await page.waitForTimeout(6000)
  await expect(cache).toBeVisible()
  const afterImage = await cache.screenshot({ path: testInfo.outputPath('cached-after.png') })
  await testInfo.attach('cached-after.png', { body: afterImage, contentType: 'image/png' })
  expect(afterImage.equals(cachedImage)).toBe(true)
  expect(await page.evaluate(() => (window as any).__cacheReveals)).toBe(0)
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as any).__cacheTerm.buffer.active
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)
  }), { timeout: 15000 }).toContain('FINAL_RESTORED_CONVERSATION')
  await expect(cache).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__cacheReveals)).toBe(1)
  await page.evaluate(async () => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    await (window as any).__terminalOutput(host.dataset.terminalId, '\r\nLIVE_AFTER_REPLAY')
  })
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as any).__cacheTerm.buffer.active
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)
  })).toContain('LIVE_AFTER_REPLAY')
})

test('transient restore sizes do not trigger repeated history replays', async ({ page }) => {
  await page.goto('/tests/browser/workbench.html')
  const terminal = page.locator('[data-terminal-kind="chat"]')
  await expect(terminal.locator('.xterm-screen')).toBeVisible({ timeout: 120000 })
  await page.waitForTimeout(600)
  const before = await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_resize').length)
  await page.evaluate(async () => {
    const host = document.querySelector('[data-terminal-kind="chat"]') as HTMLElement
    const delay = () => new Promise(resolve => setTimeout(resolve, 30))
    host.style.width = '600px'
    await delay()
    host.style.width = '700px'
    await delay()
    host.style.removeProperty('width')
    window.dispatchEvent(new Event('focus'))
  })
  await page.waitForTimeout(250)
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_resize').length)).toBe(before)
})

test('a collapsed startup and a tiny visible layout never send a 2-column terminal to the agent', async ({ page }) => {
  await page.addInitScript(() => {
    const style = document.createElement('style')
    style.id = 'collapsed-terminal-fixture'
    style.textContent = '[data-terminal-kind="chat"] { width: 0 !important; height: 0 !important; }'
    document.addEventListener('DOMContentLoaded', () => document.head.append(style), { once: true })
  })
  await page.goto('/tests/browser/workbench.html')
  await expect.poll(() => page.evaluate(() => (window as any).__workbench?.calls.filter((c: any) => c.cmd === 'term_start').length || 0), { timeout: 120000 }).toBeGreaterThan(0)
  const sizes = () => page.evaluate(() => (window as any).__workbench.calls
    .filter((c: any) => ['term_start', 'term_resize'].includes(c.cmd)).map((c: any) => ({ cols: c.args.cols, rows: c.args.rows })))
  expect((await sizes()).every((size: any) => size.cols >= 20 && size.rows >= 2)).toBe(true)
  await page.evaluate(() => document.getElementById('collapsed-terminal-fixture')?.remove())
  const terminal = page.locator('[data-terminal-kind="chat"]')
  await expect(terminal.locator('.xterm-screen')).toBeVisible()
  await page.waitForTimeout(300)
  const before = await terminal.getAttribute('data-terminal-cols')
  await terminal.evaluate(host => { (host as HTMLElement).style.width = '40px' })
  await page.waitForTimeout(300)
  expect(await terminal.getAttribute('data-terminal-cols')).toBe(before)
  expect((await sizes()).every((size: any) => size.cols >= 20 && size.rows >= 2)).toBe(true)
  await terminal.evaluate(host => (host as HTMLElement).style.removeProperty('width'))
})
