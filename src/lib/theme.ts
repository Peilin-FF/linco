// 主题系统:VSCode 风格多主题 + 字体/字号。
//
// 架构:全 app 颜色经 tailwind 的 canvas/sidebar/ink/accent 引用 CSS 变量(见 tailwind.config.js),
// 换主题 = 改 document.documentElement 上的 --canvas/--sidebar/... 变量值,无需改任何组件。
// 字体/字号同理走 --app-font / --app-font-size。

import { useEffect, useState } from 'react'
import type { ITheme } from '@xterm/xterm'

export interface ThemeVars {
  canvas: string
  sidebar: string
  ink: string
  inkMuted: string
  inkFaint: string
  accent: string
  border?: string
  hover?: string
  selection?: string
  shadow?: string
}

export interface Theme {
  id: string
  name: string
  dark: boolean
  vars: ThemeVars
}

// VSCode 热门主题的近似配色(取其编辑器背景/前景/强调)。
export const THEMES: Theme[] = [
  {
    id: 'vscode-light',
    name: 'VS Code Light Modern',
    dark: false,
    vars: {
      canvas: '#ffffff',
      sidebar: '#f8f8f8',
      ink: '#3b3b3b',
      inkMuted: '#616161',
      inkFaint: '#868686',
      accent: '#005fb8',
      border: '#e5e5e5',
      hover: '#f2f2f2',
      selection: '#e8e8e8',
      shadow: '0 2px 8px rgba(0, 0, 0, 0.16)'
    }
  },
  {
    id: 'vscode-dark',
    name: 'VS Code Dark Modern',
    dark: true,
    vars: {
      canvas: '#1f1f1f',
      sidebar: '#181818',
      ink: '#cccccc',
      inkMuted: '#9d9d9d',
      inkFaint: '#868686',
      accent: '#0078d4',
      border: '#2b2b2b',
      hover: '#2b2b2b',
      selection: '#37373d',
      shadow: '0 2px 8px rgba(0, 0, 0, 0.36)'
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark Pro',
    dark: true,
    vars: {
      canvas: '#282c34',
      sidebar: '#21252b',
      ink: '#abb2bf',
      inkMuted: '#828997',
      inkFaint: '#5c6370',
      accent: '#61afef'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    dark: true,
    vars: {
      canvas: '#272822',
      sidebar: '#1e1f1c',
      ink: '#f8f8f2',
      inkMuted: '#a6a59b',
      inkFaint: '#75715e',
      accent: '#a6e22e'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    vars: {
      canvas: '#282a36',
      sidebar: '#21222c',
      ink: '#f8f8f2',
      inkMuted: '#a8aac0',
      inkFaint: '#6272a4',
      accent: '#bd93f9'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    dark: false,
    vars: {
      canvas: '#fdf6e3',
      sidebar: '#eee8d5',
      ink: '#586e75',
      inkMuted: '#839496',
      inkFaint: '#93a1a1',
      accent: '#268bd2'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    dark: true,
    vars: {
      canvas: '#002b36',
      sidebar: '#073642',
      ink: '#93a1a1',
      inkMuted: '#839496',
      inkFaint: '#586e75',
      accent: '#268bd2'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    vars: {
      canvas: '#2e3440',
      sidebar: '#3b4252',
      ink: '#eceff4',
      inkMuted: '#d8dee9',
      inkFaint: '#7b88a1',
      accent: '#88c0d0'
    }
  }
]

export const DEFAULT_THEME_ID = 'vscode-light'

const LEGACY_THEME_IDS: Record<string, string> = {
  'github-light': 'vscode-light',
  'github-dark': 'vscode-dark'
}

export function themeById(id: string | undefined): Theme {
  const resolved = id ? LEGACY_THEME_IDS[id] || id : DEFAULT_THEME_ID
  return THEMES.find((t) => t.id === resolved) || THEMES[0]
}

/** 应用主题:把变量写到 <html>,并设 color-scheme(影响原生滚动条/控件)。 */
export function applyTheme(id: string | undefined): void {
  const t = themeById(id)
  const root = document.documentElement
  const v = t.vars
  root.style.setProperty('--canvas', v.canvas)
  root.style.setProperty('--sidebar', v.sidebar)
  root.style.setProperty('--ink', v.ink)
  root.style.setProperty('--ink-muted', v.inkMuted)
  root.style.setProperty('--ink-faint', v.inkFaint)
  root.style.setProperty('--accent', v.accent)
  root.style.setProperty('--border', v.border || (t.dark ? '#3c3c3c' : '#e5e5e5'))
  root.style.setProperty('--hover', v.hover || (t.dark ? '#ffffff12' : '#0000000d'))
  root.style.setProperty(
    '--selection',
    v.selection || (t.dark ? '#ffffff1a' : '#00000012')
  )
  root.style.setProperty(
    '--shadow-card',
    v.shadow ||
      (t.dark
        ? '0 2px 8px rgba(0, 0, 0, 0.36)'
        : '0 2px 8px rgba(0, 0, 0, 0.16)')
  )
  root.style.colorScheme = t.dark ? 'dark' : 'light'
  root.setAttribute('data-theme', t.id)
  root.setAttribute('data-theme-dark', t.dark ? '1' : '0')
}

/** 当前主题是否深色(供 CodeMirror / xterm 等需要明暗的子系统读取)。 */
export function isDarkTheme(id: string | undefined): boolean {
  return themeById(id).dark
}

/** React hook:响应式读取「当前主题是否深色」。
 *  监听 <html data-theme-dark> 属性变化(applyTheme 会写它),
 *  让编辑器/终端等子组件在切主题时即时跟随明暗,无需接 config。 */
export function useIsDark(): boolean {
  const read = (): boolean =>
    document.documentElement.getAttribute('data-theme-dark') === '1'
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()))
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme-dark']
    })
    setDark(read()) // 挂载时同步一次(防首帧错过)
    return () => obs.disconnect()
  }, [])
  return dark
}

