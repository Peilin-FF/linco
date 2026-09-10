import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import {
  vscodeDarkEditorTheme,
  vscodeLightEditorTheme
} from '@/lib/codeMirrorTheme'
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { acceptCompletion, autocompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete'
import { latexProjectCompletionSource, type LatexCompletionFile } from '@/lib/latexCompletions'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { latex } from 'codemirror-lang-latex'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import {
  Bold,
  Braces,
  Check,
  Code2,
  Heading1,
  History,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Loader2,
  Quote,
  Save,
  Sigma,
  Sparkles,
  SpellCheck2,
  Table2,
  Underline,
  X
} from 'lucide-react'
import { useIsDark } from '@/lib/theme'
import { useI18n } from '@/lib/i18n'
import type {
  LatexAiSuggestion,
  LatexPolishMode,
  LatexReviewIssue,
  LatexReviewResult,
  LatexReviewSegment
} from '@/lib/latex'
import './latex-fonts.css'

// Updating review marks must not reconfigure the editor: a full reconfiguration
// discards CodeMirror's active snippet fields while the user is still typing.
const setAiMarks = StateEffect.define<DecorationSet>()
const aiMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    const replacement = transaction.effects.find(effect => effect.is(setAiMarks))
    return replacement ? replacement.value : value.map(transaction.changes)
  },
  provide: field => EditorView.decorations.from(field),
})
import {
  loadReviewMemory, nextReviewMemory, restoreReviewState, saveReviewMemory,
  type ReviewMemory, type ReviewCheckpoint, type SavedWritingIssue
} from '@/lib/latexReviewMemory'

export type LatexEditorMode = 'visual' | 'source'

interface LatexVisualEditorProps {
  value: string
  fileName: string
  projectFiles?: readonly LatexCompletionFile[]
  relativeFile?: string
  memoryScope: string
  contextIdentity?: string
  isMainDocument: boolean
  mode: LatexEditorMode
  dirty: boolean
  saving: boolean
  readOnly?: boolean
  active?: boolean
  repositoryLabel: string
  navigationTarget?: { offset: number; revision: number } | null
  onMode: (mode: LatexEditorMode) => void
  onChange: (value: string) => void
  onSave: () => void
  onSaveAndCompile?: () => void
  onRequestSuggestion?: (context: {
    before: string
    selection: string
    after: string
    mode: LatexPolishMode
  }) => Promise<LatexAiSuggestion>
  onReviewSegments?: (segments: LatexReviewSegment[]) => Promise<LatexReviewResult>
}

type VisualRange = ReturnType<Decoration['range']>

interface ReviewSegmentRange extends LatexReviewSegment {
  from: number
  to: number
  cacheKey: string
}

interface ResolvedReviewIssue extends LatexReviewIssue {
  context?: import('@/lib/researchProduction').EvidenceReference[]
  id: string
  from: number
  to: number
  agent: string
  model: string
  filesConsidered: number
}

interface ResolvedPolishIssue {
  context?: import('@/lib/researchProduction').EvidenceReference[]
  id: string
  original: string
  replacement: string
  reason: string
  evidence: string[]
  from: number
  to: number
  agent: string
  model: string
  filesConsidered: number
}

interface ReviewPopover {
  id: string
  left: number
  top: number
}

interface PolishPopover {
  id: string
  left: number
  top: number
}

const REVIEW_SEGMENT_MAX_CHARS = 2_400
const REVIEW_BATCH_MAX_CHARS = 12_000
const REVIEW_BATCH_MAX_SEGMENTS = 8
const POLISH_MODE_STORAGE_KEY = 'linco.latex.polishMode'

function quickHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function looksLikeProse(value: string): boolean {
  const withoutComments = value.replace(/(^|[^\\])%.*$/gm, '$1')
  const readable = withoutComments
    .replace(/\\(?:cite\w*|ref|eqref|autoref|label|url|href)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}$&_~^\\]/g, ' ')
  const words = readable.match(/[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'-]*/g)
  const cjkCharacters = readable.match(/[\u3400-\u9fff]/g)
  return (words?.length || 0) >= 3 || (cjkCharacters?.length || 0) >= 6
}

function latexProseSegments(source: string): ReviewSegmentRange[] {
  const begin = source.indexOf('\\begin{document}')
  const end = source.lastIndexOf('\\end{document}')
  const bodyFrom = begin >= 0 ? begin + '\\begin{document}'.length : 0
  const bodyTo = end > bodyFrom ? end : source.length
  const segments: ReviewSegmentRange[] = []

  const appendRange = (rawFrom: number, rawTo: number): void => {
    let from = rawFrom
    let to = rawTo
    while (from < to && /\s/.test(source[from])) from += 1
    while (to > from && /\s/.test(source[to - 1])) to -= 1
    if (to - from < 8) return

    let cursor = from
    while (cursor < to) {
      let chunkTo = Math.min(to, cursor + REVIEW_SEGMENT_MAX_CHARS)
      if (chunkTo < to) {
        const window = source.slice(cursor + 500, chunkTo)
        const newline = window.lastIndexOf('\n')
        const sentence = Math.max(
          window.lastIndexOf('. '),
          window.lastIndexOf('? '),
          window.lastIndexOf('! ')
        )
        const split = Math.max(newline, sentence)
        if (split >= 0) chunkTo = cursor + 500 + split + 1
      }
      let chunkFrom = cursor
      while (chunkFrom < chunkTo && /\s/.test(source[chunkFrom])) chunkFrom += 1
      while (chunkTo > chunkFrom && /\s/.test(source[chunkTo - 1])) chunkTo -= 1
      const text = source.slice(chunkFrom, chunkTo)
      if (looksLikeProse(text)) {
        const cacheKey = `${chunkFrom}:${chunkTo}:${quickHash(text)}`
        segments.push({
          id: cacheKey,
          text,
          from: chunkFrom,
          to: chunkTo,
          cacheKey
        })
      }
      cursor = Math.max(chunkTo, cursor + 1)
    }
  }

  const blankLine = /\r?\n[ \t]*\r?\n/g
  let blockFrom = bodyFrom
  let match: RegExpExecArray | null
  while ((match = blankLine.exec(source.slice(bodyFrom, bodyTo))) !== null) {
    const boundaryFrom = bodyFrom + match.index
    appendRange(blockFrom, boundaryFrom)
    blockFrom = bodyFrom + match.index + match[0].length
  }
  appendRange(blockFrom, bodyTo)
  return segments
}

function issueSignature(issue: Pick<LatexReviewIssue, 'original' | 'replacement'>): string {
  return `${issue.original}\0${issue.replacement}`
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.from > from && range.from < to
      : range.from < to && range.to > from
  )
}

class RevealWidget extends WidgetType {
  constructor(
    private readonly kind: 'math' | 'chip' | 'setup' | 'bullet' | 'figure' | 'title',
    private readonly label: string,
    private readonly from: number,
    private readonly to: number,
    private readonly displayMath = false
  ) {
    super()
  }

  eq(other: RevealWidget): boolean {
    return (
      this.kind === other.kind &&
      this.label === other.label &&
      this.from === other.from &&
      this.to === other.to &&
      this.displayMath === other.displayMath
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const node = document.createElement(this.displayMath ? 'div' : 'span')
    node.className = `linco-latex-${this.kind}${this.displayMath ? ' is-display' : ''}`
    if (this.kind === 'math') {
      try {
        katex.render(this.label, node, {
          displayMode: this.displayMath,
          throwOnError: false,
          strict: false,
          trust: false
        })
      } catch {
        node.textContent = this.label
      }
    } else if (this.kind === 'title') {
      const [title, author] = this.label.split('\0')
      const heading = document.createElement('h1')
      heading.textContent = title || 'Untitled document'
      node.appendChild(heading)
      if (author) {
        const byline = document.createElement('div')
        byline.textContent = author
        node.appendChild(byline)
      }
    } else {
      node.textContent = this.label
    }
    node.title = this.kind === 'setup' ? 'Click to edit the LaTeX preamble' : 'Click to edit source'
    node.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const anchor = Math.min(Math.max(this.from + 1, 0), Math.max(this.to - 1, 0))
      view.dispatch({ selection: EditorSelection.cursor(anchor), scrollIntoView: true })
      view.focus()
    })
    return node
  }

  ignoreEvent(): boolean {
    return false
  }
}

