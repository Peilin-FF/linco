#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.resolve(process.env.POWERPOINT_MCP_SERVER || path.join(scriptDirectory, 'server.mjs'))
const presentationPath = path.resolve(
  process.argv[2] || path.join(
    scriptDirectory,
    '..', '..', '..', '..', '..',
    'artifacts', 'PowerPoint-live-acceptance', 'live-progress', 'live-progress.pptx'
  )
)

const server = spawn(process.execPath, [serverPath], {
  cwd: path.dirname(serverPath),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
const pending = new Map()
let sequence = 0
let previewPath

createInterface({ input: server.stdout, crlfDelay: Infinity }).on('line', (line) => {
  const message = JSON.parse(line.replace(/^\uFEFF/, ''))
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
})
server.stderr.on('data', (chunk) => process.stderr.write(chunk))

function request(method, params = {}) {
  sequence += 1
  const id = sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'linco-powerpoint-acceptance', version: '1.0.0' }
  })
  assert(initialized.serverInfo?.name === 'linco-powerpoint-live', 'Unexpected MCP server name.')

  const listed = await request('tools/list')
  const toolNames = new Set(listed.tools.map((tool) => tool.name))
  for (const required of [
    'powerpoint_live_launch',
    'powerpoint_live_draw_sequence',
    'powerpoint_live_inspect',
    'powerpoint_live_save'
  ]) {
    assert(toolNames.has(required), `Missing MCP tool: ${required}`)
  }

  const drawSequenceTool = listed.tools.find((tool) => tool.name === 'powerpoint_live_draw_sequence')
  const operationVariants = drawSequenceTool.inputSchema.properties.operations.items.oneOf
  assert(Array.isArray(operationVariants), 'draw_sequence operations are not a discriminated union.')
  const operationTypes = new Set(operationVariants.map((variant) => variant.properties.type.const))
  for (const type of ['add_shape', 'add_text', 'update', 'delete', 'connect_shapes']) {
    assert(operationTypes.has(type), `draw_sequence schema is missing ${type}.`)
  }
  assert(operationVariants.every((variant) => variant.required.includes('type')), 'A sequence variant is missing the type discriminator.')

  const addShapeTool = listed.tools.find((tool) => tool.name === 'powerpoint_live_add_shape')
  const addTextTool = listed.tools.find((tool) => tool.name === 'powerpoint_live_add_text')
  const updateTool = listed.tools.find((tool) => tool.name === 'powerpoint_live_update')
  for (const tool of [addShapeTool, addTextTool, updateTool]) {
    assert(tool.inputSchema.properties.text_runs?.items?.properties?.font_color, `${tool.name} does not expose rich text runs.`)
  }
  const transparency = addShapeTool.inputSchema.properties.fill_transparency
  assert(
    transparency.minimum === 0 && transparency.maximum === 1 && transparency.description.includes('0 (opaque)'),
    'fill_transparency is not documented as a 0..1 fraction.'
  )

  const inspectTool = listed.tools.find((tool) => tool.name === 'powerpoint_live_inspect')
  assert(inspectTool.inputSchema.properties.include_shapes?.default === false, 'inspect should be compact by default.')
  assert(inspectTool.inputSchema.properties.names?.items?.type === 'string', 'inspect names filter is missing.')

  const launched = await request('tools/call', {
    name: 'powerpoint_live_launch',
    arguments: { file_path: presentationPath, slide_index: 1, step_delay_ms: 0 }
  })
  assert(!launched.isError, `Launch failed: ${JSON.stringify(launched.structuredContent)}`)

  const relaunched = await request('tools/call', {
    name: 'powerpoint_live_launch',
    arguments: { file_path: presentationPath, slide_index: 1, step_delay_ms: 0 }
  })
  assert(!relaunched.isError, `Repeated launch failed: ${JSON.stringify(relaunched.structuredContent)}`)
  assert(relaunched.structuredContent.reused_open_presentation === true, 'Repeated launch did not attach to the open presentation.')
  assert(
    relaunched.structuredContent.presentation_count === launched.structuredContent.presentation_count,
    'Repeated launch increased the number of open presentations.'
  )

  const inspected = await request('tools/call', {
    name: 'powerpoint_live_inspect',
    arguments: {}
  })
  assert(!inspected.isError, `Inspect failed: ${JSON.stringify(inspected.structuredContent)}`)
  const audit = inspected.structuredContent
  assert(!Object.hasOwn(audit, 'shapes'), 'Compact inspect unexpectedly returned full shape details.')
  assert(audit.shape_count === 7, `Expected 7 native objects, got ${audit.shape_count}.`)
  assert(audit.slide_width === 516 && audit.slide_height === 326, 'Academic canvas points are incorrect.')
  assert(audit.canvas_width_mm === 182 && audit.canvas_height_mm === 115, 'Academic canvas millimeters are incorrect.')
  assert(audit.layout_warning_count === 0, `Layout audit returned ${audit.layout_warning_count} warnings.`)

  const detailedInspect = await request('tools/call', {
    name: 'powerpoint_live_inspect',
    arguments: { include_shapes: true }
  })
  assert(!detailedInspect.isError, `Detailed inspect failed: ${JSON.stringify(detailedInspect.structuredContent)}`)
  const shapes = detailedInspect.structuredContent.shapes
  assert(Array.isArray(shapes) && shapes.length === 7, 'Detailed inspect did not return all native objects.')

  const target = shapes[0]
  const filteredInspect = await request('tools/call', {
    name: 'powerpoint_live_inspect',
    arguments: { names: [target.name, '__missing_acceptance_shape__'] }
  })
  assert(filteredInspect.structuredContent.shapes.length === 1, 'Inspect name filtering returned unexpected objects.')
  assert(filteredInspect.structuredContent.shapes[0].name === target.name, 'Inspect name filtering returned the wrong object.')
  assert(filteredInspect.structuredContent.missing_names.includes('__missing_acceptance_shape__'), 'Inspect did not report a missing requested name.')

  const batch = await request('tools/call', {
    name: 'powerpoint_live_draw_sequence',
    arguments: {
      step_delay_ms: 0,
      operations: [
        { type: 'update', name: target.name, x: target.x },
        { type: 'update', name: target.name, y: target.y }
      ]
    }
  })
  assert(!batch.isError, `Host-side draw_sequence failed: ${JSON.stringify(batch.structuredContent)}`)
  assert(batch.structuredContent.completed === true, 'Batch result was not marked completed.')
  assert(batch.structuredContent.operation_count === 2, 'Batch result has the wrong operation_count.')
  assert(batch.structuredContent.applied_count === 2, 'Batch result has the wrong applied_count.')

  const partialBatch = await request('tools/call', {
    name: 'powerpoint_live_draw_sequence',
    arguments: {
      step_delay_ms: 0,
      operations: [
        { type: 'update', name: target.name, x: target.x },
        { type: 'update', name: '__missing_acceptance_shape__', x: 0 }
      ]
    }
  })
  assert(!partialBatch.isError, 'A partial batch should return structured progress instead of prompting a blind retry.')
  assert(partialBatch.structuredContent.completed === false, 'A partial batch incorrectly reported completion.')
  assert(partialBatch.structuredContent.applied_count === 1, 'A partial batch reported the wrong applied_count.')
  assert(partialBatch.structuredContent.failed_index === 1, 'A partial batch reported the wrong failed_index.')
  assert(batch.structuredContent.failed_index === null, 'Successful batch unexpectedly reported a failed_index.')

  previewPath = path.join(os.tmpdir(), `linco-powerpoint-acceptance-${process.pid}-${Date.now()}.png`)
  const preview = await request('tools/call', {
    name: 'powerpoint_live_export_preview',
    arguments: { output_path: previewPath, width: 800 }
  })
  assert(!preview.isError, `Preview export failed: ${JSON.stringify(preview.structuredContent)}`)

  const comparison = await request('tools/call', {
    name: 'powerpoint_live_compare_reference',
    arguments: { reference_path: previewPath, width: 800 }
  })
  assert(!comparison.isError, `Reference comparison failed: ${JSON.stringify(comparison.structuredContent)}`)
  const comparisonImages = comparison.content.filter((item) => item.type === 'image')
  assert(comparisonImages.length === 2, `compare_reference returned ${comparisonImages.length} image blocks instead of 2.`)
  assert(comparisonImages.every((item) => item.data && item.mimeType.startsWith('image/')), 'A comparison image block is incomplete.')
  assert(comparison.structuredContent.image_count === 2, 'Comparison structured result does not report both images.')

  process.stdout.write(`${JSON.stringify({
    server: initialized.serverInfo,
    tool_count: listed.tools.length,
    file_path: presentationPath,
    reused_open_presentation: relaunched.structuredContent.reused_open_presentation,
    presentation_count: relaunched.structuredContent.presentation_count,
    shape_count: audit.shape_count,
    sequence_operation_types: operationVariants.length,
    batch_applied_count: batch.structuredContent.applied_count,
    partial_batch: {
      applied_count: partialBatch.structuredContent.applied_count,
      failed_index: partialBatch.structuredContent.failed_index
    },
    comparison_image_blocks: comparisonImages.length,
    canvas_points: [audit.slide_width, audit.slide_height],
    canvas_mm: [audit.canvas_width_mm, audit.canvas_height_mm],
    layout_warning_count: audit.layout_warning_count
  }, null, 2)}\n`)
} finally {
  if (typeof previewPath === 'string') await fs.unlink(previewPath).catch(() => {})
  server.stdin.end()
  server.kill()
}
