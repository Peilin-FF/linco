// Git 操作的前端绑定:对应 Rust 的 git.rs。
import { invoke } from '@tauri-apps/api/core'

export interface GitFile {
  path: string
  work: string
  index: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
}

export interface GitBranch {
  name: string
  current: boolean
  upstream: string
  remote: boolean
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface GitStash {
  index: number
  message: string
}

// Rust 字段已是 snake/camel 混合,但结构体字段(is_repo)需手动归一
interface RawStatus {
  is_repo: boolean
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
}

const H = (host?: string): string | null => host || null

export function gitIsRepo(repo: string, host?: string): Promise<boolean> {
  return invoke('git_is_repo', { repo, host: H(host) })
}

export async function gitStatus(repo: string, host?: string): Promise<GitStatus> {
  const r = await invoke<RawStatus>('git_status', { repo, host: H(host) })
  return { ...r, isRepo: r.is_repo }
}

export function gitDiffFile(
  repo: string,
  path: string,
  staged: boolean,
  untracked: boolean,
  host?: string
): Promise<string> {
  return invoke('git_diff_file', { repo, path, staged, untracked, host: H(host) })
}

export const gitStage = (repo: string, path: string, host?: string): Promise<void> =>
  invoke('git_stage', { repo, path, host: H(host) })
export const gitUnstage = (repo: string, path: string, host?: string): Promise<void> =>
  invoke('git_unstage', { repo, path, host: H(host) })
export const gitStageAll = (repo: string, host?: string): Promise<void> =>
  invoke('git_stage_all', { repo, host: H(host) })
export const gitUnstageAll = (repo: string, host?: string): Promise<void> =>
  invoke('git_unstage_all', { repo, host: H(host) })
export const gitDiscard = (
  repo: string,
  path: string,
  untracked: boolean,
  host?: string
): Promise<void> => invoke('git_discard', { repo, path, untracked, host: H(host) })

export const gitCommit = (repo: string, message: string, host?: string): Promise<string> =>
  invoke('git_commit', { repo, message, host: H(host) })
export const gitPull = (repo: string, host?: string): Promise<string> =>
  invoke('git_pull', { repo, host: H(host) })
export const gitPush = (repo: string, host?: string): Promise<string> =>
  invoke('git_push', { repo, host: H(host) })
export const gitFetch = (repo: string, host?: string): Promise<string> =>
  invoke('git_fetch', { repo, host: H(host) })

export const gitBranches = (repo: string, host?: string): Promise<GitBranch[]> =>
  invoke('git_branches', { repo, host: H(host) })
export const gitCheckout = (repo: string, branch: string, host?: string): Promise<string> =>
  invoke('git_checkout', { repo, branch, host: H(host) })
export const gitCreateBranch = (repo: string, name: string, host?: string): Promise<string> =>
  invoke('git_create_branch', { repo, name, host: H(host) })

export const gitLog = (
  repo: string,
  limit: number,
  rev?: string,
  host?: string
): Promise<GitCommit[]> => invoke('git_log', { repo, limit, rev, host: H(host) })
export const gitShow = (repo: string, hash: string, host?: string): Promise<string> =>
  invoke('git_show', { repo, hash, host: H(host) })

export const gitStashList = (repo: string, host?: string): Promise<GitStash[]> =>
  invoke('git_stash_list', { repo, host: H(host) })
export const gitStashPush = (repo: string, message: string, host?: string): Promise<string> =>
  invoke('git_stash_push', { repo, message, host: H(host) })
export const gitStashApply = (repo: string, index: number, host?: string): Promise<string> =>
  invoke('git_stash_apply', { repo, index, host: H(host) })
export const gitStashPop = (repo: string, index: number, host?: string): Promise<string> =>
  invoke('git_stash_pop', { repo, index, host: H(host) })
export const gitStashDrop = (repo: string, index: number, host?: string): Promise<string> =>
  invoke('git_stash_drop', { repo, index, host: H(host) })
