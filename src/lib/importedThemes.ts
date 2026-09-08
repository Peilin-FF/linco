import type { SyntaxColors, Theme, ThemeVars } from './theme'

export const THEME_IMPORT_LIMIT = 64 * 1024
export const IMPORTED_THEMES_KEY = 'linco:imported-themes:v1'
const MAX_THEMES = 20
const PREFIX = 'imported:'
const SURFACES = ['canvas', 'sidebar', 'ink', 'inkMuted', 'inkFaint', 'accent', 'border', 'hover', 'selection', 'inputBackground', 'inputBorder', 'inputPlaceholder', 'widget', 'buttonHover', 'buttonSecondary', 'buttonSecondaryHover', 'link', 'error', 'warning', 'editorSelection', 'editorCursor', 'editorLineNumber', 'editorLineNumberActive', 'diffAddedForeground', 'diffDeletedForeground'] as const
const OVERLAYS = ['diffAdded', 'diffDeleted', 'diffHunk'] as const
const SYNTAX = ['comment', 'keyword', 'controlKeyword', 'variable', 'function', 'type', 'property', 'string', 'number', 'regexp', 'tag', 'attribute', 'invalid'] as const
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
type Store = Pick<Storage, 'getItem' | 'setItem'>

export class ThemeImportError extends Error {
  constructor(public readonly code: 'invalid' | 'tooLarge' | 'duplicate' | 'limit' | 'storage') { super(code) }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ThemeImportError('invalid')
  return value as Record<string, unknown>
}
function colors<K extends string>(value: unknown, keys: readonly K[], alpha = false): Record<K, string> {
  const source = object(value)
  return Object.fromEntries(keys.map(key => {
    const color = source[key]
    if (typeof color !== 'string' || !(alpha ? /^#[\da-f]{6}([\da-f]{2})?$/i : /^#[\da-f]{6}$/i).test(color)) throw new ThemeImportError('invalid')
    return [key, color.toLowerCase()]
  })) as Record<K, string>
}

/** Whitelisted data only: no CSS expressions, URLs, scripts, fonts or extensions. */
export function parseImportedTheme(text: string): Theme {
  if (new TextEncoder().encode(text).length > THEME_IMPORT_LIMIT) throw new ThemeImportError('tooLarge')
  let root: Record<string, unknown>
  try { root = object(JSON.parse(text)) } catch { throw new ThemeImportError('invalid') }
  if (root.format !== 'linco-theme' || root.version !== 1) throw new ThemeImportError('invalid')
  const theme = object(root.theme)
  if (typeof theme.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(theme.id) || typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80 || /[\u0000-\u001f\u007f]/.test(theme.name) || typeof theme.dark !== 'boolean') throw new ThemeImportError('invalid')
  const vars: ThemeVars = {
    ...colors(theme.vars, SURFACES), ...colors(theme.vars, OVERLAYS, true),
    shadow: theme.dark ? '0 4px 18px #00000040' : '0 2px 8px #0000000a'
  }
  return { id: PREFIX + theme.id, name: theme.name.trim(), dark: theme.dark, vars, syntax: colors(theme.syntax, SYNTAX) as SyntaxColors, ansi: colors(theme.ansi, ANSI) }
}

function storage(): Store | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}
let cachedRaw: string | null | undefined
let cachedThemes: Theme[] = []
export function importedThemes(store = storage()): Theme[] {
  if (!store) return []
  try {
    const raw = store.getItem(IMPORTED_THEMES_KEY)
    if (raw === cachedRaw) return cachedThemes
    if ((raw?.length || 0) > THEME_IMPORT_LIMIT * MAX_THEMES) return []
    const entries: unknown = JSON.parse(raw || '[]')
    const valid: Theme[] = []
    if (Array.isArray(entries) && entries.length <= MAX_THEMES) {
      for (const entry of entries) {
        try {
          const theme = parseImportedTheme(JSON.stringify(entry))
          if (!valid.some(item => item.id === theme.id)) valid.push(theme)
        } catch { /* Ignore a damaged entry without hiding the rest. */ }
      }
    }
    cachedRaw = raw
    cachedThemes = valid
    return valid
  } catch { return [] }
}

function save(themes: Theme[], store?: Store): void {
  if (!store) throw new ThemeImportError('storage')
  const documents = themes.map(theme => ({ format: 'linco-theme', version: 1, theme: { ...theme, id: theme.id.slice(PREFIX.length) } }))
  try { store.setItem(IMPORTED_THEMES_KEY, JSON.stringify(documents)) } catch { throw new ThemeImportError('storage') }
  cachedRaw = undefined
}
export function importTheme(text: string, store = storage()): Theme {
  const theme = parseImportedTheme(text)
  const existing = importedThemes(store)
  if (existing.some(item => item.id === theme.id)) throw new ThemeImportError('duplicate')
  if (existing.length >= MAX_THEMES) throw new ThemeImportError('limit')
  save([...existing, theme], store)
  return theme
}
export function removeImportedTheme(id: string, store = storage()): void {
  save(importedThemes(store).filter(theme => theme.id !== id), store)
}
