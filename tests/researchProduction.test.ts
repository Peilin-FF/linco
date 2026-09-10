import { describe, expect, it } from 'vitest'
import { parseResults, renderFigure, writingPacket, type FigureRecipe, type ResearchSource } from '../src/lib/researchProduction'

const source: ResearchSource = { path: 'results.csv', sha256: 'a'.repeat(64), bytes: 40, text: 'method,score\nbaseline,12\nours,15\n' }
const recipe: FigureRecipe = { version: 1, kind: 'bar', x: 'method', y: 'score', title: 'Measured results', yLabel: 'Accuracy (%)', sourcePath: source.path, sourceSha256: source.sha256, sourceRepo: '/research' }

describe('research-to-figure integrity', () => {
  it('parses quoted commas, escaped quotes, unicode and TSV without changing values', () => {
    expect(parseResults('name,score\n"method, A",1.25\n"say ""yes""",2\n')).toEqual([['name', 'score'], ['method, A', '1.25'], ['say "yes"', '2']])
    expect(parseResults('方法\t分数\n对照\t3\n', '\t')[1]).toEqual(['对照', '3'])
  })
  it('rejects malformed or ambiguous tables', () => {
    for (const text of ['name,name\na,1', 'name,\na,1', 'a,b\none', 'a,b\n"oops,1', 'a,b\n"x"oops,1']) expect(() => parseResults(text)).toThrow()
  })
  it('never drops an all-empty row or coerces missing/non-numeric data to zero', () => {
    for (const value of ['', 'NaN', 'Infinity', '2%', '1,000']) {
      expect(() => renderFigure({ ...source, text: `method,score\nours,${value}\n` }, recipe)).toThrow()
    }
    expect(() => renderFigure({ ...source, text: 'method,score\n,\nours,12\n' }, recipe)).toThrow()
  })
  it('uses all numeric rows with a zero-inclusive scale and escapes markup', () => {
    const result = renderFigure(source, { ...recipe, title: '<script>alert(1)</script>' })
    expect(result.rows).toBe(2)
    expect(result.svg).not.toContain('<script>')
    expect(result.svg).toContain('&lt;script&gt;')
    expect(result.svg).toContain(source.sha256)
    const bars = result.marks.filter(m => m.name.startsWith('value-'))
    expect(bars[0].height / bars[1].height).toBeCloseTo(12 / 15)
  })
  it('does not draw a nonzero bar for zero; supports negative values without clipping', () => {
    const result = renderFigure({ ...source, text: 'method,score\nzero,0\nnegative,-2\npositive,2\n' }, recipe)
    expect(result.marks.find(m => m.name === 'value-0')).toBeUndefined()
    expect(result.marks.filter(m => m.name.startsWith('value-')).map(m => m.height)).toEqual([99, 99])
  })
  it('rejects mismatched provenance and overflowing label layouts', () => {
    expect(() => renderFigure(source, { ...recipe, sourceSha256: 'wrong' })).toThrow(/fingerprint/)
    expect(() => renderFigure({ ...source, text: 'method,score\n' + Array.from({ length: 20 }, (_, i) => `long-label-${i},1`).join('\n') }, recipe)).toThrow(/overlap/)
    expect(() => renderFigure(source, { ...recipe, yLabel: '' })).toThrow(/units/)
  })
  it('labels categorical lines honestly and never invents error bars', () => {
    const result = renderFigure(source, { ...recipe, kind: 'line' })
    expect(result.svg).toContain('table order; equal spacing')
    expect(result.svg).toContain('No aggregation or error bars')
  })
  it('exports bounded, explicitly truncated context with source fingerprints', () => {
    const packet = writingPacket({ version: 1, directory: 'local-job', repo: '/remote', host: 'remote', capturedAt: 1, sources: [{ ...source, text: 'x'.repeat(10000) }] }, 'Author hypothesis', 'Draft')
    expect(packet).toContain(source.sha256)
    expect(packet).toContain('Excerpt truncated')
    expect(packet).toContain('not verified findings')
    expect(packet.length).toBeLessThan(6000)
    const long = writingPacket({ version: 1, directory: 'job', repo: '/remote', capturedAt: 1, sources: [] }, '', 't'.repeat(100000))
    expect(long).toContain('Manuscript truncated')
    expect(long.length).toBeLessThan(26000)
  })
})
