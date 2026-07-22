import { useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { EditorSelection, type EditorState, type Extension } from '@codemirror/state'
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
  Code2,
  Heading1,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Save,
  Sigma,
  Table2,
  Underline
} from 'lucide-react'
import { useIsDark } from '@/lib/theme'
import { useI18n } from '@/lib/i18n'

export type LatexEditorMode = 'visual' | 'source'

interface LatexVisualEditorProps {
  value: string
  fileName: string
  mode: LatexEditorMode
  dirty: boolean
  saving: boolean
  onMode: (mode: LatexEditorMode) => void
  onChange: (value: string) => void
  onSave: () => void
}

type VisualRange = ReturnType<Decoration['range']>

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

const sourceTheme = EditorView.theme({
  '&': { height: '100%', userSelect: 'text' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { minHeight: '100%', padding: '12px 0 40px' },
  '&.cm-focused': { outline: 'none' }
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
  value,
  fileName,
  mode,
  dirty,
  saving,
  onMode,
  onChange,
  onSave
}: LatexVisualEditorProps): JSX.Element {
  const { t } = useI18n()
  const dark = useIsDark()
  const editorRef = useRef<EditorView | null>(null)

  const extensions = useMemo<Extension[]>(
    () => [
      latex({
        fileName,
        autoCloseTags: true,
        autoCloseBrackets: true,
        enableAutocomplete: true,
        enableLinting: true,
        enableTooltips: mode === 'source'
      }),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSave()
            return true
          }
        },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
      ]),
      mode === 'visual' ? [visualDecorations, visualTheme] : sourceTheme
    ],
    [fileName, mode, onSave]
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-black/8 px-2">
        <div className="mr-1 flex shrink-0 items-center rounded-md bg-sidebar p-0.5 text-[11px]">
          <button
            onClick={() => onMode('visual')}
            className={`flex h-6 items-center gap-1 rounded px-2 ${
              mode === 'visual' ? 'bg-canvas text-ink shadow-sm' : 'text-ink-muted'
            }`}
          >
            <Heading1 size={12} />
            {t('latex.mode.visual')}
          </button>
          <button
            onClick={() => onMode('source')}
            className={`flex h-6 items-center gap-1 rounded px-2 ${
              mode === 'source' ? 'bg-canvas text-ink shadow-sm' : 'text-ink-muted'
            }`}
          >
            <Code2 size={12} />
            {t('latex.mode.source')}
          </button>
        </div>
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
        <div className="flex-1" />
        <span className="shrink-0 px-1 text-[10px] text-ink-faint">
          {saving ? t('latex.saving') : dirty ? t('latex.unsaved') : t('latex.saved')}
        </span>
        <ToolbarButton title={t('common.save')} onClick={onSave}>
          <Save size={14} />
        </ToolbarButton>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          value={value}
          onChange={onChange}
          onCreateEditor={(view) => {
            editorRef.current = view
          }}
          extensions={extensions}
          theme={dark && mode === 'source' ? githubDark : githubLight}
          height="100%"
          basicSetup={{
            lineNumbers: mode === 'source',
            highlightActiveLine: mode === 'source',
            highlightActiveLineGutter: mode === 'source',
            foldGutter: mode === 'source',
            tabSize: 2,
            defaultKeymap: false,
            searchKeymap: false,
            historyKeymap: false
          }}
          style={{ height: '100%', fontSize: mode === 'source' ? 13 : 16 }}
        />
      </div>
    </div>
  )
}
