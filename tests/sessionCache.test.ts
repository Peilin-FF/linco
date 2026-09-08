import { beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
const rows = [{ id: 'one', title: 'Previous experiment', mtime: 1, size: 10 }]
beforeEach(() => { vi.resetModules(); invoke.mockReset() })

it('keeps history available during refresh and coalesces simultaneous requests', async () => {
  const { agentSessions, cachedAgentSessions } = await import('@/lib/sessions')
  invoke.mockResolvedValueOnce(rows)
  await agentSessions('/project', 'openai')
  let finish!: (value: typeof rows) => void
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = agentSessions('/project', 'openai')
  const second = agentSessions('/project', 'openai')
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(cachedAgentSessions('/project', 'openai')).toEqual(rows)
  finish([])
  await Promise.all([first, second])
  expect(cachedAgentSessions('/project', 'openai')).toEqual([])
})

it('isolates projects, providers and hosts and retains cached history on failure', async () => {
  const { agentSessions, cachedAgentSessions } = await import('@/lib/sessions')
  invoke.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error('offline'))
  await agentSessions('/project', 'openai')
  expect(cachedAgentSessions('/other', 'openai')).toEqual([])
  expect(cachedAgentSessions('/project', 'anthropic')).toEqual([])
  expect(cachedAgentSessions('/project', 'openai', 'remote')).toEqual([])
  await expect(agentSessions('/project', 'openai')).rejects.toThrow('offline')
  expect(cachedAgentSessions('/project', 'openai', '')).toEqual(rows)
})

it('does not resurrect a deleted conversation from an in-flight list', async () => {
  const { agentSessions, agentSessionDelete, cachedAgentSessions } = await import('@/lib/sessions')
  invoke.mockResolvedValueOnce(rows)
  await agentSessions('/project', 'openai')
  let finish!: (value: typeof rows) => void
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(undefined)
  const listing = agentSessions('/project', 'openai')
  await agentSessionDelete('/project', 'openai', 'one')
  expect(cachedAgentSessions('/project', 'openai')).toEqual([])
  finish(rows)
  expect(await listing).toEqual([])
  // Restoring a session file externally should be reflected by a fresh list.
  invoke.mockResolvedValueOnce(rows)
  expect(await agentSessions('/project', 'openai')).toEqual(rows)
})

it('preserves history if deletion fails and bounds cache retention', async () => {
  const { agentSessions, agentSessionDelete, cachedAgentSessions } = await import('@/lib/sessions')
  invoke.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error('read only'))
  await agentSessions('/project', 'openai')
  await expect(agentSessionDelete('/project', 'openai', 'one')).rejects.toThrow('read only')
  expect(cachedAgentSessions('/project', 'openai')).toEqual(rows)
  for (let i = 0; i < 100; i++) cachedAgentSessions(`/other/${i}`, 'openai')
  expect(cachedAgentSessions('/project', 'openai')).toEqual([])
})
