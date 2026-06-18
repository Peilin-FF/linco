import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import {
  agentCancel,
  agentSend,
  onAgentDone,
  onAgentEvent,
  StreamParser,
  type ChatMessage
} from '@/lib/agent'
import type { UnlistenFn } from '@tauri-apps/api/event'
import MessageBubble from './chat/MessageBubble'

export interface ChatHandle {
  send: (text: string) => void
}

interface ChatViewProps {
  /** 启动命令,如 claude / codex */
  commandBase?: string
  cwd?: string
  env?: Record<string, string>
  /** 权限模式:default / acceptEdits / bypassPermissions */
  permissionMode?: string
}

const CHAT_ID = 'main'
let msgSeq = 0
const nextId = (): string => `m${++msgSeq}`

const ChatView = forwardRef<ChatHandle, ChatViewProps>(function ChatView(
  { commandBase, cwd, env, permissionMode },
  ref
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 用 ref 持有最新配置,避免发送闭包用到旧值
  const cfgRef = useRef({ commandBase, cwd, env, permissionMode })
  cfgRef.current = { commandBase, cwd, env, permissionMode }

  const sessionIdRef = useRef('')
  const parserRef = useRef<StreamParser | null>(null)
  const unlistenRef = useRef<UnlistenFn[]>([])

  // 更新/插入一条消息(按 id)
  const upsert = (msg: ChatMessage): void => {
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === msg.id)
      if (i === -1) return [...prev, msg]
      const next = prev.slice()
      next[i] = msg
      return next
    })
  }

  useEffect(() => {
    const parser = new StreamParser(
      (msg) => upsert(msg),
      (text) => console.warn('[agent stderr]', text)
    )
    parserRef.current = parser

    let alive = true
    ;(async () => {
      const u1 = await onAgentEvent(CHAT_ID, (json) => {
        if (!alive) return
        parser.handle(json)
        if (parser.sessionId) sessionIdRef.current = parser.sessionId
      })
      const u2 = await onAgentDone(CHAT_ID, () => {
        if (!alive) return
        parser.finish()
        setBusy(false)
      })
      unlistenRef.current = [u1, u2]
    })()

    return () => {
      alive = false
      unlistenRef.current.forEach((u) => u())
      agentCancel(CHAT_ID)
    }
  }, [])

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)

    // 用户气泡
    upsert({
      id: nextId(),
      role: 'user',
      text: trimmed,
      tools: [],
      streaming: false
    })
    // 新助手气泡(流式)
    parserRef.current?.beginAssistant(nextId())

    const { commandBase, cwd, env, permissionMode } = cfgRef.current
    agentSend({
      id: CHAT_ID,
      prompt: trimmed,
      commandBase,
      cwd,
      env,
      sessionId: sessionIdRef.current || undefined,
      permissionMode
    }).catch((e) => {
      console.error('agentSend 失败', e)
      setBusy(false)
    })
  }

  useImperativeHandle(ref, () => ({ send }))

  return (
    <div className="flex h-full w-full flex-col rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[14px] text-ink-faint">
              在下方输入,开始与 Agent 对话
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[760px] flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

export default ChatView
