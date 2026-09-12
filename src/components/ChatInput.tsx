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

/** CLI commands and terse menu answers must remain exact terminal input. */
export function canAppendAgentContext(text: string): boolean {
  const value = text.trim()
  return !!value && !value.startsWith('/') &&
    !/^(?:y|n|yes|no|ok|okay|cancel|\d+|是|否|好|好的|取消)[.!。]?$/i.test(value)
}

interface ChatInputProps {
  onSend?: (text: string) => void
  /** Prepare this explicit submission and return optional context to append. */
  onPrepareSend?: (text: string) => string | undefined | Promise<string | undefined>
  /** Forward input to this composer's own PTY, including deferred Enter. */
  onForward?: (data: string) => void
  cwd?: string
  remote?: boolean
  active?: boolean
  /** The owning PTY exists and can accept raw input. */
  ready?: boolean
  /** User-selected minimum height; long drafts can grow beyond it. */
  extraHeight?: number
  maxHeight?: number
}

export default function ChatInput({
  onSend, onPrepareSend, onForward, cwd, remote, active = true, ready = true, extraHeight = 104, maxHeight = 360,
}: ChatInputProps): JSX.Element {
  const { t, lang } = useI18n()
  const [value, setValue] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const preparingRef = useRef(false)
  const sendGeneration = useRef(0)
  const terminalEpoch = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active && ready
  const composingRef = useRef(false)
  const prevRef = useRef('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const canSend = !!cwd && active && ready && !preparing && value.trim().length > 0
  const historyRef = useRef<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const draftRef = useRef('')

  useLayoutEffect(() => {
    terminalEpoch.current++
    return () => { terminalEpoch.current++ }
  }, [ready])

  useLayoutEffect(() => {
    if (!active || !ready) {
      preparingRef.current = false
      setPreparing(false)
    }
    // A new PTY has none of the prior terminal's pending draft. Retain the
    // visible draft and re-forward it only on the next real edit/submission.
    if (!ready) prevRef.current = ''
    return () => { sendGeneration.current++ }
  }, [active, ready])

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
    if (!onForward || !activeRef.current) return
    const prev = prevRef.current
    let i = 0
    while (i < Math.min(prev.length, next.length) && prev[i] === next[i]) i++
    const out = '\x7f'.repeat(prev.length - i) + next.slice(i)
    if (out) onForward(out)
    prevRef.current = next
  }

  const handleChange = (next: string): void => {
    if (preparingRef.current || !activeRef.current) return
    setValue(next)
    setSendError(null)
    if (histIdx !== null) setHistIdx(null)
    if (!composingRef.current) forwardDiff(next)
  }

  const handleSend = (): void => {
    if (!canSend || composingRef.current || preparingRef.current) return
    forwardDiff(value)
    const text = value.trim()
    const generation = ++sendGeneration.current
    const restoreFocus = document.activeElement === taRef.current
    setSendError(null)
    const finish = (context?: string): Promise<void> => {
      if (generation !== sendGeneration.current || !activeRef.current) return Promise.resolve()
      preparingRef.current = true
      setPreparing(true)
      // Keystrokes already supplied the user text. Only append the prepared
      // context; re-sending the original would duplicate the prompt in the TUI.
      const suffix = context?.replace(/[\r\n]+/g, ' ').trim()
      if (suffix) onForward?.(' ' + suffix)
      onSend?.(text)
      // Capture this composer's callback, so switching projects cannot route
      // the deferred Enter into a different resident terminal.
      const enterDelay = suffix && navigator.platform.toLowerCase().includes('win') ? 120 : 16
      const epoch = terminalEpoch.current
      const submitted = new Promise<void>((resolve) => setTimeout(() => {
        // Resuming/reconnecting can replace a PTY within this short delay.
        // Never deliver an earlier submission's Enter to its replacement.
        if (epoch === terminalEpoch.current) onForward?.('\r')
        resolve()
      }, enterDelay))
      if (historyRef.current[historyRef.current.length - 1] !== text) historyRef.current.push(text)
      setHistIdx(null)
      draftRef.current = ''
      setValue('')
      prevRef.current = ''
      return submitted
    }
    const release = (): void => {
      if (generation !== sendGeneration.current) return
      preparingRef.current = false
      setPreparing(false)
      if (restoreFocus && activeRef.current && document.activeElement === document.body) {
        requestAnimationFrame(() => {
          if (generation === sendGeneration.current && activeRef.current) taRef.current?.focus()
        })
      }
    }
    // Slash commands belong to the CLI itself, including its interactive menus.
    if (!onPrepareSend || !canAppendAgentContext(text)) { void finish().finally(release); return }
    preparingRef.current = true
    setPreparing(true)
    let timeout: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      Promise.resolve().then(() => onPrepareSend(text)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(lang === 'zh' ? '工作板准备超时，请重试。' : 'Workboard setup timed out. Please try again.')), 15000)
      })
    ]).then(finish).catch((error: unknown) => {
      if (generation === sendGeneration.current && activeRef.current) {
        const detail = error instanceof Error ? error.message : String(error)
        setSendError((lang === 'zh' ? '消息尚未发送。' : 'Message has not been sent. ') + detail)
      }
    }).finally(() => {
      clearTimeout(timeout)
      release()
    })
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
        disabled={!cwd || !active || !ready || preparing}
        aria-busy={preparing || !ready}
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
        placeholder={cwd && !ready
          ? lang === 'zh' ? remote ? '正在连接会话…' : '正在准备会话…' : remote ? 'Connecting session…' : 'Preparing session…'
          : t(cwd ? 'chat.placeholder' : 'workspace.chooseProjectFirst')}
        title={t('workspace.composerHint')}
        className="block w-full resize-none bg-transparent text-ink placeholder:text-ink-faint focus:outline-none"
      />
      <div className="composer-footer">
        {!remote && <button
          disabled={!cwd || !ready || preparing}
          title={t('workspace.attachFile')}
          aria-label={t('workspace.attachFile')}
          className="icon-button"
          onClick={async () => {
            const selected = await open({ multiple: true, directory: false })
            const paths = typeof selected === 'string' ? [selected] : selected || []
            if (!paths.length) return
            if (!activeRef.current || preparingRef.current) return
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
      {sendError && <p role="alert" className="px-3 pb-2 text-[12px] text-red-600">{sendError}</p>}
    </div>
  )
}
