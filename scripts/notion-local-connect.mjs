// Local-only Notion authorization. Run in the background with in-project logs.
// The user opens the returned URL; this helper never approves access or edits notes.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'codex-executable': { type: 'string' } } })
if (!values['codex-executable']) throw new Error('Pass --codex-executable explicitly')
const child = spawn(values['codex-executable'], ['app-server'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
})
const pending = new Map()
let nextId = 0
let settleLogin
const completed = new Promise((resolve) => { settleLogin = resolve })
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`${method} timed out`))
  }, 60_000)
  pending.set(id, { resolve, reject, timer })
  send({ id, method, params })
})

function failPending(error) {
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(error)
  }
  pending.clear()
  settleLogin({ success: false, error: error.message })
}
child.once('error', failPending)
child.once('exit', (code) => failPending(new Error(`Local Codex helper exited ${code}`)))
// Keep diagnostic stderr separate from the copyable authorization URL.
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
  } else if (message.method === 'mcpServer/oauthLogin/completed' && message.params?.name === 'notion') {
    settleLogin(message.params)
  } else if (message.id !== undefined) {
    // No interactive approvals or other operations are delegated to this helper.
    send({ id: message.id, error: { code: -32601, message: 'This helper only monitors Notion authorization' } })
  }
})

const overallTimer = setTimeout(() => {
  failPending(new Error('Local Notion authorization timed out'))
  child.kill()
}, 16 * 60_000)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); process.exit(130) })

try {
  await request('initialize', {
    clientInfo: { name: 'linco_local_notion_check', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  send({ method: 'initialized', params: {} })
  console.log(JSON.stringify({ phase: 'starting', host: 'local Windows', server: 'notion' }))
  const login = await request('mcpServer/oauth/login', { name: 'notion', timeoutSecs: 900 })
  const authorization = new URL(login.authorizationUrl)
  const callback = new URL(authorization.searchParams.get('redirect_uri'))
  if (authorization.origin !== 'https://mcp.notion.com' || callback.hostname !== '127.0.0.1') {
    throw new Error('Unexpected authorization origin or non-local callback; login stopped')
  }
  console.log(JSON.stringify({ phase: 'awaiting_user_approval', host: 'local Windows', callbackPort: callback.port }))
  console.log(authorization.href)
  const result = await completed
  if (!result.success) throw new Error(result.error || 'Notion authorization was not completed')
  console.log(JSON.stringify({ phase: 'authorized', host: 'local Windows', server: 'notion' }))
  await request('config/mcpServer/reload', {})
  let cursor
  let notion
  do {
    const status = await request('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly' })
    notion = status.data?.find((server) => server.name === 'notion')
    cursor = status.nextCursor
  } while (!notion && cursor)
  console.log(JSON.stringify({ phase: 'verified', host: 'local Windows', server: 'notion',
    authStatus: notion?.authStatus, toolCount: Object.keys(notion?.tools || {}).length,
    notesRead: false, notesModified: false }))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  clearTimeout(overallTimer)
  child.stdin.end()
  child.kill()
}
