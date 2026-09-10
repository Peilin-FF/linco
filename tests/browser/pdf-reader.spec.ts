import { expect, test } from '@playwright/test'

declare global { interface Window { pdfReadingTest: { calls: number; cancels: number; pages: { page: number; text: string }[]; payloadKeys: string[] } } }

test('automatically requests AI analysis and renders only its exact quotes, with explanations and restored memory', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  await page.goto('/tests/browser/pdf-reader.html')
  await expect(page.locator('[data-research-highlight]')).toHaveCount(3, { timeout: 60000 })
  expect(await page.evaluate(() => window.pdfReadingTest.calls)).toBe(1)
  expect(await page.evaluate(() => window.pdfReadingTest.payloadKeys)).toEqual(['force', 'pages', 'requestId'])
  await expect(page.getByText('PDF text only · local AI connection · cloud model · 90s limit', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.pdfReadingTest.pages[0].text)).toContain('Taken together, these are test sentences.')
  await expect(page.locator('.paper-text-layer')).toContainText('synthetic research question')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: /3 key passages/ }).click()
  await expect(page.getByText('Synthetic rationale: prevents generalizing the fixture to real research.')).toBeVisible()
  await page.screenshot({ path: 'artifacts/pdf-research-highlights-preview.png' })
  await page.getByRole('button', { name: 'Method', exact: true }).click()
  await expect(page.locator('[data-research-highlight]')).toHaveCount(1)
  await expect(page.locator('[data-research-highlight="method"]')).toBeVisible()
  await page.getByRole('button', { name: 'AI highlights', exact: true }).click()
  await expect(page.locator('[data-research-highlight]')).toHaveCount(0)
  await page.getByRole('button', { name: 'AI highlights', exact: true }).click()
  await page.getByRole('button', { name: 'Method', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(page.locator('[data-research-highlight]')).toHaveCount(3)
  await page.reload()
  await expect(page.getByRole('button', { name: /Restored analysis/ })).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: 'Original PDF', exact: true }).click()
  await expect(page.locator('embed[type="application/pdf"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('a project-aware older desktop backend requests an update, never a remote reconnection', async ({ page }) => {
  await page.goto('/tests/browser/pdf-reader.html?old-backend=1')
  await expect(page.getByRole('alert')).toContainText('This window is running an older desktop backend.', { timeout: 30000 })
  await expect(page.getByRole('alert')).not.toContainText('missing required key')
  await expect(page.locator('[data-research-highlight]')).toHaveCount(0)
  expect(await page.evaluate(() => window.pdfReadingTest.payloadKeys)).toEqual(['force', 'pages', 'requestId'])
})

test('AI failure is explicit and never replaced by keyword coloring', async ({ page }) => {
  await page.goto('/tests/browser/pdf-reader.html?fail=1')
  await expect(page.getByRole('alert')).toContainText('Synthetic AI connection unavailable', { timeout: 60000 })
  await expect(page.locator('[data-research-highlight]')).toHaveCount(0)
  await expect(page.locator('.paper-text-layer')).toContainText('Our results show a synthetic improvement.')
})

test('slow analysis shows elapsed local progress and can actually be cancelled', async ({ page }) => {
  await page.goto('/tests/browser/pdf-reader.html?slow=1')
  await expect(page.getByRole('status').filter({ hasText: /Local AI is reading/ })).toContainText(/\d+s/, { timeout: 30000 })
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: /Analysis cancelled/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel analysis', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.pdfReadingTest.cancels)).toBe(1)
  await expect(page.locator('[data-research-highlight]')).toHaveCount(0)
})

test('previous successful highlights survive a failed refresh and are labelled outdated', async ({ page }) => {
  await page.goto('/tests/browser/pdf-reader.html?fail-refresh=1')
  await expect(page.locator('[data-research-highlight]')).toHaveCount(3, { timeout: 30000 })
  await page.getByRole('button', { name: 'Analyze again with the configured AI (uses your account)', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Previous highlights are retained.')
  await expect(page.locator('[data-research-highlight]')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /Previous analysis/ })).toBeVisible()
  await expect(page.getByText('Previous analysis—not yet rechecked for this version.', { exact: false })).toBeVisible()
})
