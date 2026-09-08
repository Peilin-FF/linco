import { invoke } from '@tauri-apps/api/core'

export const NOTION_HOME = 'https://app.notion.com/'
export const NOTION_MCP_SETUP = 'codex mcp add notion --url https://mcp.notion.com/mcp'
export const NOTION_MCP_LOGIN = 'codex mcp login notion'
const domains = ['notion.so', 'notion.com', 'notion.site']

export function normalizeNotionUrl(value: string): string | null {
  try {
    const input = value.trim()
    if (!input || /[\r\n\t]/.test(input)) return null
    const url = new URL(/^[\w+.-]+:/.test(input) ? input : `https://${input}`)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null
    return url.href
  } catch { return null }
}

// Store/share a page ID, never login callbacks or access tokens. p= is Notion's
// currently open database-page peek, which takes precedence over its parent.
export function notionPageUrl(value: string): string | null {
  const normalized = normalizeNotionUrl(value)
  if (!normalized) return null
  const url = new URL(normalized)
  const uuid = '(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})'
  const peek = url.searchParams.get('p') || ''
  const match = new RegExp(`^${uuid}$`, 'i').test(peek) ? peek : url.pathname.match(new RegExp(`(${uuid})/?$`, 'i'))?.[1]
  return match ? `https://www.notion.so/${match.replaceAll('-', '').toLowerCase()}` : null
}

export const notionProjectKey = (cwd?: string, host?: string): string =>
  `linco:notion:page:v1:${JSON.stringify([host || 'local', cwd || ''])}`

export function readNotionLink(key: string): string | null {
  try { return notionPageUrl(localStorage.getItem(key) || '') } catch { return null }
}

export function saveNotionLink(key: string, value: string | null): void {
  if (value === null) { localStorage.removeItem(key); return }
  const page = notionPageUrl(value)
  if (!page) throw new Error('Open a Notion page before linking it')
  localStorage.setItem(key, page)
}

export interface NotionStatus { url: string; title: string; loading: boolean }
export interface NotionLayout { visible: boolean; bounds?: { x: number; y: number; width: number; height: number } }

// Serialize native creation/navigation/layout, including StrictMode remounts.
// Coalesce layout requests so a queued resize cannot re-show an obscured pane.
let pending: Promise<unknown> = Promise.resolve()
function native<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const next = pending.then(() => invoke<T>(cmd, args))
  pending = next.catch(() => {})
  return next
}
let latestLayout: NotionLayout = { visible: false }
export function layoutNotion(layout: NotionLayout): Promise<void> {
  latestLayout = layout
  const next = pending.then(() => invoke<void>('notion_layout', { ...latestLayout }))
  pending = next.catch(() => {})
  return next
}
export const openNotion = (url: string, navigate = false): Promise<void> => native('notion_open', { url, navigate })
export const notionStatus = (): Promise<NotionStatus | null> => native('notion_status')
export const notionAction = (action: 'back' | 'forward' | 'reload'): Promise<void> => native('notion_action', { action })

export function notionAgentContext(url: string): string {
  const page = notionPageUrl(url)
  if (!page) throw new Error('Open a Notion page first')
  return `Use this Notion page as the notebook for our current project: ${page}\nRead its current contents through Notion MCP first. Summarize the latest experiment progress and outstanding questions. Do not change the note yet. If Notion MCP is unavailable or access is denied, tell me; do not invent its contents or create a replacement HTML file.`
}
