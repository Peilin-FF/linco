import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fileIconKind, folderIconKind, iconForFile, FileTypeIcon, FolderTypeIcon } from '../src/components/files/icons'

describe('file identities', () => {
  it.each([
    ['train.py', 'python'], ['C:\\work.with.dots\\TRAIN.PY', 'python'],
    ['/mnt/project/scripts/test_causal_event_order.py', 'python'],
    ['index.HTML', 'html'], ['report.htm', 'html'], ['README.md', 'markdown'],
    ['notes.mdx', 'markdown'], ['README', 'markdown'], ['app.ts', 'typescript'],
    ['types.d.ts', 'typescript'], ['App.test.tsx', 'react'], ['App.jsx', 'react'],
    ['script.mjs', 'javascript'], ['script.cjs', 'javascript'], ['theme.scss', 'css'],
    ['app.vue', 'vue'], ['main.rs', 'rust'], ['Cargo.toml', 'rust'], ['run.go', 'go'],
    ['experiment.ipynb', 'notebook'], ['thesis.tex', 'tex'], ['sources.bib', 'bibliography'],
    ['requirements_qwen3.5.txt', 'python'], ['requirements.txt', 'python'],
    ['requirements-dev.txt', 'python'], ['pyproject.toml', 'python'],
    ['plot.svg', 'image'], ['photo.avif', 'image'], ['results.csv', 'spreadsheet'],
    ['records.sqlite3', 'database'], ['events.jsonl', 'json'], ['plan.yaml', 'config'],
    ['package.json', 'package'], ['package-lock.json', 'lock'], ['pnpm-lock.yaml', 'lock'],
    ['.gitignore', 'git'], ['.gitattributes', 'git'], ['.env.production.local', 'config'],
    ['.editorconfig', 'config'], ['Dockerfile', 'docker'], ['Dockerfile.dev', 'docker'],
    ['tsconfig.node.json', 'typescript'], ['Makefile', 'shell'], ['setup.ps1', 'shell'],
    ['LICENSE', 'text'], ['paper.pdf', 'pdf'], ['run.log', 'text'], ['data.tar.gz', 'archive'],
    ['recording.mp4', 'video'], ['audio.flac', 'audio'],
    ['unknown.blob', 'file'], ['python', 'file'], ['', 'file'],
    ['constructor', 'file'], ['__proto__', 'file'], ['file.toString', 'file'],
  ])('%s resolves to %s', (name, kind) => {
    expect(fileIconKind(name)).toBe(kind)
  })

  it('reuses stable components and renders different shapes for Python, HTML, Markdown', () => {
    expect(iconForFile('run.py')).toBe(iconForFile('test.py'))
    const shapes = ['run.py', 'index.html', 'README.md'].map((name) => renderToStaticMarkup(createElement(FileTypeIcon, { name })))
    expect(new Set(shapes).size).toBe(3)
    for (const output of shapes) {
      expect(output).toContain('aria-hidden="true"')
      expect(output).toContain('width="16"')
      expect(output).not.toContain('<img')
    }
  })

  it('preserves size and consumer classes', () => {
    const output = renderToStaticMarkup(createElement(iconForFile('main.py'), { size: 20, className: 'test-icon' }))
    expect(output).toContain('width="20"')
    expect(output).toContain('file-icon-teal test-icon')
  })
})

describe('folder identities', () => {
  it.each([
    ['src', 'source'], ['SCRIPTS', 'scripts'], ['tests', 'tests'], ['unit', 'tests'],
    ['experiments', 'experiments'], ['docs', 'docs'], ['datasets', 'data'],
    ['figures', 'images'], ['.git', 'git'], ['.github', 'github'],
    ['node_modules', 'packages'], ['notebooks', 'notebooks'], ['.vscode', 'config'],
    ['C:\\project\\tests\\', 'tests'], ['/mnt/project/src/', 'source'],
    ['my.folder', 'folder'], ['__proto__', 'folder'], ['constructor', 'folder'],
  ])('%s resolves to %s', (name, kind) => expect(folderIconKind(name)).toBe(kind))

  it('retains the folder badge while changing its open state', () => {
    const closed = renderToStaticMarkup(createElement(FolderTypeIcon, { name: 'tests' }))
    const open = renderToStaticMarkup(createElement(FolderTypeIcon, { name: 'tests', open: true }))
    expect(closed).toContain('data-folder-open="false"')
    expect(open).toContain('data-folder-open="true"')
    expect(open).toContain('data-folder-icon="tests"')
    expect(open).not.toBe(closed)
  })
})
