import { useState } from 'react'
import { Plus, Trash2, Check } from 'lucide-react'
import {
  AGENT_PRESETS,
  agentLaunchCommand,
  agentExecutable,
  syncConfigToRemote,
  type AgentConfig,
  type AppConfig
} from '@/lib/config'

interface ModelSettingsProps {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'custom', label: '自定义 / 兼容' }
]

export default function ModelSettings({
  config,
  onChange
}: ModelSettingsProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string>(
    config.agents[0]?.id ?? ''
  )
  const selected = config.agents.find((a) => a.id === selectedId)
  const isOpenAI = selected?.provider === 'openai'

  // 同步配置到远程的状态
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string>('')

  const syncTo = async (hostStr: string, label: string): Promise<void> => {
    // 信任确认:WKWebView 支持 window.confirm。明确告知含密钥 + 风险。
    const ok = window.confirm(
      `将把本地 ~/.linco/config.json(含 ${config.agents.length} 个 Agent、含明文 API Key)上传到:\n\n  ${label}:~/.linco/config.json\n\n` +
        `⚠️ 密钥会以明文落到该服务器磁盘,可能进入备份/快照/审计,不可逆。\n仅在你信任这台服务器时继续。`
    )
    if (!ok) return
    setSyncing(hostStr)
    setSyncMsg('')
    try {
      await syncConfigToRemote(hostStr)
      setSyncMsg(`✓ 已同步到 ${label}`)
    } catch (e) {
      setSyncMsg(`同步失败:${String(e)}`)
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
      <h2 className="text-[20px] font-semibold text-ink">模型设置</h2>
      <p className="mt-1.5 text-[13px] text-ink-faint">
        配置要驱动的 Agent CLI(供应商、API、启动命令)。设为默认后,打开应用会自动启动它,直接对话。
      </p>

      {/* 自动启动开关 */}
      <label className="mt-5 flex items-center gap-2.5 rounded-xl bg-sidebar px-4 py-3">
        <input
          type="checkbox"
          checked={config.autoStart}
          onChange={(e) => update({ autoStart: e.target.checked })}
          className="h-4 w-4 accent-ink"
        />
        <span className="text-[14px] text-ink">打开应用时自动启动默认 Agent</span>
      </label>

      {/* 同步配置到远程服务器(含密钥,需信任确认) */}
      {config.connections.length > 0 && (
        <div className="mt-4 rounded-xl bg-sidebar p-4">
          <div className="text-[14px] font-medium text-ink">同步配置到远程</div>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            把本地这套 Agent 配置(<b className="text-amber-600">含明文 API Key</b>
            )上传到远程 <code className="font-mono">~/.linco/config.json</code>,
            让远程也能用同一套。仅在你信任该服务器时同步。
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {config.connections.map((c) => (
              <button
                key={c.id}
                onClick={() => syncTo(c.host, c.name || c.host)}
                disabled={syncing === c.host}
                className="rounded-lg border border-black/10 bg-canvas px-3 py-1.5 text-[12.5px] text-ink hover:border-black/25 disabled:opacity-50"
              >
                {syncing === c.host ? '同步中…' : `同步到 ${c.name || c.host}`}
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
          添加 Agent
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
            已配置
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
                  {config.defaultAgent === a.id ? '默认' : '设为默认'}
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
          <div className="mb-4 text-[14px] font-medium text-ink">
            编辑「{selected.name}」
          </div>
          <div className="flex flex-col gap-4">
            <Field label="名称">
              <input
                value={selected.name}
                onChange={(e) => updateAgent(selected.id, { name: e.target.value })}
                className={inputClass}
              />
            </Field>

            <Field label="供应商">
              <select
                value={selected.provider}
                onChange={(e) =>
                  updateAgent(selected.id, { provider: e.target.value })
                }
                className={inputClass}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="启动命令" hint="在终端里启动该 Agent 的命令,如 claude / codex">
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

            <Field label="登录方式" hint="API Key=注入密钥;订阅=用 CLI 自身登录(claude auth login / codex login)">
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
                  订阅登录
                </button>
              </div>
            </Field>

            {selected.authMode === 'subscription' ? (
              <div className="rounded-lg bg-canvas px-3 py-2.5 text-[12.5px] text-ink-muted">
                订阅模式:不注入 API Key,使用 CLI 自身的订阅凭据。
                在「对话」或「终端」里运行{' '}
                <code className="rounded bg-black/5 px-1 font-mono">
                  {agentExecutable(selected) === 'codex'
                    ? 'codex login'
                    : 'claude auth login'}
                </code>{' '}
                完成浏览器登录(远程连接则在远程终端里登录,凭据落在那台机器)。
              </div>
            ) : (
              <Field label="API Key" hint="作为环境变量注入,仅保存在本地 ~/.linco/config.json">
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

            <Field label="Base URL" hint="可选。自定义/中转服务时填写">
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

            <Field label="模型" hint="可选。指定默认模型名(聊天框默认用它)">
              <input
                value={selected.model}
                onChange={(e) =>
                  updateAgent(selected.id, { model: e.target.value })
                }
                placeholder={isOpenAI ? 'gpt-5' : 'claude-opus-4-8'}
                className={`${inputClass} font-mono`}
              />
            </Field>

            <Field label="可切换模型" hint="同一供应商的多个模型,聊天框下拉可切换。回车添加。">
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
                  placeholder="+ 模型名,回车添加"
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
