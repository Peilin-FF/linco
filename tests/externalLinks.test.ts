import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeExternalUrl, openExternalUrl } from '../src/lib/externalLinks'

const native = vi.hoisted(() => ({ open: vi.fn(), isTauri: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: native.open }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native.isTauri }))

beforeEach(() => { vi.resetAllMocks(); native.isTauri.mockReturnValue(true) })
afterEach(() => vi.unstubAllGlobals())

describe('untrusted terminal URLs', () => {
  it.each([
    ['https://visualstudio.microsoft.com/visual-cpp-build-tools/', 'https://visualstudio.microsoft.com/visual-cpp-build-tools/'],
    ['http://localhost:1420/a?q=x&b=2#test', 'http://localhost:1420/a?q=x&b=2#test'],
    ['HTTPS://EXAMPLE.COM', 'https://example.com/'],
    ['https://example.com/a%20b?q=a%26b', 'https://example.com/a%20b?q=a%26b'],
    ['http://[::1]:1420/', 'http://[::1]:1420/']
  ])('normalizes %s', (input, output) => expect(normalizeExternalUrl(input)).toBe(output))

  it.each([
    'javascript:alert(1)', 'data:text/html,test', 'file:///C:/Windows/notepad.exe',
    'ms-settings:privacy', 'mailto:user@example.com', 'C:/Windows/notepad.exe',
    '//example.com', 'https://user:secret@example.com', 'https://user@example.com',
    'https://example.com\nhttps://evil.test', 'https://example.com\x00x',
    'https://example.com/\u202Eexe', 'https://example.com/\u2066spoof',
    'https://example.com/a b', 'https:\\example.com', 'https://', '',
    'https://example.com/' + 'x'.repeat(8192)
  ])('rejects unsafe input without invoking the OS: %s', async input => {
    await expect(openExternalUrl(input)).rejects.toThrow()
    expect(native.open).not.toHaveBeenCalled()
  })
})

describe('opening web links', () => {
  it('uses the existing desktop plugin, without a webview popup or shell command', async () => {
    const popup = vi.fn()
    vi.stubGlobal('window', { open: popup })
    await openExternalUrl('https://example.com')
    expect(native.open).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    expect(popup).not.toHaveBeenCalled()
  })

  it('propagates native permission and OS errors for visible feedback', async () => {
    native.open.mockRejectedValue('shell.open not allowed')
    await expect(openExternalUrl('https://example.com')).rejects.toBe('shell.open not allowed')
  })

  it('opens browser previews synchronously and clears opener before navigating', async () => {
    native.isTauri.mockReturnValue(false)
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    tab.location.replace.mockImplementation(() => expect(tab.opener).toBe(null))
    const popup = vi.fn(() => tab)
    vi.stubGlobal('window', { open: popup })
    const result = openExternalUrl('https://example.com')
    expect(popup).toHaveBeenCalledExactlyOnceWith('about:blank', '_blank')
    await result
    expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    expect(native.open).not.toHaveBeenCalled()
  })

  it('reports popup blocking rather than silently doing nothing', async () => {
    native.isTauri.mockReturnValue(false)
    vi.stubGlobal('window', { open: vi.fn(() => null) })
    await expect(openExternalUrl('https://example.com')).rejects.toThrow('blocked')
  })

  it('closes a blank tab if navigation fails', async () => {
    native.isTauri.mockReturnValue(false)
    const tab = { opener: {}, location: { replace: vi.fn(() => { throw new Error('navigation denied') }) }, close: vi.fn() }
    vi.stubGlobal('window', { open: vi.fn(() => tab) })
    await expect(openExternalUrl('https://example.com')).rejects.toThrow('navigation denied')
    expect(tab.close).toHaveBeenCalledOnce()
  })
})
