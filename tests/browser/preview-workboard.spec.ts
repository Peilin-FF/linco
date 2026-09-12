import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

test.setTimeout(35000)
test.beforeEach(async ({ page }) => page.setDefaultTimeout(10000))

const fixture = '/tests/browser/preview-workboard.html'
const title = 'Organize the live preview'
const dialog = (page: Page) => page.getByRole('dialog')
const card = (page: Page, name = title) => page.locator('.pwb-card-main').filter({ has: page.getByText(name, { exact: true }) })
const state = (page: Page) => page.evaluate(() => {
  const fixtureState = (window as any).previewWorkboardTest
  return { submitted: fixtureState.submitted, opened: fixtureState.opened, disk: fixtureState.disk() }
})

async function createAction(page: Page, name = title) {
  await page.getByRole('button', { name: 'New action', exact: true }).first().click()
  await dialog(page).getByRole('textbox', { name: 'Title', exact: true }).fill(name)
  await dialog(page).getByRole('textbox', { name: 'Expected outcome', exact: true }).fill('Keep current work, decisions, and next steps in one native project board.')
  await dialog(page).getByRole('button', { name: 'Create action', exact: true }).click()
  await expect(card(page, name)).toBeVisible()
}

async function openActionDetails(page: Page, name = title) {
  await page.getByRole('button', { name: `Action details: ${name}`, exact: true }).click()
  await expect(dialog(page)).toBeVisible()
}

test('persists an action, changed status, next step, updates, and decisions after reopening', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(fixture)
  await createAction(page)
  await openActionDetails(page)
  await dialog(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('progress')
  await dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true }).fill('The native board replaces the scattered preview landing page.')
  await dialog(page).getByRole('textbox', { name: 'Next step', exact: true }).fill('Check the reopened project preserves its history.')
  await dialog(page).getByRole('textbox', { name: 'Acceptance checks', exact: true }).fill('Project state persists\nHTML stays attached to the outcome')
  await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  await dialog(page).getByRole('textbox', { name: 'Add update', exact: true }).fill('Tried a compact board; columns fit the live preview pane.')
  await dialog(page).getByRole('button', { name: 'Record update', exact: true }).click()
  await expect(dialog(page).getByText('Tried a compact board; columns fit the live preview pane.', { exact: true })).toBeVisible()
  await dialog(page).getByRole('textbox', { name: 'Add update', exact: true }).fill('Keep detailed experiments in the task history.')
  await dialog(page).getByRole('button', { name: 'Record decision', exact: true }).click()
  await expect(dialog(page).getByText('Keep detailed experiments in the task history.', { exact: true })).toBeVisible()
  expect((await state(page)).submitted).toEqual([])

  await page.reload()
  await openActionDetails(page)
  await expect(dialog(page).getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('progress')
  await expect(dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue('The native board replaces the scattered preview landing page.')
  await expect(dialog(page).getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('Check the reopened project preserves its history.')
  await expect(dialog(page).getByRole('textbox', { name: 'Acceptance checks', exact: true })).toHaveValue('Project state persists\nHTML stays attached to the outcome')
  await expect(dialog(page).getByText('Tried a compact board; columns fit the live preview pane.', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('Keep detailed experiments in the task history.', { exact: true })).toBeVisible()
  const saved = await state(page)
  const records = Object.entries(saved.disk.files).filter(([path]) => path.includes('/.linco/workboard/events/') && path.endsWith('.json'))
  expect(records.length).toBeGreaterThanOrEqual(4)
  expect(saved.submitted).toEqual([])
  expect(errors).toEqual([])
})

test('discovers existing HTML, attaches it to an action, and opens its original preview path', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  const inbox = page.locator('details.pwb-inbox')
  await inbox.locator(':scope > summary').click()
  await expect(inbox).toContainText('first-proposal.html')
  await expect(inbox).toContainText('experiment.html')
  await expect(inbox).toContainText('index.html')
  await expect(inbox).not.toContainText('notes.md')
  const row = inbox.locator('[data-artifact-path="artifacts/first-proposal.html"]')
  await row.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Opened artifact' })).toHaveText('artifacts/first-proposal.html')
  await row.getByRole('button', { name: 'Attach', exact: true }).click()
  await dialog(page).getByRole('combobox', { name: 'Action', exact: true }).selectOption({ label: title })
  await dialog(page).getByRole('button', { name: 'Attach file', exact: true }).click()
  await expect(inbox).not.toContainText('first-proposal.html')
  await page.reload()
  await card(page).click()
  await expect(page.getByRole('status', { name: 'Opened artifact' })).toHaveText(/^artifacts\/actions\/[^/]+\/action\.html$/)
  await openActionDetails(page)
  await expect(dialog(page)).toContainText('first-proposal.html')
  expect((await state(page)).submitted).toEqual([])
})

test('isolates project and host state while preserving the original project on return', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  await page.getByRole('button', { name: 'Switch fixture project', exact: true }).click()
  await expect(card(page)).toHaveCount(0)
  await createAction(page, 'A separate project outcome')
  await page.getByRole('button', { name: 'Switch fixture project', exact: true }).click()
  await expect(card(page)).toBeVisible()
  await expect(card(page, 'A separate project outcome')).toHaveCount(0)
  await page.getByRole('button', { name: 'Switch fixture host', exact: true }).click()
  await expect(card(page)).toHaveCount(0)
  await createAction(page, 'Remote machine outcome')
  await page.getByRole('button', { name: 'Switch fixture host', exact: true }).click()
  await expect(card(page)).toBeVisible()
  await expect(card(page, 'Remote machine outcome')).toHaveCount(0)
  expect((await state(page)).submitted).toEqual([])
})

