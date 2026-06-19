import { Activity, Check } from 'lucide-react'

// 会话状态:忙(有输出)/ 空闲(静默)/ 已结束(PTY 退出)
export type SessionStatus = 'busy' | 'idle' | 'exited'

// 侧栏需要的会话信息(App 的 ChatSession 子集 + 派生显示名)
export interface RailSession {
  id: string
  connId: string
  connName: string // 连接显示名(本地/集群名)
  project: string // 项目名(cwd basename)
  status: SessionStatus
}

interface Props {
  sessions: RailSession[]
  activeId: string
  onJump: (id: string) => void
}

function dot(status: SessionStatus): JSX.Element {
  if (status === 'busy') {
    // 忙:绿色脉冲点
    return (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
    )
  }
  if (status === 'exited') {
    // 已结束:空心灰点
    return <span className="h-2 w-2 shrink-0 rounded-full border border-ink-faint/50" />
  }
  // 空闲:实心灰点
  return <span className="h-2 w-2 shrink-0 rounded-full bg-ink-faint/40" />
}

/// 会话总览侧栏:列出 app 内所有 code agent 对话会话(各机器×项目),
/// 标忙/空闲/已结束,点击直达。放在对话框右侧空白区。
export default function SessionRail({
  sessions,
  activeId,
  onJump
}: Props): JSX.Element | null {
  if (sessions.length === 0) return null
  // 忙的排前面,方便一眼看到"谁在跑/谁停了"
  const order = { busy: 0, idle: 1, exited: 2 }
  const sorted = [...sessions].sort((a, b) => order[a.status] - order[b.status])

  return (
    <div className="flex h-full flex-col px-1.5 py-1.5">
      <div className="flex shrink-0 items-center gap-1 px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
        <Activity size={11} />
        会话
      </div>
      {/* 列表区:一屏约 3 张卡片(每张含 max-height),超出上下滚动 */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5">
        {sorted.map((s) => {
          const active = s.id === activeId
          return (
            <button
              key={s.id}
              onClick={() => onJump(s.id)}
              title={`${s.connName} · ${s.project}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors ${
                active
                  ? 'bg-sidebar text-ink ring-1 ring-black/10'
                  : 'text-ink-muted hover:bg-black/5'
              }`}
            >
              {dot(s.status)}
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate font-medium text-ink">
                  {s.project}
                </span>
                <span className="block truncate text-[10px] text-ink-faint">
                  {s.connName}
                </span>
              </span>
              {s.status === 'exited' && (
                <Check size={11} className="shrink-0 text-ink-faint/60" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
