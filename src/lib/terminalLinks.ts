import { WebLinksAddon } from '@xterm/addon-web-links'
import type { IDisposable, Terminal } from '@xterm/xterm'
import { normalizeExternalUrl, openExternalUrl } from './externalLinks'

export interface TerminalLinkNotice {
  url: string
  status: 'hover' | 'opening' | 'opened' | 'error'
  error?: string
}

interface LinkOptions {
  onNotice: (notice: TerminalLinkNotice | null) => void
  open?: (url: string) => Promise<void>
}

/** One handler for plain URLs and OSC 8 links (including labeled agent citations). */
export function installTerminalLinks(terminal: Terminal, options: LinkOptions): IDisposable {
  const previous = terminal.options.linkHandler
  const open = options.open ?? openExternalUrl
  let disposed = false
  let opening = false
  let lastOpened = ''
  let lastOpenedAt = 0
  const notify = (notice: TerminalLinkNotice | null): void => {
    if (!disposed) options.onNotice(notice)
  }
  const activate = async (event: MouseEvent, raw: string): Promise<void> => {
    // Preserve drag-to-select, Shift selection and right-click. A normal click opens.
    if (disposed || event.button !== 0 || event.shiftKey || terminal.hasSelection() || opening) return
    event.preventDefault()
    let url = raw
    try {
      url = normalizeExternalUrl(raw)
      if (url === lastOpened && Date.now() - lastOpenedAt < 750) return
      opening = true
      notify({ url, status: 'opening' })
      await open(url)
      lastOpened = url
      lastOpenedAt = Date.now()
      notify({ url, status: 'opened' })
    } catch (error) {
      notify({ url, status: 'error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      opening = false
    }
  }
  const hover = (_event: MouseEvent, raw: string): void => {
    let url = raw
    try { url = normalizeExternalUrl(raw) } catch { /* activation will explain the failure */ }
    notify({ url, status: 'hover' })
  }
  const leave = (): void => notify(null)
  const handler = { activate, hover, leave, allowNonHttpProtocols: true }
  terminal.options.linkHandler = handler
  const addon = new WebLinksAddon(activate, { hover, leave })
  terminal.loadAddon(addon)
  return {
    dispose() {
      disposed = true
      addon.dispose()
      if (terminal.options.linkHandler === handler) terminal.options.linkHandler = previous
    }
  }
}
