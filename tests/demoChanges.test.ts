import { expect, it } from 'vitest'
import { DemoChanges, unifiedDiff } from '../demo/changes'

it('resets the turn baseline while retaining earlier Git changes', () => {
  let current = { 'garden.json': 'basil\n', 'notes.md': 'draft\n' }
  const changes = new DemoChanges({ ...current }, () => current)
  expect(changes.changes()).toEqual({})
  changes.beginTurn()
  current = { ...current, 'garden.json': 'basil\nsunflower\n' }
  expect(changes.diff('garden.json')).toContain('+sunflower')
  changes.beginTurn()
  expect(changes.changes()).toEqual({})
  expect(changes.changes('git')).toEqual({ 'garden.json': 'M' })
  current = { ...current, 'notes.md': 'reviewed\n' }
  expect(changes.changes()).toEqual({ 'notes.md': 'M' })
  expect(changes.diff('notes.md')).toContain('-draft\n+reviewed')
  current = { ...current, 'notes.md': 'draft\n' }
  expect(changes.changes()).toEqual({})
})

it('formats additions, removals, unchanged files and context correctly', () => {
  expect(unifiedDiff('a.txt', '', 'new\n')).toContain('@@ -0,0 +1,1 @@\n+new')
  expect(unifiedDiff('a.txt', 'old\n', '')).toContain('@@ -1,1 +0,0 @@\n-old')
  expect(unifiedDiff('a.txt', 'same\n', 'same\n')).toBe('')
  expect(unifiedDiff('a.txt', 'head\nold\ntail\n', 'head\nnew\ntail\n')).toContain(' head\n-old\n+new\n tail')
})
