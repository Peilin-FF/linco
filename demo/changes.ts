export type Snapshot = Record<string, string>

export function changedFiles(before: Snapshot, after: Snapshot): Record<string, string> {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path])
    .map(path => [path, !Object.hasOwn(before, path) ? 'A' : !Object.hasOwn(after, path) ? 'D' : 'M']))
}

// A single trimmed hunk is enough for the small demo files. Keep real unchanged
// context at the edges instead of painting the entire file as deleted/added.
export function unifiedDiff(path: string, before = '', after = ''): string {
  if (before === after) return ''
  const lines = (text: string) => text ? text.replace(/\n$/, '').split('\n') : []
  const a = lines(before), b = lines(after)
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const start = Math.max(0, prefix - 3), context = Math.min(suffix, 3)
  const oldEnd = a.length - suffix, newEnd = b.length - suffix
  const rows = [
    ...a.slice(start, prefix).map(line => ` ${line}`),
    ...a.slice(prefix, oldEnd).map(line => `-${line}`),
    ...b.slice(prefix, newEnd).map(line => `+${line}`),
    ...a.slice(oldEnd, oldEnd + context).map(line => ` ${line}`),
  ]
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${a.length ? start + 1 : 0},${oldEnd + context - start} +${b.length ? start + 1 : 0},${newEnd + context - start} @@`, ...rows].join('\n')
}

export class DemoChanges {
  private turn: Snapshot | null = null
  constructor(private initial: Snapshot, private current: () => Snapshot) {}
  beginTurn() { this.turn = { ...this.current() } }
  changes(scope: 'turn' | 'git' = 'turn') {
    const base = scope === 'git' ? this.initial : this.turn
    return base ? changedFiles(base, this.current()) : {}
  }
  diff(path: string, scope: 'turn' | 'git' = 'turn') {
    const base = scope === 'git' ? this.initial : this.turn
    return base ? unifiedDiff(path, base[path], this.current()[path]) : ''
  }
}
