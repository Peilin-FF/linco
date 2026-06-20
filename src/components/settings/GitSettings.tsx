import { useState } from 'react'
import { Loader2, Cloud, Github } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { AppConfig } from '@/lib/config'
import { gitApplyCredentials, syncGitToRemote } from '@/lib/git'

interface Props {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

// 设置 → Git:配置 GitHub 用户名/token(写 ~/.git-credentials)+ HTTP 代理。
// 可同步到远程主机(凭据 + 代理)。
export default function GitSettings({ config, onChange }: Props): JSX.Element {
  const { t } = useI18n()
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string>('')
  const [err, setErr] = useState<string>('')

  const update = (next: Partial<AppConfig>): void => onChange({ ...config, ...next })

  // 失焦时把凭据写进本地 ~/.git-credentials(用户名/token 都非空才生效)
  const applyLocal = (): void => {
    gitApplyCredentials().catch((e) => setErr(String(e)))
  }

  const syncTo = async (host: string, label: string): Promise<void> => {
    setSyncing(host)
    setSyncMsg('')
    setErr('')
    try {
      await syncGitToRemote(host)
      setSyncMsg(t('git.set.synced', { name: label }))
    } catch (e) {
      setErr(String(e))
    } finally {
      setSyncing(null)
    }
  }

  return (
    <div className="max-w-[760px]">
      <h2 className="mb-1 text-[20px] font-semibold text-ink">{t('git.set.title')}</h2>
      <p className="mb-6 text-[13px] text-ink-faint">{t('git.set.subtitle')}</p>

      {/* GitHub 凭据 */}
      <div className="mb-5">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
          <Github size={13} /> GitHub
        </div>
        <Field label={t('git.set.username')}>
          <input
            value={config.githubUser ?? ''}
            onChange={(e) => update({ githubUser: e.target.value })}
            onBlur={applyLocal}
            placeholder="octocat"
            className={inputClass}
          />
        </Field>
        <Field label={t('git.set.token')} hint={t('git.set.tokenHint')}>
          <input
            type="password"
            value={config.githubToken ?? ''}
            onChange={(e) => update({ githubToken: e.target.value })}
            onBlur={applyLocal}
            placeholder="ghp_..."
            className={`${inputClass} font-mono`}
          />
        </Field>
      </div>

      {/* 同步到远程 */}
      {config.connections.length > 0 && (
        <div className="mb-4 rounded-xl bg-sidebar p-4">
          <div className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
            <Cloud size={15} className="text-ink-muted" />
            {t('git.set.syncToRemote')}
          </div>
          <p className="mt-1 text-[12.5px] text-ink-faint">{t('git.set.syncDesc')}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {config.connections.map((c) => (
              <button
                key={c.id}
                onClick={() => void syncTo(c.host, c.name || c.host)}
                disabled={syncing === c.host}
                className="flex items-center gap-1.5 rounded-lg border border-black/10 bg-canvas px-3 py-1.5 text-[12.5px] text-ink hover:border-black/25 disabled:opacity-50"
              >
                {syncing === c.host && <Loader2 size={12} className="animate-spin" />}
                {t('git.set.syncTo', { name: c.name || c.host })}
              </button>
            ))}
          </div>
          {syncMsg && <div className="mt-2 text-[12px] text-ink-muted">{syncMsg}</div>}
        </div>
      )}
      {err && <p className="mt-2 text-[12px] text-red-600">{err}</p>}
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-black/10 bg-canvas px-3 py-2 text-[14px] text-ink outline-none focus:border-black/25'

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="mb-3 block">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {hint && <span className="text-[12px] text-ink-faint">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
