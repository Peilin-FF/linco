import { expect, test } from '@playwright/test'

test.setTimeout(120000)

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/latex-completion.html')
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('offers file paths automatically and accepts with Tab without breaking braces', async ({ page }) => {
  const editor = page.locator('.cm-content')
  await editor.pressSequentially('\\input{sec')
  await expect(page.getByRole('option', { name: /sections\/intro.tex/ })).toBeVisible()
  await editor.press('Tab')
  await expect(editor).toHaveText('\\input{sections/intro.tex}')
  await expect(page.getByRole('listbox')).toHaveCount(0)
})

test('provides command snippets with editable fields, and Tab advances fields', async ({ page }) => {
  const editor = page.locator('.cm-content')
  await editor.pressSequentially('\\frac')
  await expect(page.getByRole('option', { name: /Fraction · Tab/ })).toBeVisible()
  await editor.press('Enter')
  await editor.pressSequentially('a')
  await editor.press('Tab')
  await editor.pressSequentially('b')
  await expect(editor).toHaveText('\\frac{a}{b}')
})

test('Ctrl+S requests save-and-compile, not browser Save As', async ({ page }) => {
  await page.locator('.cm-content').press('Control+s')
  await expect(page.getByLabel('Compile requests')).toHaveText('1')
})

test('keeps suggestions in visual mode and updates the file list on a project switch', async ({ page }) => {
  const editor = page.locator('.cm-content')
  await page.getByRole('button', { name: 'Rich Text', exact: true }).click()
  await editor.pressSequentially('\\includegraphics{')
  await expect(page.getByRole('option', { name: /figures\/result.pdf/ })).toBeVisible()
  await page.getByRole('button', { name: 'Switch project' }).click()
  await editor.pressSequentially('\\includegraphics{')
  await expect(page.getByRole('option', { name: /figures\/other.png/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /figures\/result.pdf/ })).toHaveCount(0)
  await editor.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Suggestions', exact: true }).click()
  await expect(page.getByRole('option', { name: /figures\/other.png/ })).toBeVisible()
})
