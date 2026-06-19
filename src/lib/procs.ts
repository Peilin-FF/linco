// 后台进程监控的前端绑定:对应 Rust 的 procs.rs。
// 列出 code agent(claude/codex)在后台起的 shell/子进程(命令/PID/时长/CPU/内存/状态)。
import { invoke } from '@tauri-apps/api/core'

export interface ProcInfo {
  pid: number
  ppid: number
  etime: string // 运行时长(ps ELAPSED,如 01:23 或 1-02:03:04)
  pcpu: string // CPU%
  pmem: string // 内存%
  stat: string // 进程状态(R/S/Ss/...)
  args: string // 完整命令行
}

const h = (host?: string): string | null => host || null

/// 列出 agent 进程子树下的后代进程。host 空=本地。
export async function agentProcesses(
  host?: string,
  cwd?: string,
  commandBase?: string
): Promise<ProcInfo[]> {
  return invoke<ProcInfo[]>('agent_processes', {
    host: h(host),
    cwd: cwd || null,
    commandBase: commandBase || null
  })
}
