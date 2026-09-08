import { useLayoutEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Paperclip, ArrowUp } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

// Windows IME can deliver compositionend before its final keydown. Check the
// native event as well so confirming a Chinese/Japanese word never sends it.
function isImeComposing(
  e: { nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number },
  composingRef: { current: boolean }
): boolean {
  return composingRef.current || e.nativeEvent?.isComposing === true ||
    e.nativeEvent?.keyCode === 229 || e.keyCode === 229
}

interface ChatInputProps {
  onSend?: (text: string) => void
  /** Forward input to this composer's own PTY, including deferred Enter. */
  onForward?: (data: string) => void
  cwd?: string
  remote?: boolean
  active?: boolean
  /** User-selected minimum height; long drafts can grow beyond it. */
  extraHeight?: number
  maxHeight?: number
}

export default function ChatInput({
  onSend, onForward, cwd, remote, active = true, extraHeight = 104, maxHeight = 360,
}: ChatInputProps): JSX.Element {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const composingRef = useRef(false)
  const prevRef = useRef('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const canSend = !!cwd && value.trim().length > 0
  const historyRef = useRef<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const draftRef = useRef('')

  useLayoutEffect(() => {
    const textarea = taRef.current
    if (!textarea || !active) return
    const resize = (): void => {
      if (!textarea.clientWidth) return
      const scrollTop = textarea.scrollTop
      textarea.style.height = '0px'
      const contentHeight = textarea.scrollHeight
      const height = Math.min(maxHeight, Math.max(extraHeight, contentHeight))
      textarea.style.height = height + 'px'
      textarea.style.overflowY = contentHeight > height ? 'auto' : 'hidden'
      textarea.scrollTop = scrollTop
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(textarea.parentElement!)
    // Font controls change CSS variables without changing the pane's width.
    const fontObserver = new MutationObserver(resize)
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
    return () => { observer.disconnect(); fontObserver.disconnect() }
  }, [value, extraHeight, maxHeight, active])

  const forwardDiff = (next: string): void => {
    if (!onForward) return
    const prev = prevRef.current
    let i = 0
    while (i < Math.min(prev.length, next.length) && prev[i] === next[i]) i++
    const out = '\x7f'.repeat(prev.length - i) + next.slice(i)
    if (out) onForward(out)
    prevRef.current = next
  }

  const handleChange = (next: string): void => {
    setValue(next)
    if (histIdx !== null) setHistIdx(null)
    if (!composingRef.current) forwardDiff(next)
  }

  const handleSend = (): void => {
    if (!canSend || composingRef.current) return
    const text = value.trim()
    onSend?.(text)
    // The text is already in the PTY. Re-sending it would duplicate the prompt.
    setTimeout(() => onForward?.('\r'), 16)
    if (historyRef.current[historyRef.current.length - 1] !== text) historyRef.current.push(text)
    setHistIdx(null)
    draftRef.current = ''
    setValue('')
    prevRef.current = ''
  }

  const replaceValue = (next: string): void => {
    setValue(next)
    if (!composingRef.current) forwardDiff(next)
    requestAnimationFrame(() => {
      const textarea = taRef.current
      if (textarea) textarea.selectionStart = textarea.selectionEnd = next.length
    })
  }

  const historyPrev = (): void => {
    const history = historyRef.current
    const current = histIdx === null ? history.length : histIdx
    if (current <= 0) return
    if (histIdx === null) draftRef.current = value
    setHistIdx(current - 1)
    replaceValue(history[current - 1])
  }

  const historyNext = (): void => {
    if (histIdx === null) return
    const next = histIdx + 1
    if (next >= historyRef.current.length) {
      setHistIdx(null)
      replaceValue(draftRef.current)
    } else {
      setHistIdx(next)
      replaceValue(historyRef.current[next])
    }
  }

  return (
    <div className="agent-composer">
      <textarea
        id={active ? 'agent-composer' : undefined}
        aria-label={t('workspace.agentInput')}
        disabled={!cwd || !active}
        ref={taRef}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={(e) => {
          composingRef.current = false
          forwardDiff(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (isImeComposing(e, composingRef)) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onForward?.('\x1b')
          } else if (e.key === 'ArrowUp' && e.currentTarget.selectionStart === 0 && historyRef.current.length > 0) {
            // Only the text boundary recalls history: navigating wrapped lines
            // should never replace the draft the user is currently editing.
            e.preventDefault()
            historyPrev()
          } else if (e.key === 'ArrowDown' && e.currentTarget.selectionEnd === value.length && histIdx !== null) {
            e.preventDefault()
            historyNext()
          }
        }}
        rows={4}
        placeholder={t(cwd ? 'chat.placeholder' : 'workspace.chooseProjectFirst')}
        title={t('workspace.composerHint')}
        className="block w-full resize-none bg-transparent text-ink placeholder:text-ink-faint focus:outline-none"
      />
      <div className="composer-footer">
        {!remote && <button
          disabled={!cwd}
          title={t('workspace.attachFile')}
          aria-label={t('workspace.attachFile')}
          className="icon-button"
          onClick={async () => {
            const selected = await open({ multiple: true, directory: false })
            const paths = typeof selected === 'string' ? [selected] : selected || []
            if (!paths.length) return
            handleChange(value + (value && !value.endsWith(' ') ? ' ' : '') + paths.map((path) => JSON.stringify(path)).join(' ') + ' ')
            taRef.current?.focus()
          }}
        ><Paperclip size={14} /></button>}
        <span className="composer-hint" title={t('workspace.composerHint')}>{t('workspace.composerHint')}</span>
        <button
          onClick={handleSend}
          aria-label={t('workspace.send')}
          title={t('workspace.send')}
          disabled={!canSend}
          className={'composer-send ' + (canSend ? 'bg-accent text-white hover:bg-[var(--button-hover)]' : 'text-ink-faint')}
        ><ArrowUp size={16} /></button>
      </div>
    </div>
  )
}
