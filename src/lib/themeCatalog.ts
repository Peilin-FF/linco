import catalog from './data/terminalThemeCatalog.json'
import type { Theme } from './theme'

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
const channels = (hex: string) => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16))
function blend(a: string, b: string, amount: number): string {
  const end = channels(b)
  return '#' + channels(a).map((value, i) => Math.round(value * (1 - amount) + end[i] * amount).toString(16).padStart(2, '0')).join('')
}
export function luminance(hex: string): number {
  const rgb = channels(hex).map(value => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 })
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (x + 0.05) / (y + 0.05)
}
function readable(color: string, background: string): string {
  const target = luminance(background) > 0.179 ? '#000000' : '#ffffff'
  for (let i = 0; i <= 20; i++) {
    const candidate = blend(color, target, i / 20)
    if (contrast(candidate, background) >= 4.5) return candidate
  }
  return target
}

// A checked-in subset of the same collection used by Ghostty. No network fetch
// or executable theme configuration at runtime. See third-party/themes/gallery.
export const CATALOG_THEMES: Theme[] = catalog.themes.map(p => {
  const bg = p.background
  const dark = luminance(bg) < luminance(p.foreground)
  const fg = readable(p.foreground, bg)
  const color = (index: number) => readable(p.ansi[index], bg)
  const muted = readable(blend(bg, fg, 0.6), bg)
  const panel = blend(bg, fg, 0.045)
  let selection = blend(bg, p.selection, 0.15)
  for (let strength = 0.14; contrast(fg, selection) < 4.5 && strength >= 0; strength -= 0.01) {
    selection = blend(bg, p.selection, Math.max(0, strength))
  }
  if (contrast(fg, selection) < 4.5) selection = bg
  const accent = readable(p.ansi[4], '#ffffff')
  return {
    id: p.id, name: p.name, dark, family: p.family,
    vars: {
      canvas: bg, sidebar: blend(bg, dark ? '#000000' : '#ffffff', 0.15), widget: panel,
      ink: fg, inkMuted: muted, inkFaint: muted, accent, border: blend(bg, fg, 0.18),
      hover: panel, selection, inputBackground: bg, inputBorder: blend(bg, fg, 0.25), inputPlaceholder: muted,
      buttonHover: blend(accent, '#000000', 0.15), buttonSecondary: panel, buttonSecondaryHover: selection,
      link: color(4), error: color(1), warning: color(3), editorSelection: selection, editorCursor: p.cursor,
      editorLineNumber: muted, editorLineNumberActive: fg,
      diffAdded: `${color(2)}18`, diffDeleted: `${color(1)}18`, diffHunk: `${color(4)}12`,
      diffAddedForeground: color(2), diffDeletedForeground: color(1), shadow: dark ? '0 4px 18px #00000040' : '0 2px 8px #0000000a'
    },
    syntax: {
      comment: muted, keyword: color(5), controlKeyword: color(5), variable: fg,
      function: color(4), type: color(6), property: color(6), string: color(2), number: color(3),
      regexp: color(1), tag: color(1), attribute: color(3), invalid: color(1)
    },
    ansi: Object.fromEntries(ANSI_NAMES.map((name, index) => [name, p.ansi[index]]))
  }
})
