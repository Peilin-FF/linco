import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  usageLoad,
  localDay,
  type DayUsage,
  type ModelUsage,
  type UsageStats as UsageStatsData
} from '@/lib/usage'
import { useI18n } from '@/lib/i18n'

const WEEKS = 26

export default function UsageStats(): JSX.Element {
  const { t } = useI18n()
  const [stats, setStats] = useState<UsageStatsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = (): void => {
    setLoading(true)
    usageLoad()
      .then((next) => {
        setStats(next)
        setError(null)
      })
      .catch((err) => {
        setStats(null)
        setError(err instanceof Error ? err.message : String(err))
      })
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
          b.cliReportedTokens +
          modelTurns(b) +
          b.estimatedInputTokens -
          (a.cliReportedTokens + modelTurns(a) + a.estimatedInputTokens)
      ),
    [stats]
  )
  const totalTurns = (stats?.totals.turns ?? 0) + (stats?.totals.cliTurns ?? 0)
  const activeDays = Object.values(stats?.days ?? {}).filter((d) => dayActivity(d) > 0).length
  const recentTurns = heatDays
    .slice(-30)
    .reduce((sum, d) => sum + dayActivity(d.usage), 0)
  const streak = currentStreak(stats?.days ?? {})

  return (
    <div className="mx-auto max-w-[920px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-ink">{t('usage.title')}</h2>
          <div className="mt-1 text-[12.5px] text-ink-faint">
            {t('usage.desc')}
          </div>
        </div>
        <button
          onClick={reload}
          className="flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-black/5 hover:text-ink"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {t('usage.refresh')}
        </button>
      </div>
      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700 ring-1 ring-red-100">
          {t('usage.loadFailed', { error })}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric label={t('usage.turns')} value={formatNum(totalTurns)} />
        <Metric label={t('usage.cliTokens')} value={formatNum(stats?.totals.cliReportedTokens ?? 0)} />
        <Metric label={t('usage.inputTokens')} value={formatNum(stats?.totals.estimatedInputTokens ?? 0)} />
        <Metric label={t('usage.streak')} value={t('usage.days', { n: streak })} />
      </div>

      <section className="mt-7">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[14px] font-medium text-ink">{t('usage.vibeFreq')}</h3>
          <span className="text-[12px] text-ink-faint">
            {t('usage.activeSummary', { activeDays, recentTurns })}
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl bg-sidebar p-4">
          <div className="grid grid-flow-col grid-rows-7 gap-1">
            {heatDays.map((d) => (
              <div
                key={d.day}
                title={t('usage.dayActivity', { day: d.day, count: dayActivity(d.usage) })}
                className={`h-3 w-3 rounded-[3px] ${heatClass(dayActivity(d.usage))} ${
                  d.future ? 'opacity-25' : ''
                }`}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end gap-1 text-[11px] text-ink-faint">
            <span>{t('usage.less')}</span>
            {[0, 1, 3, 6, 10].map((n) => (
              <span key={n} className={`h-3 w-3 rounded-[3px] ${heatClass(n)}`} />
            ))}
            <span>{t('usage.more')}</span>
          </div>
        </div>
      </section>

      <section className="mt-7">
        <h3 className="mb-2 text-[14px] font-medium text-ink">{t('usage.modelUsage')}</h3>
        <div className="overflow-hidden rounded-xl bg-sidebar">
          <div className="grid grid-cols-[1.4fr_0.8fr_0.7fr_0.9fr_0.9fr] border-b border-black/8 px-4 py-2 text-[12px] text-ink-faint">
            <span>{t('usage.col.model')}</span>
            <span>Agent</span>
            <span className="text-right">{t('usage.col.turns')}</span>
            <span className="text-right">{t('usage.col.cliToken')}</span>
            <span className="text-right">{t('usage.col.inputEst')}</span>
          </div>
          {models.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ink-faint">
              {t('usage.noRecords')}
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
      <span className="text-right tabular-nums text-ink">{formatNum(modelTurns(model))}</span>
      <span className="text-right tabular-nums text-ink">{formatNum(model.cliReportedTokens)}</span>
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
    if (dayActivity(days[key]) <= 0) return n
    n++
    d.setDate(d.getDate() - 1)
  }
}

function dayActivity(day?: DayUsage): number {
  return (day?.turns ?? 0) + (day?.cliTurns ?? 0)
}

function modelTurns(model: ModelUsage): number {
  return (model.turns ?? 0) + (model.cliTurns ?? 0)
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
