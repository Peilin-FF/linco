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
