// 远程连接的前端绑定:对应 Rust 的 remote.rs + config.rs 的 Connection。
import { invoke } from '@tauri-apps/api/core'

export interface Connection {
  id: string
  name: string
  host: string // user@ip 或 ~/.ssh/config 别名
  cwd: string // 远端默认工作目录
  identity: string // 可选私钥路径
  recentDirs?: string[] // 该远程最近用过的目录(与本地分开)
}

/** 读取 ~/.ssh/config 里的 Host 别名(供选择主机)。 */
export function sshConfigHosts(): Promise<string[]> {
  return invoke('ssh_config_hosts')
}

/** 尝试静默(key/已有 master)连接;失败表示需在终端交互(密码/2FA)。 */
export function sshConnect(host: string, identity?: string): Promise<void> {
  return invoke('ssh_connect', { host, identity: identity || null })
}

/** master 是否存活。 */
export function sshCheck(host: string): Promise<boolean> {
  return invoke('ssh_check', { host })
}

export function sshDisconnect(host: string): Promise<void> {
  return invoke('ssh_disconnect', { host })
}

export interface SshTarget {
  alias: string
  hostname: string
  user: string
  port: string
  identity: string
}

/** 解析一条 ssh 指令(如 `ssh root@ip -p 22 -i ~/.ssh/k`)。 */
export function parseSshCommand(cmd: string): Promise<SshTarget> {
  return invoke('parse_ssh_command', { cmd })
}

/** 向 ~/.ssh/config 追加一段 Host(同名报错)。 */
export function sshConfigAdd(t: SshTarget): Promise<void> {
  return invoke('ssh_config_add', {
    alias: t.alias,
    hostname: t.hostname,
    user: t.user,
    port: t.port,
    identity: t.identity
  })
}

/** 远端 HOME 目录(目录浏览器初始路径)。 */
export function remoteHome(host: string): Promise<string> {
  return invoke('remote_home', { host })
}
