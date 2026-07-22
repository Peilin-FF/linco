import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface DrawioLiveCommandEvent {
  id: number
  command: DrawioLiveCommand
}

export interface DrawioLiveCommand {
  type: string
  file_path?: string
  output_path?: string
  overwrite?: boolean
  page_name?: string
  operation?: DrawioLiveOperation
  max_cells?: number
  width?: number
}

export interface DrawioLivePoint {
  x: number
  y: number
}

export interface DrawioLiveOperation {
  type: 'shape' | 'edge' | 'update' | 'clear' | 'fit' | 'wait'
  id?: string
  label?: string
  shape?: string
  x?: number
  y?: number
  width?: number
  height?: number
  style?: string
  source?: string
  target?: string
  waypoints?: DrawioLivePoint[]
  zoom_percent?: number
  ms?: number
}

export function onDrawioLiveCommand(
  callback: (event: DrawioLiveCommandEvent) => void
): Promise<UnlistenFn> {
  return listen<DrawioLiveCommandEvent>('drawio-live-command', (event) =>
    callback(event.payload)
  )
}

export function respondDrawioLive(
  id: number,
  result?: unknown,
  error?: string
): Promise<void> {
  return invoke('drawio_live_respond', {
    id,
    result: result ?? null,
    error: error || null
  })
}
