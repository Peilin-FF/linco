import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Loader2, X } from 'lucide-react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { isTauri } from '@tauri-apps/api/core'
import { useI18n } from '@/lib/i18n'
import type { TerminalLinkNotice } from '@/lib/terminalLinks'

export default function TerminalLinkFeedback({ notice, onClose }: {
  notice: TerminalLinkNotice
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const hovering = notice.status === 'hover'
  useEffect(() => {
    if (notice.status !== 'opened') return
    const timer = window.setTimeout(onClose, 6000)
    return () => window.clearTimeout(timer)
  }, [notice.status, onClose])
  return <div
    role={notice.status === 'error' || copyError ? 'alert' : 'status'}
    className={`absolute bottom-2 left-2 right-2 z-20 rounded-lg border border-black/10 bg-canvas px-3 py-2 text-[11px] text-ink shadow-lg ${hovering ? 'pointer-events-none' : ''}`}
    data-terminal-link-feedback={notice.status}
  >
    <div className="flex items-center gap-2">
      {notice.status === 'opening' ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <ExternalLink size={13} className="shrink-0" />}
      <span className="min-w-0 flex-1 font-medium">{t(`term.link.${notice.status}`)}</span>
      {!hovering && <>
        <button className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 hover:bg-black/5" onClick={() => {
          setCopyError('')
          void Promise.resolve().then(() => isTauri() ? writeText(notice.url) : navigator.clipboard.writeText(notice.url))
            .then(() => setCopied(true)).catch(error => setCopyError(String(error)))
        }}><Copy size={12} />{t(copied ? 'term.link.copied' : 'term.link.copy')}</button>
        <button onClick={onClose} className="shrink-0 rounded p-1 hover:bg-black/5" aria-label={t('common.close')}><X size={13} /></button>
      </>}
    </div>
    <div className="mt-1 max-h-16 select-text overflow-auto break-all font-mono text-ink-muted" dir="ltr">{notice.url}</div>
    {notice.error && <p className="mt-1 max-h-20 overflow-auto break-words text-red-600">{notice.error}</p>}
    {copyError && <p className="mt-1 break-words text-red-600">{t('term.link.copyFailed')} {copyError}</p>}
  </div>
}
