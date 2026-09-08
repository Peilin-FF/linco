import { describe, expect, it } from 'vitest'
import catalog from '@/lib/data/terminalThemeCatalog.json'
import { CATALOG_THEMES, contrast, luminance } from '@/lib/themeCatalog'
import { themeById, terminalTheme } from '@/lib/theme'

describe('offline theme catalog', () => {
  it('includes 25 traceable palettes with stable, non-legacy IDs', () => {
    expect(CATALOG_THEMES).toHaveLength(25)
    expect(catalog.commit).toMatch(/^[a-f0-9]{40}$/)
    for (const theme of CATALOG_THEMES) {
      expect(theme.id).toMatch(/^gallery-/)
      expect(theme.family).toBeTruthy()
      expect(themeById(theme.id)).toBe(theme)
      expect(theme.name).not.toMatch(/monokai/i)
    }
  })

  it.each(CATALOG_THEMES)('provides readable workbench colors and original ANSI for $name', theme => {
    const source = catalog.themes.find(item => item.id === theme.id)!
    expect(source.sourceName).toBeTruthy()
    expect(theme.vars.canvas).toBe(source.background)
    expect(Object.values(theme.ansi!)).toEqual(source.ansi)
    expect(source.ansi).toHaveLength(16)
    for (const color of source.ansi) expect(color).toMatch(/^#[a-f0-9]{6}$/i)
    expect(theme.dark).toBe(luminance(source.background) < luminance(source.foreground))
    for (const color of [theme.vars.ink, theme.vars.inkMuted, theme.vars.link, ...Object.values(theme.syntax)]) {
      expect(contrast(color, theme.vars.canvas)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast('#ffffff', theme.vars.accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.vars.ink, theme.vars.selection)).toBeGreaterThanOrEqual(4.5)
    expect(terminalTheme(theme).background).toBe(source.background)
  })
})
