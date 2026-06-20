import { useCallback, useEffect, useState } from 'react'
import { History, Trash2, Loader2, CheckSquare, Square, ListChecks, X } from 'lucide-react'
import { agentSessions, agentSessionDelete, type SessionInfo } from '@/lib/sessions'
import { useI18n } from '@/lib/i18n'

interface Props {
  /** 当前项目工作目录;空则不显示 */
  cwd?: string
  /** 当前 agent 的 provider(anthropic/openai…),决定读 claude 还是 codex 历史 */
  provider: string
  /** 远程连接 host(空 = 本地) */
  host?: string
  /** 点击某条历史 → 在对话窗口恢复该会话继续聊 */
  onResume?: (id: string) => void
}

// 把 Unix 秒转成「多久以前」的紧凑相对时间(本地化标签由调用方传入)。
function relTime(
  mtime: number,
  nowSec: number,
  t: (k: string, v?: Record<string, string | number>) => string
): string {
  const d = Math.max(0, nowSec - mtime)
  if (d < 60) return t('history.justNow')
  if (d < 3600) return t('history.minAgo', { n: Math.floor(d / 60) })
  if (d < 86400) return t('history.hourAgo', { n: Math.floor(d / 3600) })
  return t('history.dayAgo', { n: Math.floor(d / 86400) })
}

