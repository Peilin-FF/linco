import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = name => readFileSync(new URL(name, import.meta.url))
const doc = JSON.parse(read('monokai-pro-ce.json'))
assert.equal(doc.format, 'linco-theme')
assert.equal(doc.version, 1)
assert.equal(doc.theme.name, 'Monokai Pro (CE)')
assert.equal(doc.theme.vars.canvas, '#2d2a2e')
assert.equal(doc.theme.vars.ink, '#fcfcfa')
assert.equal(doc.theme.syntax.keyword, '#ff6188')
assert.equal(doc.theme.syntax.string, '#ffd866')
assert.equal(Object.keys(doc.theme.ansi).length, 16)
for (const group of ['vars', 'syntax', 'ansi']) {
  for (const color of Object.values(doc.theme[group])) assert.match(color, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
}
assert.match(read('LICENSE.md').toString(), /Copyright © 2025 Monokai/)
for (const [file, width] of [['screenshot.png', 2048], ['icon.png', 1024]]) {
  const image = read(file)
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(image.readUInt32BE(16) >= width, `${file} must be at least ${width}px wide`)
}
for (const file of ['README.md', 'INSTALL.md', 'CONTRIBUTING.md']) assert.ok(read(file).length > 0)
console.log('Package verified: default CE palette, license, documentation and publication-size assets.')
