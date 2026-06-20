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

/** 列出当前项目的历史会话(newest first)。 */
export async function agentSessions(
  cwd: string,
  provider: string,
  host?: string
): Promise<SessionInfo[]> {
  if (!cwd) return []
  return invoke('agent_sessions', { cwd, provider, host: h(host) })
}

/** 删除一个历史会话文件。 */
export async function agentSessionDelete(
  cwd: string,
  provider: string,
  id: string,
  host?: string
): Promise<void> {
  await invoke('agent_session_delete', { cwd, provider, id, host: h(host) })
}
