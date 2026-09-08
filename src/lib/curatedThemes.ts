import type { ITheme } from '@xterm/xterm'
import type { SyntaxColors, Theme } from './theme'

// Linco adaptations of the upstream palettes, not editor-extension installs.
// Sources and licenses: third-party/themes/README.md.
interface DarkPalette {
  id: string; name: string
  background: string; sidebar: string; panel: string; selection: string; border: string
  foreground: string; muted: string; faint: string; accent: string; buttonHover: string
  red: string; green: string; yellow: string; blue: string; purple: string; cyan: string
  syntax: SyntaxColors
  ansi: ITheme
}

function darkTheme(p: DarkPalette): Theme {
  return {
    id: p.id, name: p.name, dark: true,
    vars: {
      canvas: p.background, sidebar: p.sidebar, widget: p.panel,
      ink: p.foreground, inkMuted: p.muted, inkFaint: p.faint,
      accent: p.accent, border: p.border, hover: p.panel, selection: p.selection,
      inputBackground: p.background, inputBorder: p.border, inputPlaceholder: p.faint,
      buttonHover: p.buttonHover, buttonSecondary: p.panel, buttonSecondaryHover: p.selection,
      link: p.blue, error: p.red, warning: p.yellow,
      editorSelection: p.selection, editorCursor: p.foreground,
      editorLineNumber: p.faint, editorLineNumberActive: p.foreground,
      diffAdded: `${p.green}18`, diffDeleted: `${p.red}18`,
      diffAddedForeground: p.green, diffDeletedForeground: p.red, diffHunk: `${p.blue}12`,
      shadow: '0 4px 18px #00000040'
    },
    syntax: p.syntax,
    ansi: p.ansi
  }
}

export const CURATED_THEMES: Theme[] = [
  darkTheme({
    // Separate ID preserves the previous migration of legacy "github-dark".
    id: 'github-dark-default', name: 'GitHub Dark Default',
    background: '#0d1117', sidebar: '#010409', panel: '#161b22', selection: '#264f78', border: '#30363d',
    foreground: '#e6edf3', muted: '#9da7b3', faint: '#7d8590', accent: '#238636', buttonHover: '#2ea043',
    red: '#f85149', green: '#7ee787', yellow: '#d29922', blue: '#79c0ff', purple: '#d2a8ff', cyan: '#a5d6ff',
    syntax: {
      comment: '#8b949e', keyword: '#ff7b72', controlKeyword: '#ff7b72', variable: '#e6edf3',
      function: '#d2a8ff', type: '#ffa657', property: '#79c0ff', string: '#a5d6ff', number: '#79c0ff',
      regexp: '#7ee787', tag: '#7ee787', attribute: '#79c0ff', invalid: '#f85149'
    },
    ansi: {
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  }),
  darkTheme({
    id: 'tokyo-night', name: 'Tokyo Night',
    background: '#1a1b26', sidebar: '#16161e', panel: '#202230', selection: '#292e42', border: '#343b58',
    foreground: '#c0caf5', muted: '#a9b1d6', faint: '#828bb8', accent: '#435b96', buttonHover: '#506dac',
    red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', purple: '#bb9af7', cyan: '#7dcfff',
    syntax: {
      comment: '#828bb8', keyword: '#bb9af7', controlKeyword: '#bb9af7', variable: '#c0caf5',
      function: '#7aa2f7', type: '#2ac3de', property: '#7dcfff', string: '#9ece6a', number: '#ff9e64',
      regexp: '#b4f9f8', tag: '#f7768e', attribute: '#bb9af7', invalid: '#f7768e'
    },
    ansi: {
      black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#737aa2', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5'
    }
  }),
  darkTheme({
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha',
    background: '#1e1e2e', sidebar: '#11111b', panel: '#181825', selection: '#313244', border: '#45475a',
    foreground: '#cdd6f4', muted: '#bac2de', faint: '#9399b2', accent: '#694a91', buttonHover: '#7c58a8',
    red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', purple: '#cba6f7', cyan: '#94e2d5',
    syntax: {
      comment: '#9399b2', keyword: '#cba6f7', controlKeyword: '#cba6f7', variable: '#cdd6f4',
      function: '#89b4fa', type: '#f9e2af', property: '#b4befe', string: '#a6e3a1', number: '#fab387',
      regexp: '#f5c2e7', tag: '#cba6f7', attribute: '#f9e2af', invalid: '#f38ba8'
    },
    ansi: {
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#cdd6f4'
    }
  })
]
