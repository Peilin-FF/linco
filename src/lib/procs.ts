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

export interface AgentTask {
  pid: number
  args: string // 完整命令行
  file: string // stdout/stderr 落盘的文件路径(实时 tail 它)
  etime: string // 运行时长
}

/// 列出 agent 起的、输出落盘成文件的后台任务(可实时查看;已滤掉管道噪声)。
/// 每个任务 → 终端区一个 tab。host 空=本地。
export async function agentTasks(
  host?: string,
  cwd?: string,
  commandBase?: string
): Promise<AgentTask[]> {
  return invoke<AgentTask[]>('agent_tasks', {
    host: h(host),
    cwd: cwd || null,
    commandBase: commandBase || null
  })
}

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

export interface ProcOutput {
  fd1: string | null // stdout 指向的文件(可 tail 看实时输出)
  fd2: string | null // stderr 指向的文件
}

/// 取某进程 stdout/stderr 指向的输出文件路径(用于实时查看它的 log)。
export async function procOutputFile(
  pid: number,
  host?: string
): Promise<ProcOutput> {
  return invoke<ProcOutput>('proc_output_file', { host: h(host), pid })
}

export interface TailChunk {
  data: string // 新增内容
  size: number // 文件当前总字节(下次作 offset)
  start: number // 本次实际起始字节
}

/// 从 offset 增量读输出文件(实时滚动)。
export async function tailFile(
  path: string,
  offset: number,
  host?: string
): Promise<TailChunk> {
  return invoke<TailChunk>('tail_file', { host: h(host), path, offset })
}
