import { useEffect, useState } from 'react'
import { Plus, Trash2, Server, FolderInput } from 'lucide-react'
import type { AppConfig } from '@/lib/config'
import { sshConfigHosts, type Connection } from '@/lib/connection'

interface ConnectionsProps {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

let cseq = 0
const newId = (): string => `conn-${Date.now()}-${++cseq}`

export default function Connections({
  config,
  onChange
}: ConnectionsProps): JSX.Element {
  const [hosts, setHosts] = useState<string[]>([])
  const [selId, setSelId] = useState(config.connections[0]?.id ?? '')

  useEffect(() => {
    sshConfigHosts().then(setHosts).catch(() => {})
  }, [])

  const selected = config.connections.find((c) => c.id === selId)

  const update = (id: string, patch: Partial<Connection>): void => {
    onChange({
      ...config,
      connections: config.connections.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      )
    })
  }

  const add = (host = ''): void => {
    const conn: Connection = {
      id: newId(),
      name: host || '新连接',
      host,
      cwd: '',
      identity: ''
    }
    onChange({ ...config, connections: [...config.connections, conn] })
    setSelId(conn.id)
  }

  const remove = (id: string): void => {
    const connections = config.connections.filter((c) => c.id !== id)
    onChange({
      ...config,
      connections,
      activeConnection:
        config.activeConnection === id ? '' : config.activeConnection
    })
    if (selId === id) setSelId(connections[0]?.id ?? '')
  }

  const inputCls =
    'w-full rounded-lg border border-black/10 bg-canvas px-3 py-2 text-[14px] text-ink outline-none focus:border-black/25'

  return (
    <div className="mx-auto max-w-[720px]">
      <h2 className="text-[20px] font-semibold text-ink">连接</h2>
      <p className="mt-1.5 text-[13px] text-ink-faint">
        配置远程开发服务器(SSH)。切到某连接后,终端 / 对话 / 文件 / Git
        都运行在该服务器上 —— agent 真正进入远程环境。
      </p>

      {/* 从 ~/.ssh/config 快速添加 */}
      {hosts.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[13px] font-medium text-ink-muted">
            从 ~/.ssh/config 添加
          </div>
          <div className="flex flex-wrap gap-2">
            {hosts.slice(0, 40).map((h) => (
              <button
                key={h}
                onClick={() => add(h)}
                className="flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-1.5 text-[13px] text-ink hover:bg-black/5"
              >
                <Plus size={13} />
                {h}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={() => add()}
        className="mt-3 flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-1.5 text-[13px] text-ink hover:bg-black/5"
      >
        <Plus size={14} />
        手动添加连接
      </button>

      {/* 已配置连接列表 */}
      {config.connections.length > 0 && (
        <div className="mt-6 flex flex-col gap-1">
          {config.connections.map((c) => (
            <div
              key={c.id}
              className={`flex items-center gap-2 rounded-xl px-3 py-2 ${
                c.id === selId ? 'bg-sidebar' : 'hover:bg-black/5'
              }`}
            >
              <button
                onClick={() => setSelId(c.id)}
                className="flex flex-1 items-center gap-2 text-left"
              >
                <Server size={14} className="text-ink-muted" />
                <span className="text-[14px] text-ink">{c.name || c.host}</span>
                <span className="text-[12px] text-ink-faint">{c.host}</span>
              </button>
              <button
                onClick={() => remove(c.id)}
                className="rounded-md p-1 text-ink-faint hover:text-[#cf222e]"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 编辑选中连接 */}
      {selected && (
        <div className="mt-6 rounded-2xl bg-sidebar p-5">
          <div className="mb-4 text-[14px] font-medium text-ink">
            编辑「{selected.name || selected.host}」
          </div>
          <div className="flex flex-col gap-4">
            <Field label="名称">
              <input
                value={selected.name}
                onChange={(e) => update(selected.id, { name: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field
              label="主机"
              hint="user@ip 或 ~/.ssh/config 别名(如 shouyun_1)"
            >
              <input
                value={selected.host}
                onChange={(e) => update(selected.id, { host: e.target.value })}
                placeholder="root@10.0.0.1"
                className={`${inputCls} font-mono`}
              />
            </Field>
            <Field
              label="远程工作目录"
              hint="切到该连接后默认进入的目录,如 /root/project"
            >
              <div className="flex items-center gap-2">
                <FolderInput size={15} className="shrink-0 text-ink-faint" />
                <input
                  value={selected.cwd}
                  onChange={(e) => update(selected.id, { cwd: e.target.value })}
                  placeholder="/root/project"
                  className={`${inputCls} font-mono`}
                />
              </div>
            </Field>
            <Field label="私钥路径" hint="可选。留空用默认 key / ssh-agent / 密码">
              <input
                value={selected.identity}
                onChange={(e) =>
                  update(selected.id, { identity: e.target.value })
                }
                placeholder="~/.ssh/id_ed25519"
                className={`${inputCls} font-mono`}
              />
            </Field>
            <p className="text-[12px] text-ink-faint">
              需要密码或动态令牌的连接:切换到该连接后会自动进入终端,在终端里输入一次即可建立连接,之后各视图复用。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

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
