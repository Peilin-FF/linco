import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { latexProjectCompletionSource } from '../src/lib/latexCompletions'

const files = ['main.tex', 'sections/intro.tex', 'figures/result.pdf', 'figures/result.png',
  'figures/实验 1.jpg', 'refs/library.bib', 'refs/other.bib', 'styles/paper.sty', 'styles/paper.cls', 'styles/paper.bst']
  .map(relative => ({ relative }))

function complete(doc: string, pos = doc.length, explicit = false) {
  return latexProjectCompletionSource(files, 'main.tex')(new CompletionContext(EditorState.create({ doc }), pos, explicit))
}
const labels = (doc: string) => complete(doc)?.options.map(option => option.label) || []

describe('LaTeX project completion', () => {
  it('keeps the built-in math commands and paired environments', () => {
    expect(labels('\\alp')).toContain('\\alpha')
    expect(labels('\\begin{equ')).toContain('equation')
    expect(labels('\\end{fig')).toContain('figure')
  })
  it('offers editable argument snippets and no suggestions in plain prose or comments', () => {
    expect(complete('\\frac')?.options.find(option => option.label === '\\frac')?.apply).toBeTypeOf('function')
    expect(complete('Just writing a paragraph')).toBeNull()
    expect(complete('% \\input{', undefined, true)).toBeNull()
    expect(complete('\\\\% \\input{', undefined, true)).toBeNull()
    expect(labels('Price is 10\\% \\input{')).toContain('sections/intro.tex')
  })
  it('suggests actual TeX paths relative to the compile root and excludes the current file', () => {
    expect(labels('\\input{')).toEqual(['sections/intro.tex'])
    expect(labels('\\include{')).toEqual(['sections/intro'])
    expect(labels('\\input{./')).toEqual(['./sections/intro.tex'])
  })
  it('filters figures, including optional arguments, starred commands and Unicode names', () => {
    const expected = ['figures/result.pdf', 'figures/result.png', 'figures/实验 1.jpg']
    expect(labels('\\includegraphics*[width=0.8\\textwidth,\nheight=4cm]{').sort()).toEqual(expected.sort())
    expect(labels('\\includepdf{')).toEqual(['figures/result.pdf'])
  })
  it('preserves prior comma-separated bibliography entries and uses the correct extension', () => {
    const doc = '\\bibliography{refs/library, re'
    const result = complete(doc)!
    expect(result.options.map(option => option.label)).toEqual(['refs/other'])
    expect(doc.slice(0, result.from)).toBe('\\bibliography{refs/library, ')
    expect(labels('\\addbibresource{')).toEqual(['refs/library.bib', 'refs/other.bib'])
  })
  it('replaces an edited path suffix without consuming closing punctuation', () => {
    const doc = '\\input{sections/inxxx.tex}'
    const result = complete(doc, doc.indexOf('xxx'))!
    expect(doc.slice(result.from, result.to)).toBe('sections/inxxx.tex')
    expect(doc.slice(result.to)).toBe('}')
  })
  it('completes installed/common package names and local styles without replacing earlier packages', () => {
    const doc = '\\usepackage[options]{amsmath, gr'
    const result = complete(doc)!
    expect(result.options.map(option => option.label)).toContain('graphicx')
    expect(result.options.map(option => option.label)).toContain('styles/paper')
    expect(result.options.map(option => option.label)).not.toContain('amsmath')
    expect(doc.slice(0, result.from)).toBe('\\usepackage[options]{amsmath, ')
    expect(labels('\\bibliographystyle{')).toEqual(['styles/paper'])
    expect(labels('\\documentclass{')).toContain('styles/paper')
  })
  it('never carries file names between project sources or inserts unsafe TeX paths', () => {
    const source = latexProjectCompletionSource([{ relative: 'other.tex' }, { relative: '../private.tex' }, { relative: 'bad%file.tex' }])
    const doc = '\\input{'
    expect(source(new CompletionContext(EditorState.create({ doc }), doc.length, false))?.options.map(option => option.label))
      .toEqual(['other.tex'])
  })
})
