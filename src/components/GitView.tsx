import { useCallback, useEffect, useState } from 'react'
import {
  GitBranch as BranchIcon,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  Check,
  Plus,
  Minus,
  Undo2,
  GitCommitHorizontal,
  History,
  Archive,
  FileText
} from 'lucide-react'
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiffFile,
  gitDiscard,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStageAll,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitUnstage,
  gitUnstageAll,
  type GitBranch as GitBranchT,
  type GitCommit,
  type GitFile,
  type GitStash,
  type GitStatus
} from '@/lib/git'
import { iconForFile } from './files/icons'
import DiffView from './git/DiffView'
import { usePrompt } from './usePrompt'

type Tab = 'changes' | 'history' | 'branches' | 'stash'

interface GitViewProps {
  repo?: string
  onPickRoot?: () => void
  /** 远程主机(空=本地) */
  host?: string
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

export default function GitView({ repo, onPickRoot, host }: GitViewProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('changes')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [sel, setSel] = useState<GitFile | null>(null)
  const [diff, setDiff] = useState('')
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const [branches, setBranches] = useState<GitBranchT[]>([])
  const [log, setLog] = useState<GitCommit[]>([])
  const [historyRev, setHistoryRev] = useState('') // 历史查看的分支(空=当前 HEAD)
  const [stashes, setStashes] = useState<GitStash[]>([])
  // 应用内输入弹窗(WKWebView 不支持 window.prompt)
  const { prompt, dialog } = usePrompt()

  const notify = (m: string): void => {
    setToast(m)
    setTimeout(() => setToast(''), 2500)
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (!repo) return
    try {
      const s = await gitStatus(repo, host)
      setStatus(s)
    } catch (e) {
      console.error('git status 失败', e)
    }
  }, [repo, host])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 自动 fetch:进入视图后静默 fetch(延迟,让 status 先渲染),之后每 3 分钟一次。
  // fetch 完成后刷新 status,远端有新提交则 behind 数更新 → 顶部出现拉取提示。
  useEffect(() => {
    if (!repo) return
    let alive = true
    const doFetch = async (): Promise<void> => {
      try {
        await gitFetch(repo, host)
        if (alive) await refresh()
      } catch {
        /* 离线或无远端时忽略 */
      }
    }
    // 延迟首次 fetch,避免和首屏 status 抢资源(尤其远程 SSH)
    const first = setTimeout(doFetch, 1200)
    const timer = setInterval(doFetch, 3 * 60 * 1000)
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [repo, refresh])

  // 选中文件后加载 diff
  useEffect(() => {
    if (!repo || !sel) {
      setDiff('')
      return
    }
    gitDiffFile(repo, sel.path, sel.staged && !sel.unstaged, sel.untracked, host)
      .then(setDiff)
      .catch(() => setDiff(''))
  }, [repo, sel, host])

  // 切到对应 tab 时拉数据
  useEffect(() => {
    if (!repo) return
    if (tab === 'branches' || tab === 'history')
      gitBranches(repo, host).then(setBranches).catch(() => {})
    if (tab === 'history')
      gitLog(repo, 100, historyRev || undefined, host).then(setLog).catch(() => {})
    if (tab === 'stash') gitStashList(repo, host).then(setStashes).catch(() => {})
  }, [tab, repo, status, historyRev, host])

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    if (!repo) return
    setBusy(true)
    try {
      await fn()
      await refresh()
      if (ok) notify(ok)
    } catch (e) {
      notify(`失败:${e}`)
    } finally {
      setBusy(false)
    }
  }

