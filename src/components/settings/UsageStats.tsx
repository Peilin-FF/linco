import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  usageLoad,
  localDay,
  type DayUsage,
  type ModelUsage,
  type UsageStats as UsageStatsData
} from '@/lib/usage'

const WEEKS = 26

export default function UsageStats(): JSX.Element {
  const [stats, setStats] = useState<UsageStatsData | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = (): void => {
    setLoading(true)
    usageLoad()
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
  }, [])

  const heatDays = useMemo(() => buildHeatDays(stats?.days ?? {}), [stats])
  const models = useMemo(
    () =>
      Object.values(stats?.models ?? {}).sort(
        (a, b) =>
          b.reportedTokens +
          b.estimatedInputTokens -
          (a.reportedTokens + a.estimatedInputTokens)
      ),
    [stats]
  )
  const activeDays = Object.values(stats?.days ?? {}).filter((d) => d.turns > 0).length
  const recentTurns = heatDays
    .slice(-30)
    .reduce((sum, d) => sum + (d.usage?.turns ?? 0), 0)
  const streak = currentStreak(stats?.days ?? {})

  return (
    <div className="mx-auto max-w-[920px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-ink">使用统计</h2>
          <div className="mt-1 text-[12.5px] text-ink-faint">
            Token 以 CLI 报告为准；未报告时保留输入估算。
          </div>
        </div>
        <button
          onClick={reload}
          className="flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-black/5 hover:text-ink"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric label="Vibe 轮次" value={formatNum(stats?.totals.turns ?? 0)} />
        <Metric label="CLI 报告 token" value={formatNum(stats?.totals.reportedTokens ?? 0)} />
        <Metric label="输入估算 token" value={formatNum(stats?.totals.estimatedInputTokens ?? 0)} />
        <Metric label="连续活跃" value={`${streak} 天`} />
      </div>

      <section className="mt-7">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[14px] font-medium text-ink">Vibe coding 频率</h3>
          <span className="text-[12px] text-ink-faint">
            {activeDays} 个活跃日 · 近 30 天 {recentTurns} 轮
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl bg-sidebar p-4">
          <div className="grid grid-flow-col grid-rows-7 gap-1">
            {heatDays.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.usage?.turns ?? 0} 轮`}
                className={`h-3 w-3 rounded-[3px] ${heatClass(d.usage?.turns ?? 0)} ${
                  d.future ? 'opacity-25' : ''
                }`}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end gap-1 text-[11px] text-ink-faint">
            <span>少</span>
            {[0, 1, 3, 6, 10].map((n) => (
              <span key={n} className={`h-3 w-3 rounded-[3px] ${heatClass(n)}`} />
            ))}
            <span>多</span>
          </div>
        </div>
      </section>

      <section className="mt-7">
        <h3 className="mb-2 text-[14px] font-medium text-ink">模型消耗</h3>
        <div className="overflow-hidden rounded-xl bg-sidebar">
          <div className="grid grid-cols-[1.4fr_0.8fr_0.7fr_0.9fr_0.9fr] border-b border-black/8 px-4 py-2 text-[12px] text-ink-faint">
            <span>模型</span>
            <span>Agent</span>
            <span className="text-right">轮次</span>
            <span className="text-right">报告 token</span>
            <span className="text-right">输入估算</span>
          </div>
          {models.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ink-faint">
              暂无使用记录
            </div>
          ) : (
            models.map((m) => <ModelRow key={m.key} model={m} />)
          )}
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl bg-sidebar px-4 py-3">
      <div className="text-[12px] text-ink-faint">{label}</div>
      <div className="mt-1 text-[20px] font-semibold text-ink">{value}</div>
    </div>
  )
}

function ModelRow({ model }: { model: ModelUsage }): JSX.Element {
  return (
    <div className="grid grid-cols-[1.4fr_0.8fr_0.7fr_0.9fr_0.9fr] items-center border-b border-black/5 px-4 py-2.5 text-[13px] last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-medium text-ink">{model.label}</div>
        <div className="truncate text-[11px] text-ink-faint">{model.provider}</div>
      </div>
      <span className="truncate text-ink-muted">{model.agentName}</span>
      <span className="text-right tabular-nums text-ink">{formatNum(model.turns)}</span>
      <span className="text-right tabular-nums text-ink">{formatNum(model.reportedTokens)}</span>
      <span className="text-right tabular-nums text-ink-muted">
        {formatNum(model.estimatedInputTokens)}
      </span>
    </div>
  )
}

function buildHeatDays(days: Record<string, DayUsage>): Array<{
  day: string
  usage?: DayUsage
  future: boolean
}> {
  const today = startOfDay(new Date())
  const start = new Date(today)
  start.setDate(today.getDate() - (WEEKS - 1) * 7 - today.getDay())
  const out = []
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = localDay(d)
    out.push({ day: key, usage: days[key], future: d > today })
  }
  return out
}

function currentStreak(days: Record<string, DayUsage>): number {
  const d = startOfDay(new Date())
  let n = 0
  for (;;) {
    const key = localDay(d)
    if ((days[key]?.turns ?? 0) <= 0) return n
    n++
    d.setDate(d.getDate() - 1)
  }
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function heatClass(turns: number): string {
  if (turns <= 0) return 'bg-black/5'
  if (turns <= 1) return 'bg-emerald-100'
  if (turns <= 3) return 'bg-emerald-300'
  if (turns <= 7) return 'bg-emerald-500'
  return 'bg-emerald-700'
}

function formatNum(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}
