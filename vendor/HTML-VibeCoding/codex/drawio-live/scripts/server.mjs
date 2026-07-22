#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SERVER_NAME = 'linco-drawio-live'
const SERVER_VERSION = '1.4.0'
const DESCRIPTOR = path.join(os.homedir(), '.linco', 'drawio-live.json')
const RESVG_MODULE = new URL('../vendor/resvg-wasm/index.mjs', import.meta.url)
const RESVG_WASM = new URL('../vendor/resvg-wasm/index_bg.wasm', import.meta.url)
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

let stepDelayMs = 120
let resvgModulePromise

const pointSchema = {
  type: 'object',
  required: ['x', 'y'],
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  additionalProperties: false
}

const shapeProperties = {
  id: { type: 'string', description: 'Stable cell id for later edges and updates.' },
  label: { type: 'string', default: '' },
  shape: {
    type: 'string',
    enum: [
      'rectangle',
      'rounded',
      'ellipse',
      'diamond',
      'cylinder',
      'hexagon',
      'triangle',
      'parallelogram',
      'cloud',
      'text',
      'swimlane'
    ],
    default: 'rounded'
  },
  x: { type: 'number' },
  y: { type: 'number' },
  width: { type: 'number', exclusiveMinimum: 0 },
  height: { type: 'number', exclusiveMinimum: 0 },
  style: { type: 'string', description: 'Full draw.io style override.' },
  fill_color: { type: 'string' },
  stroke_color: { type: 'string' },
  font_color: { type: 'string' },
  font_size: { type: 'number', minimum: 1, maximum: 200 },
  stroke_width: { type: 'number', minimum: 0, maximum: 50 }
}