function commandParts(
  source: string,
  from: number,
  to: number
): { openEnd: number; contentFrom: number; contentTo: number; closeFrom: number } | null {
  const text = source.slice(from, to)
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open < 0 || close <= open) return null
  return {
    openEnd: from + open + 1,
    contentFrom: from + open + 1,
    contentTo: from + close,
    closeFrom: from + close
  }
}

function mathSource(raw: string): { tex: string; display: boolean } {
  if (raw.startsWith('$$') && raw.endsWith('$$')) {
    return { tex: raw.slice(2, -2), display: true }
  }
  if (raw.startsWith('\\[') && raw.endsWith('\\]')) {
    return { tex: raw.slice(2, -2), display: true }
  }
  if (raw.startsWith('\\(') && raw.endsWith('\\)')) {
    return { tex: raw.slice(2, -2), display: false }
  }
  return { tex: raw.slice(1, -1), display: false }
}

function equationSource(raw: string): string {
  const match = raw.match(/^\\begin\{([^}]+)\}([\s\S]*?)\\end\{\1\}$/)
  if (!match) return raw
  const environment = match[1]
  const body = match[2].trim()
  return environment.startsWith('align') ? `\\begin{aligned}${body}\\end{aligned}` : body
}

function buildVisualDecorations(state: EditorState): DecorationSet {
  const source = state.doc.toString()
  const ranges: VisualRange[] = []
  const replaced: Array<[number, number]> = []
  const addReplace = (
    from: number,
    to: number,
    widget?: WidgetType
  ): void => {
    if (from >= to) return
    ranges.push(Decoration.replace({ widget }).range(from, to))
  }
  const hiddenByParent = (from: number, to: number): boolean =>
    replaced.some(([start, end]) => from >= start && to <= end)

  const beginDocument = source.indexOf('\\begin{document}')
  if (beginDocument >= 0) {
    const end = beginDocument + '\\begin{document}'.length
    if (!selectionTouches(state, 0, end)) {
      addReplace(0, end, new RevealWidget('setup', 'Document setup', 0, end))
      replaced.push([0, end])
    }
  }
  const endDocument = source.lastIndexOf('\\end{document}')
  if (endDocument >= 0) {
    const end = endDocument + '\\end{document}'.length
    if (!selectionTouches(state, endDocument, end)) {
      addReplace(endDocument, end)
      replaced.push([endDocument, end])
    }
  }

  syntaxTree(state).iterate({
    enter(node) {
      const { name } = node.type
      const { from, to } = node
      if (hiddenByParent(from, to)) return

      if (name === 'DollarMath' || name === 'BracketMath' || name === 'ParenMath') {
        if (!selectionTouches(state, from, to)) {
          const math = mathSource(source.slice(from, to))
          addReplace(
            from,
            to,
            new RevealWidget('math', math.tex, from, to, math.display)
          )
          replaced.push([from, to])
        }
        return
      }
      if (name === 'EquationEnvironment' || name === 'EquationArrayEnvironment') {
        if (!selectionTouches(state, from, to)) {
          addReplace(
            from,
            to,
            new RevealWidget('math', equationSource(source.slice(from, to)), from, to, true)
          )
          replaced.push([from, to])
        }
        return
      }

      if (name === 'SectioningCommand') {
        const parts = commandParts(source, from, to)
        if (!parts) return
        const command = source.slice(from, parts.openEnd)
        const level =
          command.includes('subsubsection')
            ? 'linco-latex-h4'
            : command.includes('subsection')
              ? 'linco-latex-h3'
              : command.includes('chapter')
                ? 'linco-latex-h1'
                : 'linco-latex-h2'
        if (!selectionTouches(state, from, parts.openEnd)) addReplace(from, parts.openEnd)
        if (!selectionTouches(state, parts.closeFrom, to)) addReplace(parts.closeFrom, to)
        ranges.push(
          Decoration.mark({ class: `linco-latex-heading ${level}` }).range(
            parts.contentFrom,
            parts.contentTo
          )
        )
        ranges.push(
          Decoration.line({ class: `linco-latex-heading-line ${level}` }).range(
            state.doc.lineAt(from).from
          )
        )
        return
      }

      if (name === 'Maketitle') {
        if (selectionTouches(state, from, to)) return
        const title = source.match(/\\title\{([^{}]*)\}/)?.[1] || ''
        const author = source.match(/\\author\{([^{}]*)\}/)?.[1] || ''
        addReplace(from, to, new RevealWidget('title', `${title}\0${author}`, from, to))
        replaced.push([from, to])
        return
      }

      const markClass: Record<string, string> = {
        TextBoldCommand: 'linco-latex-bold',
        TextItalicCommand: 'linco-latex-italic',
        EmphasisCommand: 'linco-latex-italic',
        UnderlineCommand: 'linco-latex-underline',
        TextSmallCapsCommand: 'linco-latex-smallcaps',
        TextTeletypeCommand: 'linco-latex-code',
        Caption: 'linco-latex-caption'
      }
      if (markClass[name]) {
        const parts = commandParts(source, from, to)
        if (!parts) return
        if (!selectionTouches(state, from, parts.openEnd)) addReplace(from, parts.openEnd)
        if (!selectionTouches(state, parts.closeFrom, to)) addReplace(parts.closeFrom, to)
        ranges.push(
          Decoration.mark({ class: markClass[name] }).range(
            parts.contentFrom,
            parts.contentTo
          )
        )
        return
      }

      if (name === 'Label') {
        if (!selectionTouches(state, from, to)) {
          addReplace(from, to)
          replaced.push([from, to])
        }
        return
      }

      if (name === 'Cite' || name === 'Ref') {
        if (selectionTouches(state, from, to)) return
        const parts = commandParts(source, from, to)
        const value = parts
          ? source.slice(parts.contentFrom, parts.contentTo)
          : source.slice(from, to)
        const label = name === 'Cite' ? `@${value}` : `→ ${value}`
        addReplace(from, to, new RevealWidget('chip', label, from, to))
        replaced.push([from, to])
        return
      }

      if (name === 'IncludeGraphics') {
        if (selectionTouches(state, from, to)) return
        const parts = commandParts(source, from, to)
        const value = parts
          ? source.slice(parts.contentFrom, parts.contentTo)
          : 'figure'
        addReplace(from, to, new RevealWidget('figure', `Figure  ${value}`, from, to))
        replaced.push([from, to])
        return
      }

      if (name === 'Item') {
        const space = source.slice(from, to).indexOf(' ')
        const commandEnd = space >= 0 ? Math.min(to, from + space + 1) : to
        if (!selectionTouches(state, from, commandEnd)) {
          addReplace(from, commandEnd, new RevealWidget('bullet', '•', from, commandEnd))
        }
        return
      }

      if (name === 'BeginEnv' || name === 'EndEnv') {
        const raw = source.slice(from, to)
        if (
          /\{(?:document|itemize|enumerate|figure\*?|table\*?|quote)\}/.test(raw) &&
          !selectionTouches(state, from, to)
        ) {
          addReplace(from, to)
          replaced.push([from, to])
        }
      }
    }
  })

  return Decoration.set(ranges, true)
}

const visualDecorations = EditorView.decorations.compute(
  ['doc', 'selection'],
  buildVisualDecorations
)

