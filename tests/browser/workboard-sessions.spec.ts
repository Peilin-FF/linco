import { expect, test, type Page } from '@playwright/test'

test.setTimeout(45000)
test.beforeEach(async ({ page }) => page.setDefaultTimeout(10000))
const fixture = '/tests/browser/workboard-sessions.html'
const input = (page: Page) => page.locator('#agent-composer')
const inspect = (page: Page) => page.evaluate(() => {
  const state = (window as any).workboardSessionsTest
  return { calls: state.calls, starts: state.starts, disk: state.disk(), existingAgents: state.existingAgents }
})
const writes = async (page: Page, since = 0) => (await inspect(page)).calls.slice(since)
  .filter((call: any) => call.command === 'term_write').map((call: any) => ({ id: call.args.id as string, data: call.args.data as string }))
const instructions = (root: string, host = '') => `${host}|${root}/.linco/workboard/INSTRUCTIONS.md`

async function openApp(page: Page, query = '') {
  await page.goto(fixture + query)
  await expect(page.getByRole('navigation', { name: 'Workspaces', exact: true })).toBeVisible({ timeout: 15000 })
  await expect(input(page)).toBeEnabled()
}

async function selectProject(page: Page, name: string) {
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.locator('.workspace-drawer').getByRole('button', { name, exact: true }).click()
}

