import { expect, test } from '@playwright/test'

test.use({ actionTimeout: 10000, viewport: { width: 900, height: 600 } })

for (const surface of ['Files', 'Live preview', 'Welcome', 'Settings']) {
  test(`SSH dropdown stays clickable above ${surface}`, async ({ page }) => {
    await page.route('**/__index__', route => route.fulfill({ body: '<p>Preview</p>' }))
    await page.goto(`/tests/browser/workbench.html?${surface === 'Welcome' ? 'empty' : 'files'}`)
    if (surface === 'Files') await page.getByRole('button', { name: 'Code', exact: true }).click()
    if (surface === 'Settings') await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const trigger = page.getByTitle('Switch connection', { exact: true })
    await trigger.click()
    const panel = page.getByRole('dialog', { name: 'Switch connection' })
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const manage = panel.getByRole('button', { name: 'Manage connections…', exact: true })
    expect(await manage.evaluate(node => {
      const rect = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
    expect((await panel.boundingBox())!.y + (await panel.boundingBox())!.height).toBeLessThanOrEqual(600)
    await panel.locator('input').fill('ssh researcher@example.invalid')
    // Verify hit testing without opening a real SSH connection.
    await panel.getByRole('button', { name: 'Add', exact: true }).click({ trial: true })
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await manage.click()
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.settings-shell')).toBeVisible()
  })
}

test('SSH dropdown hides native Notes until dismissed without reopening the page', async ({ page }) => {
  await page.route('**/__index__', route => route.fulfill({ body: '<p>Preview</p>' }))
  await page.goto('/tests/browser/workbench.html')
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  const visible = () => page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'notion_layout').at(-1)?.args.visible)
  await expect.poll(visible).toBe(true)
  const opens = await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'notion_open').length)
  const trigger = page.getByTitle('Switch connection', { exact: true })
  await trigger.click()
  await expect.poll(visible).toBe(false)
  await page.keyboard.press('Escape')
  await expect.poll(visible).toBe(true)
  await trigger.click()
  await expect.poll(visible).toBe(false)
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Switch connection' })).toHaveCount(0)
  await expect.poll(visible).toBe(true)
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'notion_open').length)).toBe(opens)
})
