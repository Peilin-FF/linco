// Opt-in component smoke tests, not a substitute for testing the rebuilt desktop.
// --paper <user@host> <remote-paper> <main.tex> <local-latexmk>
// --figure (creates a clearly labelled synthetic PowerPoint fixture)
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const hash = data => createHash('sha256').update(data).digest('hex')
await mkdir(path.join(root, 'tmp'), { recursive: true })
const job = await mkdtemp(path.join(root, 'tmp/research-production-smoke-'))
console.log(`Component test directory: ${job}`)
async function run(program, args, options = {}) {
  const log = path.join(job, 'production.log')
  const output = createWriteStream(log)
  const child = spawn(program, args, { cwd: job, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  console.log(`PID ${child.pid}; log ${log}`)
  child.stdout.pipe(output, { end: false })
  child.stderr.pipe(output, { end: false })
  const timeout = setTimeout(() => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    else child.kill('SIGKILL')
  }, 180000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }).finally(() => { clearTimeout(timeout); output.end() })
  return code
}

if (process.argv[2] === '--paper') {
  const [, , , host, repo, main, latexmk] = process.argv
  if (!host || !repo || !main || !latexmk) throw new Error('Supply remote host, paper directory, relative main file and local latexmk path.')
  const agent = await readFile(path.join(root, 'src-tauri/src/agent/linco_agent.py'), 'utf8')
  const helpers = agent.slice(agent.indexOf('def _snapshot_open('), agent.indexOf('def op_paper_ai('))
  if (!helpers) throw new Error('Snapshot helper extraction failed')
  const script = `import os, base64, json\n${helpers}\nprint(json.dumps(op_latex_snapshot(json.loads(${JSON.stringify(JSON.stringify({ repo }))}))))\n`
  const { stdout } = await new Promise((resolve, reject) => {
    const child = execFile('ssh.exe', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'python3 -'], { windowsHide: true, timeout: 90000, maxBuffer: 140 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve({ stdout }))
    child.stdin.end(script)
  })
  const snapshot = JSON.parse(stdout)
  const source = path.join(job, 'source'), output = path.join(job, 'output')
  await mkdir(source); await mkdir(output)
  const manifest = []
  const seen = new Set()
  for (const file of snapshot.files) {
    if (file.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\:<>"|?*]/.test(part))) throw new Error('Unsafe snapshot path')
    const absolute = path.resolve(source, file.path)
    if (!absolute.startsWith(source + path.sep) || seen.has(absolute.toLowerCase())) throw new Error('Snapshot collision or escape')
    seen.add(absolute.toLowerCase())
    const bytes = Buffer.from(file.data, 'base64')
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)
    manifest.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes) })
  }
  if (!manifest.some(file => file.path === main)) throw new Error('Main TeX file is missing')
  console.log(`Read-only remote capture: ${manifest.length} files, ${snapshot.bytes} bytes.`)
  // Read the offline supplement as a separate TeX tree. Do not install into or
  // overwrite the user's TeX runtime during this component test.
  const supplement = path.join(root, 'src-tauri/resources/tex/supplement/common/texmf-dist')
  const code = await run(latexmk, ['-norc', '-no-shell-escape', '-pdf', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-halt-on-error', `-outdir=${output}`, `./${main}`], { cwd: source, env: { ...process.env, TEXMFHOME: supplement, PATH: path.dirname(latexmk) + path.delimiter + process.env.PATH } })
  const pdf = path.join(output, path.basename(main, '.tex') + '.pdf')
  const pdfHash = await readFile(pdf).then(hash).catch(() => null)
  await writeFile(path.join(job, 'smoke-record.json'), JSON.stringify({ componentTest: true, host, repo, main, files: manifest, code, pdfHash, remoteWrites: false }, null, 2))
  console.log(`Local TeX exit ${code}; PDF fingerprint ${pdfHash || 'none'}`)
  if (code !== 0 || !pdfHash) process.exitCode = 1
} else if (process.argv[2] === '--figure') {
  // Reuse the application's actual geometry, not a hand-coded duplicate chart.
  const sourceCode = (await readFile(path.join(root, 'src/lib/researchProduction.ts'), 'utf8')).replace("import { invoke } from '@tauri-apps/api/core'", '')
  const compiled = ts.transpileModule(sourceCode, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { renderFigure } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  const text = 'method,score\ncontrol,12\nvariant,15\n'
  const source = { path: 'synthetic-fixture.csv', text, sha256: hash(text), bytes: Buffer.byteLength(text) }
  const recipe = { version: 1, kind: 'bar', x: 'method', y: 'score', title: 'Synthetic fixture - NOT experimental findings', yLabel: 'Test score (unitless)', sourcePath: source.path, sourceSha256: source.sha256, sourceRepo: 'test-fixture' }
  const rendered = renderFigure(source, recipe)
  await writeFile(path.join(job, 'figure-recipe.json'), JSON.stringify({ version: 1, recipe, marks: rendered.marks }, null, 2))
  await writeFile(path.join(job, 'figure.svg'), rendered.svg)
  const code = await run(process.execPath, [path.join(root, 'scripts/render-research-powerpoint.mjs'), path.join(root, 'vendor/HTML-VibeCoding/codex/powerpoint-live/scripts/server.mjs'), job, 'prepare'])
  console.log(`Local PowerPoint preparation exit ${code}; inspect ${path.join(job, 'figure-preview.png')} before saving.`)
  process.exitCode = code || 0
} else throw new Error('Choose --paper or --figure for this explicit, opt-in native component test.')
