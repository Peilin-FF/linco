import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// The build hook and tests deliberately share the same offline check.
// @ts-expect-error Node build scripts are JavaScript modules.
import { verifyTexSupplement } from '../scripts/verify-tex-supplement.mjs'

describe('app-owned offline TeX bundle', () => {
  it('ships all 18 declared academic packages and both desktop launchers', () => {
    expect(verifyTexSupplement(resolve('src-tauri/resources/tex/supplement')))
      .toEqual({ packages: 18, runfiles: 37 })
  })

  it('fails fast when the offline package tree is absent', () => {
    expect(() => verifyTexSupplement(resolve('tests/fixtures/latex/no-such-supplement')))
      .toThrow('Incomplete offline TeX supplement')
  })

  it('includes the TeX resource directory in Windows and macOS installers', () => {
    for (const platform of ['windows', 'macos']) {
      const config = JSON.parse(readFileSync(`src-tauri/tauri.${platform}.conf.json`, 'utf8'))
      expect(config.bundle.resources['resources/tex']).toBe('tex')
    }
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
    expect(config.build.beforeBundleCommand).toBe('node scripts/prepare-tex-bundle.mjs')
  })
})
