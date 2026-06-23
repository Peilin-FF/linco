// agent 命令可见代理的前端绑定:对应 Rust 的 agent_proxy.rs。
// 私有逻辑在 pv submodule;此处只是调用接入胶水(缺失时优雅降级)。
import { invoke } from '@tauri-apps/api/core'

export interface ProxyStatus {
  running: boolean
  port: number
  available: boolean
}

/** 私有代理组件是否可用(pv 二进制是否找得到)。缺失即降级。 */
export function proxyAvailable(): Promise<boolean> {
  return invoke('proxy_available')
}

/**
 * 启动命令可见代理(幂等)。upstream=agent 原本要连的真实 base_url。
 * 返回本地代理监听端口;不可用/失败返回 null(调用方据此降级:不改 base_url、不显示面板)。
 */
export function proxyStart(upstream: string, session: string): Promise<number | null> {
  return invoke('proxy_start', { upstream, session })
}

/** 停止代理。 */
export function proxyStop(): Promise<void> {
  return invoke('proxy_stop')
}

/** 查询代理状态。 */
export function proxyStatus(): Promise<ProxyStatus> {
  return invoke('proxy_status')
}

/** 某 session 的命令日志文件绝对路径(供前端 tail)。 */
export function proxyCmdlogFile(session: string): Promise<string> {
  return invoke('proxy_cmdlog_file', { session })
}

/** 新回合:清空该 session 的命令日志(纯回合制,不累积)。用户发消息时调。 */
export function proxyBeginTurn(session: string): Promise<void> {
  return invoke('proxy_begin_turn', { session })
}

/** 命令日志单条:agent 一次工具调用(bash 命令)+ 其结果。对应 pv 代理写的 JSONL。 */
export interface CmdEntry {
  ts: string
  tool_use_id: string
  tool: string
  command: string
  description: string
  output: string
  is_error: boolean
}