const visualTheme = EditorView.theme({
  '&': {
    height: '100%',
    background: '#eeeeec',
    color: '#262626',
    userSelect: 'text'
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "Georgia, 'Times New Roman', serif"
  },
  '.cm-gutters': { display: 'none' },
  '.cm-content': {
    boxSizing: 'border-box',
    width: 'min(780px, calc(100% - 28px))',
    minHeight: 'calc(100% - 56px)',
    margin: '28px auto 80px',
    padding: '56px clamp(28px, 8%, 76px) 88px',
    borderRadius: '2px',
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,.08), 0 12px 35px rgba(0,0,0,.08)',
    caretColor: '#d36e22',
    fontSize: '16px',
    lineHeight: '1.72'
  },
  '.cm-line': { padding: '0', letterSpacing: '0' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: '#cfe3ff !important'
  },
  '.linco-latex-bold': { fontWeight: '700' },
  '.linco-latex-italic': { fontStyle: 'italic' },
  '.linco-latex-underline': { textDecoration: 'underline', textUnderlineOffset: '3px' },
  '.linco-latex-smallcaps': { fontVariant: 'small-caps' },
  '.linco-latex-code': {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: '.9em',
    background: '#f2f2f0',
    borderRadius: '3px',
    padding: '1px 3px'
  },
  '.linco-latex-caption': { color: '#666', fontSize: '.9em', fontStyle: 'italic' },
  '.linco-latex-heading-line': { paddingTop: '1.05em' },
  '.linco-latex-heading': { fontFamily: "Inter, system-ui, sans-serif", fontWeight: '650' },
  '.linco-latex-h1': { fontSize: '1.8em', lineHeight: '1.25' },
  '.linco-latex-h2': { fontSize: '1.48em', lineHeight: '1.3' },
  '.linco-latex-h3': { fontSize: '1.2em', lineHeight: '1.35' },
  '.linco-latex-h4': { fontSize: '1.05em', lineHeight: '1.4' },
  '.linco-latex-math': {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '1.5em',
    padding: '0 2px',
    cursor: 'text'
  },
  '.linco-latex-math.is-display': {
    display: 'flex',
    justifyContent: 'center',
    margin: '1.1em 0',
    padding: '.6em 0'
  },
  '.linco-latex-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: '4px',
    background: '#eaf2ff',
    color: '#315f9c',
    padding: '0 5px',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '.78em',
    cursor: 'text'
  },
  '.linco-latex-setup': {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    marginBottom: '1.4em',
    borderBottom: '1px solid #e6e6e2',
    paddingBottom: '.7em',
    color: '#92928d',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '11px',
    textTransform: 'uppercase',
    cursor: 'pointer'
  },
  '.linco-latex-bullet': {
    display: 'inline-block',
    width: '1.35em',
    color: '#555',
    fontWeight: '700'
  },
  '.linco-latex-figure': {
    display: 'inline-flex',
    alignItems: 'center',
    border: '1px solid #ddd',
    borderRadius: '4px',
    background: '#f8f8f6',
    padding: '8px 10px',
    color: '#666',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '12px',
    cursor: 'text'
  },
  '.linco-latex-title': {
    display: 'block',
    margin: '0 0 2.6em',
    textAlign: 'center',
    cursor: 'text'
  },
  '.linco-latex-title h1': {
    margin: '0 0 .45em',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '1.65em',
    lineHeight: '1.25',
    fontWeight: '680'
  },
  '.linco-latex-title div': {
    color: '#686864',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '.9em'
  }
})

const SOURCE_FONT =
  "'Linco JetBrains Mono', 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace"

const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    userSelect: 'text',
    textRendering: 'optimizeSpeed',
    fontVariantNumeric: 'slashed-zero'
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: SOURCE_FONT
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '12px 0 40px',
    fontSize: '13px',
    lineHeight: '1.5',
    fontWeight: '400',
    fontFeatureSettings: "'liga' 0, 'calt' 0",
    letterSpacing: '0'
  },
  '.cm-cursor-primary': {
    fontSize: '13px',
    lineHeight: '1.5'
  },
  '.cm-gutters': {
    borderRight: 'none',
    fontFamily: SOURCE_FONT,
    fontSize: '13px',
    lineHeight: '1.5'
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 4px 0 0',
    userSelect: 'none'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderWidth: '2px',
    marginLeft: '-1px'
  },
  '.cm-lintRange.cm-lintRange': {
    backgroundImage: 'none',
    paddingBottom: '0'
  },
  '.cm-lintRange-error': {
    background: 'rgba(255, 0, 0, 0.2)'
  },
  '.cm-lintRange-warning': {
    background: 'rgba(222, 128, 20, 0.16)'
  },
  '.cm-lintRange-error .cm-lintRange-error, .cm-lintRange-warning .cm-lintRange-warning': {
    background: 'none'
  },
  '.cm-diagnosticSource': {
    display: 'none'
  },
  '&.cm-focused': { outline: 'none' }
})

const reviewTheme = EditorView.theme({
  '.linco-latex-ai-issue': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationColor: '#d6a400',
    textDecorationThickness: '1.2px',
    textUnderlineOffset: '3px',
    cursor: 'pointer'
  },
  '.linco-latex-ai-issue:hover': {
    backgroundColor: 'rgba(255, 214, 64, 0.14)'
  }
})

const polishTheme = EditorView.theme({
  '.linco-latex-polish-issue': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationColor: '#b8a6e8',
    textDecorationThickness: '1.2px',
    textUnderlineOffset: '3px',
    cursor: 'pointer'
  },
  '.linco-latex-polish-issue:hover': {
    backgroundColor: 'rgba(184, 166, 232, 0.14)'
  }
})

function ToolbarButton({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-black/5 hover:text-ink"
    >
      {children}
    </button>
  )
}

