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
import { listDir, prefetchFile, prefetchBytes, baseName, type DirEntry } from '@/lib/fs'
import { previewPrefetchFile } from '@/lib/preview'
import { startDragOut, markInternalDrag, clearInternalDrag } from '@/lib/transfer'
import {
  replaceInFile,
  searchContent,
  searchContentStream,
  searchCancel,
  listenSearch,
  buildMatchRegex,
  rangesFor,
  type FileMatches,
  type SearchOptions
} from '@/lib/search'
import { iconForFile } from './icons'
import { isMediaFile } from './FileViewer'
import { useI18n } from '@/lib/i18n'

export interface TreeContextTarget {
  entry: DirEntry
  x: number
  y: number
}

// Git 状态字符 → 颜色 class(A 绿/M 橙/D 红/? 灰)
function gitColor(ch: string): string {
  switch (ch) {
    case 'A':
      return 'text-diff-added-foreground'
    case 'M':
      return 'text-accent'
    case 'D':
      return 'text-diff-deleted-foreground'
    default:
      return 'text-ink-faint' // ? 未跟踪
  }
}

// 路径分隔符归一(同时吃 `/` 与 `\`)→ 比较 Windows 反斜杠路径与正斜杠路径时不踩坑。
function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}
/** 两个路径是否指向同一项(忽略分隔符差异 + 尾随分隔符)。 */
function samePath(a: string, b: string): boolean {
  return normPath(a).replace(/\/+$/, '') === normPath(b).replace(/\/+$/, '')
}
/** child 是否在 parent 目录之下(忽略分隔符差异)。 */
function isUnder(child: string, parent: string): boolean {
  return normPath(child).startsWith(normPath(parent).replace(/\/+$/, '') + '/')
}

// 计算节点的 git 状态:文件取自身;文件夹聚合(内部任意改动则取一个代表字符)。
function isHtmlFile(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name)
}

function prefetchPreviewEntries(entries: DirEntry[], host?: string): void {
  for (const entry of entries.filter((e) => !e.isDir && isHtmlFile(e.name)).slice(0, 8)) {
    previewPrefetchFile(entry.path, host).catch(() => {})
  }
}

function nodeGitStatus(
  entry: DirEntry,
  gitMap?: Map<string, string>
): string | null {
  if (!gitMap || gitMap.size === 0) return null
  // 归一成 `/`:gitMap 的 key 是 shadow 后端归一后的正斜杠绝对路径,但 Windows 本地项目的
  // entry.path 是反斜杠。不归一则两者永不相等 → Windows 上文件全不标记。Mac/Linux 无 `\`,无副作用。
  const self = entry.path.replace(/\\/g, '/')
  if (!entry.isDir) return gitMap.get(self) ?? null
  // 文件夹:看是否有改动落在其下;有则返回聚合标记(优先级 M>A>D>?,统一显点)
  const prefix = self.replace(/\/+$/, '') + '/'
  for (const k of gitMap.keys()) {
    if (k.startsWith(prefix)) return '•' // 文件夹只显改动点
  }
  return null
}