test('only an explicit agent request submits work; moving a task does not', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  await openActionDetails(page)
  await dialog(page).getByRole('combobox', { name: 'Status', exact: true }).selectOption('progress')
  await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await state(page)).submitted).toEqual([])
  await dialog(page).getByRole('button', { name: 'Request agent work', exact: true }).click()
  await expect.poll(async () => (await state(page)).submitted.length).toBe(1)
  expect((await state(page)).submitted[0]).toContain(title)
})

test('failed saves keep the task draft available and do not claim persisted progress', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  await openActionDetails(page)
  await page.evaluate(() => { (window as any).previewWorkboardTest.failWrites = true })
  await dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true }).fill('This draft could not be written.')
  await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Fixture disk is read-only')
  await expect(dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue('This draft could not be written.')
  await page.reload()
  await openActionDetails(page)
  await expect(dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true })).not.toHaveValue('This draft could not be written.')
})

test('external agent progress appears while a user draft is preserved, and saving does not overwrite it', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  await openActionDetails(page)
  await dialog(page).getByRole('textbox', { name: 'Next step', exact: true }).fill('My next decision is preserved while the agent reports progress.')
  await page.evaluate(async () => {
    await (window as any).previewWorkboardTest.publishAgentProgress('Agent verified that the board reopens with its project history.')
    window.dispatchEvent(new Event('focus'))
  })
  await expect(dialog(page).getByText('This action has new updates. Your draft is preserved; saving changes only the fields you edited.', { exact: true })).toBeVisible()
  await expect(dialog(page).getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('My next decision is preserved while the agent reports progress.')
  await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await page.reload()
  await openActionDetails(page)
  await expect(dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true })).toHaveValue('Agent verified that the board reopens with its project history.')
  await expect(dialog(page).getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('My next decision is preserved while the agent reports progress.')
  await expect(dialog(page).locator('.pwb-history').getByText('Agent', { exact: true })).toBeVisible()
})

test('Chinese dark mode and a narrow preview remain readable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 720 })
  await page.goto(fixture + '?lang=zh&theme=linco-dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'linco-dark')
  await expect(page.locator('.pwb-root')).toBeVisible()
  await expect(page.locator('.pwb-root')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.getByRole('button', { name: 'New action', exact: true })).toHaveCount(0)
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1)
  await page.screenshot({ path: 'artifacts/native-preview-workboard-dark-zh.png' })
})

