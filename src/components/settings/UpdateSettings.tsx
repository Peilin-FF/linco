// 设置 → 常规 → 更新:显示当前版本,并允许手动检查。
//
// 为什么需要它:标题栏的更新入口只在「检查成功且确实有新版本」时才渲染,
// 所以一次失败的检查(GitHub Release 在部分网络下的 TLS/重定向抖动)与
// 「已是最新」在界面上完全一样 —— 都是什么都不显示。用户既看不到失败,
// 也无法重试,只能等下一次 30 分钟的轮询。这里把这三种状态分开,并给出
// 一个明确的手动检查入口。
import { useEffect, useState } from 'react'
import { RefreshCw, Download } from 'lucide-react'
import { getVersion } from '@tauri-apps/api/app'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { useI18n } from '@/lib/i18n'

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; update: Update }
  | { kind: 'failed'; error: string }
  | { kind: 'installing' }

export default function UpdateSettings(): JSX.Element {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    let alive = true
    getVersion()
      .then(value => { if (alive) setVersion(value) })
      .catch(() => { /* A missing version string is not worth an error banner. */ })
    return () => { alive = false }
  }, [])

  const runCheck = async (): Promise<void> => {
    setState({ kind: 'checking' })
    try {
      const update = await check({ timeout: 60_000 })
      setState(update ? { kind: 'available', update } : { kind: 'current' })
    } catch (reason) {
      setState({ kind: 'failed', error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  const install = async (update: Update): Promise<void> => {
    setState({ kind: 'installing' })
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch (reason) {
      setState({ kind: 'failed', error: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  const busy = state.kind === 'checking' || state.kind === 'installing'

  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-medium text-ink">{t('settings.updates')}</h3>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-ink-muted">{t('update.currentVersion', { version: version || '—' })}</span>
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-ink hover:bg-black/5 disabled:opacity-40"
        >
          <RefreshCw size={12} className={state.kind === 'checking' ? 'animate-spin' : ''} />
          {t('update.checkNow')}
        </button>
      </div>

      {state.kind === 'checking' && <p role="status" className="text-[12px] text-ink-muted">{t('update.checking')}</p>}
      {state.kind === 'current' && <p role="status" className="text-[12px] text-ink-muted">{t('update.upToDate')}</p>}
      {state.kind === 'installing' && <p role="status" className="text-[12px] text-ink-muted">{t('update.installing')}</p>}

      {state.kind === 'available' && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-ink">{t('update.available', { version: state.update.version })}</span>
          <button
            type="button"
            onClick={() => void install(state.update)}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-white hover:opacity-90"
          >
            <Download size={12} />{t('update.installNow')}
          </button>
          <span className="text-ink-faint">{t('update.restartHint')}</span>
        </div>
      )}

      {state.kind === 'failed' && (
        <div className="space-y-1">
          <p role="alert" className="select-text text-[12px] text-red-600">{t('update.failed', { error: state.error })}</p>
          <p className="text-[12px] text-ink-muted">{t('update.failedHint')}</p>
        </div>
      )}
    </section>
  )
}
