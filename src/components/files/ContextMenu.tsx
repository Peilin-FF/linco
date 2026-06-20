import { useEffect, useRef } from 'react'
import {
  FilePlus,
  FolderPlus,
  FolderSearch,
  TerminalSquare,
  Scissors,
  Copy,
  ClipboardPaste,
  Link2,
  CornerUpLeft,
  Pencil,
  Trash2,
  Eye
} from 'lucide-react'
import { useI18n } from '@/lib/i18n'

export type ContextAction =
  | 'new-file'
  | 'new-folder'
  | 'reveal'
  | 'preview'
  | 'open-terminal'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'copy-path'
  | 'copy-relative-path'
  | 'rename'
  | 'delete'

interface ContextMenuProps {
  x: number
  y: number
  isDir: boolean
  /** 被右键的条目名(用于按扩展名决定是否显示「预览」) */
  fileName?: string
  canPaste: boolean
  onAction: (action: ContextAction) => void
  onClose: () => void
}

interface Item {
  action: ContextAction
  labelKey: string
  icon: typeof FilePlus
  shortcut?: string
  danger?: boolean
  dirOnly?: boolean
  /** 仅对 .html/.htm 文件显示 */
  htmlOnly?: boolean
  disabled?: boolean
  group: number
}

export default function ContextMenu({
  x,
  y,
  isDir,
  fileName,
  canPaste,
  onAction,
  onClose
}: ContextMenuProps): JSX.Element {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  const items: Item[] = [
    { action: 'new-file', labelKey: 'ctx.newFile', icon: FilePlus, dirOnly: true, group: 0 },
    {
      action: 'new-folder',
      labelKey: 'ctx.newFolder',
      icon: FolderPlus,
      dirOnly: true,
      group: 0
    },
    { action: 'reveal', labelKey: 'ctx.reveal', icon: FolderSearch, shortcut: '⌥⌘R', group: 1 },
    {
      action: 'preview',
      labelKey: 'ctx.preview',
      icon: Eye,
      htmlOnly: true,
      group: 1
    },
    {
      action: 'open-terminal',
      labelKey: 'ctx.openTerminal',
      icon: TerminalSquare,
      dirOnly: true,
      group: 1
    },
    { action: 'cut', labelKey: 'ctx.cut', icon: Scissors, shortcut: '⌘X', group: 2 },
    { action: 'copy', labelKey: 'ctx.copy', icon: Copy, shortcut: '⌘C', group: 2 },
    {
      action: 'paste',
      labelKey: 'ctx.paste',
      icon: ClipboardPaste,
      shortcut: '⌘V',
      dirOnly: true,
      disabled: !canPaste,
      group: 2
    },
    {
      action: 'copy-path',
      labelKey: 'ctx.copyPath',
      icon: Link2,
      shortcut: '⌥⌘C',
      group: 3
    },
    {
      action: 'copy-relative-path',
      labelKey: 'ctx.copyRelPath',
      icon: CornerUpLeft,
      shortcut: '⇧⌥⌘C',
      group: 3
    },
    { action: 'rename', labelKey: 'ctx.rename', icon: Pencil, shortcut: '⏎', group: 4 },
    {
      action: 'delete',
      labelKey: 'ctx.delete',
      icon: Trash2,
      shortcut: '⌘⌫',
      danger: true,
      group: 4
    }
  ]

  const ext = fileName?.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  const isHtml = !isDir && (ext === 'html' || ext === 'htm')
  const visible = items.filter((it) => {
    if (it.dirOnly && !isDir) return false
    if (it.htmlOnly && !isHtml) return false
    return true
  })

  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 230),
    top: Math.min(y, window.innerHeight - visible.length * 30 - 40)
  }

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-50 min-w-[220px] rounded-lg bg-canvas py-1 text-[13px] shadow-card ring-1 ring-black/10"
    >
      {visible.map((it, i) => {
        const newGroup = i > 0 && visible[i - 1].group !== it.group
        return (
          <div key={it.action}>
            {newGroup && <div className="my-1 h-px bg-black/8" />}
            <button
              disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return
                onAction(it.action)
                onClose()
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                it.disabled
                  ? 'cursor-default text-ink-faint/50'
                  : it.danger
                    ? 'text-red-600 hover:bg-red-50'
                    : 'text-ink hover:bg-black/5'
              }`}
            >
              <it.icon size={14} className="shrink-0" />
              <span className="flex-1">{t(it.labelKey)}</span>
              {it.shortcut && (
                <span className="text-[11px] text-ink-faint">{it.shortcut}</span>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
