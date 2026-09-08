import { expect, test, type Page } from '@playwright/test'

test.setTimeout(30000)
async function output(page: Page, id: string, text: string) {
  await page.evaluate(({ id, text }) => (window as any).__terminalOutput(id, text), { id, text })
}

for (const theme of ['linco-light', 'linco-dark']) {
  test(`interactive terminal renders plain output in color (${theme})`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__index__', route => route.fulfill({ contentType: 'text/html', body: '<p>Preview</p>' }))
    await page.goto(`/tests/browser/workbench.html?theme=${theme}`)
    const terminal = page.locator('[data-terminal-kind="chat"]:visible')
    await expect(terminal.locator('.xterm')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_start').length)).toBeGreaterThan(0)
    // Wait for the initial native fixture, then replace its screen.
    await expect(terminal.locator('[data-output-tone="success"]').first()).toBeAttached()
    const id = (await terminal.getAttribute('data-terminal-id'))!
    await output(page, id, '\x1b[2J\x1b[H2026-09-08 13:20:40 Experiment baseline\r\nstep=40 loss=0.194 reward=0.81\r\nGPU: 45GiB util=95%\r\n[WARNING] Only 12 evaluation examples\r\n[ERROR] Worker retry required\r\nCompleted checkpoint\r\n[state-dump] total=200 time=0.00ms\r\n$ ')
    for (const tone of ['number', 'label', 'time', 'warning', 'error', 'success', 'debug']) {
      await expect(terminal.locator(`[data-output-tone="${tone}"]`).first()).toBeAttached()
    }
    await page.screenshot({ path: `artifacts/terminal-highlights-${theme}.png` })
    // ANSI-styled output and the current input line are never overwritten.
    await output(page, id, '\x1b[2J\x1b[H\x1b[35mERROR source styled 42\x1b[0m\r\n$ loss=12')
    await expect(terminal.locator('[data-output-tone]')).toHaveCount(0)
    // Full-screen tools own their colors. Restoring normal screen restores hints.
    await output(page, id, '\r\nstep=3 loss=0.5\r\n')
    await expect(terminal.locator('[data-output-tone="number"]').first()).toBeAttached()
    await output(page, id, '\x1b[?1049hERROR alternate screen 12\r\n')
    await expect(terminal.locator('[data-output-tone]')).toHaveCount(0)
    await output(page, id, '\x1b[?1049l')
    await expect(terminal.locator('[data-output-tone="number"]').first()).toBeAttached()
    await terminal.locator('textarea').focus()
    await page.keyboard.type('hello')
    await expect.poll(() => page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_write').map((c: any) => c.args.data).join(''))).toContain('hello')
    expect(await page.evaluate(() => (window as any).__workbench.calls.filter((c: any) => c.cmd === 'term_kill').length)).toBe(0)
    expect(errors).toEqual([])
  })
}
