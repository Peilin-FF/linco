import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// This is the offline package contract, not an inventory of all of TeX Live.
export const academicPackages = [
  'algorithm2e', 'aliascnt', 'arydshln', 'bbding', 'changes', 'csvsimple',
  'ifoddpage', 'listingsutf8', 'lt3luabridge', 'lua-tinyyaml', 'markdown',
  'nicematrix', 'relsize', 'textpos', 'todonotes', 'truncate', 'was', 'xurl',
]

export function verifyTexSupplement(root) {
  let runfiles = 0
  function requireFile(relative) {
    const file = join(root, relative)
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Incomplete offline TeX supplement: ${relative}`)
    }
  }
  for (const name of academicPackages) {
    const metadata = `metadata/${name}.tlpobj`
    requireFile(metadata)
    const text = readFileSync(join(root, metadata), 'utf8')
    const runSection = text.match(/(?:^|\n)runfiles[^\n]*\n((?: [^\n]*(?:\n|$))*)/)
    if (!runSection) throw new Error(`No runtime file inventory in ${metadata}`)
    for (const file of runSection[1].trim().split(/\r?\n/)) {
      const relative = file.trim().replace(/^RELOC\//, 'texmf-dist/')
      if (relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
        throw new Error(`Invalid offline TeX package path in ${metadata}`)
      }
      requireFile(`common/${relative}`)
      runfiles++
    }
  }
  requireFile('windows/bin/windows/markdown2tex.exe')
  requireFile('macos/bin/universal-darwin/markdown2tex')
  return { packages: academicPackages.length, runfiles }
}
