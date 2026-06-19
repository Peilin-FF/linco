import { useEffect, useRef, useState } from 'react'
import { tailFile } from '@/lib/procs'

interface Props {
  // 输出文件路径(agent 后台任务的 stdout 落盘文件)
  file: string
  host?: string
  // 仅可见时轮询(tab 选中)
  active: boolean
  // 任务已退出(进程不在了)——仍展示最后的 log,顶部标注
  exited?: boolean
}

const TAIL_MS = 1000

/// agent 后台任务的实时输出面板:每秒增量 tail 输出文件,append 到滚动区域。
/// 这就是"看 claude 后台训练在打什么 log"——只读,贴底自动跟随。
export default function AgentTaskOutput({
  file,
  host,
  active,
  exited
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLPreElement>(null)
  const atBottomRef = useRef(true)

  // 切换文件:重置
  useEffect(() => {
    setText('')
    offsetRef.current = 0
  }, [file, host])

  // 增量 tail
  useEffect(() => {
    if (!active || !file) return
    let stop = false
    const pull = async (): Promise<void> => {
      try {
        const chunk = await tailFile(file, offsetRef.current, host)
        if (stop) return
        if (chunk.data) {
          const el = boxRef.current
          atBottomRef.current = el
            ? el.scrollHeight - el.scrollTop - el.clientHeight < 40
            : true
          setText((prev) => {
            const next = prev + chunk.data
            return next.length > 400_000 ? next.slice(next.length - 400_000) : next
          })
        }
        offsetRef.current = chunk.size
      } catch {
        // 文件暂不可读:静默重试
      }
    }
    void pull()
    const t = window.setInterval(() => void pull(), TAIL_MS)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [file, host, active])

  // 新内容到达且之前贴底 → 自动滚到底
  useEffect(() => {
    if (atBottomRef.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [text])

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e]">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1 text-[11px] text-white/50">
        <span className="truncate font-mono" title={file}>
          {file}
        </span>
        {exited && <span className="ml-auto text-amber-400/80">已结束</span>}
      </div>
      <pre
        ref={boxRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.4] text-[#d4d4d4]"
      >
        {text || '(暂无输出)'}
      </pre>
    </div>
  )
}