test('each action owns an editable notebook, its card opens that report, and user cells survive reopening', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  const created = await page.evaluate(() => {
    const disk = (window as any).previewWorkboardTest.disk()
    const event = Object.entries(disk.files).filter(([path]) => path.includes('/.linco/workboard/events/') && path.endsWith('.json'))
      .map(([, content]) => JSON.parse(String(content))).find(event => event.type === 'create')
    const path = event.patch.actionArtifact as string
    const document = new DOMParser().parseFromString(disk.files[`|C:/Projects/alpha/${path}`], 'text/html')
    const seed = JSON.parse(document.querySelector('#seed')!.textContent!)
    return {
      taskId: event.taskId, path, seed,
      styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(link => link.getAttribute('href')),
      inlineStyles: document.querySelectorAll('style').length,
      scripts: Array.from(document.querySelectorAll('script[src]')).map(script => script.getAttribute('src')),
      inlineScripts: Array.from(document.querySelectorAll('script:not([src]):not(#seed)')).map(script => script.textContent),
    }
  })
  expect(created.path).toBe(`artifacts/actions/${created.taskId}/action.html`)
  expect(created.styles).toContain('/__assets/notebook.css')
  expect(created.scripts).toContain('/__assets/notebook.js')
  expect(created.inlineStyles).toBe(0)
  expect(created.inlineScripts).toHaveLength(1)
  expect(created.inlineScripts[0]).toContain('HtmlVibeNotebook.mount(')
  expect(created.inlineScripts[0]!.length).toBeLessThan(300)
  expect(Array.isArray(created.seed)).toBe(true)
  expect(JSON.stringify(created.seed)).toContain(title)
  // A fresh action has an intention and a next step; it must not manufacture
  // progress or result labels merely to fill an empty report.
  expect(created.seed[0].html).toContain('Keep current work, decisions, and next steps in one native project board.')
  expect(created.seed[0].html).toContain('Planned')
  expect(created.seed[1].html).toContain('Next step')
  expect(created.seed.slice(2).every((cell: { type: string; html: string }) => cell.type === 'html' && cell.html.startsWith('<details>'))).toBe(true)
  expect(JSON.stringify(created.seed)).not.toContain('<details open')
  await expect(page.locator(`.pwb-inbox [data-artifact-path="${created.path}"]`)).toHaveCount(0)

  await card(page).click()
  await expect(page.getByRole('status', { name: 'Opened artifact' })).toHaveText(created.path)
  await expect(dialog(page)).toHaveCount(0)
  const customized = await page.evaluate(path => (window as any).previewWorkboardTest.addNotebookCell(path,
    { type: 'md', text: 'User adjustment: retain the alternative approach for the next iteration.' }), created.path)
  await openActionDetails(page)
  await dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true }).fill('The action details now include a new progress summary.')
  await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await page.reload()
  await card(page).click()
  await expect(page.getByRole('status', { name: 'Opened artifact' })).toHaveText(created.path)
  const saved = await state(page)
  expect(saved.disk.files[`|C:/Projects/alpha/${created.path}`]).toBe(customized)
  expect(saved.submitted).toEqual([])
})

