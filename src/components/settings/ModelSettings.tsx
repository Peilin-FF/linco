import { useState } from 'react'
import { Plus, Trash2, Check, Loader2, Wifi, CircleCheck, CircleX } from 'lucide-react'
import {
  AGENT_PRESETS,
  agentLaunchCommand,
  agentExecutable,
  syncConfigToRemote,
  testModelConnection,
  type AgentConfig,
  type AppConfig,
  type ModelTestResult
} from '@/lib/config'
import { useI18n } from '@/lib/i18n'

interface ModelSettingsProps {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

const PROVIDERS: { id: string; label?: string; labelKey?: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'custom', labelKey: 'model.customCompat' }
]

type StoredModelTestResult =
  | ModelTestResult
  | { ok: false; message: string; status: null; latencyMs: 0 }

export default function ModelSettings({
  config,
  onChange
}: ModelSettingsProps): JSX.Element {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string>(
    config.agents[0]?.id ?? ''
  )
  const selected = config.agents.find((a) => a.id === selectedId)
  const isOpenAI = selected?.provider === 'openai'

  // 同步配置到远程的状态
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string>('')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, StoredModelTestResult>>({})

  const syncTo = async (hostStr: string, label: string): Promise<void> => {
    // 信任确认:WKWebView 支持 window.confirm。明确告知含密钥 + 风险。
    const ok = window.confirm(
      t('model.syncConfirm', { n: config.agents.length, label })
    )
    if (!ok) return
    setSyncing(hostStr)
    setSyncMsg('')
    try {
      await syncConfigToRemote(hostStr)
      setSyncMsg(t('model.synced', { name: label }))
    } catch (e) {
      setSyncMsg(t('model.syncFailed', { error: String(e) }))
    } finally {
      setSyncing(null)
    }
  }

  const update = (next: Partial<AppConfig>): void =>
    onChange({ ...config, ...next })

  const updateAgent = (id: string, patch: Partial<AgentConfig>): void => {
    update({
      agents: config.agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
    })
  }

  const runConnectionTest = async (agent: AgentConfig): Promise<void> => {
    setTestingId(agent.id)
    setTestResults((prev) => {
      const next = { ...prev }
      delete next[agent.id]
      return next
    })
    try {
      const result = await testModelConnection(agent)
      setTestResults((prev) => ({ ...prev, [agent.id]: result }))
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [agent.id]: {
          ok: false,
          message: String(e),
          status: null,
          latencyMs: 0
        }
      }))
    } finally {
      setTestingId(null)
    }
  }

  const addPreset = (presetId: string): void => {
    const preset = AGENT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    // 避免重复 id
    let id = preset.id
    let n = 2
    while (config.agents.some((a) => a.id === id)) id = `${preset.id}-${n++}`
    const agent: AgentConfig = { ...preset, id, apiKey: '' }
    update({
      agents: [...config.agents, agent],
      defaultAgent: config.defaultAgent || id
    })
    setSelectedId(id)
  }

  const removeAgent = (id: string): void => {
    const agents = config.agents.filter((a) => a.id !== id)
    update({
      agents,
      defaultAgent:
        config.defaultAgent === id ? (agents[0]?.id ?? '') : config.defaultAgent
    })
    if (selectedId === id) setSelectedId(agents[0]?.id ?? '')
  }

  return (
    <div className="mx-auto max-w-[720px]">
      <h2 className="text-[20px] font-semibold text-ink">{t('model.title')}</h2>
      <p className="mt-1.5 text-[13px] text-ink-faint">
        {t('model.desc')}
      </p>

      {/* 自动启动开关 */}
      <label className="mt-5 flex items-center gap-2.5 rounded-xl bg-sidebar px-4 py-3">
        <input
          type="checkbox"
          checked={config.autoStart}
          onChange={(e) => update({ autoStart: e.target.checked })}
          className="h-4 w-4 accent-ink"
        />
        <span className="text-[14px] text-ink">{t('model.autoStart')}</span>
      </label>

      {/* 同步配置到远程服务器(含密钥,需信任确认) */}
      {config.connections.length > 0 && (
        <div className="mt-4 rounded-xl bg-sidebar p-4">
          <div className="text-[14px] font-medium text-ink">{t('model.syncToRemote')}</div>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            {t('model.syncDescFull1')}<b className="text-amber-600">{t('model.syncDescFull2')}</b>
            {t('model.syncDescFull3')}<code className="font-mono">~/.linco/config.json</code>
            {t('model.syncDescFull4')}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {config.connections.map((c) => (
              <button
                key={c.id}
                onClick={() => syncTo(c.host, c.name || c.host)}
                disabled={syncing === c.host}
                className="rounded-lg border border-black/10 bg-canvas px-3 py-1.5 text-[12.5px] text-ink hover:border-black/25 disabled:opacity-50"
              >
                {syncing === c.host ? t('model.syncing') : t('model.syncTo', { name: c.name || c.host })}
              </button>
            ))}
          </div>
          {syncMsg && (
            <div className="mt-2 text-[12px] text-ink-muted">{syncMsg}</div>
          )}
        </div>
      )}

      {/* 添加预设 */}
      <div className="mt-6">
        <div className="mb-2 text-[13px] font-medium text-ink-muted">
          {t('model.addAgent')}
        </div>
        <div className="flex flex-wrap gap-2">
          {AGENT_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => addPreset(p.id)}
              className="flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-1.5 text-[13px] text-ink hover:bg-black/5"
            >
              <Plus size={14} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* 已配置列表 */}
      {config.agents.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-[13px] font-medium text-ink-muted">
            {t('model.configured')}
          </div>
          <div className="flex flex-col gap-1">
            {config.agents.map((a) => (
              <div
                key={a.id}
                className={`flex items-center gap-2 rounded-xl px-3 py-2 ${
                  a.id === selectedId ? 'bg-sidebar' : 'hover:bg-black/5'
                }`}
              >
                <button
                  onClick={() => setSelectedId(a.id)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <span className="text-[14px] text-ink">{a.name}</span>
                  <span className="text-[12px] text-ink-faint">
                    {a.command}
                  </span>
                </button>
                {/* 设为默认 */}
                <button
                  onClick={() => update({ defaultAgent: a.id })}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${
                    config.defaultAgent === a.id
                      ? 'text-accent'
                      : 'text-ink-faint hover:text-ink-muted'
                  }`}
                >
                  {config.defaultAgent === a.id && <Check size={13} />}
                  {config.defaultAgent === a.id ? t('model.default') : t('model.setDefault')}
                </button>
                <button
                  onClick={() => removeAgent(a.id)}
                  className="rounded-md p-1 text-ink-faint hover:text-ink"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 编辑选中项 */}
      {selected && (
        <div className="mt-6 rounded-2xl bg-sidebar p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-[14px] font-medium text-ink">
              {t('model.editTitle', { name: selected.name })}
            </div>
            <button
              onClick={() => {
                runConnectionTest(selected).catch(() => {})
              }}
              disabled={testingId === selected.id}
              className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-[12.5px] text-ink-muted ring-1 ring-black/10 hover:text-ink disabled:cursor-default disabled:opacity-60"
            >
              {testingId === selected.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Wifi size={14} />
              )}
              {testingId === selected.id ? t('model.testRunning') : t('model.testConnection')}
            </button>
          </div>
          {testResults[selected.id] && (
            <div
              className={`mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] ring-1 ${
                testResults[selected.id].ok
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-100'
                  : 'bg-red-50 text-red-700 ring-red-100'
              }`}
            >
              {testResults[selected.id].ok ? (
                <CircleCheck size={15} className="mt-0.5 shrink-0" />
              ) : (
                <CircleX size={15} className="mt-0.5 shrink-0" />
              )}
              <div className="min-w-0">
                <div>{testResults[selected.id].message}</div>
                <div className="mt-0.5 text-[11px] opacity-75">
                  {t('model.testMeta', {
                    status: testResults[selected.id].status ?? '-',
                    ms: testResults[selected.id].latencyMs
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-4">
            <Field label={t('model.name')}>
              <input
                value={selected.name}
                onChange={(e) => updateAgent(selected.id, { name: e.target.value })}
                className={inputClass}
              />
            </Field>

            <Field label={t('model.provider')}>
              <select
                value={selected.provider}
                onChange={(e) =>
                  updateAgent(selected.id, { provider: e.target.value })
                }
                className={inputClass}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label ?? t(p.labelKey ?? '')}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('model.launchCmd')} hint={t('model.launchCmdHint')}>
              <input
                value={selected.command}
                onChange={(e) =>
                  updateAgent(selected.id, { command: e.target.value })
                }
                placeholder={isOpenAI ? 'codex' : 'claude'}
                className={`${inputClass} font-mono`}
              />
            </Field>

            <div className="rounded-lg bg-canvas px-3 py-2 font-mono text-[12px] text-ink-muted">
              {agentLaunchCommand(selected)}
            </div>

            <Field label={t('model.loginMethod')} hint={t('model.loginMethodHint')}>
              <div className="flex gap-2">
                <button
                  onClick={() => updateAgent(selected.id, { authMode: 'api' })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] ${
                    selected.authMode !== 'subscription'
                      ? 'border-accent bg-accent/5 text-ink'
                      : 'border-black/10 text-ink-muted hover:bg-black/5'
                  }`}
                >
                  API Key
                </button>
                <button
                  onClick={() =>
                    updateAgent(selected.id, { authMode: 'subscription' })
                  }
                  className={`flex-1 rounded-lg border px-3 py-2 text-[13px] ${
                    selected.authMode === 'subscription'
                      ? 'border-accent bg-accent/5 text-ink'
                      : 'border-black/10 text-ink-muted hover:bg-black/5'
                  }`}
                >
                  {t('model.subscription')}
                </button>
              </div>
            </Field>

            {selected.authMode === 'subscription' ? (
              <div className="rounded-lg bg-canvas px-3 py-2.5 text-[12.5px] text-ink-muted">
                {t('model.subscriptionNote1')}
                <code className="rounded bg-black/5 px-1 font-mono">
                  {agentExecutable(selected) === 'codex'
                    ? 'codex login'
                    : 'claude auth login'}
                </code>
                {t('model.subscriptionNote2')}
              </div>
            ) : (
              <Field label="API Key" hint={t('model.apiKeyHint')}>
                <input
                  type="password"
                  value={selected.apiKey}
                  onChange={(e) =>
                    updateAgent(selected.id, { apiKey: e.target.value })
                  }
                  placeholder="sk-..."
                  className={`${inputClass} font-mono`}
                />
              </Field>
            )}

            <Field label={t('model.baseUrl')} hint={t('model.baseUrlHint')}>
              <input
                value={selected.baseUrl}
                onChange={(e) =>
                  updateAgent(selected.id, { baseUrl: e.target.value })
                }
                placeholder={
                  isOpenAI
                    ? 'https://api.openai.com/v1'
                    : 'https://api.anthropic.com'
                }
                className={`${inputClass} font-mono`}
              />
            </Field>

            <Field label={t('model.model')} hint={t('model.modelHint')}>
              <input
                value={selected.model}
                onChange={(e) =>
                  updateAgent(selected.id, { model: e.target.value })
                }
                placeholder={isOpenAI ? 'gpt-5' : 'claude-opus-4-8'}
                className={`${inputClass} font-mono`}
              />
            </Field>

            <Field label={t('model.switchableModels')} hint={t('model.switchableModelsHint')}>
              <div className="flex flex-wrap items-center gap-1.5">
                {(selected.models ?? []).map((m) => (
                  <span
                    key={m}
                    className="flex items-center gap-1 rounded-md bg-canvas px-2 py-1 font-mono text-[12px] text-ink ring-1 ring-black/10"
                  >
                    {m}
                    <button
                      onClick={() =>
                        updateAgent(selected.id, {
                          models: (selected.models ?? []).filter((x) => x !== m)
                        })
                      }
                      className="text-ink-faint hover:text-red-500"
                    >
                      <Trash2 size={11} />
                    </button>
                  </span>
                ))}
                <input
                  placeholder={t('model.addModelPlaceholder')}
                  className="min-w-[140px] flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-black/25"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = e.currentTarget.value.trim()
                      const cur = selected.models ?? []
                      if (v && !cur.includes(v)) {
                        updateAgent(selected.id, { models: [...cur, v] })
                      }
                      e.currentTarget.value = ''
                    }
                  }}
                />
              </div>
            </Field>
          </div>
        </div>
      )}
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
    <label className="block">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {hint && <span className="text-[12px] text-ink-faint">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