async function selectConnection(page: Page, name: string) {
  await page.getByTitle('Switch connection', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Switch connection', exact: true }).getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

async function sendAndRead(page: Page, text: string) {
  const since = (await inspect(page)).calls.length
  await input(page).fill(text)
  await input(page).press('Enter')
  await expect.poll(async () => (await writes(page, since)).at(-1)?.data).toBe('\r')
  await expect(input(page)).toHaveValue('')
  return writes(page, since)
}

function expectTrackedSend(messages: { id: string; data: string }[], text: string) {
  expect(messages).toHaveLength(3)
  expect(messages[0].data).toBe(text)
  expect(messages[1].data).toMatch(/^ Linco project workboard \(session /)
  expect(messages[1].data).toContain('.linco/workboard/INSTRUCTIONS.md')
  expect(messages[1].data).not.toMatch(/[\r\n]/)
  expect(messages[2].data).toBe('\r')
  expect(new Set(messages.map(message => message.id)).size).toBe(1)
  expect(messages.map(message => message.data).join('').split(text)).toHaveLength(2)
}

test('startup installs persistent project instructions before the local agent without inventing actions', async ({ page }) => {
  await openApp(page)
  const state = await inspect(page)
  const root = 'C:/Projects/linco'
  expect(state.disk.files[instructions(root)]).toContain('Reuse the matching action')
  expect(state.disk.files[`|${root}/.linco/workboard/notebook.html`]).toContain('HtmlVibeNotebook.mount(')
  expect(state.disk.files[`|${root}/AGENTS.md`]).toContain(state.existingAgents)
  expect(state.disk.files[`|${root}/CLAUDE.md`]).toContain('LINCO:WORKBOARD:BEGIN')
  const start = state.starts.find((entry: any) => entry.id.startsWith('chat:') && !entry.host)
  expect(start.files).toContain(instructions(root))
  expect(start.files).toContain(`|${root}/.linco/workboard/notebook.html`)
  expect(Object.keys(state.disk.files).filter(path => /\/events\/|\/actions\//.test(path))).toEqual([])
  expect(state.disk.directories.filter((path: string) => /\/events$|\/actions$/.test(path))).toEqual([])
  await page.reload()
  await expect(input(page)).toBeEnabled()
  const reopened = await inspect(page)
  expect(reopened.disk.files[`|${root}/AGENTS.md`].split('<!-- LINCO:WORKBOARD:BEGIN -->')).toHaveLength(2)
  expect(reopened.disk.files[`|${root}/AGENTS.md`]).toContain(reopened.existingAgents)
})

test('a running agent receives each user prompt once and one scoped reminder immediately before Enter', async ({ page }) => {
  await openApp(page)
  const started = (await inspect(page)).starts.length
  const first = await sendAndRead(page, 'Investigate retained drafts TOKEN_731')
  expectTrackedSend(first, 'Investigate retained drafts TOKEN_731')
  const second = await sendAndRead(page, 'Continue the same investigation TOKEN_732')
  expectTrackedSend(second, 'Continue the same investigation TOKEN_732')
  expect(second[0].id).toBe(first[0].id)
  expect((await inspect(page)).starts).toHaveLength(started)
})

test('slash commands, short control replies, and IME confirmation keep their original bytes', async ({ page }) => {
  await openApp(page)
  for (const reply of ['/status', 'yes', '2', '好的']) {
    const messages = await sendAndRead(page, reply)
    expect(messages.map(message => message.data)).toEqual([reply, '\r'])
  }
  const since = (await inspect(page)).calls.length
  await input(page).dispatchEvent('compositionstart')
  await input(page).fill('确认这项调整')
  await input(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 })
  await input(page).dispatchEvent('compositionend')
  await input(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
  await expect(input(page)).toHaveValue('确认这项调整')
  expect((await writes(page, since)).map(message => message.data)).toEqual(['确认这项调整'])
  await input(page).press('Enter')
  await expect.poll(async () => (await writes(page, since)).at(-1)?.data).toBe('\r')
  expectTrackedSend(await writes(page, since), '确认这项调整')
})

test('plain shell messages are sent without agent protocol text', async ({ page }) => {
  await openApp(page, '?plain-shell')
  const messages = await sendAndRead(page, 'pwd')
  expect(messages.map(message => message.data)).toEqual(['pwd', '\r'])
})

test('two local resident sessions keep their drafts, filesystem scope, and send destination separate', async ({ page }) => {
  await openApp(page)
  await input(page).fill('Draft kept for linco')
  await selectProject(page, 'website')
  await expect(input(page)).toBeEnabled()
  await expect(input(page)).toHaveValue('')
  const website = await sendAndRead(page, 'Inspect the website project TOKEN_811')
  expectTrackedSend(website, 'Inspect the website project TOKEN_811')
  expect(website[0].id).toContain('website')
  const rail = page.getByRole('navigation', { name: 'Open sessions', exact: true })
  await rail.getByRole('button', { name: /^linco,/ }).click()
  await expect(input(page)).toHaveValue('Draft kept for linco')
  const since = (await inspect(page)).calls.length
  await input(page).press('Enter')
  await expect.poll(async () => (await writes(page, since)).at(-1)?.data).toBe('\r')
  const resumed = await writes(page, since)
  expect(resumed).toHaveLength(2)
  expect(resumed[0].id).toContain('linco')
  expect(resumed[0].id).not.toBe(website[0].id)
  expect(resumed[0].data).toContain('Linco project workboard')
  const state = await inspect(page)
  expect(state.disk.files[instructions('C:/Projects/linco')]).toBeDefined()
  expect(state.disk.files[instructions('C:/Projects/website')]).toBeDefined()
  expect(Object.keys(state.disk.files).filter(path => /\/events\/|\/actions\//.test(path))).toEqual([])
})

test('SSH authentication starts without filesystem setup, then each ready remote host gets its own instructions', async ({ page }) => {
  await openApp(page, '?remote-a&await-ssh')
  let state = await inspect(page)
  expect(state.starts.some((entry: any) => entry.host === 'lab-a')).toBe(true)
  expect(state.disk.files[instructions('/work/shared', 'lab-a')]).toBeUndefined()
  expect(state.calls.filter((call: any) => call.command.startsWith('fs_') && call.args.host === 'lab-a')).toEqual([])
  const authentication = await sendAndRead(page, 'fixture-authentication-token')
  expect(authentication.map(message => message.data)).toEqual(['fixture-authentication-token', '\r'])
  const remoteStarts = state.starts.filter((entry: any) => entry.host === 'lab-a').length
  await page.evaluate(() => (window as any).workboardSessionsTest.makeRemoteReady('lab-a'))
  await expect.poll(async () => (await inspect(page)).disk.files[instructions('/work/shared', 'lab-a')], { timeout: 15000 }).toBeDefined()
  const tracked = await sendAndRead(page, 'Continue the remote experiment TOKEN_912')
  expectTrackedSend(tracked, 'Continue the remote experiment TOKEN_912')
  expect(tracked[1].data).toContain('remote-a')
  expect((await inspect(page)).starts.filter((entry: any) => entry.host === 'lab-a')).toHaveLength(remoteStarts)
  await selectConnection(page, 'Lab B')
  await expect(input(page)).toBeEnabled()
  await expect.poll(async () => (await inspect(page)).disk.files[instructions('/work/shared', 'lab-b')]).toBeDefined()
  const other = await sendAndRead(page, 'Inspect the other host TOKEN_913')
  expectTrackedSend(other, 'Inspect the other host TOKEN_913')
  expect(other[1].data).toContain('remote-b')
  expect(other[0].id).not.toBe(tracked[0].id)
  state = await inspect(page)
  expect(state.disk.files['lab-b|/work/shared/CLAUDE.md']).toContain('Existing Claude-specific project rule.')
  expect(state.disk.files['|C:/Projects/linco/AGENTS.md']).toBe(state.existingAgents)
  expect(Object.keys(state.disk.files).filter(path => /\/events\/|\/actions\//.test(path))).toEqual([])
})

test('failed setup shows an error, retains the live draft, and retry adds no duplicate user text', async ({ page }) => {
  await openApp(page, '?bootstrap-fail')
  await expect(page.locator('.pwb-tracking-error')).toContainText('Fixture workboard storage is read-only')
  await expect(page.locator('.pwb-tracking-error').getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  const since = (await inspect(page)).calls.length
  await input(page).fill('Keep this draft until tracking is ready TOKEN_441')
  await input(page).press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'Message has not been sent.' })).toContainText('Fixture workboard storage is read-only')
  await expect(input(page)).toHaveValue('Keep this draft until tracking is ready TOKEN_441')
  expect((await writes(page, since)).map(message => message.data)).toEqual(['Keep this draft until tracking is ready TOKEN_441'])
  await page.evaluate(() => { (window as any).workboardSessionsTest.failWrites = false })
  await input(page).press('Enter')
  await expect.poll(async () => (await writes(page, since)).at(-1)?.data).toBe('\r')
  expectTrackedSend(await writes(page, since), 'Keep this draft until tracking is ready TOKEN_441')
  await expect(input(page)).toHaveValue('')
})

test('switching sessions during preparation cancels the pending send and preserves its draft', async ({ page }) => {
  await openApp(page, '?bootstrap-fail')
  await page.evaluate(() => { const fixture = (window as any).workboardSessionsTest; fixture.failWrites = false; fixture.holdWrites = true })
  const since = (await inspect(page)).calls.length
  await input(page).fill('Keep preparation attached to this session TOKEN_551')
  await input(page).press('Enter')
  await expect(input(page)).toBeDisabled()
  await selectProject(page, 'website')
  await page.evaluate(() => (window as any).workboardSessionsTest.releaseWrites())
  await expect(input(page)).toBeEnabled()
  await expect.poll(async () => (await inspect(page)).disk.files[instructions('C:/Projects/linco')]).toBeDefined()
  expect((await writes(page, since)).map(message => message.data)).toEqual(['Keep preparation attached to this session TOKEN_551'])
  await page.getByRole('navigation', { name: 'Open sessions', exact: true }).getByRole('button', { name: /^linco,/ }).click()
  await expect(input(page)).toHaveValue('Keep preparation attached to this session TOKEN_551')
  await input(page).press('Enter')
  await expect.poll(async () => (await writes(page, since)).at(-1)?.data).toBe('\r')
  expectTrackedSend(await writes(page, since), 'Keep preparation attached to this session TOKEN_551')
})

test('the composer stays disabled until the real terminal start resolves', async ({ page }) => {
  await page.goto(fixture + '?hold-start')
  await expect(page.getByRole('navigation', { name: 'Workspaces', exact: true })).toBeVisible({ timeout: 15000 })
  await expect.poll(async () => (await inspect(page)).starts.length).toBeGreaterThan(0)
  await expect(input(page)).toBeDisabled()
  expect(await writes(page)).toEqual([])
  await page.evaluate(() => (window as any).workboardSessionsTest.releaseStarts())
  await expect(input(page)).toBeEnabled()
  expectTrackedSend(await sendAndRead(page, 'First message after the terminal is ready TOKEN_661'), 'First message after the terminal is ready TOKEN_661')
})

test('explicit action requests append the same scoped reminder to their single prompt body', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New action', exact: true }).first().click()
  const action = page.getByRole('dialog')
  await action.getByRole('textbox', { name: 'Title', exact: true }).fill('Verify explicit handoff TOKEN_771')
  await action.getByRole('button', { name: 'Create action', exact: true }).click()
  await page.getByRole('button', { name: 'Action details: Verify explicit handoff TOKEN_771', exact: true }).click()
  const since = (await inspect(page)).calls.length
  await page.getByRole('dialog').getByRole('button', { name: 'Request agent work', exact: true }).click()
  await expect.poll(async () => (await writes(page, since)).some(message => message.data === '\r')).toBe(true)
  const messages = await writes(page, since)
  const bodies = messages.filter(message => message.data !== '\r')
  expect(bodies).toHaveLength(1)
  expect(bodies[0].data).toContain('Verify explicit handoff TOKEN_771')
  expect(bodies[0].data.split('Linco project workboard (session ')).toHaveLength(2)
  expect(bodies[0].data).toContain('.linco/workboard/INSTRUCTIONS.md')
  expect(bodies[0].data).not.toMatch(/[\r\n]/)
  expect(new Set(messages.map(message => message.id)).size).toBe(1)
})
