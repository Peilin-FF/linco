// Connect the explicitly selected remote Codex host to Notion. Run in the
// background with stdout/stderr redirected to a private, in-project .log file.
// OAuth credentials stay in Codex's remote credential store, never in this repo.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  host: { type: 'string' },
  project: { type: 'string' },
  status: { type: 'boolean', default: false },
} })
if (!values.host || !values.project) throw new Error('Pass the approved --host and --project explicitly')
const config = JSON.parse(readFileSync(join(homedir(), '.linco', 'config.json'), 'utf8'))
const connection = config.connections?.find((item) => item.host === values.host)
if (!connection) throw new Error('The approved remote host is no longer configured in Linco')
const endpoint = 'https://mcp.notion.com/mcp'
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const baseArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
if (connection.identity) baseArgs.push('-i', connection.identity)
let activeChild
function remote(command, { port, stream = false, timeout = 25000 } = {}) {
  const args = [...baseArgs]
  if (port) args.push('-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${port}`)
  args.push(values.host, `bash -ic ${quote(`cd -- ${quote(values.project)} && ${command}`)}`)
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    activeChild = child
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Connection timed out; the temporary SSH forwarding is closing'))
    }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stream) process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stream) process.stderr.write(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      activeChild = undefined
      if (code === 0) resolve(stdout)
      else reject(new Error(`Remote Codex exited ${code}. ${stream ? 'See the preceding output.' : stderr.slice(-500)}`))
    })
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { activeChild?.kill(); process.exit(130) })

const servers = JSON.parse(await remote('codex mcp list --json'))
const urlOf = (server) => server.transport?.url || server.url
const official = servers.find((server) => urlOf(server) === endpoint)
const collision = servers.find((server) => server.name === 'notion' && urlOf(server) !== endpoint)
if (collision && !official) throw new Error('A different server already uses the name notion; nothing was changed')
if (official?.enabled === false) throw new Error('The existing Notion server is disabled; nothing was changed')
const name = official?.name || 'notion'
if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Unexpected existing MCP server name')

if (values.status) {
  console.log(JSON.stringify({ host: values.host, project: values.project,
    notion: official ? { name, enabled: official.enabled, authStatus: official.auth_status, officialEndpoint: true } : null }))
} else {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  console.log(JSON.stringify({ phase: 'starting', host: values.host, project: values.project,
    server: name, reusingExisting: !!official, callbackPort: port, timeoutMinutes: 15 }))
  // The override only selects this login's listener. It does not persist a port
  // or change unrelated MCP settings. A single SSH process owns both forwarding
  // and the remote OAuth command, so its exit closes the temporary local port.
  const callback = `-c mcp_oauth_callback_port=${port}` +
    (official ? ` -c mcp_servers.${name}.oauth.callback_port=${port}` : '')
  const command = official
    ? `exec env BROWSER=true codex ${callback} mcp login ${quote(name)}`
    : `exec env BROWSER=true codex ${callback} mcp add ${quote(name)} --url ${quote(endpoint)}`
  await remote(command, { port, stream: true, timeout: 15 * 60 * 1000 })
  const updated = JSON.parse(await remote('codex mcp list --json')).find((server) => server.name === name)
  console.log(JSON.stringify({ phase: 'finished', server: name, enabled: updated?.enabled,
    authStatus: updated?.auth_status, officialEndpoint: urlOf(updated || {}) === endpoint,
    temporaryForwardingClosed: true }))
}
