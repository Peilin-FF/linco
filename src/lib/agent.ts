// Agent 对话的前端绑定 + stream-json 解析。
//
// 后端按行 emit "agent-event"(每行一个 claude stream-json),进程结束 emit "agent-done"。
// 这里把原始 JSON 行解析成 UI 消息模型,供 ChatView 渲染。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface SendOptions {
  id: string
  prompt: string
  commandBase?: string
  cwd?: string
  env?: Record<string, string>
  sessionId?: string
  permissionMode?: string
}

export function agentSend(opts: SendOptions): Promise<void> {
  return invoke('agent_send', {
    id: opts.id,
    prompt: opts.prompt,
    commandBase: opts.commandBase,
    cwd: opts.cwd,
    env: opts.env,
    sessionId: opts.sessionId,
    permissionMode: opts.permissionMode
  })
}

export function agentCancel(id: string): Promise<void> {
  return invoke('agent_cancel', { id })
}

interface RawAgentEvent {
  id: string
  line: string
}

export function onAgentEvent(
  id: string,
  cb: (json: any) => void
): Promise<UnlistenFn> {
  return listen<RawAgentEvent>('agent-event', (e) => {
    if (e.payload.id !== id) return
    try {
      cb(JSON.parse(e.payload.line))
    } catch {
      /* 非 JSON 行忽略 */
    }
  })
}

export function onAgentDone(
  id: string,
  cb: (code: number | null) => void
): Promise<UnlistenFn> {
  return listen<{ id: string; code: number | null }>('agent-done', (e) => {
    if (e.payload.id === id) cb(e.payload.code)
  })
}

// ---------- UI 消息模型 ----------

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ToolCall[]
  streaming: boolean
}

/**
 * 增量解析器:把 claude 的 stream-json 事件累积成对话消息。
 * 每个会话(对话视图)持有一个实例。
 */
export class StreamParser {
  sessionId = ''
  private current: ChatMessage | null = null

  constructor(
    private onUpdate: (msg: ChatMessage) => void,
    private onError?: (text: string) => void
  ) {}

  /** 开始一条新的助手消息(发送提问后调用)。 */
  beginAssistant(msgId: string): void {
    this.current = {
      id: msgId,
      role: 'assistant',
      text: '',
      tools: [],
      streaming: true
    }
    this.onUpdate({ ...this.current })
  }

  /** 处理一行解析后的 JSON 事件。 */
  handle(ev: any): void {
    if (!ev || typeof ev !== 'object') return

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.session_id) {
          this.sessionId = ev.session_id
        }
        break

      case 'stream_event': {
        const inner = ev.event
        if (!inner || !this.current) break
        if (
          inner.type === 'content_block_delta' &&
          inner.delta?.type === 'text_delta'
        ) {
          this.current.text += inner.delta.text ?? ''
          this.onUpdate({ ...this.current })
        } else if (
          inner.type === 'content_block_start' &&
          inner.content_block?.type === 'tool_use'
        ) {
          const tb = inner.content_block
          this.current.tools.push({
            id: tb.id ?? String(this.current.tools.length),
            name: tb.name ?? 'tool',
            input: tb.input ?? {}
          })
          this.onUpdate({ ...this.current })
        }
        break
      }

      case 'assistant': {
        // 完整助手消息:补全工具调用的 input(stream 中可能不完整)
        if (!this.current) break
        const content = ev.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              const existing = this.current.tools.find((t) => t.id === block.id)
              if (existing) existing.input = block.input
              else
                this.current.tools.push({
                  id: block.id,
                  name: block.name,
                  input: block.input
                })
            }
          }
          this.onUpdate({ ...this.current })
        }
        break
      }

      case 'result':
        if (ev.session_id) this.sessionId = ev.session_id
        if (this.current) {
          // 若流式没拿到文本,用 result 兜底
          if (!this.current.text && typeof ev.result === 'string') {
            this.current.text = ev.result
          }
          this.current.streaming = false
          this.onUpdate({ ...this.current })
        }
        break

      case 'linco_stderr':
        this.onError?.(ev.text ?? '')
        break
    }
  }

  /** 进程结束(兜底关闭流式态)。 */
  finish(): void {
    if (this.current && this.current.streaming) {
      this.current.streaming = false
      this.onUpdate({ ...this.current })
    }
    this.current = null
  }
}
