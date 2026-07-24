import { invoke } from '@tauri-apps/api/core'

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

export interface LatexCompileResult {
  success: boolean
  pdf_path: string
  log: string
  duration_ms: number
  tool_missing: boolean
}

export interface LatexAiSuggestion {
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
  return invoke('overleaf_pull', {
    repo,
    token: sessionToken(token),
    host: remoteHost(host)
  })
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
  return invoke('overleaf_publish', {
    repo,
    message,
    token: sessionToken(token),
    host: remoteHost(host)
  })
}

export function compileLatex(
  repo: string,
  mainFile: string,
  engine: 'pdflatex' | 'xelatex' | 'lualatex',
  host?: string
): Promise<LatexCompileResult> {
  return invoke('latex_compile', {
    repo,
    mainFile,
    engine,
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
}): Promise<LatexAiSuggestion> {
  return invoke('latex_ai_suggest', {
    repo: options.repo,
    currentFile: options.currentFile,
    before: options.before,
    selection: options.selection,
    after: options.after,
    projectAware: options.mode === 'project',
    host: remoteHost(options.host)
  })
}

export function reviewLatex(options: {
  repo: string
  currentFile: string
  segments: LatexReviewSegment[]
  host?: string
}): Promise<LatexReviewResult> {
  return invoke('latex_ai_review', {
    repo: options.repo,
    currentFile: options.currentFile,
    segments: options.segments,
    host: remoteHost(options.host)
  })
}
