#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const SERVER_NAME = 'linco-powerpoint-live'
const SERVER_VERSION = '0.2.0'
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const HOST_SCRIPT = path.join(SCRIPT_DIR, 'powerpoint-host.ps1')

let host
let hostSequence = 0
let stepDelayMs = 180
let sessionLaunched = false
let syncInFlight = false
const pending = new Map()

const colorProperty = { type: 'string', pattern: '^(#[0-9A-Fa-f]{6}|none|transparent)$' }
const geometryProperties = {
  x: { type: 'number', description: 'Left position in slide points.' },
  y: { type: 'number', description: 'Top position in slide points.' },
  width: { type: 'number', exclusiveMinimum: 0 },
  height: { type: 'number', exclusiveMinimum: 0 }
}
const styleProperties = {
  fill_color: colorProperty,
  stroke_color: colorProperty,
  stroke_width: { type: 'number', minimum: 0, maximum: 50 },
  fill_transparency: { type: 'number', minimum: 0, maximum: 1 },
  dash: { type: 'boolean' },
  rotation: { type: 'number' }
}
const textProperties = {
  text: { type: 'string' },
  font_size: { type: 'number', minimum: 1, maximum: 300 },
  font_name: { type: 'string' },
  font_color: colorProperty,
  bold: { type: 'boolean' },
  align: { type: 'string', enum: ['left', 'center', 'right'] },
  vertical_align: { type: 'string', enum: ['top', 'middle', 'bottom'] },
  margin: { type: 'number', minimum: 0, maximum: 100 }
}

