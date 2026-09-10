import { describe, expect, it } from 'vitest'
import { latexRuntimeErrorKey } from '../src/lib/latex'

describe('LaTeX runtime failure guidance', () => {
  it('repairs the local app, not the remote host, with the current backend', () => {
    expect(latexRuntimeErrorKey({ pdf_is_local: true }, 'research-server'))
      .toBe('latex.toolMissing')
  })

  it('asks users on an old remote backend to update and restart Linco', () => {
    expect(latexRuntimeErrorKey({}, 'research-server'))
      .toBe('latex.desktopUpdateRequired')
    expect(latexRuntimeErrorKey({ pdf_is_local: false }, 'research-server'))
      .toBe('latex.desktopUpdateRequired')
  })

  it('keeps local runtime failures local regardless of backend version', () => {
    for (const pdf_is_local of [undefined, false, true]) {
      expect(latexRuntimeErrorKey({ pdf_is_local })).toBe('latex.toolMissing')
    }
  })
})
