import { isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'

/** Terminal output is untrusted: never pass paths or arbitrary URI schemes to the OS. */
export function normalizeExternalUrl(value: string): string {
  if (value.length > 8192 || /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/u.test(value)
    || !/^https?:\/\//i.test(value)) {
    throw new Error('Only HTTP and HTTPS web links can be opened from terminal output.')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('This web address is invalid.') }
  if (!url.hostname || url.username || url.password) {
    throw new Error('Web links containing embedded credentials cannot be opened.')
  }
  return url.href
}

export async function openExternalUrl(value: string): Promise<void> {
  const url = normalizeExternalUrl(value)
  if (isTauri()) {
    // This plugin and its scoped HTTP(S) permission already ship in Linco.
    // Do not use window.open inside the desktop webview or run a shell command.
    await open(url)
    return
  }
  // Browser-only previews: open synchronously while the user gesture is active.
  // A blank tab lets us sever opener before navigation AND detect popup blocking.
  const tab = window.open('about:blank', '_blank')
  if (!tab) throw new Error('Your browser blocked the new tab. Copy the link or allow popups for this preview.')
  try {
    tab.opener = null
    tab.location.replace(url)
  } catch (error) {
    tab.close()
    throw error
  }
}
