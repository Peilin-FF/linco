import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const VERSION = '2026.05'
const RELEASE_ROOT = `https://github.com/rstudio/tinytex-releases/releases/download/v${VERSION}`

const bundles = {
  win32: {
    filename: `TinyTeX-windows-v${VERSION}.exe`,
    sha256: 'cfd2b2a39a023fbdd68f5637b12754936a3573c95d0b3fd46868d4bee8bc058b',
  },
  darwin: {
    filename: `TinyTeX-darwin-v${VERSION}.tar.xz`,
    sha256: '53f55f2ec100cc4e0ba5840f8a66086c6e37aa36b9aa4c64f924165352443e92',
  },
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const bundle = bundles[process.platform]
if (!bundle) {
  console.log(`[tex] No bundled TinyTeX runtime is configured for ${process.platform}; skipping.`)
  process.exit(0)
}

const output = resolve('src-tauri', 'resources', 'tex', bundle.filename)
mkdirSync(dirname(output), { recursive: true })
for (const candidate of Object.values(bundles)) {
  const path = resolve('src-tauri', 'resources', 'tex', candidate.filename)
  if (path !== output) rmSync(path, { force: true })
}

if (existsSync(output) && (await sha256(output)) === bundle.sha256) {
  console.log(`[tex] Verified cached ${bundle.filename}`)
  process.exit(0)
}

const partial = resolve('tmp', 'tex', `${bundle.filename}.part`)
mkdirSync(dirname(partial), { recursive: true })
rmSync(partial, { force: true })
const officialUrl = `${RELEASE_ROOT}/${bundle.filename}`
const url = process.env.LINCO_TEX_DOWNLOAD_URL || officialUrl
console.log(`[tex] Downloading ${url}`)

const curlArgs = ['--fail', '--location', '--retry', '5', '--retry-all-errors']
if (process.env.LINCO_TEX_DOWNLOAD_LOG) {
  curlArgs.push('--stderr', resolve(process.env.LINCO_TEX_DOWNLOAD_LOG))
}
curlArgs.push('--output', partial, url)
const result = spawnSync(
  'curl',
  curlArgs,
  { stdio: 'inherit' }
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`curl exited with status ${result.status}`)

const actual = await sha256(partial)
if (actual !== bundle.sha256) {
  rmSync(partial, { force: true })
  throw new Error(`TinyTeX checksum mismatch: expected ${bundle.sha256}, received ${actual}`)
}

rmSync(output, { force: true })
renameSync(partial, output)
console.log(`[tex] Ready: ${output}`)
