import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeNotionUrl, notionAgentContext, notionPageUrl, notionProjectKey, readNotionLink, saveNotionLink } from '../src/lib/notion'

const id = '0123456789abcdef0123456789abcdef'
const page = `https://www.notion.so/${id}`
afterEach(() => vi.unstubAllGlobals())

describe('Notion notebook links', () => {
  it('accepts Notion HTTPS URLs, including shorthand and published sites', () => {
    expect(normalizeNotionUrl(' app.notion.com/login ')).toBe('https://app.notion.com/login')
    expect(normalizeNotionUrl('https://team.notion.site/Notes')).toBe('https://team.notion.site/Notes')
  })
  it.each(['https://notion.so.evil.test', 'https://evilnotion.so', 'http://notion.so', 'file:///C:/private', 'javascript:alert(1)', 'https://user@notion.so', 'https://notion.so:444', 'https://notion.\nso', ''])('rejects unsafe URL %s', (url) => {
    expect(normalizeNotionUrl(url)).toBeNull()
  })
  it('extracts a page from a title or UUID and strips credentials in queries', () => {
    expect(notionPageUrl(`https://app.notion.com/Experiment-${id}?token=private#section`)).toBe(page)
    expect(notionPageUrl('https://www.notion.so/01234567-89ab-cdef-0123-456789abcdef')).toBe(page)
    expect(notionPageUrl('https://app.notion.com/login?token=private')).toBeNull()
  })
  it('uses the peeked database page instead of its parent', () => {
    expect(notionPageUrl(`https://app.notion.com/${'a'.repeat(32)}?p=${id}`)).toBe(page)
  })
  it('separates projects and hosts without delimiter collisions', () => {
    expect(notionProjectKey('/project', 'alpha')).not.toBe(notionProjectKey('/project', 'beta'))
    expect(notionProjectKey('/project', 'alpha')).not.toBe(notionProjectKey('/other', 'alpha'))
    expect(notionProjectKey('a:b', 'c')).not.toBe(notionProjectKey('b', 'c:a'))
  })
  it('persists only a canonical page and allows unlinking', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) || null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
    saveNotionLink('project', `${page}?token=private`)
    expect(storage.get('project')).toBe(page)
    expect(readNotionLink('project')).toBe(page)
    expect(() => saveNotionLink('project', 'https://app.notion.com/login')).toThrow()
    saveNotionLink('project', null)
    expect(readNotionLink('project')).toBeNull()
  })
  it('handles unavailable storage and requests read-only agent context', () => {
    expect(readNotionLink('project')).toBeNull()
    const context = notionAgentContext(`${page}?token=private`)
    expect(context).toContain(page)
    expect(context).toContain('Do not change the note yet')
    expect(context).not.toContain('token=')
    expect(() => notionAgentContext('https://app.notion.com/login')).toThrow()
  })
})
