import type { LatexReviewIssue } from './latex'
import type { EvidenceReference } from './researchProduction'

export interface SavedWritingIssue {
  id: string
  original: string
  replacement: string
  reason: string
  evidence: string[]
  from: number
  to: number
  agent: string
  model: string
  filesConsidered: number
  context?: EvidenceReference[]
}

export interface SavedReviewIssue extends SavedWritingIssue, LatexReviewIssue {}

export interface ReviewState {
  contextIdentity?: string
  source: string
  reviews: SavedReviewIssue[]
  polish: SavedWritingIssue[]
  reviewed: string[]
  ignored: string[]
}

export interface ReviewCheckpoint {
  at: string
  label: 'review' | 'polish' | 'accepted' | 'dismissed'
  state: ReviewState
  decision?: SavedWritingIssue
}

export interface ReviewMemory {
  version: 1
  scope: string
  revision: number
  head: ReviewState
  checkpoints: ReviewCheckpoint[]
}

// Explicit tuple encoding prevents same-name files on different hosts/projects colliding.
export function reviewScope(host: string | undefined, repo: string, file: string): string {
  return JSON.stringify([host || 'local', repo, file])
}

export function emptyReviewState(source: string): ReviewState {
  return { source, reviews: [], polish: [], reviewed: [], ignored: [] }
}

function validIssue(value: unknown): value is SavedWritingIssue {
  if (!value || typeof value !== 'object') return false
  const issue = value as SavedWritingIssue
  return ['id', 'original', 'replacement', 'reason', 'agent', 'model'].every(
    key => typeof (value as Record<string, unknown>)[key] === 'string'
  ) && issue.original.length > 0 && Array.isArray(issue.evidence)
    && issue.evidence.every(path => typeof path === 'string')
    && (issue.context === undefined || (Array.isArray(issue.context) && issue.context.every(source =>
      source && typeof source.path === 'string' && typeof source.excerpt === 'string'
      && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256)
      && Number.isSafeInteger(source.bytes) && source.bytes >= 0)))
    && Number.isSafeInteger(issue.from) && Number.isSafeInteger(issue.to)
    && issue.from >= 0 && issue.to > issue.from && Number.isFinite(issue.filesConsidered)
}

function validState(value: unknown): value is ReviewState {
  if (!value || typeof value !== 'object') return false
  const state = value as ReviewState
  return typeof state.source === 'string'
    && (state.contextIdentity === undefined || typeof state.contextIdentity === 'string')
    && Array.isArray(state.reviews) && state.reviews.every(issue => validIssue(issue)
      && typeof issue.segmentId === 'string'
      && ['spelling', 'grammar', 'clarity', 'consistency'].includes(issue.category))
    && Array.isArray(state.polish) && state.polish.every(validIssue)
    && Array.isArray(state.reviewed) && state.reviewed.every(key => typeof key === 'string')
    && Array.isArray(state.ignored) && state.ignored.every(key => typeof key === 'string')
}

export function validateReviewMemory(value: unknown, scope: string): ReviewMemory {
  const memory = value as ReviewMemory
  if (!memory || memory.version !== 1 || memory.scope !== scope
    || !Number.isSafeInteger(memory.revision) || memory.revision < 1
    || !validState(memory.head) || !Array.isArray(memory.checkpoints)
    || !memory.checkpoints.every(point => point && typeof point.at === 'string'
      && ['review', 'polish', 'accepted', 'dismissed'].includes(point.label)
      && validState(point.state) && (!point.decision || validIssue(point.decision)))) {
    throw new Error('Saved review history is invalid or from an unsupported version. It was not overwritten.')
  }
  return memory
}

// Restore only exact source matches; offsets alone are never trusted.
export function restoreReviewState(memory: ReviewMemory, source: string, contextIdentity = ''): ReviewState {
  if (memory.head.source !== source || (memory.head.contextIdentity || '') !== contextIdentity) return emptyReviewState(source)
  const matches = (issue: SavedWritingIssue): boolean =>
    issue.to <= source.length && issue.to - issue.from === issue.original.length
      && source.slice(issue.from, issue.to) === issue.original
  return { ...memory.head, reviews: memory.head.reviews.filter(matches), polish: memory.head.polish.filter(matches) }
}

export function nextReviewMemory(
  previous: ReviewMemory | null, scope: string, state: ReviewState,
  label?: ReviewCheckpoint['label'], decision?: SavedWritingIssue
): ReviewMemory {
  const head = structuredClone(state)
  const checkpoints = [...(previous?.checkpoints || [])]
  if (label) checkpoints.push({ at: new Date().toISOString(), label, state: head, ...(decision ? { decision: structuredClone(decision) } : {}) })
  const next: ReviewMemory = { version: 1, scope, revision: (previous?.revision || 0) + 1, head, checkpoints }
  // Never silently prune research decisions to make room. Export remains available.
  if (JSON.stringify(next).length > 20_000_000) throw new Error('Review history reached its 20 MB text limit. Export your history before continuing.')
  return next
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('linco-writing-memory', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('papers', { keyPath: 'scope' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Close other Linco windows to open review history.'))
  })
}

export async function loadReviewMemory(scope: string): Promise<ReviewMemory | null> {
  const db = await openDatabase()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction('papers', 'readonly')
      const request = transaction.objectStore('papers').get(scope)
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
    return value === undefined ? null : validateReviewMemory(value, scope)
  } finally { db.close() }
}

export async function saveReviewMemory(memory: ReviewMemory): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('papers', 'readwrite')
      const store = transaction.objectStore('papers')
      const request = store.get(memory.scope)
      let conflict = false
      request.onsuccess = () => {
        if ((request.result?.revision || 0) !== memory.revision - 1) {
          conflict = true
          transaction.abort()
        } else { store.put(memory) }
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(conflict
        ? new Error('Review history changed in another window. Export this window’s work, then reopen the paper.')
        : transaction.error || new Error('Review history was not saved.'))
      transaction.onerror = () => reject(transaction.error)
    })
  } finally { db.close() }
}