const tools = [
  {
    name: 'drawio_live_launch',
    description:
      'Connect to the visible Linco draw.io tab. Open the Drawing tab before calling this tool; subsequent operations appear there immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Drawing file shown in Linco.' },
        step_delay_ms: { type: 'integer', minimum: 0, maximum: 10000, default: 120 },
        include_screenshot: { type: 'boolean', default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_status',
    description: 'Report the visible Linco draw.io canvas path, readiness, cell counts, and viewport.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'drawio_live_screenshot',
    description: 'Capture the current draw.io canvas renderer for visual review.',
    inputSchema: {
      type: 'object',
      properties: { width: { type: 'integer', minimum: 200, maximum: 4000, default: 1600 } },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_reference_image',
    description:
      'Load a local PNG, JPEG, WebP, or GIF reference image so the Agent can compare it with live canvas screenshots.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_compare_reference',
    description:
      'Return the reference image and current draw.io canvas screenshot together for a direct visual layout comparison.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        width: { type: 'integer', minimum: 400, maximum: 4000, default: 1600 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_icon_search',
    description:
      'Search open-source icon collections through Iconify and return SVG previews so the Agent can compare visual quality before downloading.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        alternate_queries: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 6,
          description: 'Optional synonyms or simpler fallback terms.'
        },
        style: {
          type: 'string',
          enum: ['any', 'flat-color', 'cartoon', 'outline', 'filled', 'monochrome'],
          default: 'any'
        },
        limit: { type: 'integer', minimum: 1, maximum: 32, default: 12 },
        preview_count: { type: 'integer', minimum: 0, maximum: 12, default: 8 },
        prefix: { type: 'string', description: 'Optional Iconify collection prefix.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_icon_daixia_handoff',
    description:
      'Prepare a user-confirmed browser handoff URL for a resource covered by the user\'s paid Daixia account. This does not submit the task, automate login, or handle credentials.',
    inputSchema: {
      type: 'object',
      required: ['source_url', 'confirmed_by_user'],
      properties: {
        source_url: { type: 'string', description: 'Original Flaticon, IconScout, or other asset page URL.' },
        confirmed_by_user: {
          type: 'boolean',
          description: 'True only after the user explicitly chose this asset and approved use of a download credit.'
        },
        gateway: {
          type: 'string',
          enum: ['qinbaowei', 'daixiayun'],
          default: 'qinbaowei'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_icon_download',
    description:
      'Download an Iconify SVG into <project_dir>/assets/icons and update icons-manifest.json plus ATTRIBUTION.md.',
    inputSchema: {
      type: 'object',
      required: ['icon_id', 'project_dir'],
      properties: {
        icon_id: { type: 'string', description: 'Iconify id such as tabler:network.' },
        project_dir: { type: 'string' },
        file_name: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_icon_import',
    description:
      'Copy a locally downloaded SVG/PNG/JPEG/WebP icon into the draw.io project package and record its source and license.',
    inputSchema: {
      type: 'object',
      required: ['source_path', 'project_dir', 'source_url', 'license_title'],
      properties: {
        source_path: { type: 'string' },
        project_dir: { type: 'string' },
        source_url: { type: 'string' },
        author: { type: 'string' },
        license_title: { type: 'string' },
        license_url: { type: 'string' },
        file_name: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_icon_import_generated',
    description:
      'Copy a Codex-generated PNG/WebP/SVG icon into the drawing project and record its prompt and generator metadata.',
    inputSchema: {
      type: 'object',
      required: ['source_path', 'project_dir', 'prompt'],
      properties: {
        source_path: { type: 'string' },
        project_dir: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string', description: 'Generator/model name when known.' },
        file_name: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_add_icon',
    description:
      'Insert a downloaded local SVG/PNG/JPEG/WebP asset into the visible draw.io canvas as an editable image cell.',
    inputSchema: {
      type: 'object',
      required: ['id', 'asset_path', 'x', 'y', 'width', 'height'],
      properties: {
        id: { type: 'string' },
        asset_path: { type: 'string' },
        label: { type: 'string', default: '' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        opacity: { type: 'number', minimum: 1, maximum: 100, default: 100 },
        locked: { type: 'boolean', default: false },
        pause_after_ms: { type: 'integer', minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_clear',
    description: 'Clear drawable cells from the visible page before rebuilding it.',
    inputSchema: {
      type: 'object',
      required: ['confirm'],
      properties: { confirm: { type: 'boolean' } },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_add_shape',
    description: 'Add one editable shape to the visible Linco draw.io canvas.',
    inputSchema: {
      type: 'object',
      required: ['id', 'x', 'y', 'width', 'height'],
      properties: {
        ...shapeProperties,
        pause_after_ms: { type: 'integer', minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_add_edge',
    description: 'Add one editable connector between two visible cells.',
    inputSchema: {
      type: 'object',
      required: ['id', 'source', 'target'],
      properties: {
        id: { type: 'string' },
        source: { type: 'string' },
        target: { type: 'string' },
        label: { type: 'string', default: '' },
        style: { type: 'string' },
        color: { type: 'string' },
        width: { type: 'number', minimum: 0, maximum: 50 },
        dashed: { type: 'boolean' },
        curved: { type: 'boolean' },
        start_arrow: { type: 'string' },
        end_arrow: { type: 'string' },
        exit_x: { type: 'number', minimum: 0, maximum: 1 },
        exit_y: { type: 'number', minimum: 0, maximum: 1 },
        entry_x: { type: 'number', minimum: 0, maximum: 1 },
        entry_y: { type: 'number', minimum: 0, maximum: 1 },
        waypoints: { type: 'array', maxItems: 100, items: pointSchema },
        pause_after_ms: { type: 'integer', minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_update_cell',
    description: 'Update one visible cell label, style, position, or size in place.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        style: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        pause_after_ms: { type: 'integer', minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_draw_sequence',
    description:
      'Apply a paced sequence of shape, edge, update, clear, fit, and wait operations. Every operation is acknowledged by the visible canvas before the next starts.',
    inputSchema: {
      type: 'object',
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: { type: 'object', description: 'Operation with type shape, edge, update, clear, fit, or wait.' }
        },
        step_delay_ms: { type: 'integer', minimum: 0, maximum: 10000 },
        screenshot_after: { type: 'boolean', default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_fit',
    description: 'Fit the evolving diagram into the visible canvas or set a zoom percentage.',
    inputSchema: {
      type: 'object',
      properties: { zoom_percent: { type: 'number', minimum: 10, maximum: 800 } },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_inspect',
    description:
      'Read cell topology, raw and rotated visual geometry, plus deterministic large-shape crossing warnings from the visible model.',
    inputSchema: {
      type: 'object',
      properties: { max_cells: { type: 'integer', minimum: 1, maximum: 2000, default: 500 } },
      additionalProperties: false
    }
  },
  {
    name: 'drawio_live_save_snapshot',
    description: 'Save the already-visible canvas to a .drawio file. Call only after live drawing.',
    inputSchema: {
      type: 'object',
      required: ['output_path'],
      properties: {
        output_path: { type: 'string' },
        page_name: { type: 'string' },
        overwrite: { type: 'boolean', default: false }
      },
      additionalProperties: false
    }
  }
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function imageMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  }
  return types[extension]
}

async function readReferenceImage(inputPath) {
  const filePath = path.resolve(inputPath)
  const mimeType = imageMimeType(filePath)
  if (!mimeType) throw new Error('Reference image must be PNG, JPEG, WebP, or GIF.')
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error('Reference image path is not a file.')
  if (stat.size > 20 * 1024 * 1024) throw new Error('Reference image exceeds the 20 MB limit.')
  const data = await fs.readFile(filePath)
  return { filePath, mimeType, bytes: stat.size, data: data.toString('base64') }
}

function splitIconId(iconId) {
  const value = String(iconId || '')
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('Icon id must use the Iconify prefix:name format.')
  }
  const prefix = value.slice(0, separator)
  const name = value.slice(separator + 1)
  if (!/^[a-z0-9-]+$/i.test(prefix) || !/^[a-z0-9-]+$/i.test(name)) {
    throw new Error('Icon id contains unsupported characters.')
  }
  return { prefix, name }
}

function safeAssetName(value, fallback) {
  const source = String(value || fallback || 'icon').replace(/\.[a-z0-9]+$/i, '')
  const safe = source.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  return safe || 'icon'
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Icon service returned HTTP ${response.status}.`)
  return response.json()
}

const ICON_STYLE_PREFIXES = {
  'flat-color': ['flat-color-icons', 'icon-park', 'fluent-color'],
  cartoon: ['fluent-emoji-flat', 'streamline-emojis', 'noto'],
  outline: ['lucide', 'tabler', 'ph'],
  filled: ['material-symbols', 'solar', 'mdi'],
  monochrome: ['ph', 'tabler', 'material-symbols']
}

function iconSearchTerms(query, alternateQueries = []) {
  const terms = [query, ...alternateQueries]
    .flatMap((term) => {
      const value = String(term || '').trim()
      if (!value) return []
      const words = value.split(/[\s/_-]+/).filter((word) => word.length > 2)
      return [value, ...words]
    })
    .map((term) => term.toLowerCase())
  return [...new Set(terms)].slice(0, 8)
}

function iconSearchScore(iconId, query, prefixes) {
  const { prefix, name } = splitIconId(iconId)
  const normalizedName = name.replace(/[-_]+/g, ' ').toLowerCase()
  const words = String(query)
    .toLowerCase()
    .split(/[\s/_-]+/)
    .filter((word) => word.length > 2)
  let score = 0
  if (normalizedName === String(query).toLowerCase()) score += 100
  if (words.length && words.every((word) => normalizedName.includes(word))) score += 50
  score += words.filter((word) => normalizedName.includes(word)).length * 8
  const prefixIndex = prefixes.indexOf(prefix)
  if (prefixIndex >= 0) score += 20 - prefixIndex
  return score
}

async function iconifySearch(query, prefix) {
  const parameters = new URLSearchParams({ query, limit: '64' })
  if (prefix) parameters.set('prefix', prefix)
  return fetchJson(`https://api.iconify.design/search?${parameters}`)
}

async function resvgModule() {
  if (!resvgModulePromise) {
    resvgModulePromise = (async () => {
      const module = await import(RESVG_MODULE.href)
      await module.initWasm(await fs.readFile(RESVG_WASM))
      return module
    })()
  }
  return resvgModulePromise
}

async function renderSvgPreview(svg) {
  const { Resvg } = await resvgModule()
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: 192 },
    background: 'rgba(255, 255, 255, 0)',
    font: { loadSystemFonts: false }
  })
  try {
    const rendered = renderer.render()
    try {
      return Buffer.from(rendered.asPng())
    } finally {
      rendered.free()
    }
  } finally {
    renderer.free()
  }
}

async function iconPreview(icon) {
  const response = await fetch(icon.svg_url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Iconify returned HTTP ${response.status}.`)
  const svg = validateSvg(await response.text())
  if (Buffer.byteLength(svg, 'utf8') > 1024 * 1024) throw new Error('SVG preview exceeds 1 MB.')
  const license = icon.license?.spdx || icon.license?.title || 'license metadata unavailable'
  const png = await renderSvgPreview(svg)
  return {
    label: `${icon.id} | ${icon.collection} | ${license}`,
    data: png.toString('base64'),
    mimeType: 'image/png'
  }
}

async function iconifyCollection(prefix) {
  const collections = await fetchJson(
    `https://api.iconify.design/collections?prefix=${encodeURIComponent(prefix)}`
  )
  return collections?.[prefix] || {}
}

function validateSvg(svg) {
  if (!/<svg\b/i.test(svg)) throw new Error('Downloaded asset is not an SVG document.')
  if (
    /<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:|@import|(?:href|xlink:href)\s*=\s*["']https?:/i.test(
      svg
    )
  ) {
    throw new Error('SVG contains active or externally loaded content and was rejected.')
  }
  return svg
}

function assetMimeType(filePath) {
  const types = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  }
  return types[path.extname(filePath).toLowerCase()]
}

async function readIconAsset(inputPath) {
  const filePath = path.resolve(inputPath)
  const mimeType = assetMimeType(filePath)
  if (!mimeType) throw new Error('Icon asset must be SVG, PNG, JPEG, or WebP.')
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error('Icon asset path is not a file.')
  if (stat.size > 5 * 1024 * 1024) throw new Error('Icon asset exceeds the 5 MB limit.')
  const data = await fs.readFile(filePath)
  if (mimeType === 'image/svg+xml') validateSvg(data.toString('utf8'))
  return { filePath, mimeType, bytes: stat.size, data }
}

function iconDataUri(asset) {
  if (asset.mimeType === 'image/svg+xml') {
    return `data:image/svg+xml,${encodeURIComponent(asset.data.toString('utf8'))}`
  }
  return `data:${asset.mimeType};base64,${asset.data.toString('base64')}`
}

async function updateIconProject(projectDirInput, record) {
  const projectDir = path.resolve(projectDirInput)
  await fs.mkdir(projectDir, { recursive: true })
  const manifestPath = path.join(projectDir, 'icons-manifest.json')
  let manifest = { version: 1, icons: [] }
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    if (existing?.version === 1 && Array.isArray(existing.icons)) manifest = existing
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Invalid icon manifest: ${error.message}`)
  }
  manifest.icons = manifest.icons.filter(
    (icon) => icon.id !== record.id && icon.local_path !== record.local_path
  )
  manifest.icons.push(record)
  manifest.icons.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const lines = [
    '# Icon Attribution',
    '',
    'This file is generated from `icons-manifest.json`.',
    ''
  ]
  for (const icon of manifest.icons) {
    const author = icon.author?.name || icon.author || 'Unknown author'
    const license = icon.license?.title || icon.license_title || 'License recorded in manifest'
    const source = icon.source_url
      ? `[source](${icon.source_url})`
      : icon.provider === 'generated'
        ? 'generated for this project'
        : 'source unavailable'
    const licenseLink = icon.license?.url || icon.license_url
    const licenseText = licenseLink ? `[${license}](${licenseLink})` : license
    lines.push(`- \`${icon.local_path}\`: ${icon.id} by ${author}; ${licenseText}; ${source}.`)
    if (icon.generation) {
      const prompt = String(icon.generation.prompt || '').replace(/\s+/g, ' ').trim()
      lines.push(`  Generator: ${icon.generation.model || 'unknown'}; prompt: ${JSON.stringify(prompt)}.`)
    }
  }
  lines.push('')
  await fs.writeFile(path.join(projectDir, 'ATTRIBUTION.md'), lines.join('\n'), 'utf8')
  return { projectDir, manifestPath, iconCount: manifest.icons.length }
}

async function copyIconIntoProject(args) {
  const source = await readIconAsset(args.source_path)
  const projectDir = path.resolve(args.project_dir)
  const assetsDir = path.join(projectDir, 'assets', 'icons')
  await fs.mkdir(assetsDir, { recursive: true })
  const extension = path.extname(source.filePath).toLowerCase()
  const fileName = `${safeAssetName(args.file_name, path.basename(source.filePath, extension))}${extension}`
  const destination = path.join(assetsDir, fileName)
  await fs.copyFile(source.filePath, destination)
  const localPath = path.relative(projectDir, destination).split(path.sep).join('/')
  const record = {
    id: `local:${safeAssetName(fileName, 'icon')}`,
    provider: 'manual',
    local_path: localPath,
    source_url: args.source_url,
    author: args.author || 'Unknown author',
    license_title: args.license_title,
    license_url: args.license_url || '',
    imported_at: new Date().toISOString()
  }
  const project = await updateIconProject(projectDir, record)
  return { ...record, asset_path: destination, project }
}

async function copyGeneratedIconIntoProject(args) {
  const source = await readIconAsset(args.source_path)
  const projectDir = path.resolve(args.project_dir)
  const assetsDir = path.join(projectDir, 'assets', 'icons')
  await fs.mkdir(assetsDir, { recursive: true })
  const extension = path.extname(source.filePath).toLowerCase()
  const baseName = safeAssetName(args.file_name, path.basename(source.filePath, extension))
  const fileName = `${baseName}${extension}`
  const destination = path.join(assetsDir, fileName)
  await fs.copyFile(source.filePath, destination)
  const localPath = path.relative(projectDir, destination).split(path.sep).join('/')
  const record = {
    id: `generated:${baseName}`,
    provider: 'generated',
    author: 'Codex image generation',
    license_title: 'Generated asset; usage is subject to the generator service terms',
    local_path: localPath,
    generation: {
      prompt: String(args.prompt),
      model: args.model || 'Codex built-in image generation',
      generated_at: new Date().toISOString()
    }
  }
  const project = await updateIconProject(projectDir, record)
  return { ...record, asset_path: destination, project }
}

function ensureStyle(style = '') {
  return style && !style.endsWith(';') ? `${style};` : style
}

function setStyle(style, key, value) {
  if (value === undefined || value === null) return style
  const entries = ensureStyle(style).split(';').filter(Boolean)
  const filtered = entries.filter((entry) => entry.split('=', 1)[0] !== key)
  filtered.push(`${key}=${value}`)
  return `${filtered.join(';')};`
}

function shapeStyle(shape = 'rounded') {
  const common =
    'whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#1f2937;'
  const map = {
    rectangle: `rounded=0;${common}`,
    rounded: `rounded=1;${common}`,
    ellipse: `ellipse;${common}`,
    diamond: `rhombus;${common}`,
    cylinder: `shape=cylinder3;boundedLbl=1;backgroundOutline=1;${common}`,
    hexagon: `shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;${common}`,
    triangle: `triangle;${common}`,
    parallelogram: `shape=parallelogram;perimeter=parallelogramPerimeter;${common}`,
    cloud: `ellipse;shape=cloud;${common}`,
    text: 'text;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;html=1;fontColor=#1f2937;',
    swimlane: 'swimlane;startSize=30;rounded=0;html=1;whiteSpace=wrap;fillColor=#f5f5f5;strokeColor=#666666;'
  }
  return map[shape] || map.rounded
}

function edgeStyle(args) {
  let style =
    args.style ||
    'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;'
  style = setStyle(style, 'strokeColor', args.color)
  style = setStyle(style, 'strokeWidth', args.width)
  if (args.dashed !== undefined) style = setStyle(style, 'dashed', args.dashed ? 1 : 0)
  if (args.curved !== undefined) style = setStyle(style, 'curved', args.curved ? 1 : 0)
  style = setStyle(style, 'startArrow', args.start_arrow)
  style = setStyle(style, 'endArrow', args.end_arrow)
  style = setStyle(style, 'exitX', args.exit_x)
  style = setStyle(style, 'exitY', args.exit_y)
  style = setStyle(style, 'entryX', args.entry_x)
  style = setStyle(style, 'entryY', args.entry_y)
  return ensureStyle(style)
}

async function bridgeDescriptor() {
  let descriptor
  try {
    descriptor = JSON.parse(await fs.readFile(DESCRIPTOR, 'utf8'))
  } catch (error) {
    throw new Error(
      `Linco draw.io Live bridge is unavailable. Start Linco and open the Drawing tab. (${error.message})`
    )
  }
  if (!descriptor?.url || !descriptor?.token) throw new Error('Linco draw.io Live bridge descriptor is invalid.')
  return descriptor
}

async function bridgeCall(command) {
  const descriptor = await bridgeDescriptor()
  const response = await fetch(`${descriptor.url}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-linco-drawio-token': descriptor.token
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(50000)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Linco draw.io Live bridge returned HTTP ${response.status}.`)
  }
  return payload.result
}

async function applyOperation(operation) {
  const type = operation.type
  if (type === 'wait') {
    const waited = Math.max(0, Math.min(10000, operation.ms ?? stepDelayMs))
    await sleep(waited)
    return { type, waited_ms: waited }
  }
  if (!['shape', 'edge', 'update', 'clear', 'fit'].includes(type)) {
    throw new Error(`Unsupported live drawing operation: ${type}`)
  }
  const result = await bridgeCall({ type: 'operation', operation })
  await sleep(operation.pause_after_ms ?? stepDelayMs)
  return result
}

function shapeOperation(args) {
  let style = args.style || shapeStyle(args.shape)
  style = setStyle(style, 'fillColor', args.fill_color)
  style = setStyle(style, 'strokeColor', args.stroke_color)
  style = setStyle(style, 'fontColor', args.font_color)
  style = setStyle(style, 'fontSize', args.font_size)
  style = setStyle(style, 'strokeWidth', args.stroke_width)
  return {
    type: 'shape',
    id: args.id,
    label: args.label || '',
    shape: args.shape || 'rounded',
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    style: ensureStyle(style),
    pause_after_ms: args.pause_after_ms
  }
}

function edgeOperation(args) {
  return {
    type: 'edge',
    id: args.id,
    source: args.source,
    target: args.target,
    label: args.label || '',
    style: edgeStyle(args),
    waypoints: args.waypoints || [],
    pause_after_ms: args.pause_after_ms
  }
}

function updateOperation(args) {
  return {
    type: 'update',
    id: args.id,
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.style === undefined ? {} : { style: ensureStyle(args.style) }),
    ...(args.x === undefined ? {} : { x: args.x }),
    ...(args.y === undefined ? {} : { y: args.y }),
    ...(args.width === undefined ? {} : { width: args.width }),
    ...(args.height === undefined ? {} : { height: args.height }),
    pause_after_ms: args.pause_after_ms
  }
}

async function handleTool(name, args = {}) {
  switch (name) {
    case 'drawio_live_launch': {
      stepDelayMs = args.step_delay_ms ?? 120
      const status = await bridgeCall({ type: 'launch', file_path: args.file_path })
      if (args.include_screenshot === false) return { value: status }
      const screenshot = await bridgeCall({ type: 'screenshot', width: 1200 })
      return { value: status, imageData: screenshot.data }
    }
    case 'drawio_live_status':
      return { value: await bridgeCall({ type: 'status' }) }
    case 'drawio_live_screenshot': {
      const screenshot = await bridgeCall({ type: 'screenshot', width: args.width || 1600 })
      return { value: { ...screenshot, data: undefined, captured: true }, imageData: screenshot.data }
    }
    case 'drawio_live_reference_image': {
      const reference = await readReferenceImage(args.path)
      return {
        value: { path: reference.filePath, bytes: reference.bytes, loaded: true },
        imageData: reference.data,
        imageMimeType: reference.mimeType
      }
    }
    case 'drawio_live_compare_reference': {
      const reference = await readReferenceImage(args.path)
      const screenshot = await bridgeCall({ type: 'screenshot', width: args.width || 1600 })
      return {
        value: {
          reference_path: reference.filePath,
          canvas_path: screenshot.path,
          compared: true
        },
        imageContents: [
          {
            label: 'Reference image',
            data: reference.data,
            mimeType: reference.mimeType
          },
          {
            label: 'Current draw.io canvas',
            data: screenshot.data,
            mimeType: 'image/png'
          }
        ]
      }
    }
    case 'drawio_icon_search': {
      const limit = Math.max(1, Math.min(32, args.limit || 12))
      const previewCount = Math.max(0, Math.min(12, args.preview_count ?? 8))
      const style = args.style || 'any'
      const prefixes = args.prefix
        ? [String(args.prefix)]
        : ICON_STYLE_PREFIXES[style] || []
      const searchTerms = iconSearchTerms(args.query, args.alternate_queries)
      const requests = prefixes.length
        ? searchTerms.flatMap((term) => prefixes.map((prefix) => ({ term, prefix })))
        : searchTerms.map((term) => ({ term, prefix: undefined }))
      const settled = await Promise.allSettled(
        requests.map(async ({ term, prefix }) => ({
          term,
          prefix,
          result: await iconifySearch(term, prefix)
        }))
      )
      const collectionByPrefix = {}
      const iconIds = []
      const seen = new Set()
      for (const entry of settled) {
        if (entry.status !== 'fulfilled') continue
        Object.assign(collectionByPrefix, entry.value.result.collections || {})
        for (const iconId of entry.value.result.icons || []) {
          if (seen.has(iconId)) continue
          const { name } = splitIconId(iconId)
          if (/^undefined(?:-filled)?$/i.test(name)) continue
          seen.add(iconId)
          iconIds.push(iconId)
        }
      }
      iconIds.sort(
        (left, right) =>
          iconSearchScore(right, args.query, prefixes) -
          iconSearchScore(left, args.query, prefixes)
      )
      const icons = iconIds.slice(0, limit).map((iconId) => {
        const { prefix, name } = splitIconId(iconId)
        const collection = collectionByPrefix[prefix] || {}
        return {
          id: iconId,
          name,
          collection: collection.name || prefix,
          author: collection.author || null,
          license: collection.license || null,
          source_url: `https://icon-sets.iconify.design/${prefix}/${name}/`,
          svg_url: `https://api.iconify.design/${prefix}/${name}.svg`
        }
      })
      const previews = (
        await Promise.allSettled(icons.slice(0, previewCount).map((icon) => iconPreview(icon)))
      )
        .filter((entry) => entry.status === 'fulfilled')
        .map((entry) => entry.value)
      return {
        value: {
          provider: 'Iconify',
          query: args.query,
          search_terms: searchTerms,
          style,
          collection_prefixes: prefixes,
          returned: icons.length,
          previewed: previews.length,
          icons,
          selection_required: true,
          guidance:
            'Compare the SVG previews visually. Do not download the first result automatically; select a coherent set that matches the reference figure.'
        },
        imageContents: previews
      }
    }
    case 'drawio_icon_daixia_handoff': {
      if (args.confirmed_by_user !== true) {
        throw new Error('The user must explicitly choose the asset and approve use of a download credit.')
      }
      let sourceUrl
      try {
        sourceUrl = new URL(String(args.source_url))
      } catch {
        throw new Error('source_url must be a valid HTTP or HTTPS URL.')
      }
      if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
        throw new Error('source_url must use HTTP or HTTPS.')
      }
      const gateway = args.gateway === 'daixiayun' ? 'https://www.daixiayun.com' : 'https://daixia.qinbaowei.com'
      const submissionUrl = new URL('/addtask', gateway)
      submissionUrl.searchParams.set('url', sourceUrl.toString())
      return {
        value: {
          gateway,
          source_url: sourceUrl.toString(),
          submission_url: submissionUrl.toString(),
          submitted: false,
          credentials_handled: false,
          next_step:
            'Open this URL in the browser session already authenticated by the user, verify the asset and credit charge, then import the downloaded file with drawio_icon_import.'
        }
      }
    }
    case 'drawio_icon_download': {
      const { prefix, name } = splitIconId(args.icon_id)
      const downloadUrl = `https://api.iconify.design/${prefix}/${name}.svg`
      const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`Iconify returned HTTP ${response.status}.`)
      const svg = validateSvg(await response.text())
      if (Buffer.byteLength(svg, 'utf8') > 1024 * 1024) {
        throw new Error('Downloaded SVG exceeds the 1 MB limit.')
      }
      const collection = await iconifyCollection(prefix)
      const projectDir = path.resolve(args.project_dir)
      const assetsDir = path.join(projectDir, 'assets', 'icons')
      await fs.mkdir(assetsDir, { recursive: true })
      const fileName = `${safeAssetName(args.file_name, `${prefix}--${name}`)}.svg`
      const destination = path.join(assetsDir, fileName)
      await fs.writeFile(destination, svg, 'utf8')
      const localPath = path.relative(projectDir, destination).split(path.sep).join('/')
      const record = {
        id: args.icon_id,
        provider: 'Iconify',
        collection: collection.name || prefix,
        author: collection.author || null,
        license: collection.license || null,
        local_path: localPath,
        source_url: `https://icon-sets.iconify.design/${prefix}/${name}/`,
        download_url: downloadUrl,
        downloaded_at: new Date().toISOString()
      }
      const project = await updateIconProject(projectDir, record)
      return { value: { ...record, asset_path: destination, project } }
    }
    case 'drawio_icon_import':
      return { value: await copyIconIntoProject(args) }
    case 'drawio_icon_import_generated':
      return { value: await copyGeneratedIconIntoProject(args) }
    case 'drawio_live_add_icon': {
      const asset = await readIconAsset(args.asset_path)
      let style =
        `shape=image;imageAspect=0;aspect=fixed;html=1;image=${iconDataUri(asset)};` +
        `opacity=${args.opacity ?? 100};strokeColor=none;fillColor=none;`
      if (args.locked === true) {
        style += 'locked=1;movable=0;resizable=0;rotatable=0;deletable=0;'
      }
      return {
        value: await applyOperation({
          type: 'shape',
          id: args.id,
          label: args.label || '',
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          style,
          pause_after_ms: args.pause_after_ms
        })
      }
    }
    case 'drawio_live_clear':
      if (args.confirm !== true) throw new Error('confirm=true is required to clear the canvas.')
      return { value: await applyOperation({ type: 'clear' }) }
    case 'drawio_live_add_shape':
      return { value: await applyOperation(shapeOperation(args)) }
    case 'drawio_live_add_edge':
      return { value: await applyOperation(edgeOperation(args)) }
    case 'drawio_live_update_cell':
      return { value: await applyOperation(updateOperation(args)) }
    case 'drawio_live_fit':
      return { value: await applyOperation({ type: 'fit', zoom_percent: args.zoom_percent }) }
    case 'drawio_live_inspect':
      return { value: await bridgeCall({ type: 'inspect', max_cells: args.max_cells || 500 }) }
    case 'drawio_live_draw_sequence': {
      const previousDelay = stepDelayMs
      stepDelayMs = args.step_delay_ms ?? stepDelayMs
      const results = []
      try {
        for (let index = 0; index < args.operations.length; index += 1) {
          const source = args.operations[index]
          let operation
          if (source.type === 'shape') operation = shapeOperation(source)
          else if (source.type === 'edge') operation = edgeOperation(source)
          else if (source.type === 'update') operation = updateOperation(source)
          else operation = source
          results.push({ index, type: source.type, result: await applyOperation(operation) })
        }
      } finally {
        stepDelayMs = previousDelay
      }
      if (args.screenshot_after === false) {
        return { value: { operations_applied: results.length, results } }
      }
      const screenshot = await bridgeCall({ type: 'screenshot', width: 1600 })
      return {
        value: { operations_applied: results.length, results },
        imageData: screenshot.data
      }
    }
    case 'drawio_live_save_snapshot':
      return {
        value: await bridgeCall({
          type: 'save',
          output_path: args.output_path,
          page_name: args.page_name,
          overwrite: args.overwrite === true
        })
      }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function toolResult(
  value,
  { imageData, imageMimeType = 'image/png', imageContents = [], isError = false } = {}
) {
  const content = [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  if (imageData) content.push({ type: 'image', data: imageData, mimeType: imageMimeType })
  for (const image of imageContents) {
    if (image.label) content.push({ type: 'text', text: image.label })
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  return {
    content,
    ...(typeof value === 'object' && value !== null ? { structuredContent: value } : {}),
    isError
  }
}

async function handleMessage(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Open the Linco Drawing tab, launch the live session, and construct the figure with paced shape/edge/update operations. Never generate a complete .drawio file first. Save only after the user has watched the visible canvas evolve.'
    })
  }
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') return rpcResult(id, { tools })
  if (method === 'tools/call') {
    try {
      const result = await handleTool(params?.name, params?.arguments || {})
      return rpcResult(
        id,
        toolResult(result.value, {
          imageData: result.imageData,
          imageMimeType: result.imageMimeType,
          imageContents: result.imageContents
        })
      )
    } catch (error) {
      return rpcResult(
        id,
        toolResult({ error: error.message, tool: params?.name }, { isError: true })
      )
    }
  }
  if (method?.startsWith('notifications/')) return null
  return rpcError(id, -32601, `Method not found: ${method}`)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let message
  try {
    // Some Windows stdio clients prefix their first JSON-RPC message with a UTF-8 BOM.
    message = JSON.parse(line.replace(/^\uFEFF/, ''))
  } catch (error) {
    process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error', error.message))}\n`)
    return
  }
  try {
    const response = await handleMessage(message)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify(rpcError(message.id, -32603, 'Internal error', error.message))}\n`)
  }
})

process.on('uncaughtException', (error) =>
  process.stderr.write(`[${SERVER_NAME}] ${error.stack || error.message}\n`)
)
process.on('unhandledRejection', (error) =>
  process.stderr.write(`[${SERVER_NAME}] ${error?.stack || error}\n`)
)