const tools = [
  {
    name: 'powerpoint_live_launch',
    description: 'Attach to the visible PowerPoint presentation already open at the same path, or open/create it when needed, then select a slide for live native-object drawing.',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string' },
        slide_index: { type: 'integer', minimum: 1, default: 1 },
        canvas_preset: {
          type: 'string',
          enum: ['academic-wide', 'academic-tall', 'academic-single', 'presentation-16x9', 'custom'],
          default: 'academic-wide',
          description: 'New-file canvas preset. academic-wide is 182 x 115 mm (516 x 326 pt) for a two-column paper figure.'
        },
        slide_width: { type: 'number', exclusiveMinimum: 0, description: 'Custom width in points; used only with canvas_preset=custom.' },
        slide_height: { type: 'number', exclusiveMinimum: 0, description: 'Custom height in points; used only with canvas_preset=custom.' },
        step_delay_ms: { type: 'integer', minimum: 0, maximum: 10000, default: 180 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_new_slide',
    description: 'Append and select a blank slide.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'powerpoint_live_select_slide',
    description: 'Select an existing slide for subsequent live operations.',
    inputSchema: {
      type: 'object', required: ['slide_index'],
      properties: { slide_index: { type: 'integer', minimum: 1 } }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_clear',
    description: 'Delete every object from the selected slide.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'powerpoint_live_add_shape',
    description: 'Add an editable native PowerPoint AutoShape to the visible slide.',
    inputSchema: {
      type: 'object', required: ['name', 'x', 'y', 'width', 'height'],
      properties: {
        name: { type: 'string' },
        shape: { type: 'string', enum: ['rectangle', 'rounded', 'ellipse', 'diamond', 'triangle', 'hexagon', 'parallelogram', 'pentagon', 'chevron', 'cloud'], default: 'rounded' },
        ...geometryProperties, ...styleProperties, ...textProperties
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_add_text',
    description: 'Add an editable native PowerPoint text box to the visible slide.',
    inputSchema: {
      type: 'object', required: ['name', 'text', 'x', 'y', 'width', 'height'],
      properties: { name: { type: 'string' }, ...geometryProperties, ...styleProperties, ...textProperties },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_add_connector',
    description: 'Add an editable native PowerPoint straight or elbow connector.',
    inputSchema: {
      type: 'object', required: ['name', 'x1', 'y1', 'x2', 'y2'],
      properties: {
        name: { type: 'string' }, kind: { type: 'string', enum: ['straight', 'elbow'], default: 'straight' },
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        stroke_color: colorProperty, stroke_width: { type: 'number', minimum: 0, maximum: 50 }, dash: { type: 'boolean' },
        start_arrow: { type: 'string', enum: ['none', 'triangle', 'oval'], default: 'none' },
        end_arrow: { type: 'string', enum: ['none', 'triangle', 'oval'], default: 'triangle' }
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_connect_shapes',
    description: 'Create a native connector anchored to two named PowerPoint shapes so it follows later shape movement.',
    inputSchema: {
      type: 'object', required: ['name', 'source_name', 'target_name'],
      properties: {
        name: { type: 'string' }, source_name: { type: 'string' }, target_name: { type: 'string' },
        source_site: { type: 'integer', minimum: 1, default: 1 }, target_site: { type: 'integer', minimum: 1, default: 1 },
        kind: { type: 'string', enum: ['straight', 'elbow'], default: 'straight' },
        stroke_color: colorProperty, stroke_width: { type: 'number', minimum: 0, maximum: 50 }, dash: { type: 'boolean' },
        start_arrow: { type: 'string', enum: ['none', 'triangle', 'oval'], default: 'none' },
        end_arrow: { type: 'string', enum: ['none', 'triangle', 'oval'], default: 'triangle' }
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_add_image',
    description: 'Insert an image as an editable PowerPoint picture object.',
    inputSchema: {
      type: 'object', required: ['name', 'path', 'x', 'y', 'width', 'height'],
      properties: { name: { type: 'string' }, path: { type: 'string' }, ...geometryProperties },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_update',
    description: 'Update a named PowerPoint shape, text box, connector, or picture.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string' }, ...geometryProperties, ...styleProperties, ...textProperties },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_delete',
    description: 'Delete a named object from the selected slide.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'powerpoint_live_group',
    description: 'Group named objects into one editable native PowerPoint group.',
    inputSchema: {
      type: 'object', required: ['name', 'names'],
      properties: { name: { type: 'string' }, names: { type: 'array', minItems: 2, items: { type: 'string' } } },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_ungroup',
    description: 'Ungroup a named PowerPoint group.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'powerpoint_live_align',
    description: 'Align named native objects relative to each other.',
    inputSchema: {
      type: 'object', required: ['names', 'mode'],
      properties: {
        names: { type: 'array', minItems: 2, items: { type: 'string' } },
        mode: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] }
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_distribute',
    description: 'Distribute three or more named objects at equal horizontal or vertical intervals.',
    inputSchema: {
      type: 'object', required: ['names', 'mode'],
      properties: {
        names: { type: 'array', minItems: 3, items: { type: 'string' } },
        mode: { type: 'string', enum: ['horizontal', 'vertical'] }
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_z_order',
    description: 'Move a named object in the PowerPoint stacking order.',
    inputSchema: {
      type: 'object', required: ['name', 'mode'],
      properties: { name: { type: 'string' }, mode: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] } },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_duplicate',
    description: 'Duplicate a named native object with a new stable name and optional offset.',
    inputSchema: {
      type: 'object', required: ['name', 'new_name'],
      properties: {
        name: { type: 'string' }, new_name: { type: 'string' },
        offset_x: { type: 'number', default: 6 }, offset_y: { type: 'number', default: 6 }
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_draw_sequence',
    description: 'Apply native PowerPoint operations one by one with a visible delay.',
    inputSchema: {
      type: 'object', required: ['operations'],
      properties: {
        operations: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object' } },
        step_delay_ms: { type: 'integer', minimum: 0, maximum: 10000 }
      }, additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_inspect',
    description: 'Return slide dimensions and geometry/text for every native object on the selected slide.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'powerpoint_live_export_preview',
    description: 'Export the selected slide to PNG for visual review and return the image.',
    inputSchema: {
      type: 'object', required: ['output_path'],
      properties: { output_path: { type: 'string' }, width: { type: 'integer', minimum: 320, maximum: 7680, default: 3200 }, height: { type: 'integer', minimum: 180, maximum: 4320, description: 'Optional; omitted to preserve the exact slide aspect ratio.' } },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_compare_reference',
    description: 'Return the reference image and current PowerPoint slide together for direct visual layout comparison.',
    inputSchema: {
      type: 'object', required: ['reference_path'],
      properties: {
        reference_path: { type: 'string' },
        width: { type: 'integer', minimum: 320, maximum: 7680, default: 3200 },
        height: { type: 'integer', minimum: 180, maximum: 4320, description: 'Optional; omitted to preserve the exact slide aspect ratio.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'powerpoint_live_save',
    description: 'Save the visible presentation after review.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

function ensureWindows() {
  if (process.platform !== 'win32') throw new Error('PowerPoint Live currently requires Windows desktop PowerPoint.')
}

function ensureHost() {
  ensureWindows()
  if (host && !host.killed) return
  host = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  const output = createInterface({ input: host.stdout, crlfDelay: Infinity })
  output.on('line', (line) => {
    let response
    try { response = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { return }
    const item = pending.get(response.id)
    if (!item) return
    pending.delete(response.id)
    clearTimeout(item.timer)
    if (response.ok) item.resolve(response.result)
    else item.reject(new Error(response.error || 'PowerPoint host command failed.'))
  })
  host.stderr.on('data', (chunk) => process.stderr.write(`[${SERVER_NAME}:host] ${chunk}`))
  host.on('exit', (code) => {
    const error = new Error(`PowerPoint host exited with code ${code}.`)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
    host = undefined
    sessionLaunched = false
  })
}

function hostCall(command, args = {}) {
  ensureHost()
  const id = ++hostSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`PowerPoint did not respond to ${command} within 45 seconds.`))
    }, 45000)
    pending.set(id, { resolve, reject, timer })
    host.stdin.write(`${JSON.stringify({ id, command, args })}\n`, (error) => {
      if (!error) return
      clearTimeout(timer)
      pending.delete(id)
      reject(error)
    })
  })
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function operationCommand(operation) {
  const type = operation?.type
  const supported = new Set([
    'add_shape', 'add_text', 'add_connector', 'connect_shapes', 'add_image',
    'group', 'ungroup', 'align', 'distribute', 'z_order', 'duplicate', 'update', 'delete'
  ])
  if (!supported.has(type)) throw new Error(`Unsupported sequence operation type: ${type}`)
  const { type: ignored, ...args } = operation
  return { command: type, args }
}

function auditSlide(snapshot) {
  const warnings = []
  const slideWidth = Number(snapshot.slide_width) || 0
  const slideHeight = Number(snapshot.slide_height) || 0
  const shapes = Array.isArray(snapshot.shapes) ? snapshot.shapes : []
  for (const shape of shapes) {
    const x = Number(shape.x) || 0
    const y = Number(shape.y) || 0
    const width = Number(shape.width) || 0
    const height = Number(shape.height) || 0
    if (x < -0.5 || y < -0.5 || x + width > slideWidth + 0.5 || y + height > slideHeight + 0.5) {
      warnings.push({
        code: 'out-of-bounds', severity: 'error', shapes: [shape.name],
        message: `${shape.name} extends outside the ${slideWidth} x ${slideHeight} pt canvas.`
      })
    }
    if (shape.text && (
      Number(shape.text_bounds_width) > width - 2 ||
      Number(shape.text_bounds_height) > height - 2
    )) {
      warnings.push({
        code: 'text-overflow', severity: 'error', shapes: [shape.name],
        message: `${shape.name} text bounds exceed its shape bounds.`
      })
    }
  }
  for (let i = 0; i < shapes.length; i += 1) {
    const left = shapes[i]
    if (!(Number(left.auto_shape_type) > 0) || Number(left.width) < 1 || Number(left.height) < 1) continue
    for (let j = i + 1; j < shapes.length; j += 1) {
      const right = shapes[j]
      if (!(Number(right.auto_shape_type) > 0) || Number(right.width) < 1 || Number(right.height) < 1) continue
      const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
      const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
      const overlapArea = overlapWidth * overlapHeight
      const smallerArea = Math.min(left.width * left.height, right.width * right.height)
      const ratio = smallerArea > 0 ? overlapArea / smallerArea : 0
      if (ratio >= 0.35 && ratio < 0.9) {
        warnings.push({
          code: 'shape-overlap', severity: 'warning', shapes: [left.name, right.name],
          message: `${left.name} and ${right.name} overlap by ${Math.round(ratio * 100)}% of the smaller shape.`
        })
      }
    }
  }
  return {
    ...snapshot,
    canvas_width_mm: Math.round((slideWidth / 72) * 25.4 * 10) / 10,
    canvas_height_mm: Math.round((slideHeight / 72) * 25.4 * 10) / 10,
    layout_warnings: warnings,
    layout_warning_count: warnings.length
  }
}

async function handleTool(name, args) {
  switch (name) {
    case 'powerpoint_live_launch':
      stepDelayMs = args.step_delay_ms ?? 180
      {
        const value = await hostCall('launch', args)
        sessionLaunched = true
        return { value }
      }
    case 'powerpoint_live_new_slide': return { value: await hostCall('new_slide') }
    case 'powerpoint_live_select_slide': return { value: await hostCall('select_slide', args) }
    case 'powerpoint_live_clear': return { value: await hostCall('clear') }
    case 'powerpoint_live_add_shape': return { value: await hostCall('add_shape', args) }
    case 'powerpoint_live_add_text': return { value: await hostCall('add_text', args) }
    case 'powerpoint_live_add_connector': return { value: await hostCall('add_connector', args) }
    case 'powerpoint_live_connect_shapes': return { value: await hostCall('connect_shapes', args) }
    case 'powerpoint_live_add_image': return { value: await hostCall('add_image', args) }
    case 'powerpoint_live_update': return { value: await hostCall('update', args) }
    case 'powerpoint_live_delete': return { value: await hostCall('delete', args) }
    case 'powerpoint_live_group': return { value: await hostCall('group', args) }
    case 'powerpoint_live_ungroup': return { value: await hostCall('ungroup', args) }
    case 'powerpoint_live_align': return { value: await hostCall('align', args) }
    case 'powerpoint_live_distribute': return { value: await hostCall('distribute', args) }
    case 'powerpoint_live_z_order': return { value: await hostCall('z_order', args) }
    case 'powerpoint_live_duplicate': return { value: await hostCall('duplicate', args) }
    case 'powerpoint_live_draw_sequence': {
      const results = []
      const delay = args.step_delay_ms ?? stepDelayMs
      for (const operation of args.operations) {
        const { command, args: operationArgs } = operationCommand(operation)
        results.push(await hostCall(command, operationArgs))
        if (delay > 0) await sleep(delay)
      }
      return { value: { operation_count: results.length, results } }
    }
    case 'powerpoint_live_inspect': return { value: auditSlide(await hostCall('inspect')) }
    case 'powerpoint_live_export_preview': {
      const result = await hostCall('export', args)
      const imageData = (await fs.readFile(path.resolve(result.output_path))).toString('base64')
      return { value: result, imageData }
    }
    case 'powerpoint_live_compare_reference': {
      const referencePath = path.resolve(args.reference_path)
      await fs.access(referencePath)
      const outputPath = path.join(os.tmpdir(), `linco-powerpoint-${process.pid}-${Date.now()}.png`)
      const result = await hostCall('export', { output_path: outputPath, width: args.width, height: args.height })
      const [referenceData, currentData] = await Promise.all([
        fs.readFile(referencePath),
        fs.readFile(outputPath)
      ])
      await fs.unlink(outputPath).catch(() => {})
      const extension = path.extname(referencePath).toLowerCase()
      const referenceMimeType = extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.webp' ? 'image/webp' : 'image/png'
      return {
        value: { reference_path: referencePath, slide_index: result.slide_index },
        imageContents: [
          { label: 'Reference', data: referenceData.toString('base64'), mimeType: referenceMimeType },
          { label: 'Current PowerPoint slide', data: currentData.toString('base64'), mimeType: 'image/png' }
        ]
      }
    }
    case 'powerpoint_live_save': return { value: await hostCall('save') }
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result } }
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } } }
function toolResult(value, { imageData, imageContents = [], isError = false } = {}) {
  const content = [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  if (imageData) content.push({ type: 'image', data: imageData, mimeType: 'image/png' })
  for (const image of imageContents) {
    if (image.label) content.push({ type: 'text', text: image.label })
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  return { content, ...(typeof value === 'object' && value !== null ? { structuredContent: value } : {}), isError }
}

async function handleMessage(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Draw step by step in visible desktop PowerPoint using native editable objects. Inspect geometry and export a PNG after each logical section before saving.'
    })
  }
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') return rpcResult(id, { tools })
  if (method === 'tools/call') {
    try {
      const result = await handleTool(params?.name, params?.arguments || {})
      return rpcResult(id, toolResult(result.value, {
        imageData: result.imageData,
        imageContents: result.imageContents
      }))
    } catch (error) {
      return rpcResult(id, toolResult({ error: error.message, tool: params?.name }, { isError: true }))
    }
  }
  if (method?.startsWith('notifications/')) return null
  return rpcError(id, -32601, `Method not found: ${method}`)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', async (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line.replace(/^\uFEFF/, '')) }
  catch (error) { process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error', error.message))}\n`); return }
  try {
    const response = await handleMessage(message)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify(rpcError(message.id, -32603, 'Internal error', error.message))}\n`)
  }
})

setInterval(async () => {
  if (!sessionLaunched || syncInFlight) return
  syncInFlight = true
  try { await hostCall('sync') }
  catch (error) { process.stderr.write(`[${SERVER_NAME}:sync] ${error.message}\n`) }
  finally { syncInFlight = false }
}, 500).unref()

process.on('exit', () => { if (host && !host.killed) host.kill() })
process.on('uncaughtException', (error) => process.stderr.write(`[${SERVER_NAME}] ${error.stack || error.message}\n`))
process.on('unhandledRejection', (error) => process.stderr.write(`[${SERVER_NAME}] ${error?.stack || error}\n`))
