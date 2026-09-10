import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_SIZE, normalizeFontSize, selectionInk, THEMES, terminalTheme, themeById } from '@/lib/theme'
import { contrast } from '@/lib/themeCatalog'

describe('workbench themes', () => {
  it('offers Linco themes and retains the VS Code alternatives', () => {
    expect(THEMES.slice(0, 7).map((theme) => theme.id)).toEqual([
      'linco-light',
      'linco-dark',
      'vscode-light',
      'vscode-dark',
      'github-dark-default',
      'tokyo-night',
      'catppuccin-mocha'
    ])
    expect(THEMES).toHaveLength(32)
    expect(new Set(THEMES.map(theme => theme.id)).size).toBe(THEMES.length)
  })

  it('defaults to Linco Light without changing a saved theme', () => {
    expect(themeById(undefined).id).toBe('linco-light')
    expect(themeById('unknown').id).toBe('linco-light')
    expect(themeById('vscode-dark').id).toBe('vscode-dark')
  })

  it('uses compact interface typography by default', () => {
    expect(DEFAULT_FONT_SIZE).toBe(12)
  })

  it.each([undefined, 0, -1, 21, Infinity, NaN])('uses 12px for missing or invalid saved sizes: %s', (size) => {
    expect(normalizeFontSize(size)).toBe(12)
  })

  it.each([11, 12, 16, 20])('preserves an explicitly selected size: %s', (size) => {
    expect(normalizeFontSize(size)).toBe(size)
  })

  it.each(['github-dark-default', 'tokyo-night', 'catppuccin-mocha'])('has a complete, distinct dark palette for %s', (id) => {
    const theme = themeById(id)
    expect(theme.id).toBe(id)
    expect(theme.dark).toBe(true)
    expect(Object.keys(theme.ansi!)).toHaveLength(16)
    expect(terminalTheme(theme).blue).toBe(theme.ansi!.blue)
    expect(theme.syntax.keyword).not.toBe(themeById('vscode-dark').syntax.keyword)
    expect(terminalTheme(theme).extendedAnsi).toHaveLength(240)
  })

  it.each(THEMES)('keeps terminal surfaces consistent with $name', (theme) => {
    expect(terminalTheme(theme)).toMatchObject({
      background: theme.vars.canvas,
      foreground: theme.vars.ink,
      selectionBackground: theme.vars.editorSelection,
    })
  })

  it.each([
    ['github-light', 'vscode-light'],
    ['solarized-light', 'vscode-light'],
    ['github-dark', 'vscode-dark'],
    ['one-dark', 'vscode-dark'],
    ['monokai', 'vscode-dark'],
    ['dracula', 'vscode-dark'],
    ['solarized-dark', 'vscode-dark'],
    ['nord', 'vscode-dark']
  ])('migrates legacy theme %s to %s', (legacy, expected) => {
    expect(themeById(legacy).id).toBe(expected)
  })

  it('matches the VS Code Dark Modern workbench and terminal colors', () => {
    const theme = themeById('vscode-dark')
    expect(theme.vars).toMatchObject({
      canvas: '#1f1f1f',
      sidebar: '#181818',
      inputBackground: '#313131',
      inputBorder: '#3c3c3c',
      accent: '#0078d4'
    })
    expect(terminalTheme(theme)).toMatchObject({
      background: '#1f1f1f',
      foreground: '#cccccc',
      cursor: '#cccccc',
      selectionBackground: '#264f78',
      green: '#0dbc79',
      brightBlue: '#3b8eea'
    })
  })

  it('matches the VS Code Light Modern workbench and terminal colors', () => {
    const theme = themeById('vscode-light')
    expect(theme.vars).toMatchObject({
      canvas: '#ffffff',
      sidebar: '#f8f8f8',
      inputBackground: '#ffffff',
      inputBorder: '#cecece',
      accent: '#005fb8'
    })
    expect(terminalTheme(theme)).toMatchObject({
      background: '#ffffff',
      foreground: '#3b3b3b',
      cursor: '#005fb8',
      selectionBackground: '#add6ff',
      green: '#107c10',
      brightBlue: '#0451a5'
    })
  })
})

describe('selection stays legible in every theme', () => {
  const hex = /^#[0-9a-f]{6}$/i

  it('keeps the default ink readable on the selection highlight', () => {
    for (const theme of THEMES) {
      const { ink, selection } = theme.vars
      if (!hex.test(selection) || !hex.test(ink)) continue
      expect(
        contrast(ink, selection),
        `${theme.id} ink ${ink} on selection ${selection}`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('gives the terminal a selection foreground that survives the raw ANSI palette', () => {
    for (const theme of THEMES) {
      const term = terminalTheme(theme)
      const background = term.selectionBackground
      const foreground = term.selectionForeground
      expect(foreground, `${theme.id} has no selection foreground`).toBeTruthy()
      if (!background || !hex.test(background) || !foreground || !hex.test(foreground)) continue
      // Without an explicit foreground, selected cells keep their ANSI color and
      // the dim entries used for secondary output fall to roughly 1:1 here.
      expect(
        contrast(foreground, background),
        `${theme.id} selection ${foreground} on ${background}`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the original ink when it already contrasts, and flips when it does not', () => {
    expect(selectionInk('#ffffff', '#242628')).toBe('#242628')
    expect(selectionInk('#242628', '#242628')).toBe('#ffffff')
    expect(selectionInk('#f0f2d4', '#f0f2d4')).toBe('#000000')
    // A non-hex or gradient value is left to the caller's own ink.
    expect(selectionInk('color-mix(in srgb, red, blue)', '#242628')).toBe('#242628')
  })
})
