import { describe, expect, it } from 'vitest'
import { THEMES, terminalTheme, themeById } from '@/lib/theme'

describe('VS Code themes', () => {
  it('exposes only the bundled VS Code Modern themes', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual([
      'vscode-light',
      'vscode-dark'
    ])
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
