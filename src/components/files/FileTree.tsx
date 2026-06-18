import { memo, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Search,
  CaseSensitive,
  WholeWord,
  Regex,
  MoreHorizontal,
  ReplaceAll,
  Replace
} from 'lucide-react'
import { listDir, prefetchFile, prefetchBytes, type DirEntry } from '@/lib/fs'
import {
  replaceInFile,
  searchContent,
  type FileMatches,
  type SearchOptions
} from '@/lib/search'
import { iconForFile } from './icons'
import { isMediaFile } from './FileViewer'

export interface TreeContextTarget {
  entry: DirEntry
  x: number
  y: number
}

interface FileTreeProps {
  root: string
  selectedPath: string
  onSelectFile: (path: string) => void
  onContext: (t: TreeContextTarget) => void
  /** 拖拽移动:把 src 移动到 destDir 下 */
  onMove: (src: string, destDir: string) => void
  refreshKey: number
  refreshPaths: string[]
  /** 远程主机(空=本地) */
  host?: string
  /** 定位请求:设为某文件路径时,树自动展开并滚动到它(VS Code 式)。
   *  用 `路径#序号` 形式,序号变化即触发(同一文件可重复定位)。 */
  revealRequest?: string
}

interface NodeProps extends Omit<FileTreeProps, 'root'> {
  entry: DirEntry
  depth: number
  /** 需要展开定位到的目标路径(在其祖先链上的目录会自动展开) */
  revealPath: string
}

