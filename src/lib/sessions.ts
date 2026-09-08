// Code agent 会话历史的前端绑定:对应 Rust 的 sessions.rs。
// 按当前项目(cwd)+ 当前 agent(provider)列出 / 删除各家 CLI 存的历史会话。
import { invoke } from '@tauri-apps/api/core'

export interface SessionInfo {
  id: string
  title: string
  /** Unix 秒 */
  mtime: number
  /** 字节数 */
  size: number
}

function h(host?: string): string | undefined {
  return host && host.length > 0 ? host : undefined
}

interface HistoryCacheEntry {
  items?: SessionInfo[]
  pending?: Promise<SessionInfo[]>
  deleted: Set<string>
}
// Memory only: reopening a drawer should not start from an empty list. Keep
// projects, providers and local/remote hosts isolated, with bounded retention.
const historyCache = new Map<string, HistoryCacheEntry>()
function cacheEntry(cwd: string, provider: string, host?: string): HistoryCacheEntry {
  const key = JSON.stringify([h(host) ?? null, cwd, provider])
  const entry = historyCache.get(key) ?? { deleted: new Set<string>() }
  historyCache.delete(key)
  historyCache.set(key, entry)
  if (historyCache.size > 100) historyCache.delete(historyCache.keys().next().value!)
  return entry
}

export function cachedAgentSessions(cwd: string, provider: string, host?: string): SessionInfo[] {
  return cwd ? cacheEntry(cwd, provider, host).items ?? [] : []
}

/** 列出当前项目的历史会话(newest first)。 */
export async function agentSessions(
  cwd: string,
  provider: string,
  host?: string
): Promise<SessionInfo[]> {
  if (!cwd) return []
  const entry = cacheEntry(cwd, provider, host)
  if (!entry.pending) {
    // Deletion guards only apply to an older in-flight response. A fresh
    // request is authoritative (including files restored outside Linco).
    entry.deleted.clear()
    entry.pending = invoke<SessionInfo[]>('agent_sessions', { cwd, provider, host: h(host) })
      .then(items => {
        // A list already in flight must not restore a successfully deleted row.
        entry.items = items.filter(item => !entry.deleted.has(item.id))
        return entry.items
      })
      .finally(() => { entry.pending = undefined })
  }
  return entry.pending
}

/** 删除一个历史会话文件。 */
export async function agentSessionDelete(
  cwd: string,
  provider: string,
  id: string,
  host?: string
): Promise<void> {
  const entry = cacheEntry(cwd, provider, host)
  await invoke('agent_session_delete', { cwd, provider, id, host: h(host) })
  entry.deleted.add(id)
  entry.items = entry.items?.filter(item => item.id !== id)
}
