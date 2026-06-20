import { useEffect, useState } from 'react'
import { Loader2, Cloud } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import {
  pluginStatus,
  pluginSet,
  installRemotePlugins,
  type PluginStatus,
  type AppConfig
} from '@/lib/config'

interface Props {
  config: AppConfig
}

// 设置 → 插件:按 claude / codex 分组,每个插件一行 + 开关。
// 开关 = 安装/卸载(走 claude/codex plugin CLI 真注册)。装了显示开,没装显示关。
export default function PluginSettings({ config }: Props): JSX.Element {
  const { t } = useI18n()
  const [items, setItems] = useState<PluginStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null) // 正在切换的 "agent:id"
  const [syncing, setSyncing] = useState<string | null>(null) // 正在同步的 host
  const [syncMsg, setSyncMsg] = useState<string>('')
  const [err, setErr] = useState<string>('')

  const load = async (): Promise<void> => {
    try {
      setItems(await pluginStatus())
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const toggle = async (p: PluginStatus): Promise<void> => {
    const key = `${p.agent}:${p.id}`
    setBusy(key)
    setErr('')
    try {
      await pluginSet(p.agent, p.id, !p.installed)
      // 重新拉真实状态(以 CLI 为准,避免乐观更新与实际不符)
      await load()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  // 同步到某远程主机:rsync marketplace + CLI 注册(install_remote_plugins 已含全部逻辑)。
  const syncTo = async (host: string, label: string): Promise<void> => {
    setSyncing(host)
    setSyncMsg('')
    setErr('')
    try {
      await installRemotePlugins(host)
      setSyncMsg(t('plugins.synced', { name: label }))
    } catch (e) {
      setErr(String(e))
    } finally {
      setSyncing(null)
    }
  }

  const claude = items.filter((p) => p.agent === 'claude')
  const codex = items.filter((p) => p.agent === 'codex')

  const row = (p: PluginStatus): JSX.Element => {
    const key = `${p.agent}:${p.id}`
    const isBusy = busy === key
    return (
      <div
        key={key}
        className="flex items-center gap-3 border-b border-black/5 px-1 py-3 last:border-0"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{p.name}</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-ink-faint">{p.desc}</div>
        </div>
        {/* 开关 */}
        <button
          onClick={() => void toggle(p)}
          disabled={isBusy}
          role="switch"
          aria-checked={p.installed}
          title={p.installed ? t('plugins.installed') : t('plugins.notInstalled')}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            p.installed ? 'bg-ink' : 'bg-black/15'
          }`}
        >
          <span
            className={`absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-all ${
              p.installed ? 'left-[18px]' : 'left-0.5'
            }`}
          >
            {isBusy && <Loader2 size={11} className="animate-spin text-ink-faint" />}
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-[760px]">
      <h2 className="mb-1 text-[20px] font-semibold text-ink">{t('plugins.title')}</h2>
      <p className="mb-6 text-[13px] text-ink-faint">{t('plugins.subtitle')}</p>

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-faint">
          <Loader2 size={14} className="animate-spin" /> {t('plugins.loading')}
        </div>
      ) : (
        <>
          {/* Claude 组 */}
          <div className="mb-6">
            <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
              Claude Code
            </div>
            <div className="rounded-xl bg-canvas px-4 ring-1 ring-black/5">
              {claude.map(row)}
            </div>
          </div>
          {/* Codex 组 */}
          <div className="mb-4">
            <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
              Codex
            </div>
            <div className="rounded-xl bg-canvas px-4 ring-1 ring-black/5">
              {codex.map(row)}
            </div>
          </div>
          {/* 同步到远程:把当前(本地)插件状态 rsync + CLI 注册到远端主机 */}
          {config.connections.length > 0 && (
            <div className="mb-4 rounded-xl bg-sidebar p-4">
              <div className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                <Cloud size={15} className="text-ink-muted" />
                {t('plugins.syncToRemote')}
              </div>
              <p className="mt-1 text-[12.5px] text-ink-faint">
                {t('plugins.syncDesc')}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {config.connections.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => void syncTo(c.host, c.name || c.host)}
                    disabled={syncing === c.host}
                    className="flex items-center gap-1.5 rounded-lg border border-black/10 bg-canvas px-3 py-1.5 text-[12.5px] text-ink hover:border-black/25 disabled:opacity-50"
                  >
                    {syncing === c.host && (
                      <Loader2 size={12} className="animate-spin" />
                    )}
                    {t('plugins.syncTo', { name: c.name || c.host })}
                  </button>
                ))}
              </div>
              {syncMsg && (
                <div className="mt-2 text-[12px] text-ink-muted">{syncMsg}</div>
              )}
            </div>
          )}
          <p className="text-[11.5px] text-ink-faint">{t('plugins.hint')}</p>
          {err && <p className="mt-2 text-[12px] text-red-600">{err}</p>}
        </>
      )}
    </div>
  )
}
