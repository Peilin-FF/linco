// 主题系统:VSCode 风格多主题 + 字体/字号。
//
// 架构:全 app 颜色经 tailwind 的 canvas/sidebar/ink/accent 引用 CSS 变量(见 tailwind.config.js),
// 换主题 = 改 document.documentElement 上的 --canvas/--sidebar/... 变量值,无需改任何组件。
// 字体/字号同理走 --app-font / --app-font-size。

import { useEffect, useState } from 'react'

export interface ThemeVars {
  canvas: string
  sidebar: string
  ink: string
  inkMuted: string
  inkFaint: string
  accent: string
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
    id: 'github-light',
    name: 'GitHub Light',
    dark: false,
    vars: {
      canvas: '#ffffff',
      sidebar: '#f6f8fa',
      ink: '#1f2328',
      inkMuted: '#656d76',
      inkFaint: '#8c959f',
      accent: '#0969da'
    }
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    dark: true,
    vars: {
      canvas: '#0d1117',
      sidebar: '#161b22',
      ink: '#e6edf3',
      inkMuted: '#9198a1',
      inkFaint: '#6e7681',
      accent: '#2f81f7'
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

export const DEFAULT_THEME_ID = 'github-light'

export function themeById(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) || THEMES[0]
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