export default function LatexVisualEditor({
  memoryScope,
  contextIdentity = '',
  value,
  fileName,
  projectFiles,
  relativeFile,
  isMainDocument,
  mode,
  dirty,
  saving,
  readOnly = false,
  active = true,
  repositoryLabel,
  navigationTarget,
  onMode,
  onChange,
  onSave,
  onSaveAndCompile,
  onRequestSuggestion,
  onReviewSegments
}: LatexVisualEditorProps): JSX.Element {
  const { t } = useI18n()
  const dark = useIsDark()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<EditorView | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestionError, setSuggestionError] = useState('')
  const [polishMode, setPolishMode] = useState<LatexPolishMode>(() =>
    window.localStorage.getItem(POLISH_MODE_STORAGE_KEY) === 'standard'
      ? 'standard'
      : 'project'
  )
  const [polishIssues, setPolishIssues] = useState<ResolvedPolishIssue[]>([])
  const [polishPopover, setPolishPopover] = useState<PolishPopover | null>(null)
  const [reviewIssues, setReviewIssues] = useState<ResolvedReviewIssue[]>([])
  const [reviewing, setReviewing] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [reviewPopover, setReviewPopover] = useState<ReviewPopover | null>(null)
  const [reviewProgress, setReviewProgress] = useState({ checked: 0, total: 0 })
  const reviewIssuesRef = useRef<ResolvedReviewIssue[]>([])
  const polishIssuesRef = useRef<ResolvedPolishIssue[]>([])
  const applyingPolishIssueRef = useRef(false)
  const reviewCallbackRef = useRef(onReviewSegments)
  const reviewTimerRef = useRef<number | null>(null)
  const reviewGenerationRef = useRef(0)
  const reviewInFlightRef = useRef(false)
  const reviewPendingRef = useRef(false)
  const reviewedSegmentsRef = useRef(new Set<string>())
  const ignoredIssuesRef = useRef(new Set<string>())
  const reviewEnabledRef = useRef(false)
  const memoryRef = useRef<ReviewMemory | null>(null)
  const contextIdentityRef = useRef(contextIdentity)
  const sourceRef = useRef(value)
  const memoryReadyRef = useRef(false)
  const memoryQueueRef = useRef(Promise.resolve())
  const memoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const memoryMountedRef = useRef(true)
  const [memoryStatus, setMemoryStatus] = useState('loading')
  const [memoryError, setMemoryError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [checkpoints, setCheckpoints] = useState<ReviewCheckpoint[]>([])
  const [restored, setRestored] = useState(false)
  const persistRef = useRef<(label?: ReviewCheckpoint['label'], decision?: SavedWritingIssue) => void>(() => {})
  const runReviewRef = useRef<() => Promise<void>>(async () => {})
  const scheduleReviewRef = useRef<(delay?: number) => void>(() => {})

  reviewCallbackRef.current = onReviewSegments

  const replaceReviewIssues = (next: ResolvedReviewIssue[]): void => {
    reviewIssuesRef.current = next
    setReviewIssues(next)
  }

  const replacePolishIssues = (next: ResolvedPolishIssue[]): void => {
    polishIssuesRef.current = next
    setPolishIssues(next)
  }

  persistRef.current = (label, decision): void => {
    if (!memoryReadyRef.current) return
    if (memoryTimerRef.current !== null) clearTimeout(memoryTimerRef.current)
    memoryTimerRef.current = null
    try {
      const next = nextReviewMemory(memoryRef.current, memoryScope, {
        source: sourceRef.current,
        contextIdentity,
        reviews: reviewIssuesRef.current,
        polish: polishIssuesRef.current,
        reviewed: [...reviewedSegmentsRef.current],
        ignored: [...ignoredIssuesRef.current]
      }, label, decision)
      memoryRef.current = next
      if (memoryMountedRef.current) {
        setCheckpoints(next.checkpoints)
        setMemoryStatus('saving')
      }
      // Keep transaction order, including writes queued just before unmount.
      memoryQueueRef.current = memoryQueueRef.current.then(() => saveReviewMemory(next))
      void memoryQueueRef.current.then(() => {
        if (memoryMountedRef.current && memoryRef.current?.revision === next.revision) {
          setMemoryStatus('saved')
        }
      }).catch(reason => {
        if (memoryMountedRef.current) {
          setMemoryStatus('error')
          setMemoryError(String(reason))
        }
      })
    } catch (reason) {
      setMemoryStatus('error')
      setMemoryError(String(reason))
    }
  }

  const scheduleReview = (delay = 900): void => {
    if (!active || !reviewCallbackRef.current || !reviewEnabledRef.current || !memoryReadyRef.current) return
    if (reviewTimerRef.current !== null) window.clearTimeout(reviewTimerRef.current)
    reviewTimerRef.current = window.setTimeout(() => {
      reviewTimerRef.current = null
      void runReviewRef.current()
    }, delay)
  }
  scheduleReviewRef.current = scheduleReview

  runReviewRef.current = async (): Promise<void> => {
    const view = editorRef.current
    const review = reviewCallbackRef.current
    if (!active || !view || !review || !reviewEnabledRef.current || !memoryReadyRef.current) return
    if (reviewInFlightRef.current) {
      reviewPendingRef.current = true
      return
    }
    const source = view.state.doc.toString()
    const viewport = view.viewport
    const allSegments = latexProseSegments(source)
    setReviewProgress({
      checked: allSegments.filter((segment) =>
        reviewedSegmentsRef.current.has(segment.cacheKey)
      ).length,
      total: allSegments.length
    })
    const distanceFromViewport = (segment: ReviewSegmentRange): number => {
      if (segment.to >= viewport.from && segment.from <= viewport.to) return 0
      return segment.to < viewport.from
        ? viewport.from - segment.to
        : segment.from - viewport.to
    }
    const candidates = allSegments
      .filter((segment) => !reviewedSegmentsRef.current.has(segment.cacheKey))
      .sort(
        (left, right) =>
          distanceFromViewport(left) - distanceFromViewport(right) ||
          left.from - right.from
      )
    const batch: ReviewSegmentRange[] = []
    let batchCharacters = 0
    for (const segment of candidates) {
      const length = segment.text.length
      if (
        batch.length >= REVIEW_BATCH_MAX_SEGMENTS ||
        (batch.length > 0 && batchCharacters + length > REVIEW_BATCH_MAX_CHARS)
      ) {
        break
      }
      batch.push(segment)
      batchCharacters += length
    }
    if (batch.length === 0) return

    const generation = reviewGenerationRef.current
    reviewInFlightRef.current = true
    setReviewing(true)
    setReviewError('')
    let continueInBackground = false
    try {
      const result = await review(batch.map(({ id, text }) => ({ id, text })))
      if (
        generation !== reviewGenerationRef.current ||
        editorRef.current?.state.doc.toString() !== source
      ) {
        return
      }
      for (const segment of batch) reviewedSegmentsRef.current.add(segment.cacheKey)

      const batchIds = new Set(batch.map((segment) => segment.id))
      const resolved = result.issues.flatMap((issue): ResolvedReviewIssue[] => {
        const segment = batch.find((candidate) => candidate.id === issue.segmentId)
        if (!segment || ignoredIssuesRef.current.has(issueSignature(issue))) return []
        const offset = segment.text.indexOf(issue.original)
        if (
          offset < 0 ||
          segment.text.indexOf(issue.original, offset + issue.original.length) >= 0
        ) {
          return []
        }
        const from = segment.from + offset
        const to = from + issue.original.length
        return [{
          ...issue,
          id: `${issue.segmentId}:${quickHash(`${issue.original}\0${issue.replacement}`)}`,
          from,
          to,
          agent: result.agent,
          model: result.model,
          filesConsidered: result.filesConsidered,
          context: result.context?.filter(source => issue.evidence.includes(source.path))
        }]
      })
      replaceReviewIssues([
        ...reviewIssuesRef.current.filter((issue) => !batchIds.has(issue.segmentId)),
        ...resolved
      ].sort((left, right) => left.from - right.from))
      const checked = allSegments.filter((segment) =>
        reviewedSegmentsRef.current.has(segment.cacheKey)
      ).length
      setReviewProgress({ checked, total: allSegments.length })
      setRestored(false)
      persistRef.current('review')
      continueInBackground = checked < allSegments.length
    } catch (reason) {
      if (generation === reviewGenerationRef.current) {
        setReviewError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      reviewInFlightRef.current = false
      setReviewing(false)
      if (reviewPendingRef.current) {
        reviewPendingRef.current = false
        scheduleReviewRef.current(250)
      } else if (continueInBackground) {
        scheduleReviewRef.current(500)
      }
    }
  }

  useEffect(() => {
    let cancelled = false
    memoryMountedRef.current = true
    void loadReviewMemory(memoryScope).then(memory => {
      if (cancelled) return
      memoryRef.current = memory
      if (memory) {
        const source = sourceRef.current
        const state = restoreReviewState(memory, source, contextIdentityRef.current)
        replaceReviewIssues(state.reviews)
        replacePolishIssues(state.polish)
        reviewedSegmentsRef.current = new Set(state.reviewed)
        ignoredIssuesRef.current = new Set(state.ignored)
        setCheckpoints(memory.checkpoints)
        setRestored(true)
        const segments = latexProseSegments(source)
        setReviewProgress({ checked: segments.filter(segment => state.reviewed.includes(segment.cacheKey)).length, total: segments.length })
      }
      memoryReadyRef.current = true
      setMemoryStatus(memory ? 'saved' : 'ready')
    }).catch(reason => {
      if (!cancelled) {
        setMemoryStatus('error')
        setMemoryError(String(reason))
      }
    })
    return () => {
      cancelled = true
      if (memoryTimerRef.current !== null) persistRef.current()
      memoryMountedRef.current = false
      reviewGenerationRef.current += 1
      if (reviewTimerRef.current !== null) {
        window.clearTimeout(reviewTimerRef.current)
        reviewTimerRef.current = null
      }
    }
    // Parent keys the editor by the complete host/project/file identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryScope])

  useEffect(() => {
    if (contextIdentityRef.current === contextIdentity) return
    contextIdentityRef.current = contextIdentity
    reviewGenerationRef.current++
    reviewEnabledRef.current = false
    reviewedSegmentsRef.current.clear()
    ignoredIssuesRef.current.clear()
    setReviewProgress({ checked: 0, total: 0 })
    setReviewError('')
    setSuggestionError('')
    replaceReviewIssues([])
    replacePolishIssues([])
    setReviewPopover(null)
    setPolishPopover(null)
    setRestored(true)
    persistRef.current()
  }, [contextIdentity])

  useEffect(() => {
    if (!active) {
      if (reviewTimerRef.current !== null) {
        window.clearTimeout(reviewTimerRef.current)
        reviewTimerRef.current = null
      }
      reviewPendingRef.current = false
      setReviewPopover(null)
      setPolishPopover(null)
      return
    }
    scheduleReviewRef.current(250)
  }, [active])

  const requestSuggestion = async (): Promise<void> => {
    const view = editorRef.current
    if (!view || !onRequestSuggestion || suggesting || !memoryReadyRef.current) return
    const generation = reviewGenerationRef.current
    const selection = view.state.selection.main
    const source = view.state.doc.toString()
    let from = selection.from
    let to = selection.to
    if (selection.empty) {
      const segment = latexProseSegments(source).find(
        (candidate) => candidate.from <= selection.from && candidate.to >= selection.from
      )
      if (segment) {
        from = segment.from
        to = segment.to
      } else {
        const line = view.state.doc.lineAt(selection.from)
        from = line.from
        to = line.to
      }
      while (from < to && /\s/.test(source[from])) from += 1
      while (to > from && /\s/.test(source[to - 1])) to -= 1
    }
    const beforeStart = Math.max(0, from - 6000)
    const afterEnd = Math.min(source.length, to + 1800)
    const original = source.slice(from, to)
    setPolishPopover(null)
    setSuggesting(true)
    setSuggestionError('')
    try {
      const result = await onRequestSuggestion({
        before: source.slice(beforeStart, from),
        selection: original,
        after: source.slice(to, afterEnd),
        mode: polishMode
      })
      if (generation !== reviewGenerationRef.current || editorRef.current?.state.doc.toString() !== source) return
      const resolved = result.edits.flatMap((edit): ResolvedPolishIssue[] => {
        const offset = original.indexOf(edit.original)
        if (
          offset < 0 ||
          original.indexOf(edit.original, offset + edit.original.length) >= 0
        ) {
          return []
        }
        const issueFrom = from + offset
        return [{
          ...edit,
          id: `polish:${issueFrom}:${quickHash(`${edit.original}\0${edit.replacement}`)}`,
          from: issueFrom,
          to: issueFrom + edit.original.length,
          agent: result.agent,
          model: result.model,
          filesConsidered: result.filesConsidered,
          context: result.context?.filter(source => edit.evidence.includes(source.path))
        }]
      })
      const nonOverlapping = resolved
        .sort((left, right) => left.from - right.from)
        .filter((issue, index, issues) => index === 0 || issue.from >= issues[index - 1].to)
      view.dispatch({ selection: EditorSelection.cursor(from) })
      replacePolishIssues(nonOverlapping)
      setRestored(false)
      persistRef.current('polish')
      if (nonOverlapping.length === 0) {
        setSuggestionError(t('latex.ai.noPolishChanges'))
      }
    } catch (reason) {
      if (generation === reviewGenerationRef.current) setSuggestionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSuggesting(false)
    }
  }

  const togglePolishMode = (): void => {
    if (suggesting) return
    const next: LatexPolishMode = polishMode === 'project' ? 'standard' : 'project'
    window.localStorage.setItem(POLISH_MODE_STORAGE_KEY, next)
    setPolishMode(next)
    replacePolishIssues([])
    setPolishPopover(null)
    setSuggestionError('')
    persistRef.current()
  }

  const acceptPolishIssue = (issue: ResolvedPolishIssue): void => {
    const view = editorRef.current
    if (readOnly || !view || view.state.sliceDoc(issue.from, issue.to) !== issue.original) return
    const delta = issue.replacement.length - issue.original.length
    const remaining = polishIssuesRef.current
      .filter((candidate) => candidate.id !== issue.id)
      .flatMap((candidate): ResolvedPolishIssue[] => {
        if (candidate.to <= issue.from) return [candidate]
        if (candidate.from >= issue.to) {
          return [{
            ...candidate,
            from: candidate.from + delta,
            to: candidate.to + delta
          }]
        }
        return []
      })
    applyingPolishIssueRef.current = true
    replacePolishIssues(remaining)
    view.dispatch({
      changes: { from: issue.from, to: issue.to, insert: issue.replacement },
      selection: EditorSelection.cursor(issue.from + issue.replacement.length),
      scrollIntoView: true
    })
    applyingPolishIssueRef.current = false
    setPolishPopover(null)
    view.focus()
    persistRef.current('accepted', issue)
  }

  const rejectPolishIssue = (issue: ResolvedPolishIssue): void => {
    replacePolishIssues(
      polishIssuesRef.current.filter((candidate) => candidate.id !== issue.id)
    )
    setPolishPopover(null)
    editorRef.current?.focus()
    persistRef.current('dismissed', issue)
  }

  const acceptReviewIssue = (issue: ResolvedReviewIssue): void => {
    const view = editorRef.current
    if (readOnly || !view || view.state.sliceDoc(issue.from, issue.to) !== issue.original) return
    view.dispatch({
      changes: { from: issue.from, to: issue.to, insert: issue.replacement },
      selection: EditorSelection.cursor(issue.from + issue.replacement.length),
      scrollIntoView: true
    })
    setReviewPopover(null)
    view.focus()
    persistRef.current('accepted', issue)
  }

  const rejectReviewIssue = (issue: ResolvedReviewIssue): void => {
    ignoredIssuesRef.current.add(issueSignature(issue))
    replaceReviewIssues(reviewIssuesRef.current.filter((candidate) => candidate.id !== issue.id))
    setReviewPopover(null)
    editorRef.current?.focus()
    persistRef.current('dismissed', issue)
  }

  useEffect(() => {
    const view = editorRef.current
    if (!view) return
    const marks = [
      ...reviewIssues.map(issue => ({ issue, className: 'linco-latex-ai-issue', attribute: 'data-latex-review-id' })),
      ...polishIssues.map(issue => ({ issue, className: 'linco-latex-polish-issue', attribute: 'data-latex-polish-id' })),
    ].filter(({ issue }) => issue.from >= 0 && issue.to <= view.state.doc.length && issue.from < issue.to)
      .map(({ issue, className, attribute }) => Decoration.mark({
        class: className, attributes: { [attribute]: issue.id, 'aria-label': issue.reason },
      }).range(issue.from, issue.to))
    view.dispatch({ effects: setAiMarks.of(Decoration.set(marks, true)) })
  }, [reviewIssues, polishIssues])

  const reviewInteraction = useMemo(
    () =>
      EditorView.domEventHandlers({
        mousedown(event) {
          const target = event.target as HTMLElement | null
          const marker = target?.closest<HTMLElement>('[data-latex-review-id]')
          const id = marker?.dataset.latexReviewId
          const issue = reviewIssuesRef.current.find((candidate) => candidate.id === id)
          const container = containerRef.current
          if (!issue || !container) return false
          const bounds = container.getBoundingClientRect()
          const width = Math.min(440, Math.max(280, bounds.width - 24))
          const rawLeft = event.clientX - bounds.left - 24
          const left = Math.max(12, Math.min(rawLeft, bounds.width - width - 12))
          const y = event.clientY - bounds.top
          const top = y + 250 > bounds.height ? Math.max(58, y - 238) : y + 14
          setReviewPopover({ id: issue.id, left, top })
          event.preventDefault()
          return true
        }
      }),
    []
  )

  const polishInteraction = useMemo(
    () =>
      EditorView.domEventHandlers({
        mousedown(event) {
          const target = event.target as HTMLElement | null
          const marker = target?.closest<HTMLElement>('[data-latex-polish-id]')
          const id = marker?.dataset.latexPolishId
          const issue = polishIssuesRef.current.find((candidate) => candidate.id === id)
          const container = containerRef.current
          if (!issue || !container) return false
          const bounds = container.getBoundingClientRect()
          const width = Math.min(440, Math.max(280, bounds.width - 24))
          const rawLeft = event.clientX - bounds.left - 24
          const left = Math.max(12, Math.min(rawLeft, bounds.width - width - 12))
          const y = event.clientY - bounds.top
          const top = y + 280 > bounds.height ? Math.max(58, y - 268) : y + 14
          setPolishPopover({ id: issue.id, left, top })
          setReviewPopover(null)
          event.preventDefault()
          return true
        }
      }),
    []
  )

  const editorActions = useRef({ onSave, onSaveAndCompile, onChange, requestSuggestion })
  editorActions.current = { onSave, onSaveAndCompile, onChange, requestSuggestion }
  const forwardEditorChange = useCallback((text: string) => editorActions.current.onChange(text), [])
  const editorBasicSetup = useMemo(() => ({
    lineNumbers: mode === 'source',
    highlightActiveLine: mode === 'source',
    highlightActiveLineGutter: mode === 'source',
    foldGutter: mode === 'source',
    tabSize: 2,
    defaultKeymap: false,
    searchKeymap: false,
    historyKeymap: false,
    autocompletion: false,
    completionKeymap: false,
  }), [mode])

  const completionExtensions = useMemo(() => [
    autocompletion({
      override: [latexProjectCompletionSource(projectFiles || [], relativeFile)],
      activateOnTyping: true,
      defaultKeymap: false,
      interactionDelay: 0,
      maxRenderedOptions: 40,
    }),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }, ...completionKeymap])),
    EditorView.theme({
      '.cm-tooltip-autocomplete': { fontSize: '12px', lineHeight: '1.6', maxWidth: 'min(480px, 90vw)' },
      '.cm-completionDetail': { fontSize: '11px', opacity: '0.65', marginLeft: '14px' },
    }),
  ], [projectFiles, relativeFile])

  const extensions = useMemo<Extension[]>(
    () => [
      latex({
        fileName,
        autoCloseTags: true,
        autoCloseBrackets: true,
        enableAutocomplete: false,
        enableLinting: true,
        enableTooltips: mode === 'source',
        linter: {
          checkMissingDocumentEnv: isMainDocument,
          checkMissingReferences: false,
          checkCitesWithoutBibliography: false
        }
      }),
      completionExtensions,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            const actions = editorActions.current
            const save = actions.onSaveAndCompile || actions.onSave
            save()
            return true
          }
        },
        {
          key: 'Alt-\\',
          preventDefault: true,
          run: () => {
            void editorActions.current.requestSuggestion()
            return true
          }
        },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingPolishIssueRef.current) {
          replacePolishIssues([])
          setPolishPopover(null)
          setSuggestionError('')
        }
        if (update.docChanged) {
          sourceRef.current = update.state.doc.toString()
          reviewGenerationRef.current += 1
          reviewEnabledRef.current = false
          reviewPendingRef.current = false
          reviewedSegmentsRef.current.clear()
          ignoredIssuesRef.current.clear()
          replaceReviewIssues(reviewIssuesRef.current.flatMap(issue => {
            const from = update.changes.mapPos(issue.from, 1)
            const to = update.changes.mapPos(issue.to, -1)
            return from < to && update.state.sliceDoc(from, to) === issue.original
              ? [{ ...issue, from, to }] : []
          }))
          setReviewProgress({ checked: 0, total: 0 })
          setReviewPopover(null)
          if (memoryReadyRef.current) setMemoryStatus('saving')
          if (memoryTimerRef.current !== null) clearTimeout(memoryTimerRef.current)
          memoryTimerRef.current = setTimeout(() => persistRef.current(), 400)
        } else if (update.viewportChanged) {
          setPolishPopover(null)
          setReviewPopover(null)
          scheduleReviewRef.current(450)
        }
      }),
      aiMarks,
      reviewInteraction,
      polishInteraction,
      reviewTheme,
      polishTheme,
      mode === 'visual' ? [visualDecorations, visualTheme] : sourceTheme
    ],
    // requestSuggestion reads the latest editor and callback from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      fileName,
      projectFiles,
      relativeFile,
      isMainDocument,
      mode,
      completionExtensions,
      reviewInteraction,
      polishInteraction
    ]
  )

  const wrapSelection = (before: string, after: string, placeholder: string): void => {
    const view = editorRef.current
    if (!view) return
    const range = view.state.selection.main
    const selected = view.state.sliceDoc(range.from, range.to)
    const body = selected || placeholder
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `${before}${body}${after}` },
      selection: EditorSelection.range(
        range.from + before.length,
        range.from + before.length + body.length
      ),
      scrollIntoView: true
    })
    view.focus()
  }

  const insertBlock = (block: string, cursorOffset?: number): void => {
    const view = editorRef.current
    if (!view) return
    const range = view.state.selection.main
    const line = view.state.doc.lineAt(range.from)
    const prefix = line.from === range.from ? '' : '\n'
    const insert = `${prefix}${block}\n`
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(
        range.from + prefix.length + (cursorOffset ?? block.length)
      ),
      scrollIntoView: true
    })
    view.focus()
  }

  const revealOffset = (view: EditorView, requestedOffset: number): void => {
    const offset = Math.max(0, Math.min(requestedOffset, view.state.doc.length))
    view.dispatch({
      selection: EditorSelection.cursor(offset),
      effects: EditorView.scrollIntoView(offset, { y: 'center' })
    })
    setPolishPopover(null)
    setReviewPopover(null)
    view.focus()
  }

  useEffect(() => {
    const view = editorRef.current
    if (view && navigationTarget) revealOffset(view, navigationTarget.offset)
    // revision intentionally makes repeated navigation to the same heading observable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationTarget?.revision])

  const activeReviewIssue =
    reviewPopover
      ? reviewIssues.find((issue) => issue.id === reviewPopover.id) || null
      : null
  const activePolishIssue =
    polishPopover
      ? polishIssues.find((issue) => issue.id === polishPopover.id) || null
      : null

  const exportHistory = (): void => {
    if (memoryTimerRef.current !== null) persistRef.current()
    if (!memoryRef.current) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(memoryRef.current, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'linco-writing-history.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-black/5 px-3 py-1 text-[11px] text-ink-muted" role="status">
        <span>{t(`latex.memory.${memoryStatus}`)}</span>
        {restored && <span>{t('latex.memory.restored')}</span>}
        {memoryError && <span className="text-red-600">{memoryError}</span>}
      </div>
      {historyOpen && (
        <section aria-label={t('latex.memory.history')} className="absolute inset-y-10 right-0 z-40 flex w-[min(420px,100%)] flex-col border-l border-black/10 bg-canvas shadow-xl">
          <div className="flex items-center justify-between border-b border-black/10 p-3 text-[12px]">
            <strong>{t('latex.memory.history')}</strong>
            <button type="button" disabled={!memoryRef.current} onClick={exportHistory} className="rounded px-2 py-1 hover:bg-black/5 disabled:opacity-40">{t('latex.memory.export')}</button>
            <button type="button" onClick={() => setHistoryOpen(false)} aria-label={t('common.close')}><X size={15} /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-[12px]">
            <p className="text-ink-muted">{t('latex.memory.local')}</p>
            {checkpoints.some(point => point.state.reviews.some(issue => issue.context?.length) || point.state.polish.some(issue => issue.context?.length)) && <p className="text-ink-muted">{t('latex.memory.evidenceNote')}</p>}
            {checkpoints.some(point => point.state.source !== value) && <p className="rounded bg-amber-500/10 p-2 text-ink">{t('latex.memory.stale')}</p>}
            <h3 className="font-semibold">{t('latex.memory.pending')}</h3>
            {[...reviewIssues, ...polishIssues].map(issue => (
              <article key={issue.id} className="space-y-2 rounded-lg border border-black/10 p-3">
                <p className="whitespace-pre-wrap text-ink-muted line-through">{issue.original}</p>
                <p className="whitespace-pre-wrap text-ink">{issue.replacement}</p>
                <p className="text-ink-muted">{issue.reason}</p>
                {issue.evidence.length > 0 && <p className="break-all text-[10px] text-ink-muted">{issue.evidence.join(' · ')}</p>}
                {issue.context?.map(source => <details key={source.path} className="text-[10px]"><summary className="cursor-pointer break-all">{source.path} · SHA256 {source.sha256.slice(0, 12)}</summary><pre className="max-h-36 overflow-auto whitespace-pre-wrap">{source.excerpt}</pre></details>)}
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => {
                    const review = reviewIssues.find(candidate => candidate.id === issue.id)
                    if (review) rejectReviewIssue(review)
                    else rejectPolishIssue(issue)
                  }}>{t('latex.ai.reject')}</button>
                  <button type="button" disabled={readOnly} onClick={() => {
                    const review = reviewIssues.find(candidate => candidate.id === issue.id)
                    if (review) acceptReviewIssue(review)
                    else acceptPolishIssue(issue)
                  }} className="font-medium text-accent disabled:opacity-40">{t('latex.ai.accept')}</button>
                </div>
              </article>
            ))}
            {reviewIssues.length + polishIssues.length === 0 && <p className="text-ink-muted">{t('latex.memory.noPending')}</p>}
            <h3 className="font-semibold">{t('latex.memory.checkpoints')}</h3>
            {[...checkpoints].reverse().map((point, index) => (
              <details key={`${point.at}:${index}`} className="rounded-lg border border-black/10 p-3">
                <summary className="cursor-pointer">{t(`latex.memory.${point.label}`)} · {new Date(point.at).toLocaleString()}</summary>
                <p className="my-2 text-ink-muted">{point.state.source === value && (point.state.contextIdentity || '') === contextIdentity ? t('latex.memory.match') : t('latex.memory.old')}</p>
                {point.decision && <div className="space-y-1 whitespace-pre-wrap"><p className="line-through">{point.decision.original}</p><p>{point.decision.replacement}</p><p className="text-ink-muted">{point.decision.reason}</p></div>}
                {[...point.state.reviews, ...point.state.polish].map(issue => <div key={issue.id} className="mt-2 space-y-1 border-t border-black/5 pt-2"><p>{issue.original} → {issue.replacement}</p><p className="text-ink-muted">{issue.reason}</p><p className="break-all text-[10px]">{issue.agent} · {issue.model} · {issue.evidence.join(' · ')}</p>{issue.context?.map(source => <details key={source.path}><summary className="cursor-pointer break-all text-[10px]">{source.path} · SHA256 {source.sha256.slice(0, 12)}</summary><pre className="max-h-36 overflow-auto whitespace-pre-wrap text-[10px]">{source.excerpt}</pre></details>)}</div>)}
              </details>
            ))}
          </div>
        </section>
      )}
      <div className="shrink-0 border-b border-black/8">
        <div className="flex h-9 items-center gap-0.5 px-2">
          <div className="mr-1 flex shrink-0 items-center rounded-md bg-sidebar p-0.5 text-[11px]">
            <button
              onClick={() => onMode('source')}
              className={`flex h-6 items-center gap-1 rounded px-2 ${
                mode === 'source' ? 'bg-canvas text-ink shadow-sm' : 'text-ink-muted'
              }`}
            >
              <Code2 size={12} />
              {t('latex.mode.source')}
            </button>
            <button
              onClick={() => onMode('visual')}
              className={`flex h-6 items-center gap-1 rounded px-2 ${
                mode === 'visual' ? 'bg-canvas text-ink shadow-sm' : 'text-ink-muted'
              }`}
            >
              <Heading1 size={12} />
              {t('latex.mode.visual')}
            </button>
          </div>
          <button
            type="button"
            disabled={readOnly}
            title={t('latex.completion.hint')}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-ink-muted hover:bg-black/5 disabled:opacity-40"
            onClick={() => {
              if (editorRef.current) { editorRef.current.focus(); startCompletion(editorRef.current) }
            }}
          >
            <Braces size={12} />{t('latex.completion.show')}
          </button>
          {onReviewSegments && (
            <div className="relative shrink-0">
              <ToolbarButton
                title={
                  reviewError
                    ? `${t('latex.ai.autoReviewHint')}: ${reviewError}`
                    : `${t('latex.ai.autoReviewHint')}${
                        reviewProgress.total > 0
                          ? ` (${reviewProgress.checked}/${reviewProgress.total})`
                          : ''
                      }`
                }
                onClick={() => {
                  if (!memoryReadyRef.current || reviewing) return
                  reviewEnabledRef.current = true
                  reviewGenerationRef.current += 1
                  reviewedSegmentsRef.current.clear()
                  replaceReviewIssues([])
                  setReviewProgress({ checked: 0, total: 0 })
                  setReviewError('')
                  setReviewPopover(null)
                  void runReviewRef.current()
                }}
              >
                {reviewing
                  ? <Loader2 size={14} className="animate-spin text-[#b48500]" />
                  : <SpellCheck2 size={14} className={reviewIssues.length > 0 ? 'text-[#b48500]' : ''} />}
              </ToolbarButton>
              {reviewIssues.length > 0 && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#d2a000] px-0.5 text-[8px] font-semibold leading-none text-white">
                  {Math.min(reviewIssues.length, 99)}
                </span>
              )}
            </div>
          )}
          {onRequestSuggestion && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-pressed={polishMode === 'project'}
                disabled={suggesting}
                onClick={togglePolishMode}
                title={t(
                  polishMode === 'project'
                    ? 'latex.ai.projectModeHint'
                    : 'latex.ai.standardModeHint'
                )}
                className={`flex h-6 shrink-0 items-center rounded px-1.5 text-[10px] font-medium disabled:opacity-50 ${
                  polishMode === 'project'
                    ? 'bg-[#f0ebfb] text-[#7560a8]'
                    : 'bg-black/[0.035] text-ink-muted hover:bg-black/[0.06]'
                }`}
              >
                {t(
                  polishMode === 'project'
                    ? 'latex.ai.mode.project'
                    : 'latex.ai.mode.standard'
                )}
              </button>
              <div className="relative">
                <ToolbarButton
                  title={
                    suggestionError
                      ? `${t('latex.ai.requestHint')}: ${suggestionError}`
                      : t('latex.ai.requestHint')
                  }
                  onClick={() => void requestSuggestion()}
                >
                  {suggesting
                    ? <Loader2 size={14} className="animate-spin text-[#8b72c7]" />
                    : <Sparkles size={14} className={polishIssues.length > 0 ? 'text-[#8b72c7]' : ''} />}
                </ToolbarButton>
                {polishIssues.length > 0 && (
                  <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#a995d6] px-0.5 text-[8px] font-semibold leading-none text-white">
                    {Math.min(polishIssues.length, 99)}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="flex-1" />
          <button type="button" onClick={() => setHistoryOpen(open => !open)}
            aria-expanded={historyOpen} aria-label={t('latex.memory.history')}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-ink-muted hover:bg-black/5">
            <History size={13} />{t('latex.memory.history')} {checkpoints.length || ''}
          </button>
          <span className="shrink-0 px-1 text-[10px] text-ink-faint">
            {saving ? t('latex.saving') : dirty ? t('latex.unsaved') : t('latex.saved')}
          </span>
          <ToolbarButton title={t('common.save')} onClick={onSave}>
            <Save size={14} />
          </ToolbarButton>
        </div>
        <div className="flex h-9 items-center gap-0.5 border-t border-black/5 px-2">
          <select
            aria-label={t('latex.toolbar.heading')}
            defaultValue=""
            onChange={(event) => {
              const command = event.target.value
              if (command) wrapSelection(`\\${command}{`, '}', t('latex.placeholder.heading'))
              event.target.value = ''
            }}
            className="h-7 w-[86px] shrink-0 rounded-md border-0 bg-transparent px-1 text-[11px] text-ink-muted outline-none hover:bg-black/5"
          >
            <option value="">{t('latex.toolbar.heading')}</option>
            <option value="section">{t('latex.heading.section')}</option>
            <option value="subsection">{t('latex.heading.subsection')}</option>
            <option value="subsubsection">{t('latex.heading.subsubsection')}</option>
          </select>
          <div className="mx-1 h-4 w-px shrink-0 bg-black/10" />
          <ToolbarButton title={t('latex.toolbar.bold')} onClick={() => wrapSelection('\\textbf{', '}', t('latex.placeholder.text'))}>
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.italic')} onClick={() => wrapSelection('\\emph{', '}', t('latex.placeholder.text'))}>
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.underline')} onClick={() => wrapSelection('\\underline{', '}', t('latex.placeholder.text'))}>
            <Underline size={14} />
          </ToolbarButton>
          <div className="mx-1 h-4 w-px shrink-0 bg-black/10" />
          <ToolbarButton title={t('latex.toolbar.bullets')} onClick={() => insertBlock('\\begin{itemize}\n  \\item Item\n\\end{itemize}', 26)}>
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.numbering')} onClick={() => insertBlock('\\begin{enumerate}\n  \\item Item\n\\end{enumerate}', 28)}>
            <ListOrdered size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.quote')} onClick={() => insertBlock('\\begin{quote}\nQuote\n\\end{quote}', 14)}>
            <Quote size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.math')} onClick={() => wrapSelection('$', '$', 'x^2')}>
            <Sigma size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.equation')} onClick={() => insertBlock('\\[\n  x^2 + y^2 = z^2\n\\]', 5)}>
            <Braces size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.link')} onClick={() => wrapSelection('\\href{https://}{', '}', t('latex.placeholder.link'))}>
            <Link size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.figure')} onClick={() => insertBlock('\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{figure.png}\n  \\caption{Caption}\n  \\label{fig:label}\n\\end{figure}', 80)}>
            <Image size={14} />
          </ToolbarButton>
          <ToolbarButton title={t('latex.toolbar.table')} onClick={() => insertBlock('\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{ll}\n    A & B \\\\\n    C & D \\\\\n  \\end{tabular}\n  \\caption{Caption}\n\\end{table}', 72)}>
            <Table2 size={14} />
          </ToolbarButton>
        </div>
      </div>
      {activePolishIssue && polishPopover && (
        <div
          role="dialog"
          aria-label={t('latex.ai.polishSuggestion')}
          className="absolute z-50 w-[440px] max-w-[calc(100%_-_24px)] overflow-hidden rounded-md border border-[#d8cff0] bg-canvas text-[12px] text-ink shadow-2xl"
          style={{ left: polishPopover.left, top: polishPopover.top }}
        >
          <div className="flex items-start gap-2 border-b border-black/8 px-3 py-2">
            <Sparkles size={15} className="mt-0.5 shrink-0 text-[#8b72c7]" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-[#7560a8]">
                {t('latex.ai.polishSuggestion')}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-faint">
                <span>{repositoryLabel}</span>
                <span>/</span>
                <span>
                  {activePolishIssue.agent}
                  {activePolishIssue.model ? ` / ${activePolishIssue.model}` : ''}
                </span>
              </div>
              {activePolishIssue.reason && (
                <div className="mt-1 leading-4 text-ink-muted">
                  {activePolishIssue.reason}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setPolishPopover(null)}
              className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
              title={t('common.close')}
            >
              <X size={13} />
            </button>
          </div>
          <div className="max-h-[260px] space-y-2 overflow-y-auto overscroll-contain px-3 py-2.5">
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase text-ink-faint">
                {t('latex.ai.original')}
              </div>
              <div className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/[0.035] px-2 py-1.5 leading-5 text-ink-muted line-through decoration-[#a995d6]">
                {activePolishIssue.original}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase text-ink-faint">
                {t('latex.ai.replacement')}
              </div>
              <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[#f4f1fb] px-2 py-1.5 leading-5 text-ink">
                {activePolishIssue.replacement}
              </div>
            </div>
            {activePolishIssue.evidence.length > 0 && (
              <div className="flex min-w-0 flex-wrap gap-1">
                {activePolishIssue.evidence.map((path) => (
                  <span
                    key={path}
                    title={path}
                    className="max-w-[250px] truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-[9px] text-ink-muted"
                  >
                    {path}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-1.5 border-t border-black/8 px-3 py-2">
            <button
              type="button"
              onClick={() => rejectPolishIssue(activePolishIssue)}
              className="flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] text-ink-muted hover:bg-black/5"
            >
              <X size={13} />
              {t('latex.ai.reject')}
            </button>
            <button
              type="button"
              onClick={() => acceptPolishIssue(activePolishIssue)}
              className="flex h-7 items-center gap-1 rounded-md bg-[#eee9f8] px-2.5 text-[11px] font-medium text-[#6f5a9f] hover:bg-[#e3dcf3]"
            >
              <Check size={13} />
              {t('latex.ai.accept')}
            </button>
          </div>
        </div>
      )}
      {activeReviewIssue && reviewPopover && (
        <div
          role="dialog"
          aria-label={t('latex.ai.reviewSuggestion')}
          className="absolute z-50 w-[440px] max-w-[calc(100%_-_24px)] overflow-hidden rounded-md border border-black/12 bg-canvas text-[12px] text-ink shadow-2xl"
          style={{ left: reviewPopover.left, top: reviewPopover.top }}
        >
          <div className="flex items-start gap-2 border-b border-black/8 px-3 py-2">
            <SpellCheck2 size={15} className="mt-0.5 shrink-0 text-[#b48500]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-ink-faint">
                <span className="font-semibold uppercase text-[#946f00]">
                  {t(`latex.ai.category.${activeReviewIssue.category}`)}
                </span>
                {activeReviewIssue.agent && (
                  <>
                    <span>·</span>
                    <span>
                      {activeReviewIssue.agent}
                      {activeReviewIssue.model ? ` / ${activeReviewIssue.model}` : ''}
                    </span>
                  </>
                )}
              </div>
              {activeReviewIssue.reason && (
                <div className="mt-0.5 leading-4 text-ink-muted">
                  {activeReviewIssue.reason}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setReviewPopover(null)}
              className="rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
              title={t('common.close')}
            >
              <X size={13} />
            </button>
          </div>
          <div className="space-y-2 px-3 py-2.5">
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase text-ink-faint">
                {t('latex.ai.original')}
              </div>
              <div className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-[#fff7d8] px-2 py-1.5 leading-5 text-ink-muted line-through decoration-[#b24635]">
                {activeReviewIssue.original}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase text-ink-faint">
                {t('latex.ai.replacement')}
              </div>
              <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-[#edf7ef] px-2 py-1.5 leading-5 text-ink">
                {activeReviewIssue.replacement}
              </div>
            </div>
            {activeReviewIssue.evidence.length > 0 && (
              <div className="flex min-w-0 flex-wrap gap-1">
                {activeReviewIssue.evidence.map((path) => (
                  <span
                    key={path}
                    title={path}
                    className="max-w-[250px] truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-[9px] text-ink-muted"
                  >
                    {path}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-1.5 border-t border-black/8 px-3 py-2">
            <button
              type="button"
              onClick={() => rejectReviewIssue(activeReviewIssue)}
              className="flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] text-ink-muted hover:bg-black/5"
            >
              <X size={13} />
              {t('latex.ai.reject')}
            </button>
            <button
              type="button"
              onClick={() => acceptReviewIssue(activeReviewIssue)}
              className="flex h-7 items-center gap-1 rounded-md bg-ink px-2.5 text-[11px] font-medium text-canvas hover:opacity-85"
            >
              <Check size={13} />
              {t('latex.ai.accept')}
            </button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          value={value}
          onChange={forwardEditorChange}
          editable={!readOnly}
          autoFocus={mode === 'source'}
          onCreateEditor={(view) => {
            editorRef.current = view
            if (navigationTarget) revealOffset(view, navigationTarget.offset)
            scheduleReviewRef.current(650)
          }}
          extensions={extensions}
          theme={
            dark && mode === 'source'
              ? vscodeDarkEditorTheme
              : vscodeLightEditorTheme
          }
          height="100%"
          basicSetup={editorBasicSetup}
          style={{ height: '100%', fontSize: mode === 'visual' ? 16 : 13 }}
        />
      </div>
    </div>
  )
}
