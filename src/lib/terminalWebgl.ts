import { WebglAddon } from '@xterm/addon-webgl'
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'

export type TerminalRendererKind = 'webgl' | 'canvas'

interface WebglAddonLike extends ITerminalAddon {
  onContextLoss: (listener: () => void) => IDisposable
}

export interface TerminalWebglHandle {
  readonly kind: TerminalRendererKind
  dispose: () => void
}

type WebglFactory = () => WebglAddonLike

export function enableTerminalWebgl(
  terminal: Terminal,
  onChange?: (kind: TerminalRendererKind) => void,
  createAddon: WebglFactory = () => new WebglAddon()
): TerminalWebglHandle {
  let addon: WebglAddonLike | undefined
  let contextLossSubscription: IDisposable | undefined
  let kind: TerminalRendererKind = 'canvas'

  const setKind = (next: TerminalRendererKind): void => {
    kind = next
    onChange?.(next)
  }

  try {
    addon = createAddon()
    contextLossSubscription = addon.onContextLoss(() => {
      contextLossSubscription?.dispose()
      contextLossSubscription = undefined
      addon?.dispose()
      addon = undefined
      setKind('canvas')
      terminal.refresh(0, Math.max(0, terminal.rows - 1))
    })
    terminal.loadAddon(addon)
    setKind('webgl')
  } catch {
    contextLossSubscription?.dispose()
    addon?.dispose()
    addon = undefined
    setKind('canvas')
  }

  return {
    get kind() {
      return kind
    },
    dispose: () => {
      contextLossSubscription?.dispose()
      contextLossSubscription = undefined
      addon?.dispose()
      addon = undefined
    }
  }
}
