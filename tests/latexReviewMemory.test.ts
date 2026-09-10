import { describe, expect, it } from 'vitest'
import { emptyReviewState, nextReviewMemory, restoreReviewState, reviewScope, validateReviewMemory, type SavedReviewIssue } from '../src/lib/latexReviewMemory'

const issue: SavedReviewIssue = {
  id: 'one', segmentId: 'segment', original: 'We is', replacement: 'We are',
  from: 0, to: 5, reason: 'Agreement', category: 'grammar', evidence: [],
  agent: 'test', model: 'fixture', filesConsidered: 0
}
const scope = reviewScope('remote-a', '/paper', '/paper/main.tex')

describe('paper review memory', () => {
  it('isolates hosts, repositories and complete file paths', () => {
    expect(new Set([
      scope, reviewScope('remote-b', '/paper', '/paper/main.tex'),
      reviewScope(undefined, '/paper', '/paper/main.tex'),
      reviewScope('remote-a', '/other', '/paper/main.tex'),
      reviewScope('remote-a', '/paper', '/paper/appendix/main.tex')
    ]).size).toBe(5)
  })
  it('restores findings and dismissed signatures without mutating snapshots', () => {
    const state = { ...emptyReviewState('We is testing.'), reviews: [issue], ignored: ['a'], reviewed: ['b'] }
    const saved = nextReviewMemory(null, scope, state, 'review')
    state.reviews.length = 0
    const restored = restoreReviewState(saved, 'We is testing.')
    expect(restored.reviews).toEqual([issue])
    expect(restored.ignored).toEqual(['a'])
    expect(restored.reviewed).toEqual(['b'])
  })
  it('does not apply old offsets to changed source', () => {
    const saved = nextReviewMemory(null, scope, { ...emptyReviewState('We is testing.'), reviews: [issue] }, 'review')
    expect(restoreReviewState(saved, 'Now we are testing.')).toEqual(emptyReviewState('Now we are testing.'))
    expect(saved.checkpoints[0].state.reviews).toEqual([issue])
  })
  it('retains captured evidence but invalidates active findings when research context changes', () => {
    const reference = { path: 'results.csv', sha256: 'b'.repeat(64), bytes: 24, excerpt: 'baseline,12\nours,15' }
    const saved = nextReviewMemory(null, scope, { ...emptyReviewState('We is testing.'), contextIdentity: 'repo-a', reviews: [{ ...issue, context: [reference] }] }, 'review')
    expect(restoreReviewState(saved, saved.head.source, 'repo-a').reviews[0].context).toEqual([reference])
    expect(restoreReviewState(saved, saved.head.source, 'repo-b').reviews).toEqual([])
    expect(saved.checkpoints[0].state.reviews[0].context).toEqual([reference])
    for (const context of [null, {}, [{ ...reference, sha256: 'unverified' }], [{ ...reference, bytes: -1 }]]) {
      const invalid = { ...saved, head: { ...saved.head, reviews: [{ ...issue, context }] } }
      expect(() => validateReviewMemory(invalid, scope)).toThrow()
    }
  })
  it('rejects invalid anchors even when the source matches', () => {
    const saved = nextReviewMemory(null, scope, { ...emptyReviewState('We is testing.'), reviews: [{ ...issue, from: 2 }] })
    expect(restoreReviewState(saved, saved.head.source).reviews).toEqual([])
    const beyondEnd = nextReviewMemory(null, scope, { ...emptyReviewState('We is'), reviews: [{ ...issue, to: 999 }] })
    expect(restoreReviewState(beyondEnd, 'We is').reviews).toEqual([])
  })
  it('keeps accepted and dismissed decisions and increments revisions', () => {
    const first = nextReviewMemory(null, scope, emptyReviewState('We is testing.'), 'review')
    const second = nextReviewMemory(first, scope, emptyReviewState('We are testing.'), 'accepted', issue)
    const third = nextReviewMemory(second, scope, second.head, 'dismissed', issue)
    expect(third.revision).toBe(3)
    expect(third.checkpoints.map(point => point.label)).toEqual(['review', 'accepted', 'dismissed'])
    expect(third.checkpoints[1].decision?.reason).toBe('Agreement')
    expect(first.checkpoints).toHaveLength(1)
  })
  it('rejects unknown schemas, other scopes, malformed lists and categories', () => {
    const valid = nextReviewMemory(null, scope, emptyReviewState('text'))
    expect(validateReviewMemory(valid, scope)).toEqual(valid)
    for (const bad of [null, { ...valid, version: 2 }, { ...valid, scope: 'elsewhere' },
      { ...valid, head: { ...valid.head, reviews: [{ ...issue, category: 'invented' }] } },
      { ...valid, checkpoints: [{ label: 'review', state: {} }] }]) {
      expect(() => validateReviewMemory(bad, scope)).toThrow()
    }
  })
})
