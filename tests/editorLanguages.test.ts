import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { languageForFile } from '../src/lib/editorLanguages'

describe('research file language support', () => {
  it.each([
    ['C:\\project\\launch_pilot.sh', 'Shell'], ['train.py', 'Python'],
    ['types.pyi', 'Python'], ['setup.ps1', 'PowerShell'], ['kernel.cu', 'C++ / CUDA'],
    ['config.toml', 'TOML'], ['Dockerfile.dev', 'Dockerfile'], ['.bashrc', 'Shell'],
    ['.env.local', 'Shell'], ['view.tsx', 'TypeScript'], ['notes.md', 'Markdown'],
    ['index.html', 'HTML'], ['data.yaml', 'YAML'], ['readme.txt', 'Plain text'],
  ])('%s uses %s', (path, expected) => expect(languageForFile(path).label).toBe(expected))

  it.each([
    ['launch.sh', '# Baseline\nexport SEED=42\nif [ -d outputs ]; then\n  echo "Ready"\nfi\n'],
    ['train.py', '# Baseline\nfrom pathlib import Path\ndef run(seed: int = 42):\n    return "Ready"\n'],
  ])('parses real tokens instead of plain text for %s', (path, doc) => {
    const state = EditorState.create({ doc, extensions: languageForFile(path).extensions })
    const tokens: string[] = []
    highlightTree(syntaxTree(state), classHighlighter, (_from, _to, classes) => tokens.push(classes))
    expect(tokens.some((token) => token.includes('comment'))).toBe(true)
    expect(new Set(tokens).size).toBeGreaterThanOrEqual(3)
  })
})
