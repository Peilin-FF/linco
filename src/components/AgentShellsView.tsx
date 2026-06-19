import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Terminal as TerminalIcon, X, FileText } from 'lucide-react'
import {
  agentProcesses,
  procOutputFile,
  tailFile,
  type ProcInfo
} from '@/lib/procs'

interface Props {
  host?: string
  cwd?: string
  // agent 命令名(claude/codex),用于在进程树里定位 agent 根进程
  commandBase?: string
  // 仅当该面板真正可见时才轮询(终端视图 + 选中本标签)
  active: boolean
}

const POLL_MS = 2500 // 进程列表刷新
const TAIL_MS = 1000 // 输出实时滚动刷新

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

// 取命令的简短展示名(给输出面板标题用)
function shortCmd(args: string): string {
  return args.length > 60 ? args.slice(0, 60) + '…' : args
}

/// 后台进程面板:列出 code agent 在后台起的 shell/子进程,点开看实时输出。
/// 输出来源 = 进程 fd1 指向的文件(agent 起后台进程时 stdout 被重定向到文件),
/// 实时 tail 它 → 把"claude 后台训练在打什么 log"从盲盒里暴露出来。只读监控。
export default function AgentShellsView({
  host,
  cwd,
  commandBase,
  active
}: Props): JSX.Element {
  const [procs, setProcs] = useState<ProcInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const seq = useRef(0)

  // 当前查看输出的进程(null=只看列表)
  const [viewPid, setViewPid] = useState<number | null>(null)

  const poll = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const list = await agentProcesses(host, cwd, commandBase)
      if (my !== seq.current) return
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
    setViewPid(null)
  }, [host, cwd, commandBase])

  // 仅可见时轮询列表;隐藏/卸载即停
  useEffect(() => {
    if (!active) return
    void poll()
    const t = window.setInterval(() => void poll(), POLL_MS)
    return () => window.clearInterval(t)
  }, [active, poll])

  const viewProc = procs.find((p) => p.pid === viewPid) || null

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

      {/* 列表(上) + 输出面板(下,选中进程时出现) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={`min-h-0 overflow-auto ${viewPid != null ? 'h-2/5 shrink-0 border-b border-black/8' : 'flex-1'}`}
        >
          {err ? (
            <div className="px-3 py-4 text-[12px] text-red-500/80">{err}</div>
          ) : procs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-[13px] text-ink-faint">
              <span>{loaded ? 'agent 暂无后台进程' : '加载中…'}</span>
              {loaded && (
                <span className="text-[11px]">
                  agent 起的后台 shell/子进程会实时显示在这里,点一行看它的实时输出
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
                    onClick={() => setViewPid(p.pid)}
                    className={`cursor-pointer border-b border-black/[0.04] hover:bg-black/[0.05] ${
                      p.pid === viewPid ? 'bg-[#5c8bd6]/15' : ''
                    }`}
                    title="点击查看实时输出"
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

        {viewPid != null && (
          <OutputPane
            key={viewPid}
            pid={viewPid}
            title={viewProc ? shortCmd(viewProc.args) : `PID ${viewPid}`}
            exited={loaded && !viewProc}
            host={host}
            active={active}
            onClose={() => setViewPid(null)}
          />
        )}
      </div>
    </div>
  )
}

// —— 单个进程的实时输出面板 ——
// 先解析进程 fd1 的输出文件,再每 TAIL_MS 增量 tail 它,append 到滚动区域。
function OutputPane({
  pid,
  title,
  exited,
  host,
  active,
  onClose
}: {
  pid: number
  title: string
  exited: boolean
  host?: string
  active: boolean
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [file, setFile] = useState<string | null>(null)
  const [status, setStatus] = useState<'resolving' | 'ok' | 'none'>('resolving')
  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLPreElement>(null)
  const atBottomRef = useRef(true)

  // 解析输出文件(fd1,缺则 fd2)
  useEffect(() => {
    let cancelled = false
    setStatus('resolving')
    setText('')
    offsetRef.current = 0
    procOutputFile(pid, host)
      .then((o) => {
        if (cancelled) return
        const f = o.fd1 || o.fd2
        if (f) {
          setFile(f)
          setStatus('ok')
        } else {
          setStatus('none')
        }
      })
      .catch(() => !cancelled && setStatus('none'))
    return () => {
      cancelled = true
    }
  }, [pid, host])

  // 增量 tail:每 TAIL_MS 拉新增内容
  useEffect(() => {
    if (status !== 'ok' || !file || !active) return
    let stop = false
    const pull = async (): Promise<void> => {
      try {
        const chunk = await tailFile(file, offsetRef.current, host)
        if (stop) return
        if (chunk.data) {
          // 记录是否贴底(贴底才自动滚,用户上滚查看时不打断)
          const el = boxRef.current
          atBottomRef.current = el
            ? el.scrollHeight - el.scrollTop - el.clientHeight < 40
            : true
          setText((prev) => {
            const next = prev + chunk.data
            // 防爆:只保留尾部 ~200KB
            return next.length > 200_000 ? next.slice(next.length - 200_000) : next
          })
        }
        offsetRef.current = chunk.size
      } catch {
        // 文件暂不可读(进程刚退出等):静默,下次再试
      }
    }
    void pull()
    const t = window.setInterval(() => void pull(), TAIL_MS)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [status, file, host, active])

  // 新内容到达且之前贴底 → 自动滚到底
  useEffect(() => {
    if (atBottomRef.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [text])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e1e]">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1 text-[11px] text-white/70">
        <FileText size={12} />
        <span className="truncate font-mono" title={file || title}>
          {title}
        </span>
        {exited && <span className="text-amber-400/80">(已退出)</span>}
        <button
          onClick={onClose}
          className="ml-auto rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
          title="关闭输出"
        >
          <X size={13} />
        </button>
      </div>
      {status === 'none' ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12px] text-white/40">
          输出未落盘,无法实时查看
          <br />
          (该进程的 stdout 未重定向到文件)
        </div>
      ) : (
        <pre
          ref={boxRef}
          className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.4] text-[#d4d4d4]"
        >
          {status === 'resolving' ? '解析输出位置…' : text || '(暂无输出)'}
        </pre>
      )}
    </div>
  )
}
