import type { ChatMessage } from '@/lib/agent'
import Markdown from './Markdown'
import ToolCallCard from './ToolCallCard'

export default function MessageBubble({
  msg
}: {
  msg: ChatMessage
}): JSX.Element {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-ink px-4 py-2.5 text-[14px] leading-relaxed text-canvas">
          {msg.text}
        </div>
      </div>
    )
  }

  // assistant
  return (
    <div className="flex flex-col gap-1">
      {msg.tools.map((t) => (
        <ToolCallCard key={t.id} tool={t} />
      ))}
      {(msg.text || msg.streaming) && (
        <div className="max-w-full">
          <Markdown text={msg.text} />
          {msg.streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-ink align-middle" />
          )}
        </div>
      )}
    </div>
  )
}