const ANSI_LIGHT = {
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

const ANSI_DARK = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
}

function defaultExtendedAnsi(): string[] {
  const colors: string[] = []
  const cube = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]
  for (let i = 0; i < 216; i++) {
    const r = cube[Math.floor(i / 36) % 6]
    const g = cube[Math.floor(i / 6) % 6]
    const b = cube[i % 6]
    colors.push(`#${r.toString(16).padStart(2, '0')}${g
      .toString(16)
      .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`)
  }
  for (let i = 0; i < 24; i++) {
    const channel = (8 + i * 10).toString(16).padStart(2, '0')
    colors.push(`#${channel}${channel}${channel}`)
  }
  return colors
}

const DEFAULT_EXTENDED_ANSI = defaultExtendedAnsi()

/** Build an xterm palette from the active workbench theme. ANSI colors match VS Code. */
export function terminalTheme(theme: Theme = currentTheme()): ITheme {
  const ansi = theme.dark ? ANSI_DARK : ANSI_LIGHT
  const extendedAnsi = [...DEFAULT_EXTENDED_ANSI]
  if (!theme.dark) {
    // Codex renders its input surface with xterm color 235 (#262626).
    // Re-theme that indexed color so a light workbench does not retain a dark bar.
    extendedAnsi[235 - 16] = theme.vars.selection || '#e8e8e8'
  }
  return {
    background: theme.vars.canvas,
    foreground: theme.vars.ink,
    cursor: theme.vars.accent,
    cursorAccent: theme.vars.canvas,
    selectionBackground:
      theme.vars.selection || (theme.dark ? '#ffffff1a' : '#00000012'),
    extendedAnsi,
    ...ansi
  }
}

export function currentTheme(): Theme {
  return themeById(document.documentElement.getAttribute('data-theme') || undefined)
}

/** Observe theme changes without coupling terminal components to app config state. */
export function observeTheme(listener: (theme: Theme) => void): () => void {
  const root = document.documentElement
  const observer = new MutationObserver(() => listener(currentTheme()))
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

// ---------- 字体 ----------

export interface FontOption {
  value: string // CSS font-family 值;'' = 系统默认
  label: string
  mono?: boolean
}

export const UI_FONTS: FontOption[] = [
  { value: '', label: '系统默认 · System' },
  { value: '"SF Pro Text", system-ui', label: 'SF Pro' },
  { value: '"PingFang SC", sans-serif', label: 'PingFang SC' },
  { value: '"Microsoft YaHei", sans-serif', label: '微软雅黑 YaHei' },
  { value: 'Inter, sans-serif', label: 'Inter' },
  { value: 'Roboto, sans-serif', label: 'Roboto' },
  { value: '"JetBrains Mono", monospace', label: 'JetBrains Mono', mono: true },
  { value: '"Fira Code", monospace', label: 'Fira Code', mono: true },
  { value: 'ui-monospace, Menlo, monospace', label: '等宽 Mono', mono: true }
]

export const FONT_SIZE_MIN = 11
export const FONT_SIZE_MAX = 20
export const DEFAULT_FONT_SIZE = 14

/** 应用字体与字号。font='' 时清除 --app-font(回退系统字体链)。 */
export function applyFont(font: string | undefined, size: number | undefined): void {
  const root = document.documentElement
  if (font && font.trim()) {
    root.style.setProperty('--app-font', font)
  } else {
    root.style.removeProperty('--app-font')
  }
  const s = size && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX ? size : DEFAULT_FONT_SIZE
  root.style.setProperty('--app-font-size', `${s}px`)
}
