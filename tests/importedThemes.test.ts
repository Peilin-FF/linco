import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importTheme, importedThemes, IMPORTED_THEMES_KEY, parseImportedTheme, removeImportedTheme, THEME_IMPORT_LIMIT } from '../src/lib/importedThemes'
import { themeById, THEMES } from '../src/lib/theme'

const fixture = readFileSync(new URL('../community-themes/monokai-pro-ce/monokai-pro-ce.json', import.meta.url), 'utf8')
function memoryStore() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
afterEach(() => vi.unstubAllGlobals())

describe('data-only imported themes', () => {
  it('validates the separate CE package without registering it as a built-in theme', () => {
    const theme = parseImportedTheme(fixture)
    expect(theme.id).toBe('imported:monokai-pro-ce')
    expect(theme.vars.canvas).toBe('#2d2a2e')
    expect(theme.ansi?.green).toBe('#a9dc76')
    expect(THEMES.some(item => item.name === theme.name)).toBe(false)
  })
  it.each([
    (doc: any) => { doc.theme.vars.canvas = 'url(https://example.com/track)' },
    (doc: any) => { doc.theme.vars.ink = 'var(--secret)' },
    (doc: any) => { doc.theme.vars.canvas = '#ffffff00' },
    (doc: any) => { doc.theme.syntax.keyword = '</style><script>alert(1)</script>' },
    (doc: any) => { delete doc.theme.ansi.red },
    (doc: any) => { doc.theme.dark = 'true' },
    (doc: any) => { doc.theme.name = '' },
    (doc: any) => { doc.theme.id = '__proto__' },
    (doc: any) => { doc.version = 2 },
    (doc: any) => { doc.theme.vars = [] },
  ])('rejects malformed or executable styling %#', mutate => {
    const doc = JSON.parse(fixture)
    mutate(doc)
    expect(() => parseImportedTheme(JSON.stringify(doc))).toThrow('invalid')
  })
  it('limits input by UTF-8 bytes', () => {
    expect(() => parseImportedTheme(' '.repeat(THEME_IMPORT_LIMIT + 1))).toThrow('tooLarge')
    expect(() => parseImportedTheme('界'.repeat(THEME_IMPORT_LIMIT / 2))).toThrow('tooLarge')
  })
  it('copies only color roles and ignores unrecognized payloads', () => {
    const doc = JSON.parse(fixture)
    doc.theme.vars.shadow = 'url(https://example.com/track)'
    doc.theme.script = 'alert(1)'
    const theme = parseImportedTheme(JSON.stringify(doc))
    expect(theme.vars.shadow).toBe('0 4px 18px #00000040')
    expect(theme).not.toHaveProperty('script')
  })
  it('persists palettes, resolves saved IDs, and removes only the local copy', () => {
    const store = memoryStore()
    vi.stubGlobal('localStorage', store)
    const theme = importTheme(fixture, store)
    expect(themeById(theme.id).name).toBe('Monokai Pro (CE)')
    expect(importedThemes(store)).toHaveLength(1)
    expect(() => importTheme(fixture, store)).toThrow('duplicate')
    removeImportedTheme(theme.id, store)
    expect(importedThemes(store)).toEqual([])
    expect(themeById(theme.id).id).toBe('linco-light')
    expect(parseImportedTheme(fixture).name).toBe('Monokai Pro (CE)')
  })
  it('isolates imported IDs from built-ins', () => {
    const store = memoryStore()
    const doc = JSON.parse(fixture)
    doc.theme.id = 'linco-light'
    expect(importTheme(JSON.stringify(doc), store).id).toBe('imported:linco-light')
    expect(themeById('linco-light').vars.canvas).toBe('#ffffff')
  })
  it('does not register an import when device storage fails', () => {
    const store = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(() => importTheme(fixture, store)).toThrow('storage')
    expect(importedThemes(store)).toEqual([])
  })
  it('recovers valid stored entries alongside damaged entries', () => {
    const store = memoryStore()
    store.setItem(IMPORTED_THEMES_KEY, JSON.stringify([null, JSON.parse(fixture), { format: 'bad' }]))
    expect(importedThemes(store)).toHaveLength(1)
    store.setItem(IMPORTED_THEMES_KEY, 'invalid JSON')
    expect(importedThemes(store)).toEqual([])
  })
  it('caps the number of imported themes', () => {
    const store = memoryStore()
    for (let i = 0; i < 20; i++) {
      const doc = JSON.parse(fixture)
      doc.theme.id = `theme-${i}`
      importTheme(JSON.stringify(doc), store)
    }
    expect(() => importTheme(fixture, store)).toThrow('limit')
    expect(importedThemes(store)).toHaveLength(20)
  })
})
