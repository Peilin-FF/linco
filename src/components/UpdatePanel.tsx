import { Download, X } from 'lucide-react'

interface Props {
  version: string
  /** release notes(latest.json 的 notes / GitHub release body),即更新公告 */
  body?: string
  error?: string | null
  t: (k: string, v?: Record<string, string | number>) => string
  onInstall: () => void
  onClose: () => void
}

// 把 release notes 的极简 markdown(标题 / - 列表 / 空行)渲染成行。
// 不引重型 md 库——公告内容简单,逐行处理即可。
function renderNotes(body: string): JSX.Element[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: JSX.Element[] = []
  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    if (!line.trim()) {
      out.push(<div key={i} className="h-1.5" />)
      return
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push(
        <div key={i} className="mt-1 text-[13px] font-semibold text-ink">
          {line.replace(/^#{1,6}\s/, '')}
        </div>
      )
      return
    }
    const m = line.match(/^\s*[-*]\s+(.*)$/)
    if (m) {
      out.push(
        <div key={i} className="flex gap-1.5 text-[12.5px] leading-relaxed text-ink-muted">
          <span className="select-none text-accent">·</span>
          <span>{m[1]}</span>
        </div>
      )
      return
    }
    out.push(
      <div key={i} className="text-[12.5px] leading-relaxed text-ink-muted">
        {line}
      </div>
    )
  })
  return out
}

/// 更新公告浮层:点右上角「新版本」横幅弹出,展示更新内容,再让用户决定是否更新。
export default function UpdatePanel({
  version,
  body,
  error,
  t,
  onInstall,
  onClose
}: Props): JSX.Element {
  return (
    <>
      {/* 点外部关闭 */}
      <div className="fixed inset-0 z-[59]" onClick={onClose} />
      <div className="absolute right-0 top-full z-[60] mt-1.5 w-[320px] overflow-hidden rounded-xl bg-canvas shadow-card ring-1 ring-black/10">
        <div className="flex items-center justify-between border-b border-black/8 px-3.5 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink">
              {t('update.whatsNew')}
            </span>
            <span className="font-mono text-[11px] text-ink-faint">v{version}</span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-ink-faint hover:bg-black/5 hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[260px] overflow-y-auto px-3.5 py-2.5">
          {body && body.trim() ? (
            <div className="flex flex-col gap-0.5">{renderNotes(body)}</div>
          ) : (
            <div className="text-[12.5px] text-ink-faint">
              {t('update.available', { version })}
            </div>
          )}
          {error && (
            <div className="mt-2 text-[12px] text-red-600">
              {t('update.failed', { error })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-black/8 px-3.5 py-2.5">
          <span className="text-[11px] text-ink-faint">{t('update.restartHint')}</span>
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={onClose}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-muted hover:bg-black/5"
            >
              {t('update.later')}
            </button>
            <button
              onClick={onInstall}
              className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90"
            >
              <Download size={13} />
              {t('update.installNow')}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
