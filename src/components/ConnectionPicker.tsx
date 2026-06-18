import { useEffect, useRef, useState } from 'react'
import {
  Monitor,
  Server,
  ChevronDown,
  Plus,
  Check,
  Loader2,
  TerminalSquare
} from 'lucide-react'
import type { Connection } from '@/lib/connection'

export type ConnState = 'idle' | 'connecting' | 'connected' | 'error'

interface ConnectionPickerProps {
  connections: Connection[]
  activeId: string // '' = 本地
  state: ConnState
  sshHosts: string[] // ~/.ssh/config 里的 Host
  onSelectLocal: () => void
  onSelectConnection: (id: string) => void
  onQuickConnect: (host: string) => void // 从 ssh config host 一键连
  onManage: () => void
  /** 输入 ssh 指令添加连接;返回错误信息或 null */
  onAddSshCommand: (cmd: string) => Promise<string | null>
}

export default function ConnectionPicker({
  connections,
  activeId,
  state,
  sshHosts,
  onSelectLocal,
  onSelectConnection,
  onQuickConnect,
  onManage,
  onAddSshCommand
}: ConnectionPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [sshInput, setSshInput] = useState('')
  const [sshErr, setSshErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const submitSsh = async (): Promise<void> => {
    const cmd = sshInput.trim()
    if (!cmd || adding) return
    setAdding(true)
    setSshErr(null)
    const err = await onAddSshCommand(cmd)
    setAdding(false)
    if (err) {
      setSshErr(err)
    } else {
      setSshInput('')
      setOpen(false)
    }
  }

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const active = connections.find((c) => c.id === activeId)
  const isLocal = !activeId
  const label = isLocal ? '本地' : active?.name || active?.host || '远程'

  // 已存连接已用过的 host,避免在“快速连接”里重复列
  const savedHosts = new Set(connections.map((c) => c.host))
  const quickHosts = sshHosts.filter((h) => !savedHosts.has(h)).slice(0, 30)

  const dot =
    state === 'connected'
      ? 'bg-[#27894e]'
      : state === 'connecting'
        ? 'bg-[#b8860b]'
        : state === 'error'
          ? 'bg-[#cf222e]'
          : 'bg-ink-faint'

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-ink-muted hover:bg-black/5 hover:text-ink"
        title="切换连接"
      >
        {isLocal ? (
          <Monitor size={14} />
        ) : state === 'connecting' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Server size={14} />
        )}
        <span className="max-w-[140px] truncate">{label}</span>
        {!isLocal && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
        <ChevronDown size={13} className="text-ink-faint" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-[460px] min-w-[300px] overflow-auto rounded-xl bg-canvas py-1 shadow-card ring-1 ring-black/10">
          {/* 灵动岛:输入 ssh 指令添加连接 */}
          <div className="px-2 pb-1.5 pt-1">
            <div
              className={`flex items-center gap-1.5 rounded-lg border bg-sidebar px-2 py-1.5 transition-colors ${
                sshErr ? 'border-[#cf222e]/50' : 'border-black/10 focus-within:border-[#5c8bd6]'
              }`}
            >
              {adding ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-ink-faint" />
              ) : (
                <TerminalSquare size={13} className="shrink-0 text-ink-faint" />
              )}
              <input
                value={sshInput}
                onChange={(e) => {
                  setSshInput(e.target.value)
                  setSshErr(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitSsh()
                }}
                placeholder="ssh root@1.2.3.4 -p 22"
                className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
              />
              {sshInput.trim() && (
                <button
                  onClick={() => void submitSsh()}
                  className="shrink-0 rounded-md bg-ink px-2 py-0.5 text-[11px] text-canvas hover:opacity-90"
                >
                  添加
                </button>
              )}
            </div>
            {sshErr && (
              <div className="mt-1 px-1 text-[11px] text-[#cf222e]">{sshErr}</div>
            )}
          </div>
          <div className="my-1 h-px bg-black/8" />

          {/* 本地 */}
          <button
            onClick={() => {
              onSelectLocal()
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-black/5"
          >
            <Monitor size={14} className="text-ink-muted" />
            <span className="flex-1">本地</span>
            {isLocal && <Check size={13} className="text-[#2f6fd0]" />}
          </button>

          {/* 已保存连接 */}
          {connections.length > 0 && (
            <>
              <div className="my-1 h-px bg-black/8" />
              <div className="px-3 py-0.5 text-[11px] text-ink-faint">连接</div>
              {connections.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onSelectConnection(c.id)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-black/5"
                >
                  <Server size={14} className="text-ink-muted" />
                  <span className="flex-1 truncate">
                    {c.name || c.host}
                    <span className="ml-1 text-[11px] text-ink-faint">
                      {c.host}
                    </span>
                  </span>
                  {c.id === activeId && (
                    <Check size={13} className="text-[#2f6fd0]" />
                  )}
                </button>
              ))}
            </>
          )}

          {/* ~/.ssh/config 快速连接 */}
          {quickHosts.length > 0 && (
            <>
              <div className="my-1 h-px bg-black/8" />
              <div className="px-3 py-0.5 text-[11px] text-ink-faint">
                ~/.ssh/config
              </div>
              {quickHosts.map((h) => (
                <button
                  key={h}
                  onClick={() => {
                    onQuickConnect(h)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink-muted hover:bg-black/5"
                >
                  <Server size={14} className="text-ink-faint" />
                  <span className="flex-1 truncate">{h}</span>
                </button>
              ))}
            </>
          )}

          <div className="my-1 h-px bg-black/8" />
          <button
            onClick={() => {
              onManage()
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink-muted hover:bg-black/5"
          >
            <Plus size={14} />
            管理连接…
          </button>
        </div>
      )}
    </div>
  )
}
