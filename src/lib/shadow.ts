// 影子快照(Cursor 式本轮 agent 改动 diff)的前端绑定:对应 Rust 的 shadow.rs。
import { invoke } from '@tauri-apps/api/core'

/** 开始新一轮(用户发消息时调):记 git stash create 基线,覆盖上一轮。 */
export function shadowBeginTurn(repo: string, host?: string): Promise<void> {
  return invoke('shadow_begin_turn', { host: host || null, repo })
}

/** 某文件本轮的 unified diff;无基线/无改动返回空串。 */
export function shadowDiff(repo: string, path: string, host?: string): Promise<string> {
  return invoke('shadow_diff', { host: host || null, repo, path })
}

/** 本轮改过的文件:绝对路径→状态字符(M/A/D)。 */
export async function shadowChanged(
  repo: string,
  host?: string
): Promise<Record<string, string>> {
  return invoke('shadow_changed', { host: host || null, repo })
}
