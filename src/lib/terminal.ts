// 终端 PTY 的前端绑定:封装 Rust 暴露的 term_* 命令与 term-output 事件。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface TermOutput {
  id: string
  data: string // base64
}

export function termStart(
  id: string,
  cols: number,
  rows: number,
  opts?: {
    cwd?: string
    env?: Record<string, string>
    initialCommand?: string
    host?: string
    identity?: string
  }
): Promise<void> {
  return invoke('term_start', {
    id,
    cols,
    rows,
    cwd: opts?.cwd,
    env: opts?.env,
    initialCommand: opts?.initialCommand,
    host: opts?.host || null,
    identity: opts?.identity || null
  })
}

// 会话可能尚未建好(挂载瞬间 ResizeObserver / 提前输入)或已死。这类
// fire-and-forget 调用遇到"会话不存在"是良性的:吞掉,避免海量未处理 rejection
// 拖垮启动(否则前端会卡在"加载中")。真正异常仍打到 console.debug,不掩盖问题。
function ignoreNoSession(e: unknown): void {
  const msg = String(e)
  if (!msg.includes('终端会话不存在')) {
    console.debug('term op failed:', msg)
  }
}

export function termWrite(id: string, data: string): Promise<void> {
  return invoke<void>('term_write', { id, data }).catch(ignoreNoSession)
}

export function termResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('term_resize', { id, cols, rows }).catch(ignoreNoSession)
}

export function termKill(id: string): Promise<void> {
  return invoke<void>('term_kill', { id }).catch(ignoreNoSession)
}

/** 监听某个终端的输出,回调收到的是已解码的原始字节。 */
export function onTermOutput(
  id: string,
  cb: (bytes: Uint8Array) => void
): Promise<UnlistenFn> {
  return listen<TermOutput>('term-output', (e) => {
    if (e.payload.id !== id) return
    cb(b64ToBytes(e.payload.data))
  })
}

export function onTermExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen<{ id: string }>('term-exit', (e) => {
    if (e.payload.id === id) cb()
  })
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i)
  return out
}
