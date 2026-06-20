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
  FileText,
  Loader2
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
  gitRemoteUrl,
  gitTestConnection,
  type GitBranch as GitBranchT,
  type GitCommit,
  type GitFile,
  type GitStash,
  type GitStatus,
  type GitConnTest
} from '@/lib/git'
import { onRemoteFsChange } from '@/lib/watch'
import type { AppConfig } from '@/lib/config'
import { useI18n } from '@/lib/i18n'
import { iconForFile } from './files/icons'
import DiffView from './git/DiffView'
import { usePrompt } from './usePrompt'

type Tab = 'changes' | 'history' | 'branches' | 'stash'

interface GitViewProps {
  repo?: string
  onPickRoot?: () => void
  /** 远程主机(空=本地) */
  host?: string
  /** GitHub 用户名(设置里配的);分支旁展示 */
  githubUser?: string
  /** 全量配置 + 写回(用于读/改 http 代理:本地 config.httpProxy / 远程 connection.httpProxy) */
  config?: AppConfig
  onChange?: (config: AppConfig) => void
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

export default function GitView({
  repo,
  onPickRoot,
  host,
  githubUser,
  config,
  onChange
}: GitViewProps): JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('changes')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [remoteSlug, setRemoteSlug] = useState('') // origin owner/repo
  const [conn, setConn] = useState<GitConnTest | null>(null) // 连通性测试结果
  const [testing, setTesting] = useState(false)
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

  // origin 仓库信息(owner/repo)——分支旁展示上游仓库。repo/host 变化时重拉。
  useEffect(() => {
    if (!repo) {
      setRemoteSlug('')
      return
    }
    let alive = true
    gitRemoteUrl(repo, host)
      .then((info) => {
        if (alive) setRemoteSlug(info.slug || '')
      })
      .catch(() => {
        if (alive) setRemoteSlug('')
      })
    return () => {
      alive = false
    }
  }, [repo, host])

  // 连通性测试:点状态点手动触发(也在 repo/host 变化时清空旧结果)。
  const testConn = useCallback(async (): Promise<void> => {
    if (!repo) return
    setTesting(true)
    try {
      setConn(await gitTestConnection(repo, host))
    } catch (e) {
      setConn({ ok: false, status: null, message: String(e), latencyMs: 0, slug: '' })
    } finally {
      setTesting(false)
    }
  }, [repo, host])

  useEffect(() => {
    setConn(null) // 切仓库/主机 → 清旧状态(用户点一下重新测)
  }, [repo, host])

