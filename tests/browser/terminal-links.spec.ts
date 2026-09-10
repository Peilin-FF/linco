import { expect, test, type Page } from '@playwright/test'

interface LinkState { opened: string[]; copied: string; failOpen: boolean; failCopy: boolean; columns: number; rows: number; ready: boolean; starts: number; writes: string[] }
declare global { interface Window { terminalLinkTest: LinkState; rewriteTerminalLinks: () => Promise<void>; enableAgentMouseReporting: () => Promise<void> } }

const microsoft = 'https://visualstudio.microsoft.com/visual-cpp-build-tools/'
async function point(page: Page, row: number, column = 5) {
  const screen = await page.locator('.xterm-screen').boundingBox()
  if (!screen) throw new Error('Terminal screen missing')
  const { columns, rows } = await page.evaluate(() => window.terminalLinkTest)
  return { x: screen.x + (column - 0.5) * screen.width / columns, y: screen.y + (row - 0.5) * screen.height / rows }
}
async function hover(page: Page, row: number, column = 5) {
  const p = await point(page, row, column)
  await page.mouse.move(p.x, p.y)
  await expect(page.locator('[data-terminal-link-feedback="hover"]')).toBeVisible()
  return p
}
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/terminal-links.html')
  await page.waitForFunction(() => window.terminalLinkTest?.ready)
  await expect(page.locator('.xterm-screen')).toBeVisible()
})

test('a normal click opens a plain URL through the native API and can copy its destination', async ({ page }) => {
  const p = await hover(page, 2)
  await expect(page.getByRole('status')).toContainText(microsoft)
  expect(await page.evaluate(() => window.terminalLinkTest.opened)).toEqual([])
  await page.mouse.click(p.x, p.y)
  await expect(page.getByRole('status')).toContainText('Sent to your default browser')
  expect(await page.evaluate(() => window.terminalLinkTest.opened)).toEqual([microsoft])
  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.terminalLinkTest.copied)).toBe(microsoft)
  expect(await page.evaluate(() => window.terminalLinkTest.writes)).toEqual([])
})

test('a labeled OSC 8 link opens the hidden destination, not the label', async ({ page }) => {
  const p = await hover(page, 3)
  await expect(page.getByRole('status')).toContainText(microsoft)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.opened)).toEqual([microsoft])
})

test('Markdown punctuation is not included in the URL', async ({ page }) => {
  const p = await hover(page, 4, 20)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.opened)).toEqual(['https://example.com/paper?q=alpha&n=1'])
})

test('browser-opening failure is visible and leaves a usable copy action', async ({ page }) => {
  await page.evaluate(() => { window.terminalLinkTest.failOpen = true })
  const p = await hover(page, 2)
  await page.mouse.click(p.x, p.y)
  await page.mouse.move(1200, 700)
  await expect(page.getByRole('alert')).toContainText('Simulated browser-opening failure')
  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.copied)).toBe(microsoft)
})

test('unsafe schemes are rejected with an explanation, never sent to the OS', async ({ page }) => {
  const p = await hover(page, 5)
  await page.mouse.click(p.x, p.y)
  await expect(page.getByRole('alert')).toContainText('Only HTTP and HTTPS')
  expect(await page.evaluate(() => window.terminalLinkTest.opened)).toEqual([])
})

test('wide Unicode text and soft-wrapped links keep correct click coordinates', async ({ page }) => {
  const p = await hover(page, 6, 40)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.opened)).toEqual(['https://example.com/unicode'])
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  const wrapped = await hover(page, 8, 5)
  await page.mouse.click(wrapped.x, wrapped.y)
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.opened.at(-1))).toBe('https://example.com/' + 'long-path/'.repeat(18) + '?q=wrapped')
})

test('switching and resizing a conversation preserves links without restarting its session', async ({ page }) => {
  const starts = await page.evaluate(() => window.terminalLinkTest.starts)
  await page.getByRole('button', { name: 'Toggle conversation' }).click()
  await page.getByRole('button', { name: 'Toggle conversation' }).click()
  await page.getByRole('button', { name: 'Resize conversation' }).click()
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.columns)).toBeLessThan(80)
  const p = await hover(page, 2)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.opened)).toEqual([microsoft])
  expect(await page.evaluate(() => window.terminalLinkTest.starts)).toBe(starts)
})

test('dragging to select a URL does not launch the browser', async ({ page }) => {
  const a = await hover(page, 2, 2)
  const b = await point(page, 2, 30)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.terminalLinkTest.opened)).toEqual([])
})

test('clipboard errors are visible, not swallowed', async ({ page }) => {
  await page.evaluate(() => { window.terminalLinkTest.failOpen = true; window.terminalLinkTest.failCopy = true })
  const p = await hover(page, 2)
  await page.mouse.click(p.x, p.y)
  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('alert')).toContainText('Simulated clipboard failure')
})

test('ordinary drag selects agent text even with mouse reporting, Ctrl+C copies instead of interrupting', async ({ page }) => {
  await page.evaluate(() => window.enableAgentMouseReporting())
  const a = await point(page, 1, 1), b = await point(page, 1, 30)
  await page.mouse.move(a.x, a.y); await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Copy selection', exact: true })).toBeVisible()
  await page.keyboard.press('Control+c')
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.copied)).toContain('Links in agent conversations')
  expect(await page.evaluate(() => window.terminalLinkTest.writes)).not.toContain('\x03')
  expect(await page.evaluate(() => window.terminalLinkTest.writes)).not.toEqual(expect.arrayContaining([expect.stringContaining('\x1b[<')]))
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
})

test('Ctrl+C with no selection still interrupts the agent', async ({ page }) => {
  const p = await point(page, 1, 2)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('Control+c')
  await expect.poll(() => page.evaluate(() => window.terminalLinkTest.writes)).toContain('\x03')
  expect(await page.evaluate(() => window.terminalLinkTest.copied)).toBe('')
})
