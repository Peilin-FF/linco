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
