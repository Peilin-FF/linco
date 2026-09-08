import { expect, test, type Page } from '@playwright/test'

test.setTimeout(30000)

async function openLogs(page: Page, query = '') {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__index__', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Project preview</p>' }))
  await page.goto(`/tests/browser/workbench.html?logs${query}`)
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name: /^Terminal/ }).click()
  await expect(page.locator('.log-reader:visible')).toBeVisible()
  return errors
}

test('readable logs highlight important output and preserve progress rewrites and raw ANSI', async ({ page }) => {
  const errors = await openLogs(page)
  const reader = page.locator('.log-reader:visible')
  await expect(reader.getByText('Downloading 100%', { exact: true })).toBeVisible()
  await expect(reader).not.toContainText('Downloading 10%')
  await expect(reader.locator('[data-log-level="error"]')).toContainText('Worker retry')
  await expect(reader.locator('[data-log-level="metric"]')).toContainText('loss: 0.194')
  await expect(reader.locator('[data-log-level="debug"]')).toContainText('[state-dump]')
  await expect(reader.locator('.output-number').filter({ hasText: '0.194' })).toBeVisible()
  await expect(reader.locator('.output-label').filter({ hasText: 'loss' })).toHaveCSS('color', 'rgb(36, 99, 165)')
  await expect(reader.locator('img')).toHaveCount(0)
  await expect(reader).toHaveCSS('font-size', '13px')
  await expect(reader).toHaveCSS('font-family', /JetBrains Mono/)
  await page.getByRole('button', { name: 'Highlights', exact: true }).click()
  await expect(reader).not.toContainText('[state-dump]')
  await expect(reader).toContainText('Completed baseline')
  await page.getByRole('button', { name: /^Errors/ }).click()
  await expect(reader.locator('.log-line')).toHaveCount(1)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.getByRole('textbox', { name: 'Find in output' }).fill('loss')
  await expect(reader.locator('mark')).toHaveText('loss')
  await page.getByRole('textbox', { name: 'Find in output' }).fill('')
  await page.getByRole('button', { name: 'Larger log text' }).click()
  await expect(reader).toHaveCSS('font-size', '14px')
  await page.getByRole('button', { name: 'Wrap log lines' }).click()
  await expect(reader).not.toHaveClass(/is-wrapped/)
  await page.getByRole('button', { name: 'Wrap log lines' }).click()
  await page.screenshot({ path: 'artifacts/logs-reading-light.png' })
  await page.getByRole('button', { name: 'Raw', exact: true }).click()
  await expect(page.locator('.agent-task-output:visible .xterm')).toBeVisible()
  await expect(reader).toHaveCount(0)
  await page.getByRole('button', { name: 'Raw', exact: true }).click()
  await expect(reader).toContainText('loss: 0.194')
  expect(errors).toEqual([])
})

test('truncated logs replace old output, font preferences persist, and dark mode remains readable', async ({ page }) => {
  const errors = await openLogs(page, '&theme=linco-dark')
  const reader = page.locator('.log-reader:visible')
  await expect(reader).toContainText('Worker retry')
  await page.evaluate(() => (window as any).__workbench.setTaskLog('=== New run ===\nstep=1 loss: 0.82\n'))
  await expect(reader).toContainText('New run')
  await expect(reader).not.toContainText('Worker retry')
  await page.getByRole('button', { name: 'Larger log text' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('linco:log-font-size'))).toBe('14')
  await page.screenshot({ path: 'artifacts/logs-reading-dark.png' })
  expect(errors).toEqual([])
})

test('an unreadable log explains the failure without creating or changing a process', async ({ page }) => {
  await openLogs(page, '&log-error')
  await expect(page.getByText('Log file unreadable', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((call: any) => call.cmd === 'term_kill').length)).toBe(0)
})
