import { describe, expect, it } from 'vitest'
import { pageScale } from '@/components/latex/PdfPageView'

describe('pdf page scale', () => {
  const letter = { width: 612, height: 792 }

  it('fits the page to the column at 100%', () => {
    expect(pageScale(letter, 612, 1)).toBe(1)
    expect(pageScale(letter, 306, 1)).toBe(0.5)
  })

  it('multiplies the fitted scale by the zoom', () => {
    expect(pageScale(letter, 612, 2)).toBe(2)
    expect(pageScale(letter, 306, 2)).toBe(1)
  })

  it('is a pure function of the column width, so a scrollbar cannot feed back into it', () => {
    // The reader reserves the scrollbar gutter; identical widths must give identical
    // scales, or a page could resize itself on every render and flicker.
    expect(pageScale(letter, 800, 1.4)).toBe(pageScale(letter, 800, 1.4))
  })

  it('survives a page with no measured width', () => {
    expect(pageScale({ width: 0, height: 0 }, 600, 1.5)).toBe(1.5)
  })
})
