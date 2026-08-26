import { describe, expect, it, vi } from 'vitest'
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))

import { enableTerminalWebgl } from '@/lib/terminalWebgl'

interface FakeAddon extends ITerminalAddon {
  dispose: ReturnType<typeof vi.fn>
  loseContext: () => void
  onContextLoss: (listener: () => void) => IDisposable
}

function fakeAddon(): FakeAddon {
  let listener: (() => void) | undefined
  return {
    activate: vi.fn(),
    dispose: vi.fn(),
    onContextLoss: (next) => {
      listener = next
      return { dispose: vi.fn(() => (listener = undefined)) }
    },
    loseContext: () => listener?.()
  }
}

function fakeTerminal(): Terminal {
  return {
    rows: 24,
    loadAddon: vi.fn(),
    refresh: vi.fn()
  } as unknown as Terminal
}

describe('enableTerminalWebgl', () => {
  it('activates WebGL and reports the renderer', () => {
    const terminal = fakeTerminal()
    const addon = fakeAddon()
    const changes: string[] = []
    const handle = enableTerminalWebgl(terminal, (kind) => changes.push(kind), () => addon)

    expect(terminal.loadAddon).toHaveBeenCalledWith(addon)
    expect(handle.kind).toBe('webgl')
    expect(changes).toEqual(['webgl'])
  })

  it('falls back to canvas when WebGL initialization fails', () => {
    const terminal = fakeTerminal()
    const changes: string[] = []
    const handle = enableTerminalWebgl(terminal, (kind) => changes.push(kind), () => {
      throw new Error('WebGL2 unavailable')
    })

    expect(handle.kind).toBe('canvas')
    expect(changes).toEqual(['canvas'])
    expect(terminal.loadAddon).not.toHaveBeenCalled()
  })

  it('restores the canvas renderer after context loss', () => {
    const terminal = fakeTerminal()
    const addon = fakeAddon()
    const changes: string[] = []
    const handle = enableTerminalWebgl(terminal, (kind) => changes.push(kind), () => addon)

    addon.loseContext()
    expect(handle.kind).toBe('canvas')
    expect(addon.dispose).toHaveBeenCalledOnce()
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
    expect(changes).toEqual(['webgl', 'canvas'])
  })
})