  // 当前位置的 http 代理:本地=config.httpProxy;远程=该连接的 httpProxy。
  // 本地/远程代理常不同,各自独立存储。
  const curProxy = ((): string => {
    if (!config) return ''
    if (!host) return config.httpProxy ?? ''
    return config.connections.find((c) => c.host === host)?.httpProxy ?? ''
  })()
  const setProxy = (v: string): void => {
    if (!config || !onChange) return
    if (!host) {
      onChange({ ...config, httpProxy: v })
    } else {
      onChange({
        ...config,
        connections: config.connections.map((c) =>
          c.host === host ? { ...c, httpProxy: v } : c
        )
      })
    }
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 监听文件变更(agent 改文件)→ debounce 后刷新 git 状态(灵敏)。
  useEffect(() => {
    if (!repo) return
    let un: (() => void) | undefined
    let timer: number | undefined
    onRemoteFsChange((e) => {
      if ((e.host || undefined) !== (host || undefined)) return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), 200)
    }).then((f) => (un = f))
    return () => {
      if (timer) window.clearTimeout(timer)
      un?.()
    }
  }, [repo, host, refresh])

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
      notify(t('git.toast.failed', { error: String(e) }))
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
          {t('git.pickDir')}
        </button>
      </div>
    )
  }

  if (status && !status.isRepo) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-canvas text-[14px] text-ink-faint shadow-card ring-1 ring-black/5">
        {t('git.notRepo')}
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
    }, t('git.toast.committed'))
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
            title={t('git.stageToggle')}
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
      {/* 顶部:用户名 · 上游仓库 · 分支 + 同步操作 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[13px]">
        {/* GitHub 用户名 + 上游仓库(配了/拿到才显示) */}
        {(githubUser || remoteSlug) && (
          <span className="flex items-center gap-1 text-[12px] text-ink-faint">
            {githubUser && <span className="text-ink-muted">{githubUser}</span>}
            {githubUser && remoteSlug && <span className="text-ink-faint/50">·</span>}
            {remoteSlug && <span className="font-mono">{remoteSlug}</span>}
            <span className="mx-0.5 text-ink-faint/40">/</span>
          </span>
        )}
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
        {/* 连通性状态:点一下测试。200 绿、其它码黄/红、失败灰。 */}
        <button
          onClick={() => void testConn()}
          disabled={testing || !repo}
          title={conn ? `${conn.message} · ${conn.latencyMs}ms` : t('git.conn.test')}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-muted hover:bg-black/5"
        >
          {testing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                !conn
                  ? 'bg-ink-faint/40'
                  : conn.status && conn.status >= 200 && conn.status < 300
                    ? 'bg-emerald-500'
                    : conn.status
                      ? 'bg-amber-500'
                      : 'bg-red-500'
              }`}
            />
          )}
          <span className="font-mono">
            {testing
              ? t('git.conn.testing')
              : conn?.status
                ? conn.status
                : conn
                  ? t('git.conn.fail')
                  : t('git.conn.test')}
          </span>
        </button>
        <button
          disabled={busy}
          className="rounded-md p-1 text-ink-muted hover:bg-black/5 hover:text-ink"
          title="fetch"
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={() => run(() => gitPull(repo, host), t('git.toast.pulled'))}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 hover:text-ink"
          title="pull"
        >
          <ArrowDown size={13} />{t('git.pull')}
        </button>
        <button
          onClick={() => run(() => gitPush(repo, host), t('git.toast.pushed'))}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 hover:text-ink"
          title="push"
        >
          <ArrowUp size={13} />{t('git.push')}
        </button>
      </div>

      {/* HTTP 代理(按位置:本地 / 当前远程各自独立)。国内 push GitHub 常需配。 */}
      {config && onChange && (
        <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5">
          <span className="shrink-0 text-[11px] text-ink-faint">
            {host ? t('git.proxy.remote') : t('git.proxy.local')}
          </span>
          <input
            value={curProxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890"
            className="min-w-0 flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-black/25"
          />
          {curProxy && (
            <button
              onClick={() => setProxy('')}
              className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-ink-faint hover:bg-black/5 hover:text-ink"
            >
              {t('git.proxy.clear')}
            </button>
          )}
        </div>
      )}

      {/* 远端有新提交:醒目提示拉取(behind>0) */}
      {!!status && status.behind > 0 && (
        <div className="flex shrink-0 items-center gap-2 bg-[#5c8bd6]/12 px-3 py-1.5 text-[12.5px] text-[#2f6fd0]">
          <ArrowDown size={14} className="shrink-0" />
          <span className="flex-1">
            {t('git.behindHint', { behind: status.behind })}
            {status.ahead > 0 && t('git.aheadHint', { ahead: status.ahead })}
          </span>
          <button
            onClick={() => run(() => gitPull(repo, host), t('git.toast.pulled'))}
            disabled={busy}
            className="shrink-0 rounded-md bg-[#2f6fd0] px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('git.pull')}
          </button>
        </div>
      )}

      {/* 子标签 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-black/8 px-2 py-1">
        {(
          [
            ['changes', t('git.tab.changes'), GitCommitHorizontal],
            ['history', t('git.tab.history'), History],
            ['branches', t('git.tab.branches'), BranchIcon],
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
                  <span>{t('git.staged', { n: staged.length })}</span>
                  {staged.length > 0 && (
                    <button
                      onClick={() => run(() => gitUnstageAll(repo, host))}
                      className="text-ink-faint hover:text-ink"
                      title={t('git.unstageAll')}
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
                  <span>{t('git.changes', { n: unstaged.length })}</span>
                  {unstaged.length > 0 && (
                    <button
                      onClick={() => run(() => gitStageAll(repo, host))}
                      className="text-ink-faint hover:text-ink"
                      title={t('git.stageAll')}
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
                  placeholder={t('git.commitPlaceholder')}
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
                    ? t('git.commitStaged', { n: staged.length })
                    : t('git.commitAll', { n: unstaged.length })}
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
                        title={t('git.discardTitle')}
                      >
                        <Undo2 size={12} />{t('git.discard')}
                      </button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1">
                    <DiffView diff={diff} />
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
                  {t('git.selectFile')}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'history' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* 分支选择:看本地或远端(其他人)分支的提交 */}
            <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[12px]">
              <span className="text-ink-faint">{t('git.viewBranch')}</span>
              <select
                value={historyRev}
                onChange={(e) => setHistoryRev(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1 text-[12px] text-ink outline-none focus:border-[#5c8bd6]"
              >
                <option value="">{t('git.currentBranch', { branch: status?.branch || 'HEAD' })}</option>
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
                    {t('git.clickCommit')}
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
                const name = (await prompt(t('git.newBranchName')))?.trim()
                if (name) run(() => gitCreateBranch(repo, name, host), t('git.toast.branchCreated', { name }))
              }}
              className="mb-2 flex items-center gap-1.5 rounded-md bg-sidebar px-2.5 py-1 text-[12.5px] text-ink hover:bg-black/5"
            >
              <Plus size={13} />{t('git.newBranch')}
            </button>
            {branches.map((b) => (
              <div
                key={b.name}
                onClick={() =>
                  !b.current && run(() => gitCheckout(repo, b.name, host), t('git.toast.switched', { name: b.name }))
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
                const msg = (await prompt(t('git.stashDesc'))) ?? ''
                run(() => gitStashPush(repo, msg, host), t('git.toast.stashed'))
              }}
              className="mb-2 flex items-center gap-1.5 rounded-md bg-sidebar px-2.5 py-1 text-[12.5px] text-ink hover:bg-black/5"
            >
              <Archive size={13} />{t('git.stashSave')}
            </button>
            {stashes.length === 0 && (
              <div className="px-2 py-2 text-[12px] text-ink-faint">{t('git.stashEmpty')}</div>
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
                    onClick={() => run(() => gitStashPop(repo, s.index, host), t('git.toast.popped'))}
                    className="rounded px-1.5 py-0.5 text-[11px] hover:bg-black/10"
                  >
                    pop
                  </button>
                  <button
                    onClick={() => run(() => gitStashApply(repo, s.index, host), t('git.toast.applied'))}
                    className="rounded px-1.5 py-0.5 text-[11px] hover:bg-black/10"
                  >
                    apply
                  </button>
                  <button
                    onClick={() => run(() => gitStashDrop(repo, s.index, host), t('git.toast.dropped'))}
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