interface FileTreeProps {
  root: string
  selectedPath: string
  onSelectFile: (path: string) => void
  /** 点击任意节点(文件或文件夹)时回调,记录树选中项供键盘快捷键用 */
  onSelect?: (entry: DirEntry) => void
  onContext: (t: TreeContextTarget) => void
  /** 拖拽移动:把 src 移动到 destDir 下 */
  onMove: (src: string, destDir: string) => void
  /** 多选集合(Ctrl/Cmd+点击切换)。命中的节点高亮。空集=无多选。 */
  multiSel?: Set<string>
  /** Ctrl/Cmd+点击某节点 → 切换它在多选集合中的状态(不打开文件)。 */
  onToggleMulti?: (entry: DirEntry) => void
  refreshKey: number
  refreshPaths: string[]
  /** 远程主机(空=本地) */
  host?: string
  /** Git 逐文件状态:绝对路径→状态字符(M/A/D/?)。用于显色标 + 文件夹聚合。 */
  gitMap?: Map<string, string>
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
  onSelect,
  onContext,
  onMove,
  multiSel,
  onToggleMulti,
  refreshKey,
  refreshPaths,
  revealPath,
  host,
  gitMap
}: NodeProps): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<number | null>(null)

  // 悬停预读:停留 ~250ms 才预读,避免滚动滑过时狂发命令(远程尤其卡)
  const onHoverEnter = (): void => {
    if (entry.isDir) return
    if (isHtmlFile(entry.name)) {
      previewPrefetchFile(entry.path, host).catch(() => {})
      return
    }
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
      const next = await listDir(entry.path, host)
      setChildren(next)
      prefetchPreviewEntries(next, host)
    } catch (e) {
      console.error('列目录失败', e)
      setChildren([])
    } finally {
      setLoading(false)
    }
  }

  const toggle = (e?: React.MouseEvent): void => {
    // Ctrl/Cmd+点击:切换多选(不打开文件、不展开目录),用于批量删除/复制。
    if (e && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onToggleMulti?.(entry)
      return
    }
    onSelect?.(entry) // 记录树选中节点(文件或文件夹),供键盘快捷键作用
    if (!entry.isDir) {
      onSelectFile(entry.path)
      return
    }
    if (!open && children === null) void loadChildren()
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (
      refreshKey > 0 &&
      open &&
      entry.isDir &&
      (refreshPaths.length === 0 || refreshPaths.some((p) => samePath(p, entry.path)))
    )
      void loadChildren()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 定位展开:目标在本目录(或后代)→ 展开本目录;就是目标本身 → 滚动到可见。
  // 目标可能是文件(滚动它自己)或文件夹(展开+滚动)。
  useEffect(() => {
    if (!revealPath) return
    if (entry.isDir) {
      if (samePath(revealPath, entry.path) || isUnder(revealPath, entry.path)) {
        // 目标落在本目录或其后代:即便已展开过也强制重拉,确保新建项立即出现。
        void loadChildren()
        setOpen(true)
      }
    }
    if (samePath(revealPath, entry.path)) {
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
  const isMulti = multiSel ? multiSel.has(entry.path) : false
  const gitSt = nodeGitStatus(entry, gitMap)

  // 拖拽源
  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData('text/linco-path', entry.path)
    e.dataTransfer.effectAllowed = 'move'
    // 标记「本轮拖拽源自 app 内」:若拖回 app 内文件夹应当移动,而非当作外部导入。
    markInternalDrag([entry.path], host || '')
    if (!host) {
      // 本地:同步发起原生拖出(可拖到 Finder/资源管理器;失败静默)
      startDragOut([entry.path])
    }
  }
  const onDragEnd = (): void => {
    // 拖拽结束(无论落在 app 内还是 Finder)清除内部标志,避免影响下次外部拖入
    clearInternalDrag()
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
    if (!src || samePath(src, entry.path)) return
    if (isUnder(entry.path, src)) return
    onMove(src, entry.path)
  }

  return (
    <div>
      <div
        ref={rowRef}
        draggable
        {...(entry.isDir
          ? { 'data-drop-dir': entry.path, 'data-drop-host': host || '' }
          : {})}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
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
            ? 'bg-accent/15 ring-1 ring-accent/40'
            : isMulti
              ? 'bg-[var(--selection)] text-ink ring-1 ring-accent/40'
              : isSelected
                ? 'bg-[var(--selection)] text-ink'
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
              <FolderOpen size={15} className="shrink-0 text-accent" />
            ) : (
              <Folder size={15} className="shrink-0 text-accent" />
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
        <span
          className={`truncate ${
            gitSt && gitSt !== '•' ? gitColor(gitSt) : ''
          }`}
        >
          {entry.name}
        </span>
        {gitSt && (
          <span
            className={`ml-auto shrink-0 pr-1 text-[11px] font-semibold ${gitColor(
              gitSt === '•' ? 'M' : gitSt
            )}`}
          >
            {gitSt === '•' ? '●' : gitSt}
          </span>
        )}
      </div>

      {entry.isDir && open && (
        <div>
          {loading && children === null ? (
            <div
              className="py-1 text-[12px] text-ink-faint"
              style={{ paddingLeft: (depth + 1) * 12 + 20 }}
            >
              {t('tree.loading')}
            </div>
          ) : (
            children?.map((c) => (
              <Node
                key={c.path}
                entry={c}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                onSelect={onSelect}
                onContext={onContext}
                onMove={onMove}
                multiSel={multiSel}
                onToggleMulti={onToggleMulti}
                refreshKey={refreshKey}
                refreshPaths={refreshPaths}
                revealPath={revealPath}
                host={host}
                gitMap={gitMap}
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
  onSelect,
  onContext,
  onMove,
  multiSel,
  onToggleMulti,
  refreshKey,
  refreshPaths,
  host,
  revealRequest,
  gitMap
}: FileTreeProps): JSX.Element {
  const { t } = useI18n()
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
  // 流式搜索:当前搜索 ID(每次新搜索自增,旧 sid 的事件直接丢弃防串台)
  const searchSid = useRef(0)
  // 手动重跑搜索的触发器(替换后刷新结果);变化即重新执行搜索 effect
  const [searchNonce, setSearchNonce] = useState(0)

  const totalMatches = results?.reduce((n, f) => n + f.matches.length, 0) ?? 0

  // revealPath 定位后清空
  useEffect(() => {
    if (!revealPath) return
    const t = setTimeout(() => setRevealPath(''), 1500)
    return () => clearTimeout(t)
  }, [revealPath])

  const load = async (): Promise<void> => {
    try {
      const next = await listDir(root, host)
      setEntries(next)
      prefetchPreviewEntries(next, host)
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
    if (
      refreshKey > 0 &&
      (refreshPaths.length === 0 || refreshPaths.some((p) => samePath(p, root)))
    ) {
      void load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 内容搜索:防抖 300ms + 竞态保护。
  // 本地:一问一答 searchContent(秒出)。远程:流式 searchContentStream(边搜边返回)。
  useEffect(() => {
    const q = query
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    let canceled = false
    setSearching(true)

    // —— 本地:维持原有一问一答 ——
    if (!host) {
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
    }

    // —— 远程:流式 ——
    const mySid = String(++searchSid.current)
    const re = buildMatchRegex(q, opts)
    if (!re) {
      // 非法正则:不发起,清空
      setResults([])
      setSearching(false)
      return
    }
    setResults([]) // 新搜索从空开始,逐批 append
    // 按文件聚合的可变索引(path -> FileMatches),逐批合并后整体 setResults
    const byPath = new Map<string, FileMatches>()
    let un: (() => void) | undefined
    let timer: number | undefined

    const start = async (): Promise<void> => {
      un = await listenSearch(
        (e) => {
          if (canceled || e.sid !== mySid) return // 串台/过期 丢弃
          let changed = false
          for (const [path, line, text] of e.rows) {
            const ranges = rangesFor(text, re)
            if (ranges.length === 0) continue
            const ml = { line, text: text.slice(0, 400), ranges }
            const f = byPath.get(path)
            if (f) f.matches.push(ml)
            else byPath.set(path, { path, matches: [ml] })
            changed = true
          }
          if (changed) setResults(Array.from(byPath.values()))
        },
        (e) => {
          if (canceled || e.sid !== mySid) return
          setSearching(false)
        }
      )
      if (canceled) {
        un?.()
        return
      }
      searchContentStream(mySid, root, q, opts, host).catch(
        () => !canceled && setSearching(false)
      )
    }

    timer = window.setTimeout(() => void start(), 300)
    return () => {
      canceled = true
      if (timer) clearTimeout(timer)
      un?.()
      // 通知远端 kill 这次搜索的子进程(防大仓库孤儿 grep)
      void searchCancel(mySid, host).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, root, host, searchNonce])

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
    // 重新触发搜索 effect(本地一问一答 / 远程流式 都走同一路径)
    setSearchNonce((n) => n + 1)
  }

  const replaceFile = async (path: string): Promise<void> => {
    try {
      await replaceInFile(path, query, replacement, opts, host)
      await rerun()
    } catch (e) {
      window.alert(t('tree.replaceFailed', { error: String(e) }))
    }
  }

  const replaceAll = async (): Promise<void> => {
    if (!results || totalMatches === 0) return
    if (!window.confirm(t('tree.confirmReplaceAll', { files: results.length }))) return
    try {
      for (const f of results)
        await replaceInFile(f.path, query, replacement, opts, host)
      await rerun()
    } catch (e) {
      window.alert(t('tree.replaceFailed', { error: String(e) }))
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
          ? 'bg-accent/20 text-accent'
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
            title={t('tree.toggleReplace')}
          >
            {showReplace ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>

          <div className="min-w-0 flex-1 space-y-1">
            {/* Search */}
            <div className="flex items-center gap-1 rounded-md border border-black/10 bg-canvas px-1.5 py-1 focus-within:border-accent">
              <Search size={12} className="shrink-0 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('tree.search')}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
              />
              <Toggle
                active={opts.caseSensitive}
                onClick={() =>
                  setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))
                }
                icon={CaseSensitive}
                title={t('tree.caseSensitive')}
              />
              <Toggle
                active={opts.wholeWord}
                onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
                icon={WholeWord}
                title={t('tree.wholeWord')}
              />
              <Toggle
                active={opts.isRegex}
                onClick={() => setOpts((o) => ({ ...o, isRegex: !o.isRegex }))}
                icon={Regex}
                title={t('tree.regex')}
              />
              {/* ⋯ 展开过滤 */}
              <Toggle
                active={showFilters}
                onClick={() => setShowFilters((s) => !s)}
                icon={MoreHorizontal}
                title={t('tree.filterFiles')}
              />
            </div>

            {/* Replace */}
            {showReplace && (
              <div className="flex items-center gap-1">
                <div className="flex flex-1 items-center gap-1 rounded-md border border-black/10 bg-canvas px-1.5 py-1 focus-within:border-accent">
                  <Replace size={12} className="shrink-0 text-ink-faint" />
                  <input
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    placeholder={t('tree.replace')}
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
                  />
                </div>
                <button
                  onClick={replaceAll}
                  disabled={!results || totalMatches === 0}
                  title={t('tree.replaceAll')}
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
                    {t('tree.include')}
                  </div>
                  <input
                    value={opts.include}
                    onChange={(e) =>
                      setOpts((o) => ({ ...o, include: e.target.value }))
                    }
                    placeholder={t('tree.includePlaceholder')}
                    className="w-full rounded-md border border-black/10 bg-canvas px-1.5 py-1 text-[12px] text-ink outline-none focus:border-accent placeholder:text-ink-faint"
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-[11px] text-ink-faint">
                    {t('tree.exclude')}
                  </div>
                  <input
                    value={opts.exclude}
                    onChange={(e) =>
                      setOpts((o) => ({ ...o, exclude: e.target.value }))
                    }
                    placeholder={t('tree.excludePlaceholder')}
                    className="w-full rounded-md border border-black/10 bg-canvas px-1.5 py-1 text-[12px] text-ink outline-none focus:border-accent placeholder:text-ink-faint"
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
        data-drop-root=""
        data-drop-dir={root}
        data-drop-host={host || ''}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault()
            onContext({ entry: rootEntry, x: e.clientX, y: e.clientY })
          }
        }}
      >
        {query ? (
          searching && results === null ? (
            <div className="px-3 py-2 text-[12px] text-ink-faint">{t('tree.searching')}</div>
          ) : !results || results.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-ink-faint">
              {searching ? t('tree.searching') : t('tree.noResults')}
            </div>
          ) : (
            <>
              <div className="px-3 py-1 text-[11px] text-ink-faint">
                {t('tree.resultSummary', { files: results.length, matches: totalMatches })}
                {searching ? ' · …' : ''}
              </div>
              {results.map((f) => {
                const isCol = collapsed.has(f.path)
                const FileIcon = iconForFile(baseName(f.path))
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
                        {baseName(f.path)}
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
                          title={t('tree.replaceThisFile')}
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
                          title={t('tree.lineN', { line: m.line })}
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
              onSelect={onSelect}
              onContext={onContext}
              onMove={onMove}
              multiSel={multiSel}
              onToggleMulti={onToggleMulti}
              refreshKey={refreshKey}
              refreshPaths={refreshPaths}
              revealPath={revealPath}
              host={host}
              gitMap={gitMap}
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
      <span key={`m${i}`} className="rounded-sm bg-[var(--find-highlight)] text-ink">
        {chars.slice(s, e).join('')}
      </span>
    )
    cursor = e
  })
  if (cursor < chars.length)
    parts.push(<span key="tail">{chars.slice(cursor).join('')}</span>)
  return <>{parts}</>
}
