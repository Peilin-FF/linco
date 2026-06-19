import { invoke } from '@tauri-apps/api/core'

export interface UsageTotals {
  turns: number
  estimatedInputTokens: number
  reportedTokens: number
}

export interface ModelUsage {
  key: string
  label: string
  agentId: string
  agentName: string
  provider: string
  model: string
  turns: number
  estimatedInputTokens: number
  reportedTokens: number
  firstAt: string
  lastAt: string
}

export interface DayUsage {
  day: string
  turns: number
  estimatedInputTokens: number
  reportedTokens: number
}

export interface SessionUsage {
  sessionId: string
  modelKey: string
  lastReportedTotalTokens: number
}

export interface UsageStats {
  version: number
  totals: UsageTotals
  models: Record<string, ModelUsage>
  days: Record<string, DayUsage>
  sessions: Record<string, SessionUsage>
}

export interface UsageAgentContext {
  sessionId?: string
  agentId: string
  agentName: string
  provider: string
  model: string
}

export function usageLoad(): Promise<UsageStats> {
  return invoke<UsageStats>('usage_load')
}

export function usageRecordTurn(
  agent: UsageAgentContext,
  prompt: string,
  opts?: { host?: string; cwd?: string }
): Promise<UsageStats> {
  return invoke<UsageStats>('usage_record_turn', {
    input: {
      ...agent,
      host: opts?.host || null,
      cwd: opts?.cwd || null,
      prompt,
      day: localDay(),
      at: new Date().toISOString()
    }
  })
}

export function usageIngestTerminalOutput(
  agent: UsageAgentContext & { sessionId: string },
  text: string
): Promise<UsageStats> {
  return invoke<UsageStats>('usage_ingest_terminal_output', {
    input: {
      ...agent,
      text,
      day: localDay(),
      at: new Date().toISOString()
    }
  })
}

export function localDay(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
