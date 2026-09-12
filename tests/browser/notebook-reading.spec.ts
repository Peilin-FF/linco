import { expect, test, type Page } from '@playwright/test'

test.setTimeout(30000)
const fixture = '/tests/browser/notebook-reading.html'
const htmlCell = (page: Page) => page.locator('.cell[data-type="html"]')
const mdCell = (page: Page) => page.locator('.cell[data-type="md"]')

async function openNotebook(page: Page) {
  await page.goto(fixture)
  await expect(page.getByRole('button', { name: 'Edit notebook', exact: true })).toBeVisible()
}

test('starts as a light reading surface with one toolbar action and noneditable tables', async ({ page }) => {
  await openNotebook(page)
  await expect(page.locator('.toolbar button:visible')).toHaveCount(1)
  await expect(page.locator('#hint')).toBeHidden()
  await htmlCell(page).hover()
  await expect(htmlCell(page).locator('.cellbar')).toBeHidden()
  await expect(htmlCell(page).locator('.cellno')).toBeHidden()
  await expect(page.locator('.tinybar')).toBeHidden()
  await expect(page.locator('.adder').first()).toBeHidden()
  expect(await page.locator('table.edit .c').evaluateAll(cells => cells.every(cell => !(cell as HTMLElement).isContentEditable))).toBe(true)
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).colorScheme)).toBe('light')
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeVisible()
  await expect(page.locator('.tinybar')).toBeVisible()
  expect(await page.locator('table.edit .c').evaluateAll(cells => cells.every(cell => (cell as HTMLElement).isContentEditable))).toBe(true)
})

test('keeps HTML, user requirements and table edits when returning to reading, then saves only the seed', async ({ page }) => {
  const saves: any[] = []
  await page.route('**/__save', async route => {
    saves.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } })
  })
  await openNotebook(page)
  await htmlCell(page).locator('.rendered > section > p').dblclick()
  await expect(page.getByRole('button', { name: 'Done editing', exact: true })).toBeVisible()
  await htmlCell(page).locator('.rendered > section > p').fill('The refined result stays attached to its action.')
  await page.getByRole('button', { name: 'Done editing', exact: true }).click()
  await expect(htmlCell(page).locator('[contenteditable="true"]')).toHaveCount(0)
  await expect(htmlCell(page).locator('[data-result="preserve"]')).toBeVisible()
  await expect(mdCell(page)).toContainText('Keep my original requirement here.')
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click()
  await mdCell(page).focus()
  await mdCell(page).getByRole('button', { name: 'Edit block', exact: true }).click()
  await mdCell(page).locator('textarea').fill('Keep my original requirement here.\n\nAdd a concise next step.')
  await page.locator('table.edit tbody tr').first().locator('td .c').last().fill('Reviewed')
  await page.getByRole('button', { name: 'Done editing', exact: true }).click()
  await expect(page.locator('#hint')).toHaveText('Unsaved changes')
  await page.keyboard.press('Control+s')
  await expect(page.locator('#hint')).toHaveText('Saved')
  expect(saves).toHaveLength(1)
  expect(Object.keys(saves[0]).sort()).toEqual(['path', 'seed'])
  expect(saves[0].path).toBe(fixture)
  expect(saves[0].seed[0].html).toContain('data-result="preserve"')
  expect(saves[0].seed[0].html).toContain('The refined result stays attached to its action.')
  expect(saves[0].seed[1]).toEqual({ type: 'md', text: 'Keep my original requirement here.\n\nAdd a concise next step.' })
  expect(saves[0].seed[2]).toEqual({ type: 'table', head: ['Result', 'Status'], rows: [['Preview', 'Reviewed'], ['Notes', 'Saved']] })
  expect(await page.locator('table.edit .c').first().getAttribute('contenteditable')).toBe('false')
})

test('shows save failures in reading view and retries without losing inserted notes', async ({ page }) => {
  let attempts = 0
  const saves: any[] = []
  await page.route('**/__save', async route => {
    saves.push(route.request().postDataJSON())
    attempts += 1
    await route.fulfill({ status: attempts === 1 ? 400 : 200, json: attempts === 1 ? { ok: false, error: 'Fixture disk unavailable' } : { ok: true } })
  })
  await openNotebook(page)
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click()
  await page.getByRole('button', { name: 'Add note', exact: true }).click()
  await mdCell(page).last().locator('textarea').fill('Please preserve this note even if saving fails.')
  await page.getByRole('button', { name: 'Done editing', exact: true }).click()
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('alert')).toHaveText('Could not save: Fixture disk unavailable')
  await expect(mdCell(page).last()).toContainText('Please preserve this note even if saving fails.')
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('#hint')).toHaveText('Saved')
  expect(saves[1].seed).toEqual(saves[0].seed)
  expect(saves[1].seed.at(-1)).toEqual({ type: 'md', text: 'Please preserve this note even if saving fails.' })
})

test('supports keyboard insertion and block reordering in editing view', async ({ page }) => {
  await openNotebook(page)
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click()
  const rail = page.locator('.adder').last()
  await rail.focus()
  await page.keyboard.press('Enter')
  await expect(rail).toHaveAttribute('aria-expanded', 'true')
  await rail.locator('button[data-t="md"]').press('Enter')
  await mdCell(page).last().locator('textarea').fill('A note inserted from the keyboard.')
  await page.getByRole('button', { name: 'Done editing', exact: true }).click()
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click()
  await mdCell(page).last().focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.locator('#nb > .cell').nth(2)).toContainText('A note inserted from the keyboard.')
  await expect(page.locator('#nb > .cell').last()).toHaveAttribute('data-type', 'table')
})

for (const edition of ['codex-en', 'codex-zh', 'plugin-en', 'plugin-zh']) {
  test(`${edition} exposes localized reading controls and preserves legacy source content`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${fixture}?edition=${edition}`)
    await expect(page.locator('#notebook-mode')).toHaveText(edition.endsWith('-zh') ? '编辑' : 'Edit')
    await page.locator('#notebook-mode').click()
    await expect(page.locator('#notebook-add-note')).toHaveText(edition.endsWith('-zh') ? '添加笔记' : 'Add note')
    await expect(page.locator('#save')).toHaveText(edition.endsWith('-zh') ? '保存' : 'Save')
    await expect(htmlCell(page)).toContainText('A quieter workspace')
    await expect(mdCell(page)).toContainText('Keep my original requirement here.')
    expect(errors).toEqual([])
  })
}
