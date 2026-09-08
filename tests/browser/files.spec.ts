import { expect, test, type Page } from '@playwright/test'

test.setTimeout(45000)

test.beforeEach(async ({ page }) => {
  await page.route('**/__index__', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Project preview</p>' }))
})

async function openFiles(page: Page, theme = 'linco-light') {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/tests/browser/workbench.html?files&theme=${theme}`)
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[data-file-entry="README.md"]')).toBeVisible()
  return errors
}

async function openPython(page: Page) {
  await page.locator('[data-file-entry="scripts"]').click()
  await page.locator('[data-file-entry="train.py"]').click()
  await expect(page.locator('[data-workspace-view="files"] .cm-content[contenteditable="true"]')).toContainText('run_experiment')
}

const shellStarts = (page: Page) => page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_start' && c.args.id.startsWith('shell-')))
const shellKills = (page: Page) => page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_kill' && c.args.id.startsWith('shell-')))

async function assertSplitFits(page: Page) {
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    return { files: bounds('[data-workspace-view="files"]'), terminal: bounds('#workspace-terminal'), canvas: bounds('.workspace-canvas') }
  })
  expect(layout.files.height).toBeGreaterThanOrEqual(130)
  expect(layout.terminal.height).toBeGreaterThanOrEqual(80)
  expect(layout.files.bottom).toBeLessThanOrEqual(layout.terminal.y - 7)
  expect(layout.terminal.bottom).toBeLessThanOrEqual(layout.canvas.bottom + 1)
  expect(layout.terminal.right).toBeLessThanOrEqual(layout.canvas.right + 1)
  expect(layout.files.x).toBe(layout.terminal.x)
}

for (const theme of ['linco-light', 'linco-dark']) {
  test(`file and folder identities stay compact and readable in ${theme}`, async ({ page }) => {
    const errors = await openFiles(page, theme)
    const fileIcon = (name: string) => page.locator(`[data-file-entry="${name}"] > [data-file-icon]`)
    for (const [name, kind] of [['README.md', 'markdown'], ['index.html', 'html'], ['.gitignore', 'git'], ['requirements_qwen3.5.txt', 'python'], ['plot.png', 'image'], ['package.json', 'package']]) {
      await expect(fileIcon(name)).toHaveAttribute('data-file-icon', kind)
      await expect(fileIcon(name)).toHaveAttribute('aria-hidden', 'true')
      await expect(fileIcon(name)).toHaveCSS('width', '16px')
    }
    const folder = page.locator('[data-file-entry="tests"] > [data-folder-icon]')
    await expect(folder).toHaveAttribute('data-folder-open', 'false')
    await page.locator('[data-file-entry="tests"]').click()
    await expect(folder).toHaveAttribute('data-folder-open', 'true')
    await expect(fileIcon('test_causal_event_order.py')).toHaveAttribute('data-file-icon', 'python')
    await openPython(page)
    const python = fileIcon('train.py')
    const colors = await Promise.all([python, fileIcon('index.html'), fileIcon('README.md')].map((icon) => icon.evaluate((node) => getComputedStyle(node).color)))
    expect(new Set(colors).size).toBe(3)
    const tab = page.locator('[data-workspace-view="files"] [title$="/scripts/train.py"]')
    await expect(tab.locator('[data-file-icon="python"]')).toHaveCount(1)
    expect(await tab.locator('[data-file-icon]').evaluate((node) => getComputedStyle(node).color)).toBe(colors[0])
    // Git's M/A text remains separate from the file-type color.
    await expect(page.locator('[data-file-entry="train.py"]')).toContainText('M')
    await page.getByRole('button', { name: 'Show terminal in Files', exact: true }).click()
    await expect(page.locator('#workspace-terminal [data-terminal-kind="shell"] .xterm-screen')).toBeVisible()
    await assertSplitFits(page)
    await page.screenshot({ path: `artifacts/files-${theme}.png` })
    expect(errors).toEqual([])
  })
}

test('search results and Git changes use the same file-type icons', async ({ page }) => {
  const errors = await openFiles(page)
  const files = page.locator('[data-workspace-view="files"]')
  await files.locator('input').first().fill('baseline')
  await expect(files.getByText('train.py', { exact: true })).toBeVisible()
  for (const kind of ['python', 'html', 'markdown']) await expect(files.locator(`[data-file-icon="${kind}"]`)).toHaveCount(1)
  await page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name: 'Git', exact: true }).click()
  const git = page.locator('[data-workspace-view="git"]')
  for (const kind of ['python', 'html', 'markdown']) await expect(git.locator(`[data-file-icon="${kind}"]`)).toHaveCount(1)
  expect(errors).toEqual([])
})

test('shell and Python files have distinct syntax colors and a true code font', async ({ page }) => {
  const errors = await openFiles(page)
  await openPython(page)
  const editor = page.locator('[data-workspace-view="files"] .cm-editor:visible')
  await expect(editor.locator('.cm-scroller')).toHaveCSS('font-family', /JetBrains Mono/)
  const pythonColors = await editor.locator('.cm-line span').evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).color))])
  expect(pythonColors.length).toBeGreaterThanOrEqual(3)
  await page.locator('[data-file-entry="run.sh"]').click()
  await expect(page.locator('[data-editor-language="Shell"]')).toBeVisible()
  await expect(editor.locator('.cm-content')).toContainText('export SEED=42')
  const shellColors = await editor.locator('.cm-line span').evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).color))])
  expect(shellColors.length).toBeGreaterThanOrEqual(3)
  await editor.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('# keep this draft')
  await expect(page.getByRole('button', { name: 'Wrap code lines', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.locator('.cm-content')).toHaveClass(/cm-lineWrapping/)
  await page.getByRole('button', { name: 'Wrap code lines', exact: true }).click()
  await expect(editor.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/)
  await page.getByRole('button', { name: 'Wrap code lines', exact: true }).click()
  await expect(editor.locator('.cm-content')).toHaveClass(/cm-lineWrapping/)
  await expect(editor.locator('.cm-content')).toContainText('# keep this draft')
  await page.screenshot({ path: 'artifacts/files-shell-highlighted.png' })
  expect(errors).toEqual([])
})

test('long file lines wrap to the available width without changing the text', async ({ page }) => {
  const errors = await openFiles(page)
  await openPython(page)
  const editor = page.locator('[data-workspace-view="files"] .cm-editor:visible')
  const content = editor.locator('.cm-content')
  const longLine = '# ' + 'experiment_result_'.repeat(70)
  await content.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n' + longLine)
  const line = editor.locator('.cm-line').filter({ hasText: longLine })
  await expect.poll(() => line.evaluate(node => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight))).toBeGreaterThan(2)
  await page.setViewportSize({ width: 900, height: 700 })
  await expect.poll(() => editor.locator('.cm-scroller').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
  await expect(line).toHaveText(longLine)
  await page.getByRole('button', { name: 'Wrap code lines', exact: true }).click()
  await expect(content).not.toHaveClass(/cm-lineWrapping/)
  await expect(line).toHaveText(longLine)
  await page.getByRole('button', { name: 'Wrap code lines', exact: true }).click()
  await expect(content).toHaveClass(/cm-lineWrapping/)
  await expect(line).toHaveText(longLine)
  expect(errors).toEqual([])
})

test('the Files terminal resizes and preserves both the editor and PTY when hidden or shown full-size', async ({ page }) => {
  const errors = await openFiles(page)
  await openPython(page)
  await page.locator('[data-workspace-view="files"] .cm-content[contenteditable="true"]').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n# draft stays open')
  await page.getByRole('button', { name: 'Show terminal in Files', exact: true }).click()
  const terminal = page.locator('#workspace-terminal')
  await expect(terminal).toHaveAttribute('data-terminal-docked', 'true')
  await expect.poll(async () => (await shellStarts(page)).length).toBe(1)
  const first = (await shellStarts(page))[0]
  expect(first.args.cwd).toBe('C:\\Projects\\linco')
  await terminal.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo files')
  await expect.poll(() => page.evaluate((id) => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_write' && c.args.id === id).map((c: any) => c.args.data).join(''), first.args.id)).toBe('echo files')
  await terminal.locator('[data-terminal-kind="shell"]').evaluate((node) => { (window as any).__filesShellNode = node })
  await assertSplitFits(page)
  const before = (await terminal.boundingBox())!.height
  const separator = page.getByRole('separator', { name: 'Resize Files terminal' })
  await separator.focus()
  await page.keyboard.press('ArrowUp')
  expect((await terminal.boundingBox())!.height).toBe(before + 20)
  const handle = (await separator.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 35)
  await page.mouse.up()
  expect((await terminal.boundingBox())!.height).toBeGreaterThan(before + 20)
  await page.getByRole('button', { name: 'Hide terminal panel', exact: true }).click()
  await expect(terminal).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByRole('button', { name: 'Show terminal in Files', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Show terminal in Files', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Workspace tools' })
  await nav.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(terminal).toHaveAttribute('data-terminal-docked', 'false')
  await nav.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(terminal).toHaveAttribute('data-terminal-docked', 'true')
  await expect(page.locator('[data-workspace-view="files"] .cm-content[contenteditable="true"]')).toContainText('# draft stays open')
  expect(await terminal.locator('[data-terminal-kind="shell"]').evaluate((node) => node === (window as any).__filesShellNode)).toBe(true)
  expect((await shellStarts(page)).length).toBe(1)
  expect(await shellKills(page)).toEqual([])
  await page.setViewportSize({ width: 900, height: 600 })
  await assertSplitFits(page)
  await page.screenshot({ path: 'artifacts/files-compact.png' })
  expect(errors).toEqual([])
})

test('folder context action opens a shell in that folder without leaving Files', async ({ page }) => {
  const errors = await openFiles(page)
  await page.locator('[data-file-entry="scripts"]').click({ button: 'right' })
  await page.getByText('Open in terminal', { exact: true }).click()
  await expect(page.locator('#workspace-terminal')).toHaveAttribute('data-terminal-docked', 'true')
  await expect.poll(async () => (await shellStarts(page)).length).toBe(1)
  expect((await shellStarts(page))[0].args.cwd).toBe('C:\\Projects\\linco/scripts')
  await expect(page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-current', 'page')
  expect(errors).toEqual([])
})

test('changing project opens a separate terminal and an empty project panel does not kill other sessions', async ({ page }) => {
  const errors = await openFiles(page)
  await page.getByRole('button', { name: 'Show terminal in Files', exact: true }).click()
  await expect.poll(async () => (await shellStarts(page)).length).toBe(1)
  const first = (await shellStarts(page))[0].args.id
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.locator('.workspace-drawer').getByText('website', { exact: true }).click()
  await expect(page.locator('.workspace-drawer')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show terminal in Files', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show terminal in Files', exact: true }).click()
  await expect.poll(async () => (await shellStarts(page)).length).toBe(2)
  const second = (await shellStarts(page))[1]
  expect(second.args.cwd).toBe('C:\\Projects\\website')
  await page.getByRole('button', { name: 'Close terminal: website', exact: true }).click()
  await expect(page.getByText('Open a terminal in this project.', { exact: true })).toBeVisible()
  await expect(page.locator(`[data-terminal-id="${first}"]`)).toHaveCount(1)
  await expect.poll(async () => (await shellKills(page)).length).toBe(1)
  expect((await shellKills(page))[0].args.id).toBe(second.args.id)
  expect(errors).toEqual([])
})

test('Files and its terminal controls have Chinese labels', async ({ page }) => {
  await page.goto('/tests/browser/workbench.html?files&lang=zh')
  await page.getByRole('button', { name: '编程', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '当前工作空间的工具' }).getByRole('button', { name: '文件', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '在文件页显示终端', exact: true }).click()
  await expect(page.getByRole('button', { name: '隐藏文件页终端', exact: true })).toBeVisible()
})
