// Call the user's locally authorized Notion connection without reading credentials
// or starting an AI turn. Redirect stdout/stderr to in-project logs when running.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  'codex-executable': { type: 'string' },
  inspect: { type: 'string' },
  tool: { type: 'string' },
  'arguments-file': { type: 'string' },
  'allow-write': { type: 'boolean', default: false },
} })
if (!values['codex-executable']) throw new Error('Pass --codex-executable explicitly')
if (!!values.inspect === !!values.tool) throw new Error('Choose --inspect or --tool')
if (values.tool && !values['arguments-file']) throw new Error('Pass --arguments-file for a tool call')
const argumentsValue = values.tool
  ? JSON.parse(readFileSync(values['arguments-file'], 'utf8').replace(/^\uFEFF/, ''))
  : undefined
if (Array.isArray(argumentsValue) && (values.tool !== 'notion-fetch' || argumentsValue.length > 10)) {
  throw new Error('Batch mode is limited to at most ten read-only Notion fetches')
}
const child = spawn(values['codex-executable'], ['app-server'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
})
const pending = new Map()
let nextId = 0
let threadId
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`${method} timed out; verify a write's target before retrying`))
  }, 120_000)
  pending.set(id, { resolve, reject, timer })
  send({ id, method, params })
})
const fail = (error) => {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
  pending.clear()
}
child.once('error', fail)
child.once('exit', (code) => fail(new Error(`Local Codex transport exited ${code}`)))
child.stderr.pipe(process.stderr)
createInterface({ input: child.stdout }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id !== undefined && !message.method) {
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    if (message.error) item.reject(new Error(message.error.message))
    else item.resolve(message.result)
  } else if (message.id !== undefined) {
    console.error(JSON.stringify({ approvalRequired: message.method }))
    send({ id: message.id, error: { code: -32601, message: 'Interactive requests require the user; this helper cannot approve them' } })
  }
})
const overallTimer = setTimeout(() => {
  fail(new Error('Local Notion operation exceeded its time limit'))
  child.kill()
}, 5 * 60_000)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); process.exit(130) })

try {
  await request('initialize', {
    clientInfo: { name: 'linco_local_notion_records', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  send({ method: 'initialized', params: {} })
  if (values.tool) {
    const started = await request('thread/start', { cwd: process.cwd(), ephemeral: true })
    threadId = started.thread.id
  }
  let cursor
  let notion
  do {
    const status = await request('mcpServerStatus/list', { threadId, cursor, limit: 100, detail: 'toolsAndAuthOnly' })
    notion = status.data?.find((server) => server.name === 'notion')
    cursor = status.nextCursor
  } while (!notion && cursor)
  if (!notion || notion.authStatus !== 'oAuth') throw new Error('Local Notion OAuth access is unavailable')
  const tools = Object.entries(notion.tools || {}).map(([key, spec]) => ({ ...spec, name: spec.name || key }))
  if (values.inspect) {
    const selected = new Set(values.inspect.split(','))
    console.log(JSON.stringify({ host: 'local Windows', authStatus: notion.authStatus,
      names: tools.map((tool) => tool.name), tools: tools.filter((tool) => selected.has(tool.name)) }))
  } else {
    const tool = tools.find((item) => item.name === values.tool)
    if (!tool) throw new Error('Requested Notion tool is not available')
    const readTools = new Set(['notion-search', 'notion-fetch'])
    if (!readTools.has(values.tool) && !values['allow-write']) throw new Error('A write requires explicit --allow-write')
    const inputs = Array.isArray(argumentsValue) ? argumentsValue : [argumentsValue]
    const results = []
    for (const input of inputs) {
      const result = await request('mcpServer/tool/call', { threadId, server: 'notion', tool: values.tool, arguments: input })
      results.push({ requestedId: input.id, ...result })
      if (result.isError) process.exitCode = 1
    }
    console.log(JSON.stringify(Array.isArray(argumentsValue) ? { results } : results[0]))
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  clearTimeout(overallTimer)
  child.stdin.end()
  child.kill()
}
