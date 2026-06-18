import {
  File,
  FileCode,
  FileJson,
  FileText,
  Image as ImageIcon,
  Settings2,
  type LucideIcon
} from 'lucide-react'

// 按扩展名给文件挑一个合适的图标(VS Code 风格的轻量映射)
export function iconForFile(name: string): LucideIcon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'rs',
      'py',
      'go',
      'java',
      'c',
      'cpp',
      'h',
      'css',
      'scss',
      'html',
      'vue',
      'svelte',
      'sh'
    ].includes(ext)
  )
    return FileCode
  if (['json', 'yaml', 'yml', 'toml', 'lock'].includes(ext)) return FileJson
  if (['md', 'txt', 'log'].includes(ext)) return FileText
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext))
    return ImageIcon
  if (['env', 'gitignore', 'editorconfig', 'conf'].includes(ext))
    return Settings2
  return File
}
