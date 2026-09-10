// Local-only deterministic bridge. Research data is never executed as code.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const [, , serverPath, directory, mode] = process.argv
let sequence = 0
const pending = new Map()
const server = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
server.stderr.on('data', data => process.stderr.write(data))
createInterface({ input: server.stdout }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const item = pending.get(message.id)
  if (!item) return
  pending.delete(message.id)
  clearTimeout(item.timer)
  if (message.error) item.reject(new Error(message.error.message))
  else item.resolve(message.result)
})
server.on('error', error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }; pending.clear() })
server.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('PowerPoint bridge exited')) }; pending.clear() })
function rpc(method, params) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('PowerPoint bridge timed out')) }, 45000)
    pending.set(id, { resolve, reject, timer })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const text = result.content?.find(item => item.type === 'text')?.text
  return result.structuredContent || (text ? JSON.parse(text) : {})
}
try {
  if (!['prepare', 'save'].includes(mode)) throw new Error('Invalid PowerPoint action')
  const data = JSON.parse(await readFile(path.join(directory, 'figure-recipe.json'), 'utf8'))
  if (data.recipe.kind !== 'bar') throw new Error('Editable PowerPoint export currently supports bar figures. Use SVG for line figures.')
  const file = path.join(directory, 'figure.pptx')
  let exists = false
  try { await access(file); exists = true } catch { /* New figure. */ }
  if (mode === 'prepare' && exists) throw new Error('This PowerPoint file already exists. Open it to continue editing; generate a new figure revision to create a separate presentation.')
  if (mode === 'save' && !exists) throw new Error('Prepare and visually review the PowerPoint figure first.')
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'linco-research-production', version: '1' } })
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  await tool('powerpoint_live_launch', { file_path: file, slide_index: 1, canvas_preset: 'academic-wide', step_delay_ms: 0 })
  if (mode === 'prepare') {
    const operations = data.marks.map(mark => ({
      type: mark.text !== undefined ? 'add_text' : 'add_shape', name: mark.name,
      x: mark.x, y: mark.y, width: mark.width, height: mark.height,
      ...(mark.text !== undefined ? { text: mark.text, font_size: mark.fontSize, font_name: 'Arial', font_color: '#323638', align: 'center', margin: 0 }
        : { shape: 'rectangle', fill_color: mark.fill, stroke_color: 'none', stroke_width: 0 })
    }))
    const drawn = await tool('powerpoint_live_draw_sequence', { operations, step_delay_ms: 0 })
    if (drawn.completed === false) throw new Error(drawn.error || 'PowerPoint drawing was incomplete')
  }
  const inspection = await tool('powerpoint_live_inspect', { include_shapes: true })
  if (inspection.layout_warning_count !== 0) throw new Error('Resolve PowerPoint layout warnings before saving: ' + JSON.stringify(inspection))
  await tool('powerpoint_live_export_preview', { output_path: path.join(directory, 'figure-preview.png'), width: 1800 })
  if (mode === 'save') await tool('powerpoint_live_save', {})
  const presentationSha256 = mode === 'save' ? createHash('sha256').update(await readFile(file)).digest('hex') : null
  await writeFile(path.join(directory, `powerpoint-${mode === 'save' ? 'saved' : 'prepared'}.json`), JSON.stringify({
    version: 1, at: new Date().toISOString(), sourceSha256: data.recipe.sourceSha256,
    presentationSha256, inspection,
    note: 'The recipe records initial geometry. This inspection records the editable presentation; manual edits require scientific review and are not automatically validated against data.'
  }, null, 2))
  console.log(mode === 'save' ? 'PowerPoint figure saved after user approval.' : 'Figure ready in visible PowerPoint. Inspect its preview, then approve Save.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  server.stdin.end()
  server.kill()
}
