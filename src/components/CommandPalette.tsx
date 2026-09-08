import { useEffect, useRef, useState } from 'react'
import { Search, ArrowUpRight, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

export interface WorkspaceCommand {
  id: string
  label: string
  detail?: string
  icon: LucideIcon
  run: () => void
}

export default function CommandPalette({ commands, onClose }: {
  commands: WorkspaceCommand[]
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const filtered = commands.filter((item) => `${item.label} ${item.detail || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); previous?.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    dialog.current?.querySelector(`#command-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const choose = (command: WorkspaceCommand): void => {
    dialog.current?.close()
    onClose()
    requestAnimationFrame(command.run)
  }
  return (
    <dialog ref={dialog} className="command-palette" aria-label={t('workspace.commands')} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="command-panel">
        <div className="command-search">
          <Search size={20} className="text-ink-muted" />
          <input role="combobox" aria-label={t('workspace.searchCommands')} aria-expanded="true" aria-controls="workspace-command-list" aria-activedescendant={filtered.length ? `command-${active}` : undefined} aria-autocomplete="list" value={query} placeholder={t('workspace.searchCommands')} onChange={(event) => { setQuery(event.target.value); setActive(0) }} onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => filtered.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length : 0)
            }
            if (event.key === 'Enter' && filtered[active]) { event.preventDefault(); choose(filtered[active]) }
          }} />
          <button className="command-escape" onClick={onClose} aria-label={t('workspace.closeCommands')}>Esc</button>
        </div>
        <div className="command-list" id="workspace-command-list" role="listbox" aria-label={t('workspace.commands')}>
          {filtered.map((command, index) => (
            <button key={command.id} id={`command-${index}`} role="option" aria-selected={active === index} tabIndex={-1} className={`command-item ${active === index ? 'is-active' : ''}`} onMouseMove={() => setActive(index)} onClick={() => choose(command)}>
              <command.icon size={18} /><span className="flex-1 text-left"><span className="block">{command.label}</span>{command.detail && <span className="block text-[11px] text-ink-muted">{command.detail}</span>}</span><ArrowUpRight size={14} className="text-ink-faint" />
            </button>
          ))}
          {!filtered.length && <p className="command-empty">{t('workspace.noCommands')}</p>}
        </div>
        <div className="command-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> {t('workspace.navigate')}</span><span><kbd>↵</kbd> {t('workspace.select')}</span></div>
      </div>
    </dialog>
  )
}
