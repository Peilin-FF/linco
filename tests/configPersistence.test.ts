import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '@/lib/config'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
const base: AppConfig = { agents: [], defaultAgent: '', autoStart: false, cwd: '/project', recentDirs: [], connections: [], activeConnection: '', theme: 'linco-light' }

beforeEach(() => { vi.resetModules(); invoke.mockReset() })

describe('configuration persistence', () => {
  it('does not roll back a theme when an earlier directory selection finishes', async () => {
    const { mergeConfigChange } = await import('@/lib/config')
    const current = { ...base, theme: 'gallery-nord' }
    const next = mergeConfigChange(base, { ...base, cwd: '/new-project', recentDirs: ['/new-project'] }, current)
    expect(next.theme).toBe('gallery-nord')
    expect(next.cwd).toBe('/new-project')
    expect(base.theme).toBe('linco-light')
  })

  it('applies explicit theme changes while preserving other recent preferences', async () => {
    const { mergeConfigChange } = await import('@/lib/config')
    const next = mergeConfigChange(base, { ...base, theme: 'gallery-ayu' }, { ...base, language: 'zh', cwd: '/new-project' })
    expect(next).toMatchObject({ theme: 'gallery-ayu', language: 'zh', cwd: '/new-project' })
  })

  it('serializes saves so the latest theme is the last value written', async () => {
    let finish!: () => void
    invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
    const { saveConfig } = await import('@/lib/config')
    const first = saveConfig({ ...base, theme: 'gallery-nord' })
    const last = saveConfig({ ...base, theme: 'gallery-ayu' })
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([first, last])
    expect(invoke.mock.calls.map(call => call[1].config.theme)).toEqual(['gallery-nord', 'gallery-ayu'])
  })

  it('reports a failed save without blocking a subsequent retry', async () => {
    invoke.mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(undefined)
    const { saveConfig } = await import('@/lib/config')
    await expect(saveConfig(base)).rejects.toThrow('disk unavailable')
    await expect(saveConfig({ ...base, theme: 'gallery-nord' })).resolves.toBeUndefined()
  })
})
