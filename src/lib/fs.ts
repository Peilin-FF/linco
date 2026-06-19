// 文件系统操作的前端绑定:对应 Rust 的 fs.rs。
// 每个调用可带 host(空/undefined = 本地;非空 = 远程 SSH)。
import { invoke } from '@tauri-apps/api/core'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

interface RawEntry {
  name: string
  path: string
  is_dir: boolean
}

const h = (host?: string): string | null => host || null

export async function listDir(path: string, host?: string): Promise<DirEntry[]> {
  const raw = await invoke<RawEntry[]>('fs_list_dir', { path, host: h(host) })
  return raw.map((e) => ({ name: e.name, path: e.path, isDir: e.is_dir }))
}

export function readFile(path: string, host?: string): Promise<string> {
  return invoke('fs_read_file', { path, host: h(host) })
}

// —— 文本预读缓存(yazi 式 preload):悬停时提前读好,点击瞬时显示 ——
const textCache = new Map<string, Promise<string>>()
const cacheKey = (path: string, host?: string): string => `${host || ''}|${path}`

/** 带缓存的文本读取:命中缓存直接返回,未命中则读并缓存。 */
export function readFileCached(path: string, host?: string): Promise<string> {
  const k = cacheKey(path, host)
  let p = textCache.get(k)
  if (!p) {
    p = invoke<string>('fs_read_file', { path, host: h(host) })
    textCache.set(k, p)
    // 失败不留缓存,允许重试
    p.catch(() => textCache.delete(k))
    // 限制缓存大小
    if (textCache.size > 40) {
      const first = textCache.keys().next().value
      if (first) textCache.delete(first)
    }
  }
  return p
}

/** 悬停预读(忽略错误,纯预热缓存)。 */
export function prefetchFile(path: string, host?: string): void {
  readFileCached(path, host).catch(() => {})
}

/** 失效某文件的预读缓存(保存/移动/删除后调用):文本与二进制缓存都清。 */
export function invalidateFile(path: string, host?: string): void {
  const k = cacheKey(path, host)
  textCache.delete(k)
  bytesCache.delete(k)
}

/** 读文件为 base64(图片/视频/音频/PDF 等二进制预览)。 */
export function readBytes(path: string, host?: string): Promise<string> {
  return invoke('fs_read_bytes', { path, host: h(host) })
}

// —— 二进制(base64)预读缓存:远程图片/视频经 SSH 传输较慢,
//    悬停预读 + 缓存,点开瞬时显示 ——
const bytesCache = new Map<string, Promise<string>>()

/** 带缓存的二进制读取(返回 base64)。 */
export function readBytesCached(path: string, host?: string): Promise<string> {
  const k = cacheKey(path, host)
  let p = bytesCache.get(k)
  if (!p) {
    p = invoke<string>('fs_read_bytes', { path, host: h(host) })
    bytesCache.set(k, p)
    p.catch(() => bytesCache.delete(k))
    if (bytesCache.size > 20) {
      const first = bytesCache.keys().next().value
      if (first) bytesCache.delete(first)
    }
  }
  return p
}

/** 悬停预读二进制(媒体文件预热)。 */
export function prefetchBytes(path: string, host?: string): void {
  readBytesCached(path, host).catch(() => {})
}

export function writeFile(
  path: string,
  content: string,
  host?: string
): Promise<void> {
  return invoke('fs_write_file', { path, content, host: h(host) })
}

/** 写入二进制文件(base64):供 xlsx 等二进制格式保存写回。 */
export function writeBytes(
  path: string,
  b64: string,
  host?: string
): Promise<void> {
  return invoke('fs_write_bytes', { path, b64, host: h(host) })
}

export function createFile(
  parent: string,
  name: string,
  host?: string
): Promise<string> {
  return invoke('fs_create_file', { parent, name, host: h(host) })
}

export function createDir(
  parent: string,
  name: string,
  host?: string
): Promise<string> {
  return invoke('fs_create_dir', { parent, name, host: h(host) })
}

export function renamePath(
  path: string,
  newName: string,
  host?: string
): Promise<string> {
  return invoke('fs_rename', { path, newName, host: h(host) })
}

export function deletePath(path: string, host?: string): Promise<void> {
  return invoke('fs_delete', { path, host: h(host) })
}

export function revealInFinder(path: string): Promise<void> {
  return invoke('fs_reveal', { path })
}

export function copyPath(
  src: string,
  destDir: string,
  host?: string
): Promise<string> {
  return invoke('fs_copy', { src, destDir, host: h(host) })
}

export function movePath(
  src: string,
  destDir: string,
  host?: string
): Promise<string> {
  return invoke('fs_move', { src, destDir, host: h(host) })
}

export async function searchFiles(
  root: string,
  query: string,
  host?: string
): Promise<DirEntry[]> {
  const raw = await invoke<RawEntry[]>('fs_search', {
    root,
    query,
    host: h(host)
  })
  return raw.map((e) => ({ name: e.name, path: e.path, isDir: e.is_dir }))
}
