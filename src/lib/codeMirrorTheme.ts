import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import {
  THEMES,
  VSCODE_DARK_SYNTAX,
  VSCODE_LIGHT_SYNTAX,
  type SyntaxColors,
  type Theme
} from './theme'

interface EditorPalette {
  background: string
  foreground: string
  cursor: string
  selection: string
  selectionMatch: string
  lineBorder: string
  lineNumber: string
  lineNumberActive: string
  widget: string
  border: string
  input: string
  inputBorder: string
  accent: string
  buttonHover: string
  findMatch: string
  findHighlight: string
  link: string
  diffAdded: string
  diffDeleted: string
  syntax: SyntaxColors
}

function palette(theme: Theme): EditorPalette {
  const v = theme.vars
  return {
    // CSS variables also update an open editor when switching between two light
    // (or two dark) themes, without recreating its document or undo history.
    background: `var(--canvas, ${v.canvas})`,
    foreground: `var(--ink, ${v.ink})`,
    cursor: `var(--editor-cursor, ${v.editorCursor})`,
    selection: `var(--editor-selection, ${v.editorSelection})`,
    selectionMatch: 'color-mix(in srgb, var(--editor-selection) 50%, transparent)',
    lineBorder: `var(--border, ${v.border})`,
    lineNumber: `var(--editor-line-number, ${v.editorLineNumber})`,
    lineNumberActive: `var(--editor-line-number-active, ${v.editorLineNumberActive})`,
    widget: `var(--widget, ${v.widget})`,
    border: `var(--border, ${v.border})`,
    input: `var(--input-background, ${v.inputBackground})`,
    inputBorder: `var(--input-border, ${v.inputBorder})`,
    accent: `var(--accent, ${v.accent})`,
    buttonHover: `var(--button-hover, ${v.buttonHover})`,
    findMatch: theme.dark ? '#9e6a03' : '#a8ac94',
    findHighlight: '#ea5c0055',
    link: `var(--link, ${v.link})`,
    diffAdded: `var(--diff-added, ${v.diffAdded})`,
    diffDeleted: `var(--diff-deleted, ${v.diffDeleted})`,
    // CSS variables also update syntax when switching between two dark themes,
    // without replacing the document, history, selection or editor instance.
    syntax: Object.fromEntries(Object.entries(theme.dark ? VSCODE_DARK_SYNTAX : VSCODE_LIGHT_SYNTAX)
      .map(([name, color]) => [name, `var(--syntax-${name}, ${color})`])) as unknown as SyntaxColors
  }
}

function createVscodeEditorTheme(theme: Theme): Extension {
  const p = palette(theme)
  return [
    EditorView.theme(
      {
        '&': {
          backgroundColor: p.background,
          color: p.foreground
        },
        '.cm-scroller': {
          fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
          lineHeight: '1.65',
          fontVariantLigatures: 'none'
        },
        '.cm-line': { padding: '0 12px' },
        '&.cm-focused': { outline: 'none' },
        '.cm-content': { caretColor: p.cursor },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: p.selection
        },
        '.cm-selectionMatch': { backgroundColor: p.selectionMatch },
        '.cm-activeLine': {
          backgroundColor: 'transparent',
          boxShadow: `inset 0 0 0 1px ${p.lineBorder}`
        },
        '.cm-gutters': {
          backgroundColor: p.background,
          borderRight: 'none',
          color: p.lineNumber
        },
        '.cm-activeLineGutter': {
          backgroundColor: p.background,
          color: p.lineNumberActive
        },
        '.cm-foldPlaceholder': {
          backgroundColor: p.widget,
          borderColor: p.border,
          color: p.foreground
        },
        '.cm-panels': {
          backgroundColor: p.widget,
          color: p.foreground
        },
        '.cm-panels.cm-panels-top': { borderBottomColor: p.border },
        '.cm-panels.cm-panels-bottom': { borderTopColor: p.border },
        '.cm-textfield': {
          backgroundColor: p.input,
          border: `1px solid ${p.inputBorder}`,
          color: p.foreground
        },
        '.cm-button': {
          backgroundColor: p.accent,
          backgroundImage: 'none',
          border: '1px solid transparent',
          color: '#ffffff'
        },
        '.cm-button:hover': { backgroundColor: p.buttonHover },
        '.cm-tooltip': {
          backgroundColor: p.widget,
          borderColor: p.border,
          color: p.foreground
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: p.selection,
          color: p.foreground
        },
        '.cm-searchMatch': { backgroundColor: p.findHighlight },
        '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: p.findMatch },
        '.cm-matchingBracket': {
          backgroundColor: 'transparent',
          outline: `1px solid ${p.lineNumber}`
        }
      },
      { dark: theme.dark }
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.comment, color: p.syntax.comment },
        { tag: [t.keyword, t.modifier, t.moduleKeyword], color: p.syntax.keyword },
        { tag: t.controlKeyword, color: p.syntax.controlKeyword },
        { tag: [t.variableName, t.name], color: p.syntax.variable },
        {
          tag: [t.function(t.variableName), t.function(t.propertyName)],
          color: p.syntax.function
        },
        { tag: [t.typeName, t.className, t.namespace], color: p.syntax.type },
        { tag: t.propertyName, color: p.syntax.property },
        { tag: t.tagName, color: p.syntax.tag },
        { tag: t.attributeName, color: p.syntax.attribute },
        { tag: [t.string, t.character, t.attributeValue], color: p.syntax.string },
        { tag: [t.number, t.bool, t.atom, t.null], color: p.syntax.number },
        { tag: t.regexp, color: p.syntax.regexp },
        { tag: [t.meta, t.processingInstruction], color: p.syntax.keyword },
        { tag: [t.link, t.url], color: p.link, textDecoration: 'underline' },
        { tag: t.heading, color: p.syntax.type, fontWeight: 'bold' },
        { tag: t.strong, fontWeight: 'bold' },
        { tag: t.emphasis, fontStyle: 'italic' },
        { tag: t.strikethrough, textDecoration: 'line-through' },
        { tag: t.inserted, backgroundColor: p.diffAdded },
        { tag: t.deleted, backgroundColor: p.diffDeleted },
        { tag: t.invalid, color: p.syntax.invalid }
      ])
    )
  ]
}

const lightTheme = THEMES.find((theme) => theme.id === 'vscode-light') || THEMES[0]
const darkTheme = THEMES.find((theme) => theme.id === 'vscode-dark') || THEMES[1]

export const vscodeLightEditorTheme = createVscodeEditorTheme(lightTheme)
export const vscodeDarkEditorTheme = createVscodeEditorTheme(darkTheme)