  if (!repo) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
        <button
          onClick={onPickRoot}
          className="flex items-center gap-2 rounded-lg bg-sidebar px-4 py-2.5 text-[14px] text-ink hover:bg-black/5"
        >
          <BranchIcon size={16} />
          选择工作目录
        </button>
      </div>
    )
  }

  if (status && !status.isRepo) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-canvas text-[14px] text-ink-faint shadow-card ring-1 ring-black/5">
        当前目录不是 Git 仓库
      </div>
    )
  }

  const staged = status?.files.filter((f) => f.staged) ?? []
  const unstaged = status?.files.filter((f) => f.unstaged) ?? []
  const changedCount = status?.files.length ?? 0

  // 提交:若没有任何已暂存内容,先 add -A 暂存全部再提交(符合日常习惯);
  // 若已部分暂存,则尊重选择,只提交暂存的。
  const doCommit = async (): Promise<void> => {
    if (!repo || !commitMsg.trim() || changedCount === 0) return
    await run(async () => {
      if (staged.length === 0) await gitStageAll(repo, host)
      await gitCommit(repo, commitMsg, host)
      setCommitMsg('')
    }, '已提交')
  }

  const FileRow = ({
    f,
    onAction,
    actionIcon: ActionIcon
  }: {
    f: GitFile
    onAction: () => void
    actionIcon: typeof Plus
  }): JSX.Element => {
    const Icon = iconForFile(f.path)
    const code = f.untracked ? '?' : (f.staged ? f.index : f.work).trim() || 'M'
    const codeColor =
      code === '?'
        ? 'text-[#1a7f37]'
        : code === 'D'
          ? 'text-[#cf222e]'
          : code === 'A'
            ? 'text-[#1a7f37]'
            : 'text-[#9a6700]'
    return (
      <div
        onClick={() => setSel(f)}
        className={`group flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[12.5px] ${
          sel?.path === f.path && sel?.staged === f.staged
            ? 'bg-[#5c8bd6]/15'
            : 'hover:bg-black/[0.05]'
        }`}
      >
        <Icon size={13} className="shrink-0 text-ink-muted" />
        <span className="truncate text-ink">{baseName(f.path)}</span>
        <span className="truncate text-[11px] text-ink-faint">
          {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAction()
            }}
            className="rounded p-0.5 text-ink-faint opacity-0 hover:bg-black/10 hover:text-ink group-hover:opacity-100"
            title="暂存/取消"
          >
            <ActionIcon size={13} />
          </button>
          <span className={`w-3 text-center font-mono text-[11px] ${codeColor}`}>
            {code}
          </span>
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 顶部:分支 + 同步操作 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[13px]">
        <BranchIcon size={14} className="text-ink-muted" />
        <span className="font-medium text-ink">{status?.branch || '—'}</span>
        {!!status && (status.ahead > 0 || status.behind > 0) && (
          <span className="flex items-center gap-1 text-[11px] text-ink-faint">
            {status.behind > 0 && (
              <span className="flex items-center">
                <ArrowDown size={11} />
                {status.behind}
              </span>
            )}
            {status.ahead > 0 && (
              <span className="flex items-center">
                <ArrowUp size={11} />
                {status.ahead}
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => run(() => gitFetch(repo, host), '已 fetch')}
          disabled={busy}
          className="rounded-md p-1 text-ink-muted hover:bg-black/5 hover:text-ink"
          title="fetch"
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={() => run(() => gitPull(repo, host), '已拉取')}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 hover:text-ink"
          title="pull"
        >
          <ArrowDown size={13} />拉取
        </button>
        <button
          onClick={() => run(() => gitPush(repo, host), '已推送')}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 hover:text-ink"
          title="push"
        >
          <ArrowUp size={13} />推送
        </button>
      </div>

      {/* 远端有新提交:醒目提示拉取(behind>0) */}
      {!!status && status.behind > 0 && (
        <div className="flex shrink-0 items-center gap-2 bg-[#5c8bd6]/12 px-3 py-1.5 text-[12.5px] text-[#2f6fd0]">
          <ArrowDown size={14} className="shrink-0" />
          <span className="flex-1">
            远端有 {status.behind} 个新提交可拉取
            {status.ahead > 0 && `,本地领先 ${status.ahead} 个`}
          </span>
          <button
            onClick={() => run(() => gitPull(repo, host), '已拉取')}
            disabled={busy}
            className="shrink-0 rounded-md bg-[#2f6fd0] px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            拉取
          </button>
        </div>
      )}

      {/* 子标签 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-black/8 px-2 py-1">
        {(
          [
            ['changes', '变更', GitCommitHorizontal],
            ['history', '历史', History],
            ['branches', '分支', BranchIcon],
            ['stash', 'Stash', Archive]
          ] as [Tab, string, typeof History][]
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${
              tab === id
                ? 'bg-sidebar text-ink'
                : 'text-ink-muted hover:bg-black/5'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
        {toast && (
          <span className="ml-auto truncate text-[11px] text-ink-faint">
            {toast}
          </span>
        )}
      </div>

      {/* 主体 */}
      <div className="flex min-h-0 flex-1">
        {tab === 'changes' && (
          <>
            {/* 左:文件列表 + 提交 */}
            <div className="flex w-[300px] shrink-0 flex-col border-r border-black/8">
              <div className="min-h-0 flex-1 overflow-auto">
                {/* 暂存区 */}
                <div className="flex items-center justify-between px-2 py-1 text-[11px] font-medium uppercase text-ink-faint">
                  <span>已暂存 ({staged.length})</span>
                  {staged.length > 0 && (
                    <button
                      onClick={() => run(() => gitUnstageAll(repo, host))}
                      className="text-ink-faint hover:text-ink"
                      title="全部取消暂存"
                    >
                      <Minus size={12} />
                    </button>
                  )}
                </div>
                {staged.map((f) => (
                  <FileRow
                    key={`s-${f.path}`}
                    f={f}
                    actionIcon={Minus}
                    onAction={() => run(() => gitUnstage(repo, f.path, host))}
                  />
                ))}

                {/* 未暂存 */}
                <div className="mt-1 flex items-center justify-between px-2 py-1 text-[11px] font-medium uppercase text-ink-faint">
                  <span>变更 ({unstaged.length})</span>
                  {unstaged.length > 0 && (
                    <button
                      onClick={() => run(() => gitStageAll(repo, host))}
                      className="text-ink-faint hover:text-ink"
                      title="全部暂存"
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>
                {unstaged.map((f) => (
                  <FileRow
                    key={`u-${f.path}`}
                    f={f}
                    actionIcon={Plus}
                    onAction={() => run(() => gitStage(repo, f.path, host))}
                  />
                ))}
              </div>

              {/* 提交框 */}
              <div className="shrink-0 border-t border-black/8 p-2">
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="提交信息(⌘↩ 提交)"
                  rows={2}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void doCommit()
                    }
                  }}
                  className="w-full resize-none rounded-md border border-black/10 bg-canvas px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-[#5c8bd6] placeholder:text-ink-faint"
                />
                <button
                  onClick={() => void doCommit()}
                  disabled={busy || !commitMsg.trim() || changedCount === 0}
                  className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-ink py-1.5 text-[12.5px] text-canvas hover:opacity-90 disabled:opacity-40"
                >
                  <Check size={13} />
                  {staged.length > 0
                    ? `提交已暂存 (${staged.length})`
                    : `提交全部更改 (${unstaged.length})`}
                </button>
              </div>
            </div>

            {/* 右:diff */}
            <div className="min-w-0 flex-1">
              {sel ? (
                <div className="flex h-full flex-col">
                  <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[12.5px]">
                    <FileText size={13} className="text-ink-muted" />
                    <span className="truncate text-ink">{sel.path}</span>
                    <div className="flex-1" />
                    {!sel.staged && (
                      <button
                        onClick={() =>
                          run(() => gitDiscard(repo, sel.path, sel.untracked, host))
                        }
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-black/5 hover:text-[#cf222e]"
                        title="丢弃改动"
                      >
                        <Undo2 size={12} />丢弃
                      </button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1">
                    <DiffView diff={diff} />
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
                  选择左侧文件查看改动
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'history' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* 分支选择:看本地或远端(其他人)分支的提交 */}
            <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[12px]">
              <span className="text-ink-faint">查看分支</span>
              <select
                value={historyRev}
                onChange={(e) => setHistoryRev(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1 text-[12px] text-ink outline-none focus:border-[#5c8bd6]"
              >
                <option value="">当前分支 ({status?.branch || 'HEAD'})</option>
                {branches
                  .filter((b) => !b.current)
                  .map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.remote ? `🌐 ${b.name}` : b.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex min-h-0 flex-1">
              {/* 提交列表 */}
              <div className="w-[320px] shrink-0 overflow-auto border-r border-black/8">
                {log.map((c) => (
                  <div
                    key={c.hash}
                    onClick={() => gitShow(repo, c.hash, host).then(setDiff)}
                    className="cursor-pointer border-b border-black/5 px-3 py-1.5 hover:bg-black/[0.04]"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[11px] text-[#2f6fd0]">
                        {c.short}
                      </span>
                      <span className="truncate text-[12.5px] text-ink">
                        {c.subject}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-faint">
                      {c.author} · {c.date}
                    </div>
                  </div>
                ))}
              </div>
              {/* 选中提交的 diff */}
              <div className="min-w-0 flex-1">
                {diff ? (
                  <DiffView diff={diff} />
                ) : (
                  <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
                    点击提交查看改动
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'branches' && (
          <div className="flex-1 overflow-auto p-2">
            <button
              onClick={async () => {
                const name = (await prompt('新分支名'))?.trim()
                if (name) run(() => gitCreateBranch(repo, name, host), `已创建 ${name}`)
              }}
              className="mb-2 flex items-center gap-1.5 rounded-md bg-sidebar px-2.5 py-1 text-[12.5px] text-ink hover:bg-black/5"
            >
              <Plus size={13} />新建分支
            </button>
            {branches.map((b) => (
              <div
                key={b.name}
                onClick={() =>
                  !b.current && run(() => gitCheckout(repo, b.name, host), `已切换到 ${b.name}`)
                }
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12.5px] ${
                  b.current ? 'bg-[#5c8bd6]/15 text-ink' : 'text-ink-muted hover:bg-black/5'
                }`}
              >
                <BranchIcon size={13} className="shrink-0" />
                <span className="truncate">{b.name}</span>
                {b.current && <Check size={12} className="shrink-0 text-[#2f6fd0]" />}
                {b.upstream && (
                  <span className="ml-auto truncate text-[11px] text-ink-faint">
                    {b.upstream}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'stash' && (
          <div className="flex-1 overflow-auto p-2">
            <button
              onClick={async () => {
                const msg = (await prompt('Stash 描述(可空)')) ?? ''
                run(() => gitStashPush(repo, msg, host), '已 stash')
              }}
              className="mb-2 flex items-center gap-1.5 rounded-md bg-sidebar px-2.5 py-1 text-[12.5px] text-ink hover:bg-black/5"
            >
              <Archive size={13} />保存当前改动到 Stash
            </button>
            {stashes.length === 0 && (
              <div className="px-2 py-2 text-[12px] text-ink-faint">无 stash</div>
            )}
            {stashes.map((s) => (
              <div
                key={s.index}
                className="group flex items-center gap-2 rounded px-2 py-1 text-[12.5px] text-ink hover:bg-black/[0.05]"
              >
                <Archive size={13} className="shrink-0 text-ink-muted" />
                <span className="truncate">{s.message}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                  <button
                    onClick={() => run(() => gitStashPop(repo, s.index, host), '已 pop')}
                    className="rounded px-1.5 py-0.5 text-[11px] hover:bg-black/10"
                  >
                    pop
                  </button>
                  <button
                    onClick={() => run(() => gitStashApply(repo, s.index, host), '已 apply')}
                    className="rounded px-1.5 py-0.5 text-[11px] hover:bg-black/10"
                  >
                    apply
                  </button>
                  <button
                    onClick={() => run(() => gitStashDrop(repo, s.index, host), '已删除')}
                    className="rounded px-1.5 py-0.5 text-[11px] text-[#cf222e] hover:bg-black/10"
                  >
                    drop
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* 输入弹窗(新分支 / stash 描述) */}
      {dialog}
    </div>
  )
}
