import { useEffect, useRef, useState } from 'react'
import { tailFile } from '@/lib/procs'
import { proxyCmdlogFile, type CmdEntry } from '@/lib/agentProxy'
import { useI18n } from '@/lib/i18n'

interface Props {
  // 会话标识(每会话一份命令日志)
  session: string
  host?: string
  // 仅可见时轮询
  active: boolean
}

const TAIL_MS = 1000

/// 「Agent 命令」面板:展示当前会话里 agent 执行的每条 bash 命令 + 它得到的结果
/// (模型真正"看到了什么")。数据来自私有代理旁路写的 JSONL,经 tailFile 增量读
/// (本地/远程同一通道)。同一回合的多条命令**顺序汇总在这一个面板**,不再每命令开一个 tab。
export default function AgentCommandLog({ session, host, active }: Props): JSX.Element {
  const { t } = useI18n()
  const [entries, setEntries] = useState<CmdEntry[]>([])
  const [file, setFile] = useState('')
  const offsetRef = useRef(0)
  const bufRef = useRef('') // 不完整行的残余,跨次拼接
  const scrollRef = useRef<HTMLDivElement>(null)

  // 解析 session → 日志文件路径
  useEffect(() => {
    let alive = true
    proxyCmdlogFile(session)
      .then((p) => {
        if (alive) setFile(p)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [session])

  // 切文件:重置
  useEffect(() => {
    offsetRef.current = 0
    bufRef.current = ''
    setEntries([])
  }, [file, host])

  // 新回合(用户发消息派发 linco:turn-refresh):清空面板,只看当前回合的命令。
  // 后端已截断 JSONL 文件,这里把 offset 归零、清空已渲染条目,与文件同步。
  useEffect(() => {
    const onTurn = (): void => {
      offsetRef.current = 0
      bufRef.current = ''
      setEntries([])
    }
    window.addEventListener('linco:turn-refresh', onTurn)
    return () => window.removeEventListener('linco:turn-refresh', onTurn)
  }, [])

  // 增量 tail JSONL → 逐行解析为 CmdEntry 追加
  useEffect(() => {
    if (!active || !file) return
    let stop = false
    const pull = async (): Promise<void> => {
      try {
        const chunk = await tailFile(file, offsetRef.current, host)
        if (stop) return
        offsetRef.current = chunk.size
        if (!chunk.data) return
        bufRef.current += chunk.data
        const parts = bufRef.current.split('\n')
        bufRef.current = parts.pop() ?? '' // 最后一段可能不完整,留到下次
        const fresh: CmdEntry[] = []
        for (const line of parts) {
          const s = line.trim()
          if (!s) continue
          try {
            fresh.push(JSON.parse(s) as CmdEntry)
          } catch {
            /* 跳过坏行 */
          }
        }
        if (fresh.length) setEntries((prev) => [...prev, ...fresh])
      } catch {
        /* 文件暂不可读(还没产生)：静默重试 */
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), TAIL_MS)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [file, host, active])

  // 新内容到达滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1 text-[11px] text-ink-faint">
        <span className="font-mono">{t('cmdlog.title')}</span>
        <span className="ml-auto">{entries.length}</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-2 py-2 font-mono text-[12px]">
        {entries.length === 0 ? (
          <div className="px-2 py-4 text-ink-faint">{t('cmdlog.empty')}</div>
        ) : (
          entries.map((e) => (
            <div key={e.tool_use_id} className="mb-3">
              {/* 命令行:$ + 命令(非 Bash 工具显示工具名) */}
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 text-accent">
                  {e.tool === 'Bash' ? '$' : `[${e.tool}]`}
                </span>
                <span className="whitespace-pre-wrap break-all text-ink">
                  {e.command}
                </span>
              </div>
              {e.description && (
                <div className="pl-4 text-[11px] text-ink-faint">{e.description}</div>
              )}
              {/* 输出:模型看到的结果 */}
              {e.output && (
                <pre
                  className={`mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded px-3 py-2 text-[11.5px] leading-relaxed ${
                    e.is_error
                      ? 'bg-red-950/40 text-red-300'
                      : 'bg-sidebar text-ink-muted'
                  }`}
                >
                  {e.output}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