test('the native white board and action details stay white inside a dark app', async ({ page }) => {
  await page.goto(fixture + '?theme=linco-dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'linco-dark')
  await expect(page.locator('.pwb-root')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await createAction(page)
  await openActionDetails(page)
  await expect(dialog(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(dialog(page).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title)
})

test('retrying action creation reuses the notebook after its event publication failed', async ({ page }) => {
  await page.goto(fixture)
  await page.getByRole('button', { name: 'New action', exact: true }).first().click()
  await dialog(page).getByRole('textbox', { name: 'Title', exact: true }).fill(title)
  await page.evaluate(() => { (window as any).previewWorkboardTest.failEventWrites = true })
  await dialog(page).getByRole('button', { name: 'Create action', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('Fixture event publication failed')
  const before = Object.keys((await state(page)).disk.files).filter(path => /\/artifacts\/actions\/[^/]+\/action\.html$/.test(path))
  expect(before).toHaveLength(1)
  await expect(card(page)).toHaveCount(0)

  await page.evaluate(() => { (window as any).previewWorkboardTest.failEventWrites = false })
  await dialog(page).getByRole('button', { name: 'Create action', exact: true }).click()
  await expect(card(page)).toBeVisible()
  const after = Object.keys((await state(page)).disk.files).filter(path => /\/artifacts\/actions\/[^/]+\/action\.html$/.test(path))
  expect(after).toEqual(before)
  await card(page).click()
  await expect(page.getByRole('status', { name: 'Opened artifact' })).toHaveText(before[0].replace('|C:/Projects/alpha/', ''))
})

test('the real preview submits notebook requirements with its action context as one agent message', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/__assets/**', async route => {
    const asset = new URL(route.request().url()).pathname.split('/').at(-1)!
    if (!['notebook.js', 'notebook.css', 'katex.min.js', 'katex.min.css'].includes(asset)) return route.fulfill({ status: 404, body: '' })
    await route.fulfill({ path: resolve('vendor/HTML-VibeCoding/codex/en/skills/html-kit/assets', asset) })
  })
  await page.route('**/artifacts/actions/**/action.html', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(1))
    const html = await page.evaluate(path => (window as any).previewWorkboardTest.disk().files[`|C:/Projects/alpha/${path}`], relative)
    await route.fulfill({ contentType: 'text/html', body: html })
  })
  await page.goto(fixture + '?screen')
  await createAction(page)
  const created = await page.evaluate(() => {
    const disk = (window as any).previewWorkboardTest.disk()
    return Object.entries(disk.files).filter(([path]) => path.includes('/.linco/workboard/events/') && path.endsWith('.json'))
      .map(([, content]) => JSON.parse(String(content))).find(event => event.type === 'create')
  })
  await page.evaluate(path => (window as any).previewWorkboardTest.addNotebookCell(path,
    { type: 'md', text: 'Please keep the alternative approach available.' }), created.patch.actionArtifact)
  await card(page).click()
  const preview = page.frameLocator('iframe[title="preview"]')
  await expect(preview.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(preview.locator('body')).toContainText('Please keep the alternative approach available.')
  expect((await state(page)).submitted).toEqual([])
  await page.getByRole('button', { name: 'Submit to Agent', exact: true }).click()
  await expect.poll(async () => (await state(page)).submitted.length).toBe(1)
  const prompt = (await state(page)).submitted[0]
  expect(prompt).toContain(created.taskId)
  expect(prompt).toContain(created.patch.actionArtifact)
  expect(prompt).toContain('check the new requirements I added in it')
  expect(prompt).toContain('write each answer directly below its requirement')
  expect(prompt).toContain('.linco/workboard/events/')
  expect(prompt).not.toMatch(/[\r\n]/)
  expect(errors).toEqual([])
})

test('earlier persisted history remains accessible and a clean open form receives live agent progress', async ({ page }) => {
  await page.goto(fixture)
  await createAction(page)
  await page.evaluate(async () => { await (window as any).previewWorkboardTest.publishHistory(55) })
  await page.reload()
  await openActionDetails(page)
  const history = dialog(page).locator('.pwb-history')
  await expect(history.locator(':scope > li')).toHaveCount(50)
  await expect(history.getByText('Persisted adjustment 1', { exact: true })).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Show earlier history', exact: true }).click()
  await expect(history.locator(':scope > li')).toHaveCount(56)
  await expect(history.getByText('Persisted adjustment 1', { exact: true })).toBeVisible()
  await expect(history.getByText('Created action', { exact: true })).toBeVisible()

  await page.evaluate(async () => {
    await (window as any).previewWorkboardTest.publishAgentProgress('The agent saved a fresh progress report while this clean form was open.')
    window.dispatchEvent(new Event('focus'))
  })
  await expect(dialog(page).getByRole('textbox', { name: 'Latest progress', exact: true }))
    .toHaveValue('The agent saved a fresh progress report while this clean form was open.')
  await expect(dialog(page).getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  expect((await state(page)).submitted).toEqual([])
})
