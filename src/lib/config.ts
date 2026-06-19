// 应用配置的前端绑定:对应 Rust 的 config.rs。
import { invoke } from '@tauri-apps/api/core'
import type { Connection } from './connection'

export interface AgentConfig {
  id: string
  name: string
  provider: string
  command: string
  apiKey: string
  baseUrl: string
  model: string
}

export interface AppConfig {
  agents: AgentConfig[]
  defaultAgent: string
  autoStart: boolean
  /** 当前工作目录(agent 在此运行) */
  cwd: string
  /** 最近用过的工作目录 */
  recentDirs: string[]
  /** 已配置的远程连接 */
  connections: Connection[]
  /** 当前激活的连接 id(空 = 本地) */
  activeConnection: string
}

// Rust 端用 snake_case 序列化,Tauri 默认 camelCase 转换;
// 但我们的字段名(api_key/base_url/default_agent/auto_start)需手动映射。
interface RawAgent {
  id: string
  name: string
  provider: string
  command: string
  api_key: string
  base_url: string
  model: string
}
interface RawConfig {
  agents: RawAgent[]
  default_agent: string
  auto_start: boolean
  cwd: string
  recent_dirs: string[]
  connections: Connection[]
  active_connection: string
}

function fromRaw(raw: RawConfig): AppConfig {
  return {
    agents: (raw.agents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider ?? '',
      command: a.command,
      apiKey: a.api_key ?? '',
      baseUrl: a.base_url ?? '',
      model: a.model ?? ''
    })),
    defaultAgent: raw.default_agent ?? '',
    autoStart: raw.auto_start ?? true,
    cwd: raw.cwd ?? '',
    recentDirs: raw.recent_dirs ?? [],
    connections: raw.connections ?? [],
    activeConnection: raw.active_connection ?? ''
  }
}

function toRaw(cfg: AppConfig): RawConfig {
  return {
    agents: cfg.agents.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      command: a.command,
      api_key: a.apiKey,
      base_url: a.baseUrl,
      model: a.model
    })),
    default_agent: cfg.defaultAgent,
    auto_start: cfg.autoStart,
    cwd: cfg.cwd,
    recent_dirs: cfg.recentDirs,
    connections: cfg.connections,
    active_connection: cfg.activeConnection
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const raw = await invoke<RawConfig>('load_config')
  return fromRaw(raw)
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await invoke('save_config', { config: toRaw(cfg) })
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function hasFlag(command: string, shortFlag: string, longFlag: string): boolean {
  const parts = command.split(/\s+/).filter(Boolean)
  return parts.some(
    (p) =>
      p === shortFlag ||
      p.startsWith(`${shortFlag}=`) ||
      p === longFlag ||
      p.startsWith(`${longFlag}=`)
  )
}

function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

function defaultCommandForProvider(provider: string): string {
  return provider === 'openai' ? 'codex' : 'claude'
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function codexConfigArg(key: string, value: string | boolean): string {
  const tomlValue = typeof value === 'boolean' ? String(value) : tomlString(value)
  return ` -c ${shellQuote(`${key}=${tomlValue}`)}`
}

function hasCodexProviderConfig(command: string): boolean {
  return command.includes('model_provider') || command.includes('model_providers.')
}

/** 返回用于进程定位/补全缓存的 agent 可执行名,不带模型/权限参数。 */
export function agentExecutable(agent: AgentConfig): string {
  return commandHead(agent.command) || defaultCommandForProvider(agent.provider)
}

/** 生成真正写入 PTY 的 TUI 启动命令。 */
export function agentLaunchCommand(agent: AgentConfig): string {
  let cmd = agent.command.trim()
  if (!cmd) cmd = defaultCommandForProvider(agent.provider)

  const head = commandHead(cmd).split('/').pop() ?? ''
  const model = agent.model.trim()
  const isCodex = agent.provider === 'openai' || head === 'codex'
  if (isCodex && agent.baseUrl.trim() && !hasCodexProviderConfig(cmd)) {
    cmd += codexConfigArg('model_provider', 'linco')
    cmd += codexConfigArg('model_providers.linco.name', 'Linco')
    cmd += codexConfigArg('model_providers.linco.base_url', agent.baseUrl.trim())
    cmd += codexConfigArg('model_providers.linco.wire_api', 'responses')
    cmd += codexConfigArg('model_providers.linco.env_key', 'LINCO_OPENAI_API_KEY')
    cmd += codexConfigArg('model_providers.linco.requires_openai_auth', false)
  }
  if (model) {
    if (isCodex) {
      if (!hasFlag(cmd, '-m', '--model')) cmd += ` -m ${shellQuote(model)}`
    } else if (agent.provider === 'anthropic' || head === 'claude') {
      if (!hasFlag(cmd, '--model', '--model')) cmd += ` --model ${shellQuote(model)}`
    }
  }
  return cmd
}

/** 把 agent 配置展开成注入终端的环境变量。 */
export function agentEnv(agent: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {}
  const p = agent.provider
  if (agent.apiKey) {
    if (p === 'anthropic') env.ANTHROPIC_API_KEY = agent.apiKey
    else if (p === 'openai') {
      env.OPENAI_API_KEY = agent.apiKey
      env.LINCO_OPENAI_API_KEY = agent.apiKey
    } else {
      // 自定义 / 其他:两个都给,最大兼容
      env.ANTHROPIC_API_KEY = agent.apiKey
      env.OPENAI_API_KEY = agent.apiKey
    }
  }
  if (agent.baseUrl) {
    if (p === 'anthropic') env.ANTHROPIC_BASE_URL = agent.baseUrl
    else if (p === 'openai') env.OPENAI_BASE_URL = agent.baseUrl
    else {
      env.ANTHROPIC_BASE_URL = agent.baseUrl
      env.OPENAI_BASE_URL = agent.baseUrl
    }
  }
  if (agent.model) {
    if (p === 'openai') env.OPENAI_MODEL = agent.model
    else if (p === 'anthropic') env.ANTHROPIC_MODEL = agent.model
    else {
      env.OPENAI_MODEL = agent.model
      env.ANTHROPIC_MODEL = agent.model
    }
  }
  return env
}

/** 内置 agent 预设,方便用户一键添加。 */
export const AGENT_PRESETS: Omit<AgentConfig, 'apiKey'>[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    provider: 'anthropic',
    command: 'claude',
    baseUrl: '',
    model: ''
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'openai',
    command: 'codex',
    baseUrl: '',
    model: ''
  }
]
