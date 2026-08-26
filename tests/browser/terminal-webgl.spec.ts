import { expect, test } from '@playwright/test'

test('WebGL renders one batched write per terminal resize', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto('/tests/browser/terminal-webgl.html')
  await page.waitForFunction(() => window.terminalHarness?.ready === true)
  const result = await page.evaluate(() => window.terminalHarness)
  console.info('terminal benchmark', result)

  expect(result.renderer).toBe('webgl')
  expect(result.resizeCycles).toBe(2)
  expect(result.writes).toBe(2)
  expect(result.renderEvents).toBeLessThan(20)
  expect(result.bytes).toBeGreaterThan(1_000_000)
  expect(result.finalLine).toContain('LINCO_WEBGL_FINAL_MARKER')
  expect(result.baseY).toBeGreaterThan(4000)
  expect(result.viewportY).toBe(result.baseY)
  expect(result.canvasCount).toBeGreaterThan(0)
  expect(result.canvasWidth).toBeGreaterThan(0)
  expect(result.canvasHeight).toBeGreaterThan(0)
  expect(result.parseMs).toBeLessThan(5000)
  expect(consoleErrors).toEqual([])

  await page.screenshot({ path: 'test-results/terminal-webgl.png' })
})
