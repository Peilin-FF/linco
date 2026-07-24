// 影子快照(Cursor 式本轮 agent 改动 diff)的前端绑定:对应 Rust 的 shadow.rs。
import { invoke } from '@tauri-apps/api/core'

const diffCache = new Map<string, string>()
const diffRequests = new Map<string, { promise: Promise<string>; epoch: number }>()
const diffEpoch = new Map<string, number>()

function normalized(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function diffKey(repo: string, path: string, host?: string): string {
  return `${host || 'local'}\0${normalized(repo)}\0${normalized(path)}`
}

/** 开始新一轮(用户发消息时调):记 git stash create 基线,覆盖上一轮。 */
export function shadowBeginTurn(repo: string, host?: string): Promise<void> {
  invalidateShadowDiff(repo, undefined, host)
  return invoke('shadow_begin_turn', { host: host || null, repo })
}

/** 某文件本轮的 unified diff;无基线/无改动返回空串。 */
export function shadowDiff(repo: string, path: string, host?: string): Promise<string> {
  const key = diffKey(repo, path, host)
  const cached = diffCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const epoch = diffEpoch.get(key) || 0
  const pending = diffRequests.get(key)
  if (pending?.epoch === epoch) return pending.promise
  const request = invoke<string>('shadow_diff', { host: host || null, repo, path })
    .then((diff) => {
      if ((diffEpoch.get(key) || 0) === epoch) diffCache.set(key, diff)
      return diff
    })
    .finally(() => {
      if (diffRequests.get(key)?.promise === request) diffRequests.delete(key)
    })
  diffRequests.set(key, { promise: request, epoch })
  return request
}

/** 同步读取已完成的 diff,供文件首屏避免 file→diff 闪烁。 */
export function peekShadowDiff(repo: string, path: string, host?: string): string | undefined {
  return diffCache.get(diffKey(repo, path, host))
}

/** 文件变化或新一轮开始时失效缓存。path 空表示清理整个仓库。 */
export function invalidateShadowDiff(repo: string, path?: string, host?: string): void {
  const prefix = `${host || 'local'}\0${normalized(repo)}\0`
  if (path) {
    const key = diffKey(repo, path, host)
    diffCache.delete(key)
    diffEpoch.set(key, (diffEpoch.get(key) || 0) + 1)
    return
  }
  const keys = new Set([...diffCache.keys(), ...diffRequests.keys()])
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    diffCache.delete(key)
    diffEpoch.set(key, (diffEpoch.get(key) || 0) + 1)
  }
}

/** 本轮改过的文件:绝对路径→状态字符(M/A/D)。 */
export async function shadowChanged(
  repo: string,
  host?: string
): Promise<Record<string, string>> {
  return invoke('shadow_changed', { host: host || null, repo })
}