/// 会话历史面板:列出「当前项目」里该 agent 存的历史会话,可逐个或批量删除防堆积。
/// 放在对话框左侧空白区(与右侧 SessionRail 镜像)。一屏约 3 条,超出滚动。
export default function SessionHistory({ cwd, provider, host, onResume }: Props): JSX.Element | null {
  const { t } = useI18n()
  const [items, setItems] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  // 批量删除:选择模式 + 已选 id 集合 + 确认态 + 进行中
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  // 项目名 = cwd 末段(用于头部标注「当前项目」)
  const projectName = cwd ? cwd.replace(/\/+$/, '').split('/').pop() || cwd : ''

  const refresh = useCallback(async () => {
    if (!cwd) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const list = await agentSessions(cwd, provider, host)
      setItems(list)
      setNow(Math.floor(Date.now() / 1000))
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [cwd, provider, host])

  // 项目 / agent / 连接变化时重载;并退出选择模式(列表已换)
  useEffect(() => {
    void refresh()
    setSelectMode(false)
    setSelected(new Set())
    setBatchConfirm(false)
  }, [refresh])

  // 点别处取消「确认删除」态
  useEffect(() => {
    if (!confirmId) return
    const onDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement | null
      if (!el?.closest('[data-histitem]')) setConfirmId(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [confirmId])

  const onDelete = async (id: string): Promise<void> => {
    if (!cwd) return
    setBusyId(id)
    try {
      await agentSessionDelete(cwd, provider, id, host)
      setItems((cur) => cur.filter((s) => s.id !== id))
    } catch {
      // 删除失败:刷新回真值
      void refresh()
    } finally {
      setBusyId(null)
      setConfirmId(null)
    }
  }

  // 切换某条的选中态
  const toggleSel = (id: string): void => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = items.length > 0 && selected.size === items.length
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(items.map((s) => s.id)))
  }

  const exitSelect = (): void => {
    setSelectMode(false)
    setSelected(new Set())
    setBatchConfirm(false)
  }

  // 批量删除已选(逐个删,失败即刷新回真值)
  const onBatchDelete = async (): Promise<void> => {
    if (!cwd || selected.size === 0) return
    setBatchBusy(true)
    const ids = [...selected]
    try {
      for (const id of ids) {
        await agentSessionDelete(cwd, provider, id, host)
      }
      setItems((cur) => cur.filter((s) => !selected.has(s.id)))
      exitSelect()
    } catch {
      void refresh()
      exitSelect()
    } finally {
      setBatchBusy(false)
    }
  }

  if (!cwd) return null
  // 没有历史也不显示空面板(避免占地方)
  if (!loading && items.length === 0) return null

  return (
    <div className="flex h-full flex-col px-1.5 py-1.5">
      <div className="flex shrink-0 flex-col gap-0.5 px-1 pb-1">
        <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
          <History size={11} />
          <span className="truncate">{t('history.title')}</span>
          {items.length > 0 && (
            <span className="text-ink-faint/70">· {items.length}</span>
          )}
          <span className="flex-1" />
          {/* 进入/退出批量选择模式 */}
          {items.length > 0 && (
            <button
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              title={selectMode ? t('history.exitSelect') : t('history.select')}
              className={`shrink-0 rounded p-0.5 transition-colors ${
                selectMode
                  ? 'text-accent hover:bg-accent/10'
                  : 'text-ink-faint hover:bg-black/10 hover:text-ink'
              }`}
            >
              {selectMode ? <X size={12} /> : <ListChecks size={12} />}
            </button>
          )}
        </div>
        {/* 项目名:明确「只列当前项目」的会话,不是全机历史 */}
        {!selectMode && projectName && (
          <span className="truncate pl-0.5 text-[10px] text-ink-faint/80" title={cwd}>
            {projectName}
          </span>
        )}
        {/* 批量操作条:全选 + 删除选中(N) */}
        {selectMode && (
          <div className="flex items-center gap-1 pt-0.5">
            <button
              onClick={toggleAll}
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] text-ink-muted hover:bg-black/5"
            >
              {allSelected ? (
                <CheckSquare size={12} className="text-accent" />
              ) : (
                <Square size={12} />
              )}
              {t('history.selectAll')}
            </button>
            <span className="flex-1" />
            {batchBusy ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-ink-faint" />
            ) : batchConfirm ? (
              <span className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={() => void onBatchDelete()}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-500/10"
                >
                  {t('history.confirmDelete')}
                </button>
                <button
                  onClick={() => setBatchConfirm(false)}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-muted hover:bg-black/10"
                >
                  {t('history.cancel')}
                </button>
              </span>
            ) : (
              <button
                onClick={() => setBatchConfirm(true)}
                disabled={selected.size === 0}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:text-ink-faint/50"
              >
                <Trash2 size={11} />
                {t('history.deleteN', { n: selected.size })}
              </button>
            )}
          </div>
        )}
      </div>
      {/* 列表区:一屏约 3 条,超出上下滚动 */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5">
        {items.map((s) => {
          const confirming = confirmId === s.id
          const busy = busyId === s.id
          const checked = selected.has(s.id)
          // 选择模式:整条点击 = 勾选/取消;否则 = 恢复会话
          return (
            <div
              key={s.id}
              data-histitem
              className={`group flex shrink-0 items-center gap-1 rounded-lg pl-2 pr-1 text-left text-[11px] text-ink-muted transition-colors ${
                selectMode && checked ? 'bg-accent/10' : 'hover:bg-black/5'
              }`}
            >
              {/* 选择模式下的勾选框 */}
              {selectMode && (
                <button
                  type="button"
                  onClick={() => toggleSel(s.id)}
                  className="shrink-0 text-ink-faint hover:text-ink"
                >
                  {checked ? (
                    <CheckSquare size={13} className="text-accent" />
                  ) : (
                    <Square size={13} />
                  )}
                </button>
              )}
              {/* 卡片主体:选择模式→勾选;否则→恢复会话 */}
              <button
                type="button"
                onClick={() => (selectMode ? toggleSel(s.id) : onResume?.(s.id))}
                disabled={busy || confirming}
                title={selectMode || confirming ? undefined : t('history.resume')}
                className="flex min-w-0 flex-1 items-center py-1.5 text-left disabled:cursor-default"
              >
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate font-medium text-ink">{s.title}</span>
                  <span className="block truncate text-[10px] text-ink-faint">
                    {relTime(s.mtime, now, t)}
                  </span>
                </span>
              </button>
              {/* 选择模式下隐藏单条删除按钮(用顶部批量删除) */}
              {selectMode ? null : busy ? (
                <Loader2 size={13} className="shrink-0 animate-spin text-ink-faint" />
              ) : confirming ? (
                // 确认删除:并排「确认 / 取消」两个按钮
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => void onDelete(s.id)}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-500/10"
                  >
                    {t('history.confirmDelete')}
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-muted hover:bg-black/10"
                  >
                    {t('history.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmId(s.id)}
                  title={t('history.delete')}
                  className="shrink-0 rounded p-1 text-ink-faint opacity-0 transition-opacity hover:bg-black/10 hover:text-red-600 group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
