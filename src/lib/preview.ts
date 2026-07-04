// 预览服务器的前端绑定:对应 Rust 的 preview.rs。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** 启动本地预览服务器(幂等),返回监听端口。 */
export function previewStart(): Promise<number> {
  return invoke('preview_start')
}

/** 设置当前预览目标:工作目录 root + 相对路径 target_rel(+ 远程 host)。 */
export function previewSetTarget(
  root: string,
  targetRel: string,
  host?: string
): Promise<void> {
  return invoke('preview_set_target', {
    host: host || null,
    root,
    targetRel
  })
}

/** 解析默认预览目标(index.html / artifacts/index.html / 最新 *.html),返回相对 root 的路径。 */
export function previewDefaultTarget(root: string, host?: string): Promise<string> {
  return invoke('preview_default_target', { host: host || null, root })
}

/** 后台预取渲染引擎资源(KaTeX 等)到永久缓存,打开预览前就备好,首屏不等传输。 */
export function previewPrefetchAssets(host?: string): Promise<void> {
  return invoke('preview_prefetch_assets', { host: host || null })
}

/** 监听热刷新事件(claude 改了 HTML → 自动重载 iframe)。 */
export function previewPrefetchFile(path: string, host?: string): Promise<void> {
  return invoke('preview_prefetch_file', { host: host || null, path })
}

export function onPreviewReload(cb: () => void): Promise<UnlistenFn> {
  return listen<{ token: number }>('preview-reload', () => cb())
}
