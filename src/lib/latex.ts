import { invoke } from '@tauri-apps/api/core'
import type { EvidenceReference } from './researchProduction'

export interface OverleafProjectInfo {
  connected: boolean
  remote_name: string
  remote_url: string
  project_id: string
  branch: string
  dirty: boolean
  ahead: number
  behind: number
}

export interface OverleafCollaborationResult {
  remote_head?: string | null
  remote_updated: boolean
  incoming: boolean
  applied: boolean
  pending: boolean
  info: OverleafProjectInfo | null
}

export interface LatexCompileResult {
  success: boolean
  pdf_path: string
  log: string
  duration_ms: number
  tool_missing: boolean
  pdf_is_local?: boolean
  provenance_path?: string
  cached?: boolean
}

/** Older desktop backends compile on SSH hosts; current ones always use local TeX. */
export function latexRuntimeErrorKey(
  result: Pick<LatexCompileResult, 'pdf_is_local'>,
  host?: string
): 'latex.desktopUpdateRequired' | 'latex.toolMissing' {
  return host && result.pdf_is_local !== true
    ? 'latex.desktopUpdateRequired'
    : 'latex.toolMissing'
}

export interface LatexAiSuggestion {
  context?: EvidenceReference[]
  suggestion: string
  edits: LatexPolishEdit[]
  evidence: string[]
  agent: string
  model: string
  filesConsidered: number
}

export type LatexPolishMode = 'standard' | 'project'

export interface LatexPolishEdit {
  original: string
  replacement: string
  reason: string
  evidence: string[]
}

export interface LatexReviewSegment {
  id: string
  text: string
}

export interface LatexReviewIssue {
  segmentId: string
  original: string
  replacement: string
  reason: string
  category: 'spelling' | 'grammar' | 'clarity' | 'consistency'
  evidence: string[]
}

export interface LatexReviewResult {
  context?: EvidenceReference[]
  issues: LatexReviewIssue[]
  agent: string
  model: string
  filesConsidered: number
}

const remoteHost = (host?: string): string | null => host || null
const sessionToken = (token?: string): string | null => token?.trim() || null

export function overleafProjectInfo(
  repo: string,
  host?: string
): Promise<OverleafProjectInfo> {
  return invoke('overleaf_project_info', { repo, host: remoteHost(host) })
}

export function overleafClone(options: {
  gitUrl: string
  destination: string
  token: string
  remember: boolean
  host?: string
}): Promise<OverleafProjectInfo> {
  return invoke('overleaf_clone', {
    gitUrl: options.gitUrl,
    destination: options.destination,
    token: options.token,
    remember: options.remember,
    host: remoteHost(options.host)
  })
}

export function overleafPull(
  repo: string,
  token?: string,
  host?: string
): Promise<OverleafProjectInfo> {
  return requireSafePaperSync().then(() => invoke('overleaf_pull', {
    repo,
    token: sessionToken(token),
    host: remoteHost(host)
  }))
}

export function overleafStoreToken(
  repo: string,
  token: string,
  remember: boolean,
  host?: string
): Promise<void> {
  return invoke('overleaf_store_token', {
    repo,
    token,
    remember,
    host: remoteHost(host)
  })
}

export function overleafPublish(
  repo: string,
  message: string,
  token?: string,
  host?: string
): Promise<OverleafProjectInfo> {
  return requireSafePaperSync().then(() => invoke('overleaf_publish', {
    repo,
    message,
    token: sessionToken(token),
    host: remoteHost(host)
  }))
}

export async function requireSafePaperSync(): Promise<void> {
  const version = await invoke<number>('overleaf_sync_capabilities').catch(() => 0)
  if (typeof version !== 'number' || version < 1) throw new Error('Safe paper merging needs the updated desktop backend. Rebuild and reopen Linco; reconnecting Overleaf will not update the app.')
}

export interface OverleafMergePending { remoteHead: string | null }

/** A genuine overlap is a saved, pending state, not an authentication failure. */
export function overleafMergePending(reason: string): OverleafMergePending | null {
  if (!reason.includes('OVERLEAF_SYNC_PENDING') && !reason.includes('OVERLEAF_SYNC_CONFLICT')) return null
  const heads = /OVERLEAF_SYNC_PENDING:\s+([\da-f]{40}|[\da-f]{64})\s+([\da-f]{40}|[\da-f]{64})\./i.exec(reason)
  return { remoteHead: heads?.[2] || null }
}

export function shouldRetryOverleafMerge(pending: OverleafMergePending, result: OverleafCollaborationResult): boolean {
  return !!(result.remote_head && result.remote_head !== pending.remoteHead)
    || !!(result.info && !result.pending && result.info.behind === 0)
}

export function overleafCollaborationPoll(
  repo: string,
  token: string | undefined,
  host?: string
): Promise<OverleafCollaborationResult> {
  return invoke('overleaf_collaboration_poll', {
    repo,
    token: sessionToken(token),
    host: remoteHost(host)
  })
}

export function overleafCollaborationApply(
  repo: string,
  host?: string
): Promise<OverleafCollaborationResult> {
  return invoke('overleaf_collaboration_apply', {
    repo,
    host: remoteHost(host)
  })
}

export function compileLatex(
  repo: string,
  mainFile: string,
  engine: 'pdflatex' | 'xelatex' | 'lualatex',
  host?: string,
  force = false
): Promise<LatexCompileResult> {
  return invoke('latex_compile', {
    repo,
    mainFile,
    engine,
    force,
    host: remoteHost(host)
  })
}

export function suggestLatex(options: {
  repo: string
  currentFile: string
  before: string
  selection: string
  after: string
  mode: LatexPolishMode
  host?: string
  researchHost?: string
  evidencePaths?: string[]
  paperBrief?: string
}): Promise<LatexAiSuggestion> {
  return invoke('latex_ai_suggest', {
    repo: options.repo,
    currentFile: options.currentFile,
    before: options.before,
    selection: options.selection,
    after: options.after,
    projectAware: options.mode === 'project',
    evidencePaths: options.evidencePaths || [],
    paperBrief: options.paperBrief || '',
    host: remoteHost(options.host),
    // 空串代表“研究仓库在本机”,不能经 remoteHost 变成 null——那会退回继承稿件主机。
    researchHost: options.researchHost ?? ''
  })
}

export function reviewLatex(options: {
  repo: string
  currentFile: string
  segments: LatexReviewSegment[]
  host?: string
  researchHost?: string
  evidencePaths?: string[]
  paperBrief?: string
}): Promise<LatexReviewResult> {
  return invoke('latex_ai_review', {
    repo: options.repo,
    currentFile: options.currentFile,
    segments: options.segments,
    evidencePaths: options.evidencePaths || [],
    paperBrief: options.paperBrief || '',
    host: remoteHost(options.host),
    researchHost: options.researchHost ?? ''
  })
}