const Node = memo(function Node({
  entry,
  depth,
  selectedPath,
  onSelectFile,
  onContext,
  onMove,
  refreshKey,
  refreshPaths,
  revealPath,
  host
}: NodeProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<number | null>(null)

  // 悬停预读:停留 ~250ms 才预读,避免滚动滑过时狂发命令(远程尤其卡)
  const onHoverEnter = (): void => {
    if (entry.isDir) return
    if (hoverTimer.current != null) clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      // xlsx/xls 与媒体一样按二进制预读;csv/tsv 是文本(TableViewer 也走文本缓存)
      const e = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
      const binary = isMediaFile(entry.name) || e === 'xlsx' || e === 'xls'
      if (binary) {
        if (host) prefetchBytes(entry.path, host)
      } else {
        prefetchFile(entry.path, host)
      }
    }, 250)
  }
  const onHoverLeave = (): void => {
    if (hoverTimer.current != null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const loadChildren = async (): Promise<void> => {
    setLoading(true)
    try {
      setChildren(await listDir(entry.path, host))
    } catch (e) {
      console.error('列目录失败', e)
      setChildren([])
    } finally {
      setLoading(false)
    }
  }

  const toggle = (): void => {
    if (!entry.isDir) {
      onSelectFile(entry.path)
      return
    }
    if (!open && children === null) void loadChildren()
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (open && entry.isDir && refreshPaths.includes(entry.path))
      void loadChildren()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 定位展开:目标在本目录(或后代)→ 展开本目录;就是目标本身 → 滚动到可见。
  // 目标可能是文件(滚动它自己)或文件夹(展开+滚动)。
  useEffect(() => {
    if (!revealPath) return
    if (entry.isDir) {
      if (revealPath === entry.path || revealPath.startsWith(entry.path + '/')) {
        if (children === null) void loadChildren()
        setOpen(true)
      }
    }
    if (revealPath === entry.path) {
      // 等展开/布局完成后,仅当目标不在可视区域时才滚动(避免已可见时无谓跳动)
      setTimeout(() => {
        const el = rowRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        const visible = r.top >= 0 && r.bottom <= window.innerHeight
        if (!visible) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 120)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath])

  const FileIcon = entry.isDir ? null : iconForFile(entry.name)
  const isSelected = entry.path === selectedPath

  // 拖拽源
  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData('text/linco-path', entry.path)
    e.dataTransfer.effectAllowed = 'move'
  }

  // 文件夹作为放置目标
  const onDragOver = (e: React.DragEvent): void => {
    if (!entry.isDir) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOver) setDragOver(true)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!entry.isDir) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const src = e.dataTransfer.getData('text/linco-path')
    // 不能拖到自身或自己的子目录;不能拖到自己所在目录(无意义)
    if (!src || src === entry.path) return
    if (entry.path.startsWith(src + '/')) return
    onMove(src, entry.path)
  }

  return (
    <div>
      <div
        ref={rowRef}
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => dragOver && setDragOver(false)}
        onDrop={onDrop}
        onClick={toggle}
        onMouseEnter={onHoverEnter}
        onMouseLeave={onHoverLeave}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContext({ entry, x: e.clientX, y: e.clientY })
        }}
        className={`flex cursor-pointer items-center gap-1 rounded py-[3px] pr-2 text-[13px] ${
          dragOver
            ? 'bg-[#5c8bd6]/15 ring-1 ring-[#5c8bd6]/40'
            : isSelected
              ? 'bg-[#5c8bd6]/15 text-ink'
              : 'text-ink hover:bg-black/[0.07]'
        }`}
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        {entry.isDir ? (
          <>
            {open ? (
              <ChevronDown size={14} className="shrink-0 text-ink-faint" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-ink-faint" />
            )}
            {open ? (
              <FolderOpen size={15} className="shrink-0 text-[#5c8bd6]" />
            ) : (
              <Folder size={15} className="shrink-0 text-[#5c8bd6]" />
            )}
          </>
        ) : (
          <>
            <span className="w-[14px] shrink-0" />
            {FileIcon && (
              <FileIcon size={15} className="shrink-0 text-ink-muted" />
            )}
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </div>

      {entry.isDir && open && (
        <div>
          {loading && children === null ? (
            <div
              className="py-1 text-[12px] text-ink-faint"
              style={{ paddingLeft: (depth + 1) * 12 + 20 }}
            >
              加载中…
            </div>
          ) : (
            children?.map((c) => (
              <Node
                key={c.path}
                entry={c}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                onContext={onContext}
                onMove={onMove}
                refreshKey={refreshKey}
                refreshPaths={refreshPaths}
                revealPath={revealPath}
                host={host}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
})

export default function FileTree({
  root,
  selectedPath,
  onSelectFile,
  onContext,
  onMove,
  refreshKey,
  refreshPaths,
  host,
  revealRequest
}: FileTreeProps): JSX.Element {
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [revealPath, setRevealPath] = useState('')

  // 外部定位请求(打开/切换文件时)→ 驱动内部 revealPath 展开+滚动到该文件。
  // revealRequest 形如 "路径#序号";解析出路径,序号变化即重新定位。
  useEffect(() => {
    if (!revealRequest) return
    const hashIdx = revealRequest.lastIndexOf('#')
    const p = hashIdx > 0 ? revealRequest.slice(0, hashIdx) : revealRequest
    if (p) setRevealPath(p)
  }, [revealRequest])

  // —— 内容搜索状态(VS Code 风格)——
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [opts, setOpts] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    include: '',
    exclude: ''
  })
  const [results, setResults] = useState<FileMatches[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const totalMatches = results?.reduce((n, f) => n + f.matches.length, 0) ?? 0

  // revealPath 定位后清空
  useEffect(() => {
    if (!revealPath) return
    const t = setTimeout(() => setRevealPath(''), 1500)
    return () => clearTimeout(t)
  }, [revealPath])

  const load = async (): Promise<void> => {
    try {
      setEntries(await listDir(root, host))
    } catch (e) {
      console.error('列根目录失败', e)
      setEntries([])
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, host])

  useEffect(() => {
    if (refreshPaths.includes(root)) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 内容搜索:防抖 300ms + 竞态保护
  useEffect(() => {
    const q = query
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    let canceled = false
    setSearching(true)
    const t = setTimeout(() => {
      searchContent(root, q, opts, host)
        .then((r) => !canceled && setResults(r))
        .catch(() => !canceled && setResults([]))
        .finally(() => !canceled && setSearching(false))
    }, 300)
    return () => {
      canceled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, root, host])

  const toggleCollapse = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const rerun = async (): Promise<void> => {
    if (!query) return
    setSearching(true)
    try {
      setResults(await searchContent(root, query, opts, host))
    } finally {
      setSearching(false)
    }
  }

  const replaceFile = async (path: string): Promise<void> => {
    try {
      await replaceInFile(path, query, replacement, opts, host)
      await rerun()
    } catch (e) {
      window.alert(`替换失败:${e}`)
    }
  }

  const replaceAll = async (): Promise<void> => {
    if (!results || totalMatches === 0) return
    if (!window.confirm(`在 ${results.length} 个文件中替换全部匹配?`)) return
    try {
      for (const f of results)
        await replaceInFile(f.path, query, replacement, opts, host)
      await rerun()
    } catch (e) {
      window.alert(`替换失败:${e}`)
    }
  }

  const rootEntry: DirEntry = { name: root, path: root, isDir: true }

  const Toggle = ({
    active,
    onClick,
    icon: Icon,
    title
  }: {
    active: boolean
    onClick: () => void
    icon: typeof CaseSensitive
    title: string
  }): JSX.Element => (
    <button
      onClick={onClick}
      title={title}
      className={`rounded p-0.5 ${
        active
          ? 'bg-[#5c8bd6]/20 text-[#2f6fd0]'
          : 'text-ink-faint hover:bg-black/10 hover:text-ink'
      }`}
    >
      <Icon size={13} />
    </button>
  )

  return (
    <div className="flex h-full flex-col">
      {/* 搜索 / 替换 / 过滤(VS Code 风格) */}
      <div className="shrink-0 border-b border-black/8 px-2 pb-2 pt-2">
        <div className="flex items-start gap-1">
          {/* 展开替换行 */}
          <button
            onClick={() => setShowReplace((s) => !s)}
            className="mt-1 shrink-0 rounded p-0.5 text-ink-faint hover:bg-black/5"
            title="切换替换"
          >
            {showReplace ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>

          <div className="min-w-0 flex-1 space-y-1">
            {/* Search */}
            <div className="flex items-center gap-1 rounded-md border border-black/10 bg-canvas px-1.5 py-1 focus-within:border-[#5c8bd6]">
              <Search size={12} className="shrink-0 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
              />
              <Toggle
                active={opts.caseSensitive}
                onClick={() =>
                  setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))
                }
                icon={CaseSensitive}
                title="区分大小写"
              />
              <Toggle
                active={opts.wholeWord}
                onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
                icon={WholeWord}
                title="全词匹配"
              />
              <Toggle
                active={opts.isRegex}
                onClick={() => setOpts((o) => ({ ...o, isRegex: !o.isRegex }))}
                icon={Regex}
                title="正则"
              />
              {/* ⋯ 展开过滤 */}
              <Toggle
                active={showFilters}
                onClick={() => setShowFilters((s) => !s)}
                icon={MoreHorizontal}
                title="包含/排除文件"
              />
            </div>

            {/* Replace */}
            {showReplace && (
              <div className="flex items-center gap-1">
                <div className="flex flex-1 items-center gap-1 rounded-md border border-black/10 bg-canvas px-1.5 py-1 focus-within:border-[#5c8bd6]">
                  <Replace size={12} className="shrink-0 text-ink-faint" />
                  <input
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    placeholder="替换"
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
                  />
                </div>
                <button
                  onClick={replaceAll}
                  disabled={!results || totalMatches === 0}
                  title="全部替换"
                  className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-black/5 hover:text-ink disabled:opacity-40"
                >
                  <ReplaceAll size={14} />
                </button>
              </div>
            )}

            {/* files to include / exclude(点 ⋯ 展开) */}
            {showFilters && (
              <div className="space-y-1 pt-0.5">
                <div>
                  <div className="mb-0.5 text-[11px] text-ink-faint">
                    包含的文件
                  </div>
                  <input
                    value={opts.include}
                    onChange={(e) =>
                      setOpts((o) => ({ ...o, include: e.target.value }))
                    }
                    placeholder="例如 *.ts, src/**/*.py"
                    className="w-full rounded-md border border-black/10 bg-canvas px-1.5 py-1 text-[12px] text-ink outline-none focus:border-[#5c8bd6] placeholder:text-ink-faint"
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-[11px] text-ink-faint">
                    排除的文件
                  </div>
                  <input
                    value={opts.exclude}
                    onChange={(e) =>
                      setOpts((o) => ({ ...o, exclude: e.target.value }))
                    }
                    placeholder="例如 *.test.ts, dist/**"
                    className="w-full rounded-md border border-black/10 bg-canvas px-1.5 py-1 text-[12px] text-ink outline-none focus:border-[#5c8bd6] placeholder:text-ink-faint"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 结果(有 query)/ 文件树(无 query) */}
      <div
        className="min-h-0 flex-1 overflow-auto pb-1"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault()
            onContext({ entry: rootEntry, x: e.clientX, y: e.clientY })
          }
        }}
      >
        {query ? (
          searching && results === null ? (
            <div className="px-3 py-2 text-[12px] text-ink-faint">搜索中…</div>
          ) : !results || results.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-ink-faint">
              {searching ? '搜索中…' : '无结果'}
            </div>
          ) : (
            <>
              <div className="px-3 py-1 text-[11px] text-ink-faint">
                {results.length} 个文件,{totalMatches} 处匹配
              </div>
              {results.map((f) => {
                const isCol = collapsed.has(f.path)
                const FileIcon = iconForFile(f.path.split('/').pop() || '')
                return (
                  <div key={f.path}>
                    <div
                      onClick={() => toggleCollapse(f.path)}
                      className="group flex cursor-pointer items-center gap-1 px-2 py-1 hover:bg-black/[0.05]"
                    >
                      {isCol ? (
                        <ChevronRight size={13} className="shrink-0 text-ink-faint" />
                      ) : (
                        <ChevronDown size={13} className="shrink-0 text-ink-faint" />
                      )}
                      <FileIcon size={13} className="shrink-0 text-ink-muted" />
                      <span className="truncate text-[12.5px] text-ink">
                        {f.path.split('/').pop()}
                      </span>
                      <span className="ml-auto shrink-0 rounded-full bg-black/8 px-1.5 text-[10.5px] text-ink-muted">
                        {f.matches.length}
                      </span>
                      {showReplace && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            void replaceFile(f.path)
                          }}
                          title="替换此文件"
                          className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:bg-black/10 hover:text-ink group-hover:opacity-100"
                        >
                          <Replace size={12} />
                        </button>
                      )}
                    </div>
                    {!isCol &&
                      f.matches.map((m) => (
                        <div
                          key={m.line}
                          onClick={() => onSelectFile(f.path)}
                          className="flex cursor-pointer items-baseline gap-2 py-[1px] pl-7 pr-2 hover:bg-black/[0.05]"
                          title={`第 ${m.line} 行`}
                        >
                          <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">
                            {m.line}
                          </span>
                          <span className="truncate whitespace-pre font-mono text-[11.5px] text-ink-muted">
                            <HighlightedLine text={m.text} ranges={m.ranges} />
                          </span>
                        </div>
                      ))}
                  </div>
                )
              })}
            </>
          )
        ) : (
          entries.map((c) => (
            <Node
              key={c.path}
              entry={c}
              depth={0}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              onContext={onContext}
              onMove={onMove}
              refreshKey={refreshKey}
              refreshPaths={refreshPaths}
              revealPath={revealPath}
              host={host}
            />
          ))
        )}
      </div>
    </div>
  )
}

// 高亮一行内的匹配区间
function HighlightedLine({
  text,
  ranges
}: {
  text: string
  ranges: [number, number][]
}): JSX.Element {
  const chars = [...text]
  const parts: JSX.Element[] = []
  let cursor = 0
  ranges.forEach(([s, e], i) => {
    if (s > cursor)
      parts.push(<span key={`p${i}`}>{chars.slice(cursor, s).join('')}</span>)
    parts.push(
      <span key={`m${i}`} className="rounded-sm bg-[#f8d775] text-ink">
        {chars.slice(s, e).join('')}
      </span>
    )
    cursor = e
  })
  if (cursor < chars.length)
    parts.push(<span key="tail">{chars.slice(cursor).join('')}</span>)
  return <>{parts}</>
}
