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
  /** 可选模型列表(同一供应商多个模型,聊天框切换);空则只用 model */
  models: string[]
  /** 权限模式(随 provider 取值) */
  permission: string
  /** 思考力/推理预算 */
  effort: string
  /** 登录方式:''/'api'=注入 API Key;'subscription'=用 CLI 订阅登录(不注入 key) */
  authMode: string
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
  /** 开发语言偏好:''=未选(首启询问)/ 'zh' / 'en' */
  language?: string
  /** 已安装的插件 agent:''=未选 / 'claude' / 'codex'。决定装哪套插件。 */
  pluginAgent?: string
  /** 界面主题 id(见 lib/theme.ts);空=github-light */
  theme?: string
  /** 界面字体 CSS font-family;空=系统默认 */
  uiFont?: string
  /** 界面字号 px;0/缺省=14 */
  uiFontSize?: number
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
  models?: string[]
  permission?: string
  effort?: string
  auth_mode?: string
}
interface RawConfig {
  agents: RawAgent[]
  default_agent: string
  auto_start: boolean
  cwd: string
  recent_dirs: string[]
  connections: Connection[]
  active_connection: string
  language: string
  plugin_agent?: string
  theme?: string
  ui_font?: string
  ui_font_size?: number
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
      model: a.model ?? '',
      models: a.models ?? [],
      permission: a.permission ?? '',
      effort: a.effort ?? '',
      authMode: a.auth_mode ?? ''
    })),
    defaultAgent: raw.default_agent ?? '',
    autoStart: raw.auto_start ?? true,
    cwd: raw.cwd ?? '',
    recentDirs: raw.recent_dirs ?? [],
    connections: raw.connections ?? [],
    activeConnection: raw.active_connection ?? '',
    language: raw.language ?? '',
    pluginAgent: raw.plugin_agent ?? '',
    theme: raw.theme ?? '',
    uiFont: raw.ui_font ?? '',
    uiFontSize: raw.ui_font_size ?? 0
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
      model: a.model,
      models: a.models ?? [],
      permission: a.permission ?? '',
      effort: a.effort ?? '',
      auth_mode: a.authMode ?? ''
    })),
    default_agent: cfg.defaultAgent,
    auto_start: cfg.autoStart,
    cwd: cfg.cwd,
    recent_dirs: cfg.recentDirs,
    connections: cfg.connections,
    active_connection: cfg.activeConnection,
    language: cfg.language ?? '',
    plugin_agent: cfg.pluginAgent ?? '',
    theme: cfg.theme ?? '',
    ui_font: cfg.uiFont ?? '',
    ui_font_size: cfg.uiFontSize ?? 0
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const raw = await invoke<RawConfig>('load_config')
  return fromRaw(raw)
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await invoke('save_config', { config: toRaw(cfg) })
}

/** 首启选定 agent + 开发语言:写回 config + 装对应那套(claude→~/.claude/plugins,codex→~/.codex)。 */
export async function setLanguage(agent: 'claude' | 'codex', lang: 'zh' | 'en'): Promise<void> {
  await invoke('set_language', { agent, lang })
}

/** 给某远程主机安装当前语言的插件(连接成功后调,失败可忽略)。 */
export async function installRemotePlugins(host: string): Promise<void> {
  await invoke('install_remote_plugins', { host })
}

/** 把本地配置(含明文 API Key)整份上传到远程 ~/.linco/config.json。
 *  仅在用户明确信任该服务器时调用。 */
export async function syncConfigToRemote(host: string): Promise<void> {
  await invoke('sync_config_to_remote', { host })
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

// —— provider 能力表:权限/思考力的可选项随 provider 不同 ——
export interface CapOption {
  value: string
  label: string
}
export interface ProviderCaps {
  permissions: CapOption[]
  efforts: CapOption[]
  /** 是否支持订阅登录(CLI 自身 OAuth) */
  hasSubscription: boolean
  /** 订阅登录命令(在终端里跑) */
  loginCmd: string
}

function isCodexProvider(provider: string, command?: string): boolean {
  const head = (command ? commandHead(command).split('/').pop() : '') ?? ''
  return provider === 'openai' || head === 'codex'
}

/** 取某 agent 的能力:权限模式 / 思考力 选项 + 订阅登录信息。
 *  label 原样用 CLI 取值(不翻译),空值显示为 default。 */
export function providerCaps(agent: AgentConfig): ProviderCaps {
  if (isCodexProvider(agent.provider, agent.command)) {
    return {
      permissions: [
        { value: '', label: 'default' },
        { value: 'full-auto', label: 'full-auto' },
        { value: 'bypass', label: 'bypass' }
      ],
      efforts: [
        { value: '', label: 'default' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' }
      ],
      hasSubscription: true,
      loginCmd: 'codex login'
    }
  }
  // claude / anthropic / 其它默认按 claude
  return {
    permissions: [
      { value: '', label: 'default' },
      { value: 'acceptEdits', label: 'acceptEdits' },
      { value: 'plan', label: 'plan' },
      { value: 'bypassPermissions', label: 'bypassPermissions' }
    ],
    efforts: [
      { value: '', label: 'default' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' }
    ],
    hasSubscription: true,
    loginCmd: 'claude auth login'
  }
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

  // 权限模式:控制是否反复询问。codex 与 claude 取值/flag 不同。
  const perm = agent.permission.trim()
  if (perm) {
    if (isCodex) {
      if (perm === 'full-auto' && !hasFlag(cmd, '--full-auto', '--full-auto')) {
        cmd += ' --full-auto'
      } else if (
        perm === 'bypass' &&
        !cmd.includes('--dangerously-bypass-approvals-and-sandbox')
      ) {
        cmd += ' --dangerously-bypass-approvals-and-sandbox'
      }
    } else if (
      perm !== 'default' &&
      !hasFlag(cmd, '--permission-mode', '--permission-mode')
    ) {
      cmd += ` --permission-mode ${shellQuote(perm)}`
    }
  }

  // 思考力/推理预算。claude: --effort;codex: -c model_reasoning_effort="..."
  const effort = agent.effort.trim()
  if (effort) {
    if (isCodex) {
      if (!cmd.includes('model_reasoning_effort')) {
        cmd += codexConfigArg('model_reasoning_effort', effort)
      }
    } else if (!hasFlag(cmd, '--effort', '--effort')) {
      cmd += ` --effort ${shellQuote(effort)}`
    }
  }
  return cmd
}

/** 把 agent 配置展开成注入终端的环境变量。 */
export function agentEnv(agent: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {}
  const p = agent.provider
  // 订阅登录:不注入 API Key,让 CLI 走自己的订阅凭据(~/.claude、~/.codex)。
  // ANTHROPIC_API_KEY/OPENAI_API_KEY 一旦设置会盖过订阅,所以这里整段跳过。
  if (agent.authMode !== 'subscription' && agent.apiKey) {
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
    model: '',
    models: [],
    permission: '',
    effort: '',
    authMode: ''
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'openai',
    command: 'codex',
    baseUrl: '',
    model: '',
    models: [],
    permission: '',
    effort: '',
    authMode: ''
  }
]
