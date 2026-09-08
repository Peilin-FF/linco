import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { rust } from '@codemirror/lang-rust'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { c, cpp } from '@codemirror/legacy-modes/mode/clike'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'

interface FileLanguage { label: string; extensions: Extension[] }
const language = (label: string, extension: Extension): FileLanguage => ({ label, extensions: [extension] })
const languages = {
  python: language('Python', python()),
  json: language('JSON', json()),
  javascript: language('JavaScript', javascript({ jsx: true })),
  typescript: language('TypeScript', javascript({ jsx: true, typescript: true })),
  rust: language('Rust', rust()),
  markdown: language('Markdown', markdown()),
  html: language('HTML', html()),
  css: language('CSS', css()),
  yaml: language('YAML', yaml()),
  shell: language('Shell', StreamLanguage.define(shell)),
  powershell: language('PowerShell', StreamLanguage.define(powerShell)),
  c: language('C', StreamLanguage.define(c)),
  cpp: language('C++ / CUDA', StreamLanguage.define(cpp)),
  toml: language('TOML', StreamLanguage.define(toml)),
  docker: language('Dockerfile', StreamLanguage.define(dockerFile)),
  text: { label: 'Plain text', extensions: [] } as FileLanguage,
}

export function languageForFile(path: string): FileLanguage {
  const name = path.split(/[\\/]/).pop()!.toLowerCase()
  if (/^dockerfile(?:\.|$)/.test(name)) return languages.docker
  if (/^\.(?:bashrc|bash_profile|zshrc|zprofile)$/.test(name) || /^\.env(?:\.|$)/.test(name)) return languages.shell
  const ext = name.slice(name.lastIndexOf('.') + 1)
  switch (ext) {
    case 'py': case 'pyi': case 'pyw': return languages.python
    case 'json': case 'jsonl': case 'ipynb': return languages.json
    case 'js': case 'jsx': case 'mjs': case 'cjs': return languages.javascript
    case 'ts': case 'tsx': case 'mts': case 'cts': return languages.typescript
    case 'rs': return languages.rust
    case 'md': case 'markdown': return languages.markdown
    case 'html': case 'htm': case 'vue': case 'svelte': return languages.html
    case 'css': case 'scss': case 'less': return languages.css
    case 'yaml': case 'yml': return languages.yaml
    case 'sh': case 'bash': case 'zsh': return languages.shell
    case 'ps1': case 'psm1': case 'psd1': return languages.powershell
    case 'c': case 'h': return languages.c
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'cu': case 'cuh': return languages.cpp
    case 'toml': return languages.toml
    default: return languages.text
  }
}
