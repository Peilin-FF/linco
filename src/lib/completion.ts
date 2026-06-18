// 聊天输入框补全的前端绑定:对应 Rust 的 completion.rs。
import { invoke } from '@tauri-apps/api/core'

export interface CompletionData {
  commands: string[]
  skills: string[]
  agents: string[]
}

export interface CompletionItem {
  kind: 'command' | 'skill' | 'file'
  label: string // 显示文本
  insert: string // 选中后插入到输入框的文本(含前缀)
  isDir?: boolean // 文件类:是否目录
}

// 前端缓存:同 (commandBase, cwd, host) 不重复请求
const cache = new Map<string, Promise<CompletionData>>()

export function loadCompletions(
  commandBase: string,
  cwd?: string,
  host?: string
): Promise<CompletionData> {
  const key = `${host || ''}|${commandBase}`
  let p = cache.get(key)
  if (!p) {
    p = invoke<CompletionData>('agent_completions', {
      commandBase,
      cwd: cwd || null,
      host: host || null
    })
    cache.set(key, p)
    p.catch(() => cache.delete(key))
  }
  return p
}
