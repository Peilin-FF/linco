import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { overleafMergePending, overleafPublish, overleafPull, shouldRetryOverleafMerge } from '../src/lib/latex'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const call = vi.mocked(invoke)
beforeEach(() => { call.mockReset() })

describe('safe, quiet paper synchronization', () => {
  it('refuses to write through an older desktop backend', async () => {
    call.mockRejectedValue('Command overleaf_sync_capabilities not found')
    await expect(overleafPull('/paper')).rejects.toThrow('updated desktop backend')
    await expect(overleafPublish('/paper', 'saved')).rejects.toThrow('updated desktop backend')
    expect(call.mock.calls.map(([command]) => command)).toEqual(['overleaf_sync_capabilities', 'overleaf_sync_capabilities'])
  })

  it('checks capability before preserving the existing local and remote payloads', async () => {
    const info = { connected: true, ahead: 0, behind: 0 }
    call.mockImplementation(async command => command === 'overleaf_sync_capabilities' ? 1 : info)
    await expect(overleafPull('/paper', ' token ', 'lab')).resolves.toEqual(info)
    expect(call).toHaveBeenNthCalledWith(2, 'overleaf_pull', { repo: '/paper', host: 'lab', token: 'token' })
    await overleafPublish('/local', 'checkpoint')
    expect(call).toHaveBeenNthCalledWith(4, 'overleaf_publish', { repo: '/local', host: null, token: null, message: 'checkpoint' })
  })

  it.each([40, 64])('recognizes pending versions without treating them as auth errors (%i-character IDs)', length => {
    const remoteHead = 'b'.repeat(length)
    expect(overleafMergePending(`OVERLEAF_SYNC_PENDING: ${'a'.repeat(length)} ${remoteHead}. Both versions saved.`)).toEqual({ remoteHead })
  })

  it('keeps legacy overlap messages quiet but never hides real failures', () => {
    expect(overleafMergePending('OVERLEAF_SYNC_CONFLICT: old backend')).toEqual({ remoteHead: null })
    for (const error of ['OVERLEAF_AUTH_REQUIRED', 'OVERLEAF_SYNC_FAILED', 'Git not found', 'connection refused']) {
      expect(overleafMergePending(error)).toBeNull()
    }
  })

  it('does not repeatedly merge an unchanged pair; retries when the collaborator changes it', () => {
    const pending = { remoteHead: 'b'.repeat(40) }
    const result = { remote_head: pending.remoteHead, remote_updated: true, incoming: true, applied: false, pending: true, info: null }
    expect(shouldRetryOverleafMerge(pending, result)).toBe(false)
    expect(shouldRetryOverleafMerge(pending, { ...result, remote_head: 'c'.repeat(40) })).toBe(true)
    expect(shouldRetryOverleafMerge(pending, { ...result, remote_head: undefined })).toBe(false)
  })
})
