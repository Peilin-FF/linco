// 全局内容搜索/替换的前端绑定:对应 Rust 的 search.rs。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

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

// ============ 流式搜索(远程,边搜边返回)============
// 远程大仓库:发起 search_content_stream(立即返回),结果经 remote-search-match/done
// 事件分批到达。后端只回 path:lineno:text;行内匹配区间 ranges 由前端用同一正则即时算。

/** 后端流式推来的一批匹配:rows = [[绝对path, 行号, 行文本], ...] */
export interface SearchMatchEvent {
  sid: string
  host: string
  rows: [string, number, string][]
}
export interface SearchDoneEvent {
  sid: string
  host: string
  count: number
  hitLimit: boolean
}

/** 发起远程流式搜索(仅远程)。立即返回,结果走事件。 */
export function searchContentStream(
  sid: string,
  root: string,
  query: string,
  opts: SearchOptions,
  host: string
): Promise<void> {
  return invoke('search_content_stream', {
    sid,
    root,
    query,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isRegex: opts.isRegex,
    host
  })
}

/** 取消进行中的远程流式搜索。 */
export function searchCancel(sid: string, host: string): Promise<void> {
  return invoke('search_cancel', { sid, host })
}

/** 订阅流式搜索事件。返回取消订阅函数。 */
export async function listenSearch(
  onMatch: (e: SearchMatchEvent) => void,
  onDone: (e: SearchDoneEvent) => void
): Promise<UnlistenFn> {
  const un1 = await listen<SearchMatchEvent>('remote-search-match', (e) => onMatch(e.payload))
  const un2 = await listen<SearchDoneEvent>('remote-search-done', (e) => onDone(e.payload))
  return () => {
    un1()
    un2()
  }
}

/** 构造与后端一致的匹配正则(用于前端算行内 ranges)。无效正则返回 null。 */
export function buildMatchRegex(query: string, opts: SearchOptions): RegExp | null {
  let pat = opts.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) pat = `\\b${pat}\\b`
  try {
    return new RegExp(pat, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

/** 对一行文本算所有匹配区间(char 偏移),与 MatchLine.ranges 格式一致。 */
export function rangesFor(text: string, re: RegExp): [number, number][] {
  const ranges: [number, number][] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
    if (m[0].length === 0) re.lastIndex++ // 防空匹配死循环
  }
  return ranges
}
