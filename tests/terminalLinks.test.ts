import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installTerminalLinks } from '../src/lib/terminalLinks'

const fixture = () => {
  const previous = { activate: vi.fn() }
  const terminal = { options: { linkHandler: previous }, hasSelection: vi.fn(() => false), loadAddon: vi.fn() }
  const open = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined)
  const onNotice = vi.fn()
  const links = installTerminalLinks(terminal as unknown as Terminal, { open, onNotice })
  const event = { button: 0, shiftKey: false, preventDefault: vi.fn() } as unknown as MouseEvent
  const activate = (url: string) => terminal.options.linkHandler.activate(event, url)
  return { terminal, open, onNotice, links, event, activate, previous }
}

describe('terminal link gestures', () => {
  it('opens on a normal click and publishes opening + completion', async () => {
    const f = fixture()
    await f.activate('https://example.com')
    expect(f.open).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    expect(f.onNotice.mock.calls.map(c => c[0].status)).toEqual(['opening', 'opened'])
    f.links.dispose()
  })
  it('preserves selection and Shift-click', async () => {
    const f = fixture()
    f.terminal.hasSelection.mockReturnValue(true)
    await f.activate('https://example.com')
    f.terminal.hasSelection.mockReturnValue(false)
    Object.assign(f.event, { shiftKey: true })
    await f.activate('https://example.com')
    Object.assign(f.event, { shiftKey: false, button: 2 })
    await f.activate('https://example.com')
    expect(f.open).not.toHaveBeenCalled()
    f.links.dispose()
  })
  it('does not open two tabs for double-clicks', async () => {
    const f = fixture()
    await Promise.all([f.activate('https://example.com'), f.activate('https://example.com')])
    await f.activate('https://example.com')
    expect(f.open).toHaveBeenCalledOnce()
    f.links.dispose()
  })
  it('reports unsupported OSC links without calling the OS', async () => {
    const f = fixture()
    await f.activate('file:///C:/Windows/notepad.exe')
    expect(f.open).not.toHaveBeenCalled()
    expect(f.onNotice).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: expect.stringContaining('HTTP') }))
    f.links.dispose()
  })
  it('surfaces errors and permits retry after a failure', async () => {
    const f = fixture()
    f.open.mockRejectedValueOnce('permission denied')
    await f.activate('https://example.com')
    expect(f.onNotice).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: 'permission denied' }))
    await f.activate('https://example.com')
    expect(f.onNotice).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'opened' }))
    f.links.dispose()
  })
  it('does not update a disposed view when an open completes', async () => {
    const f = fixture()
    let finish!: () => void
    f.open.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = f.activate('https://example.com')
    f.links.dispose()
    finish()
    await pending
    expect(f.onNotice).toHaveBeenCalledTimes(1)
    expect(f.terminal.options.linkHandler).toBe(f.previous)
  })
})
