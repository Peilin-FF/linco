// 全局内容搜索/替换的前端绑定:对应 Rust 的 search.rs。
import { invoke } from '@tauri-apps/api/core'

export interface MatchLine {
  line: number
  text: string
  ranges: [number, number][]
}

export interface FileMatches {
  path: string
  matches: MatchLine[]
}

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  isRegex: boolean
  include: string
  exclude: string
}

export function searchContent(
  root: string,
  query: string,
  opts: SearchOptions,
  host?: string
): Promise<FileMatches[]> {
  return invoke('search_content', {
    root,
    query,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isRegex: opts.isRegex,
    include: opts.include,
    exclude: opts.exclude,
    host: host || null
  })
}

export function replaceInFile(
  path: string,
  query: string,
  replacement: string,
  opts: Pick<SearchOptions, 'caseSensitive' | 'wholeWord' | 'isRegex'>,
  host?: string
): Promise<number> {
  return invoke('replace_in_file', {
    path,
    query,
    replacement,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isRegex: opts.isRegex,
    host: host || null
  })
}
