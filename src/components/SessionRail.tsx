import { MessagesSquare } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useI18n } from '@/lib/i18n'

// 会话状态:忙(有输出)/ 空闲(静默)/ 已结束(PTY 退出)
export type SessionStatus = 'busy' | 'idle' | 'exited'

// 侧栏需要的会话信息(App 的 ChatSession 子集 + 派生显示名)
export interface RailSession {
  id: string
  connId: string
  connName: string // 连接显示名(本地/集群名)
  project: string // 项目名(cwd basename)
  agentName: string
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
  const { t } = useI18n()
  const tabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])
  if (sessions.length === 0) return null
  return (
    <nav className="session-rail" aria-label={t('rail.sessions')}>
      <MessagesSquare size={13} className="shrink-0 text-ink-faint" aria-hidden="true" />
      <div ref={tabsRef} className="session-tabs">
        {sessions.map((s) => {
          const active = s.id === activeId
          return (
            <button
              key={s.id}
              onClick={() => onJump(s.id)}
              title={`${s.connName} · ${s.project} · ${s.agentName} · ${t(`workspace.session.${s.status}`)}`}
              aria-label={`${s.project}, ${s.agentName}, ${s.connName}, ${t(`workspace.session.${s.status}`)}`}
              aria-current={active ? 'true' : undefined}
              className={`session-tab ${active ? 'is-active' : ''}`}
            >
              {dot(s.status)}
              <span className="truncate">{s.project}</span>
              <span className="session-tab-agent">{s.agentName}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
