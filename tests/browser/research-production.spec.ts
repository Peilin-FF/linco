import { expect, test, type Page } from '@playwright/test'

const calls = (page: Page) => page.evaluate(() => (window as unknown as { researchCalls(): { command: string; args: Record<string, unknown> }[] }).researchCalls())
async function capture(page: Page) {
  await page.getByRole('textbox', { name: 'Evidence files' }).fill('training/model.py\nresults.csv')
  await page.getByRole('textbox', { name: 'Paper brief' }).fill('Compare measured methods without claiming statistical significance.')
  await page.getByRole('button', { name: 'Capture selected evidence', exact: true }).click()
  await expect(page.getByText('Captured evidence', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh source fingerprints' })).toBeEnabled()
}
async function render(page: Page) {
  await page.getByRole('textbox', { name: 'Metric and units' }).fill('Score (unitless)')
  await page.getByRole('button', { name: 'Render and save a new figure revision' }).click()
  await expect(page.getByRole('img', { name: 'Figure rendered from captured experiment data' })).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await page.route('http://asset.localhost/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTQkAAAAASUVORK5CYII=', 'base64') }))
  await page.goto('/tests/browser/research-production.html')
  await expect(page.getByRole('textbox', { name: 'Research repository' })).toHaveValue('/research')
})

test('captures only selected remote evidence, saves exact chart geometry locally, and restores without recapture', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  expect(await calls(page)).toEqual([])
  await capture(page)
  const captured = (await calls(page)).find(c => c.command === 'research_capture')!
  expect(captured.args).toEqual({ repo: '/research', paths: ['training/model.py', 'results.csv'], host: 'remote-a' })
  await render(page)
  const figure = (await calls(page)).find(c => c.command === 'research_save_figure')!
  expect(figure.args.packetDirectory).toBe('C:/fixture/research-1')
  expect(figure.args.host).toBeUndefined()
  const marks = figure.args.marks as { name: string; height: number }[]
  expect(marks.find(m => m.name === 'value-0')!.height / marks.find(m => m.name === 'value-1')!.height).toBeCloseTo(12 / 15)
  await page.screenshot({ path: 'artifacts/research-production-preview.png', fullPage: true })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export context for ChatGPT' }).click()
  expect((await download).suggestedFilename()).toBe('linco-writing-packet.txt')
  await page.reload()
  await expect(page.getByText('Captured evidence', { exact: false })).toBeVisible()
  expect((await calls(page)).every(c => c.command === 'research_load')).toBe(true)
  await expect(page.getByRole('textbox', { name: 'Evidence files' })).toHaveValue('training/model.py\nresults.csv')
  expect(errors).toEqual([])
})

test('shows changed fingerprints and refuses missing values instead of dropping them', async ({ page }) => {
  await capture(page)
  await page.evaluate(() => (window as unknown as { changeResults(text: string): void }).changeResults('method,score\nbaseline,12\nours,\n'))
  await page.getByRole('button', { name: 'Refresh source fingerprints' }).click()
  await expect(page.getByText('Changed sources: results.csv.', { exact: false })).toBeVisible()
  await page.getByRole('textbox', { name: 'Metric and units' }).fill('Score (unitless)')
  await page.getByRole('button', { name: 'Render and save a new figure revision' }).click()
  await expect(page.getByRole('alert')).toContainText('No rows were dropped')
  expect((await calls(page)).some(c => c.command === 'research_save_figure')).toBe(false)
  await page.getByRole('textbox', { name: 'Research repository' }).fill('/other')
  await expect(page.getByRole('button', { name: 'Export context for ChatGPT' })).toBeDisabled()
})

test('PowerPoint preparation and explicit save approval are separate local requests', async ({ page }) => {
  await capture(page)
  await render(page)
  await page.getByRole('button', { name: 'Open editable PowerPoint' }).click()
  await expect(page.getByRole('button', { name: 'Approve preview and save PowerPoint' })).toBeEnabled()
  let powerpoint = (await calls(page)).filter(c => c.command === 'research_powerpoint')
  expect(powerpoint.map(c => c.args)).toEqual([{ directory: 'C:/fixture/figure-1', save: false }])
  await page.getByRole('button', { name: 'Approve preview and save PowerPoint' }).click()
  await expect(page.getByRole('button', { name: 'PowerPoint saved', exact: true })).toBeDisabled()
  powerpoint = (await calls(page)).filter(c => c.command === 'research_powerpoint')
  expect(powerpoint[1].args).toEqual({ directory: 'C:/fixture/figure-1', save: true })
})

test('a late capture never appears in a different host workspace', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { holdCapture(): void }).holdCapture())
  await page.getByRole('textbox', { name: 'Evidence files' }).fill('results.csv')
  await page.getByRole('button', { name: 'Capture selected evidence' }).click()
  await expect(page.getByRole('status')).toContainText('Capturing')
  await page.getByRole('button', { name: 'Switch host' }).click()
  await page.evaluate(() => (window as unknown as { releaseCapture(): void }).releaseCapture())
  await expect(page.getByRole('textbox', { name: 'Evidence files' })).toHaveValue('')
  await expect(page.getByText('Captured evidence', { exact: false })).toHaveCount(0)
  // The host now appears both in the summary line and as an option in the research-host
  // select, so assert the control's value: the panel followed the workspace switch.
  await expect(page.getByRole('combobox', { name: 'Research host' })).toHaveValue('remote-b')
})
