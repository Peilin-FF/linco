import { useState } from 'react'
import { ChevronRight, Wrench } from 'lucide-react'
import type { ToolCall } from '@/lib/agent'

// 工具参数的一行摘要(尽量取最有信息的字段)
function summarize(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    const key =
      o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url
    if (typeof key === 'string') return key
    try {
      return JSON.stringify(o)
    } catch {
      return ''
    }
  }
  return String(input)
}

export default function ToolCallCard({ tool }: { tool: ToolCall }): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = summarize(tool.input)

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-black/8 bg-sidebar text-[13px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/[0.03]"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-ink-faint transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        />
        <Wrench size={13} className="shrink-0 text-ink-muted" />
        <span className="font-medium text-ink">{tool.name}</span>
        {summary && (
          <span className="truncate font-mono text-[12px] text-ink-faint">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-black/8 bg-canvas px-3 py-2 font-mono text-[12px] text-ink-muted">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
      )}
    </div>
  )
}
