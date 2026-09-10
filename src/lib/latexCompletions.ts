import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { latexCompletionSource } from 'codemirror-lang-latex'

export interface LatexCompletionFile { relative: string }

const builtin = latexCompletionSource(true)
const packages = [
  'amsmath', 'amssymb', 'amsthm', 'graphicx', 'xcolor', 'booktabs', 'hyperref',
  'cleveref', 'natbib', 'biblatex', 'geometry', 'microtype', 'fontspec',
  'caption', 'subcaption', 'enumitem', 'listings', 'listingsutf8', 'algorithm2e',
  'algorithmicx', 'tikz', 'todonotes', 'changes', 'csvsimple', 'nicematrix', 'xurl',
]
const commandSnippets = [
  ['\\section', '\\section{${title}}', 'Section heading'],
  ['\\subsection', '\\subsection{${title}}', 'Subsection heading'],
  ['\\textbf', '\\textbf{${text}}', 'Bold text'],
  ['\\textit', '\\textit{${text}}', 'Italic text'],
  ['\\emph', '\\emph{${text}}', 'Emphasis'],
  ['\\frac', '\\frac{${numerator}}{${denominator}}', 'Fraction · Tab moves between fields'],
  ['\\sqrt', '\\sqrt{${expression}}', 'Square root'],
  ['\\input', '\\input{${}}', 'Insert a TeX file · project-relative path'],
  ['\\include', '\\include{${}}', 'Include a TeX chapter · omit .tex'],
  ['\\includegraphics', '\\includegraphics{${}}', 'Insert a figure · project-relative path'],
  ['\\bibliography', '\\bibliography{${}}', 'BibTeX databases · omit .bib'],
  ['\\bibliographystyle', '\\bibliographystyle{${}}', 'BibTeX style'],
  ['\\addbibresource', '\\addbibresource{${}}', 'BibLaTeX database · include .bib'],
  ['\\usepackage', '\\usepackage{${}}', 'Load a LaTeX package'],
  ['\\documentclass', '\\documentclass{${}}', 'Choose a document class'],
  ['\\citep', '\\citep{${key}}', 'Parenthetical citation · natbib'],
  ['\\citet', '\\citet{${key}}', 'Textual citation · natbib'],
  ['\\label', '\\label{${key}}', 'Name a reference target'],
  ['\\ref', '\\ref{${key}}', 'Reference a label'],
  ['\\eqref', '\\eqref{${key}}', 'Reference an equation'],
].map(([label, template, detail]) => snippetCompletion(template, { label, detail, type: 'function', boost: 5 }))

const fileCommands: Record<string, { extensions: string[]; omitExtension?: boolean; list?: boolean }> = {
  input: { extensions: ['tex'] },
  include: { extensions: ['tex'], omitExtension: true },
  subfile: { extensions: ['tex'] },
  includeonly: { extensions: ['tex'], omitExtension: true, list: true },
  includegraphics: { extensions: ['pdf', 'png', 'jpg', 'jpeg', 'eps'] },
  includepdf: { extensions: ['pdf'] },
  bibliography: { extensions: ['bib'], omitExtension: true, list: true },
  addbibresource: { extensions: ['bib'] },
  bibliographystyle: { extensions: ['bst'], omitExtension: true },
  usepackage: { extensions: ['sty'], omitExtension: true, list: true },
  documentclass: { extensions: ['cls'], omitExtension: true },
}

function inComment(context: CompletionContext): boolean {
  const line = context.state.doc.lineAt(context.pos)
  return /(^|[^\\])(?:\\\\)*%/.test(context.state.sliceDoc(line.from, context.pos))
}

/** Use the same project-root-relative paths as Linco's compiler, also in subfiles. */
export function latexProjectCompletionSource(files: readonly LatexCompletionFile[], currentFile = '') {
  const paths = [...new Set(files.map(file => file.relative.replaceAll('\\', '/')))]
    .filter(file => file && !/[%#{}$^~\r\n]/.test(file) && !file.startsWith('/') && !file.split('/').includes('..'))
    .sort((a, b) => a.localeCompare(b))

  return (context: CompletionContext): CompletionResult | null => {
    if (inComment(context)) return null
    const prefix = context.state.sliceDoc(Math.max(0, context.pos - 4000), context.pos)
    const argument = /\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)$/.exec(prefix)
    const rule = argument && fileCommands[argument[1]]
    if (argument && rule) {
      const command = argument[1]
      const argumentText = argument[2]
      if (/[\\\r\n%#{}]/.test(argumentText)) return null
      const token = rule.list ? argumentText.slice(argumentText.lastIndexOf(',') + 1) : argumentText
      const leadingSpace = token.length - token.trimStart().length
      const typed = token.slice(leadingSpace)
      const from = context.pos - typed.length
      const dotPrefix = typed.startsWith('./') ? './' : ''
      const used = new Set(rule.list ? argumentText.split(',').slice(0, -1).map(part => part.trim()) : [])
      const options: Completion[] = paths.flatMap(file => {
        const extension = file.split('.').pop()?.toLowerCase() || ''
        if (!rule.extensions.includes(extension) || (extension === 'tex' && file === currentFile)) return []
        const label = dotPrefix + (rule.omitExtension ? file.replace(/\.[^.\/]+$/, '') : file)
        return [{ label, detail: extension.toUpperCase(), info: `Project file: ${file}`, type: 'text' }]
      })
      if (command === 'usepackage') options.push(...packages.map(label => ({ label, detail: 'LaTeX package', type: 'class' })))
      if (command === 'documentclass') options.push(...['article', 'report', 'book', 'beamer'].map(label => ({ label, detail: 'Document class', type: 'class' })))
      const unique = [...new Map(options.filter(option => !used.has(option.label)).map(option => [option.label, option])).values()]
      // Replace the rest of a partially edited name, never its closing brace/comma.
      const tail = context.state.sliceDoc(context.pos, context.state.doc.lineAt(context.pos).to).match(/^[^},\s]*/)?.[0] || ''
      return { from, to: context.pos + tail.length, options: unique, validFor: /^[^{}\\,\r\n%#]*$/ }
    }
    // Reuse the language package's commands, math symbols, and paired environments.
    const result = builtin(context)
    if (!result) return null
    if (/\\[A-Za-z]*$/.test(prefix) && !/^[{[]/.test(context.state.sliceDoc(context.pos, context.pos + 1))) {
      const snippetLabels = new Set(commandSnippets.map(option => option.label))
      return { ...result, options: [...commandSnippets, ...result.options.filter(option => !snippetLabels.has(option.label))] }
    }
    return result
  }
}
