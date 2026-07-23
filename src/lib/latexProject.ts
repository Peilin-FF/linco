export interface LatexProjectTextFile {
  name: string
  path: string
  relative: string
  depth: number
}

function normalizeRelativePath(value: string): string {
  const parts: string[] = []
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

function comparablePath(value: string, caseInsensitive: boolean): string {
  const normalized = normalizeRelativePath(value)
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function rootDirective(source: string): string {
  const match = source.match(/^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im)
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') || ''
}

function resolveRootDirective(file: LatexProjectTextFile, directive: string): string {
  const slash = file.relative.replace(/\\/g, '/').lastIndexOf('/')
  const directory = slash >= 0 ? file.relative.slice(0, slash + 1) : ''
  const candidate = normalizeRelativePath(`${directory}${directive}`)
  return /\.[a-z0-9]+$/i.test(candidate) ? candidate : `${candidate}.tex`
}

function uncommentedSource(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== '%') continue
        let backslashes = 0
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
          backslashes += 1
        }
        if (backslashes % 2 === 0) return line.slice(0, index)
      }
      return line
    })
    .join('\n')
}

export function chooseLatexMainDocument(
  files: LatexProjectTextFile[],
  rememberedPath: string,
  sources: ReadonlyMap<string, string>,
  caseInsensitive = false
): string {
  const remembered = files.find((file) => file.path === rememberedPath)
  if (remembered) return remembered.path

  const byRelative = new Map(
    files.map((file) => [comparablePath(file.relative, caseInsensitive), file])
  )
  for (const file of files) {
    const directive = rootDirective(sources.get(file.path) || '')
    if (!directive) continue
    const target = byRelative.get(
      comparablePath(resolveRootDirective(file, directive), caseInsensitive)
    )
    if (target) return target.path
  }

  const structuralCandidates = files
    .map((file) => {
      const source = uncommentedSource(sources.get(file.path) || '')
      const hasClass = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(source)
      const hasDocument = /\\begin\s*\{document\}/.test(source)
      return {
        file,
        structural: hasClass || hasDocument,
        score:
          (hasClass ? 1000 : 0) +
          (hasDocument ? 500 : 0) +
          (file.name.toLowerCase() === 'main.tex' ? 100 : 0) +
          Math.max(0, 20 - file.depth)
      }
    })
    .filter((candidate) => candidate.structural)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.file.depth - b.file.depth ||
        a.file.relative.localeCompare(b.file.relative)
    )

  return (
    structuralCandidates[0]?.file.path ||
    files.find((file) => file.name.toLowerCase() === 'main.tex')?.path ||
    files[0]?.path ||
    ''
  )
}
