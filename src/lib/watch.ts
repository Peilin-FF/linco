// 文件监听的前端绑定:对应 Rust 的 watch.rs / agent_rpc 推送。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** 启动监听某工作目录(host 空=本地)。切换工作目录/连接时再调一次即切换。 */
export function watchStart(root: string, host?: string): Promise<void> {
  return invoke('watch_start', { host: host || null, root })
}

/** 停止监听。 */
export function watchStop(): Promise<void> {
  return invoke('watch_stop')
}

export interface FsChange {
  host: string // '' = 本地
  paths: string[]
}

/** 订阅远端/本地文件变更推送。回调收到变更的路径列表。 */
export function onRemoteFsChange(cb: (e: FsChange) => void): Promise<UnlistenFn> {
  return listen<FsChange>('remote-fs-change', (e) => cb(e.payload))
}
