import { expect, test } from '@playwright/test'

test('project onboarding stays in demo memory and preserves the scripted garden request', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Water Basil', exact: true })).toBeVisible({ timeout: 120000 })
  await expect.poll(() => page.evaluate(() => (window as any).__workbench.calls.filter((call: any) => call.cmd === 'term_start').length)).toBeGreaterThan(0)

  const installed = await page.evaluate(async () => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke
    const root = 'C:/Projects/linco'
    const entries = await invoke('fs_list_dir', { path: root })
    const workboard = await invoke('fs_list_dir', { path: `${root}/.linco/workboard` })
    return {
      entries: entries.map((entry: any) => entry.name),
      workboard: workboard.map((entry: any) => entry.name),
      instructions: await invoke('fs_read_file', { path: `${root}/.linco/workboard/INSTRUCTIONS.md` }),
      template: await invoke('fs_read_file', { path: `${root}/.linco/workboard/notebook.html` }),
      agents: await invoke('fs_read_file', { path: `${root}/AGENTS.md` }),
      claude: await invoke('fs_read_file', { path: `${root}/CLAUDE.md` }),
      readme: await invoke('fs_read_file', { path: `${root}/README.md` }),
      changes: (await invoke('git_status', { cwd: root })).files,
    }
  })
  expect(installed.entries).toEqual(expect.arrayContaining(['.linco', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'src']))
  expect(installed.entries.some((name: string) => name.endsWith('.tmp'))).toBe(false)
  expect(installed.workboard.sort()).toEqual(['INSTRUCTIONS.md', 'notebook.html'])
  expect(installed.instructions).toContain('Before substantive work')
  expect(installed.template).toContain('HtmlVibeNotebook.mount')
  expect(installed.agents).toContain('.linco/workboard/INSTRUCTIONS.md')
  expect(installed.claude).toContain('.linco/workboard/INSTRUCTIONS.md')
  expect(installed.readme).toContain('# Pocket Garden')
  expect(installed.changes).toEqual([])
  await expect(page.locator('.demo-notice')).toContainText('No AI calls, shell execution, or account connections')

  await page.getByRole('button', { name: 'Add a sunflower', exact: false }).click()
  await page.locator('#agent-composer').press('Enter')
  await expect(page.getByRole('button', { name: 'Water Sunflower', exact: true })).toBeVisible()
  await expect(page.locator('.demo-notice')).toContainText('No AI model was called')
  const sent = await page.evaluate(async () => {
    const fixture = (window as any).__workbench
    const invoke = (window as any).__TAURI_INTERNALS__.invoke
    return {
      text: fixture.calls.filter((call: any) => call.cmd === 'term_write').map((call: any) => call.args.data).join(''),
      changes: (await invoke('git_status', { cwd: 'C:/Projects/linco' })).files.map((file: any) => file.path),
      workboard: (await invoke('fs_list_dir', { path: 'C:/Projects/linco/.linco/workboard' })).map((entry: any) => entry.name),
    }
  })
  expect(sent.text.match(/Add a sunflower/g)).toHaveLength(1)
  expect(sent.text.match(/Linco project workboard/g)).toHaveLength(1)
  expect(sent.changes).toEqual(['src/garden.json'])
  expect(sent.workboard.sort()).toEqual(['INSTRUCTIONS.md', 'notebook.html'])

  await page.reload()
  await expect(page.getByRole('button', { name: 'Water Basil', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Water Sunflower', exact: true })).toHaveCount(0)
})
