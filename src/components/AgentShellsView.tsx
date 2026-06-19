import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Terminal as TerminalIcon } from 'lucide-react'
import { agentProcesses, type ProcInfo } from '@/lib/procs'

interface Props {
  host?: string
  cwd?: string
  // agent 命令名(claude/codex),用于在进程树里定位 agent 根进程
  commandBase?: string
  // 仅当该面板真正可见时才轮询(终端视图 + 选中本标签)
  active: boolean
}

const POLL_MS = 2500

// 把 ps 的 STAT 首字母翻译成人话(只取主状态位)
function stateLabel(stat: string): string {
  switch (stat.charAt(0)) {
    case 'R':
      return '运行'
    case 'S':
      return '睡眠'
    case 'D':
      return '不可中断'
    case 'T':
      return '停止'
    case 'Z':
      return '僵尸'
    case 'I':
      return '空闲'
    default:
      return stat || '—'
  }
}

/// 后台进程面板:列出 code agent 在后台起的 shell/子进程,把盲盒变透明。
/// 只读监控(不杀进程);仅面板可见时轮询,切连接/隐藏即停。
export default function AgentShellsView({
  host,
  cwd,
  commandBase,
  active
}: Props): JSX.Element {
  const [procs, setProcs] = useState<ProcInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 首次加载完成标记:用于区分「还没拉过」与「拉过但是空」
  const [loaded, setLoaded] = useState(false)
  const seq = useRef(0)

  const poll = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const list = await agentProcesses(host, cwd, commandBase)
      if (my !== seq.current) return // 已被更新的轮询取代
      setProcs(list)
      setErr(null)
    } catch (e) {
      if (my !== seq.current) return
      setErr(String(e))
    } finally {
      if (my === seq.current) {
        setLoading(false)
        setLoaded(true)
      }
    }
  }, [host, cwd, commandBase])

  // 切连接/工作目录:清空重来
  useEffect(() => {
    setProcs([])
    setLoaded(false)
    setErr(null)
  }, [host, cwd, commandBase])

  // 仅可见时轮询;隐藏/卸载即停
  useEffect(() => {
    if (!active) return
    void poll()
    const t = window.setInterval(() => void poll(), POLL_MS)
    return () => window.clearInterval(t)
  }, [active, poll])

  return (
    <div className="flex h-full flex-col">
      {/* 顶部状态条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[12px] text-ink-muted">
        <TerminalIcon size={13} />
        <span>
          agent 后台进程
          {commandBase ? ` · ${commandBase.split('/').pop()}` : ''}
        </span>
        <span className="ml-1 text-ink-faint">{procs.length} 个</span>
        <button
          onClick={() => void poll()}
          className="ml-auto rounded p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
          title="刷新"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {err ? (
          <div className="px-3 py-4 text-[12px] text-red-500/80">{err}</div>
        ) : procs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-[13px] text-ink-faint">
            <span>{loaded ? 'agent 暂无后台进程' : '加载中…'}</span>
            {loaded && (
              <span className="text-[11px]">
                agent 起的后台 shell/子进程会实时显示在这里
              </span>
            )}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-canvas text-ink-faint">
              <tr className="border-b border-black/8 text-left">
                <th className="px-3 py-1.5 font-medium">命令</th>
                <th className="px-2 py-1.5 font-medium">PID</th>
                <th className="px-2 py-1.5 font-medium">时长</th>
                <th className="px-2 py-1.5 font-medium">CPU</th>
                <th className="px-2 py-1.5 font-medium">内存</th>
                <th className="px-3 py-1.5 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {procs.map((p) => (
                <tr
                  key={p.pid}
                  className="border-b border-black/[0.04] hover:bg-black/[0.03]"
                >
                  <td
                    className="max-w-0 truncate px-3 py-1.5 font-mono text-ink"
                    title={p.args}
                  >
                    {p.args}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-ink-muted">{p.pid}</td>
                  <td className="px-2 py-1.5 text-ink-muted">{p.etime}</td>
                  <td className="px-2 py-1.5 text-ink-muted">{p.pcpu}%</td>
                  <td className="px-2 py-1.5 text-ink-muted">{p.pmem}%</td>
                  <td className="px-3 py-1.5 text-ink-muted" title={p.stat}>
                    {stateLabel(p.stat)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
