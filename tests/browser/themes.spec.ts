import { expect, test } from '@playwright/test'

// Cold Vite dependency preparation on Windows can take longer than a UI action.
test.setTimeout(180000)

test('curated themes update open editors and terminals, save selection, and preserve drafts', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/__index__', route => route.fulfill({ contentType: 'text/html', body: '<p>Preview</p>' }))
  await page.goto('/tests/browser/workbench.html?files')
  await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeVisible({ timeout: 120000 })
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page.locator('[data-file-entry="scripts"]').click()
  await page.locator('[data-file-entry="train.py"]').click()
  const editor = page.locator('[data-workspace-view="files"] .cm-editor')
  await expect(editor.locator('.cm-content')).toContainText('run_experiment')
  await editor.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n# retained draft')
  await editor.evaluate(node => { (window as any).__themeEditor = node })
  await page.getByRole('button', { name: 'Show terminal in Files', exact: true }).click()
  const terminal = page.locator('#workspace-terminal [data-terminal-kind="shell"]')
  await expect(terminal.locator('.xterm')).toBeVisible()
  await terminal.evaluate(node => { (window as any).__themeTerminal = node })
  const starts = await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_start').length)

  const themes = [
    ['github-dark-default', 'GitHub Dark Default', 'rgb(13, 17, 23)', 'rgb(255, 123, 114)', '#ff7b72'],
    ['tokyo-night', 'Tokyo Night', 'rgb(26, 27, 38)', 'rgb(187, 154, 247)', '#bb9af7'],
    ['catppuccin-mocha', 'Catppuccin Mocha', 'rgb(30, 30, 46)', 'rgb(203, 166, 247)', '#cba6f7'],
    ['gallery-nord', 'Nord', 'rgb(46, 52, 64)', 'rgb(184, 148, 177)', '#b894b1'],
  ]
  for (const [id, name, background, keyword, keywordHex] of themes) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const card = page.locator(`[data-theme-option="${id}"]`)
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    await expect.poll(() => page.evaluate(() => (window as any).__workbench.getConfig().theme)).toBe(id)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--syntax-keyword').trim())).toBe(keywordHex)
    await page.locator('.settings-sidebar').getByRole('button').first().click()
    await expect(editor).toHaveCSS('background-color', background)
    await expect(page.locator('[data-file-entry="train.py"] > .truncate')).toHaveCSS('color',
      await page.locator('[data-file-entry="train.py"]').evaluate(node => getComputedStyle(node).color))
    await expect(editor.locator('.cm-content')).toContainText('# retained draft')
    await expect(editor.locator('.cm-line span').filter({ hasText: /^from$/ }).first()).toHaveCSS('color', keyword)
    await expect(terminal).toHaveCSS('background-color', background)
    expect(await editor.evaluate(node => node === (window as any).__themeEditor)).toBe(true)
    expect(await terminal.evaluate(node => node === (window as any).__themeTerminal)).toBe(true)
    await page.screenshot({ path: `artifacts/theme-${id}.png` })
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.screenshot({ path: 'artifacts/theme-picker.png', fullPage: true })
  await page.getByRole('button', { name: /Linco · Light/ }).click()
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--output-number'))).toBe('')
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_start').length)).toBe(starts)
  expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_kill').length)).toBe(0)
  expect(errors).toEqual([])
})
