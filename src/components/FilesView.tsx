import { useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import FileTree, { type TreeContextTarget } from './files/FileTree'
import FileViewer from './files/FileViewer'
import ContextMenu, { type ContextAction } from './files/ContextMenu'
import { usePrompt } from './usePrompt'
import {
  copyPath as fsCopy,
  createDir,
  createFile,
  deletePath,
  movePath,
  renamePath,
  revealInFinder,
  type DirEntry
} from '@/lib/fs'
import { onRemoteFsChange } from '@/lib/watch'
import { gitStatus } from '@/lib/git'

interface FilesViewProps {
  /** 工作目录(资源管理器根) */
  root?: string
  onPickRoot?: () => void
  /** 在指定目录打开一个新终端 */
  onOpenInTerminal?: (dir: string) => void
  /** 在预览视图打开某 HTML 文件 */
  onPreview?: (path: string) => void
  /** 外部请求打开的文件路径(如从搜索结果跳转);变化时自动选中 */
  openPath?: string
  /** 远程主机(空=本地) */
  host?: string
}

interface Clipboard {
  path: string
  mode: 'cut' | 'copy'
}

export default function FilesView({
  root,
  onPickRoot,
  onOpenInTerminal,
  onPreview,
  openPath,
  host
}: FilesViewProps): JSX.Element {
  // 多标签:已打开的文件列表 + 当前激活的文件
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [menu, setMenu] = useState<TreeContextTarget | null>(null)
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)
  // 文件树当前选中节点(文件或文件夹),供键盘快捷键(F2/Delete/⌘C/⌘X/⌘V)作用
  const [treeSel, setTreeSel] = useState<DirEntry | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshPaths, setRefreshPaths] = useState<string[]>([])
  // Git 逐文件状态:绝对路径 → 状态字符(M/A/D/?)。供文件树显色标 + 文件夹聚合。
  const [gitMap, setGitMap] = useState<Map<string, string>>(new Map())
  // 文件树定位请求(active 变化时让左侧树跳转到该文件,VS Code 式)
  const [revealReq, setRevealReq] = useState('')
  const revealSeq = useRef(0)
  const treePanelRef = useRef<HTMLDivElement | null>(null)
  // 应用内输入弹窗(替代 WKWebView 不支持的 window.prompt)
  const { prompt, dialog } = usePrompt()

  // active(当前预览的文件)变化 → 请求树定位到它
  useEffect(() => {
    if (active) {
      revealSeq.current += 1
      setRevealReq(`${active}#${revealSeq.current}`)
    }
  }, [active])

  // 打开文件:加入标签(已存在则不重复)并激活
  const openFile = (path: string): void => {
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setActive(path)
  }

  // 新建后定位:文件→作为标签打开(并触发树展开+定位);文件夹→仅请求树定位展开。
  // 关键:这会让新建项所在目录被展开,否则在未展开的目录里新建会"看不见"。
  const revealAndOpen = (createdPath: string): void => {
    if (/\.[^/]+$/.test(createdPath)) {
      // 有扩展名,当作文件打开
      openFile(createdPath)
    } else {
      revealSeq.current += 1
      setRevealReq(`${createdPath}#${revealSeq.current}`)
    }
  }

  // 关闭标签:移除并把激活切到相邻标签
  const closeTab = (path: string): void => {
    setTabs((prev) => {
      const i = prev.indexOf(path)
      const next = prev.filter((p) => p !== path)
      setActive((cur) =>
        cur === path ? (next[i] ?? next[i - 1] ?? '') : cur
      )
      return next
    })
  }

  // 外部请求打开某文件(如搜索/Git 跳转)→ 作为标签打开
  useEffect(() => {
    if (openPath) openFile(openPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath])

  const refresh = (...dirs: string[]): void => {
    setRefreshPaths(dirs)
    setRefreshKey((k) => k + 1)
  }

  // 拉取 Git 逐文件状态,建 绝对路径→状态字符 的 map(供文件树显标)。
  const loadGit = async (): Promise<void> => {
    if (!root) return
    try {
      const s = await gitStatus(root, host)
      if (!s.isRepo) {
        setGitMap(new Map())
        return
      }
      const m = new Map<string, string>()
      const base = root.replace(/\/+$/, '')
      for (const f of s.files) {
        // 状态字符:未跟踪=? 删除=D 新增=A 其余=M
        const ch = f.untracked
          ? '?'
          : f.index === 'A' || f.work === 'A'
            ? 'A'
            : f.index === 'D' || f.work === 'D'
              ? 'D'
              : 'M'
        m.set(`${base}/${f.path}`, ch)
      }
      setGitMap(m)
    } catch {
      setGitMap(new Map())
    }
  }

  // 进入/换工作目录时拉一次 git 状态
  useEffect(() => {
    void loadGit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, host])

  // 监听文件变更(远程 agent / 本地扫描推送)→ debounce 后刷新受影响目录,
  // 实现"agent 改文件,文件树自动刷新"(灵敏)。
  //
  // 抗"训练跑"洪流:活跃训练目录(logs/outputs/...)会持续高频写盘,事件如雨。
  // 朴素 debounce(每来一条就重置定时器)在持续写时要么永不触发、要么暴刷;
  // 且每次刷新都跑一次**全仓库 git status**(loadGit),会把交互(展开目录)挤到队尾。
  // 对策:
  //  1) 目录刷新:debounce 400ms + 最长 1.2s 强制 flush(持续写也只是每 ~1.2s 刷一次)。
  //  2) git 刷新:独立节流,最多每 3s 一次(全仓 git status 贵,不必跟每次文件变同频)。
  useEffect(() => {
    let un: (() => void) | undefined
    let timer: number | undefined
    let firstAt = 0 // 本轮 pending 第一条事件时刻(用于最长等待上限)
    let lastGit = 0 // 上次 loadGit 时刻(节流)
    const pendingDirs = new Set<string>()

    const flush = (): void => {
      if (timer) {
        window.clearTimeout(timer)
        timer = undefined
      }
      firstAt = 0
      if (pendingDirs.size) {
        refresh(...pendingDirs)
        pendingDirs.clear()
      }
      // git 状态独立节流:全仓 status 贵,持续写时不必每次都跑
      const now = Date.now()
      if (now - lastGit > 3000) {
        lastGit = now
        void loadGit()
      }
    }

    onRemoteFsChange((e) => {
      // 只关心当前连接(host 一致;本地都为空串)
      if ((e.host || undefined) !== (host || undefined)) return
      for (const p of e.paths) {
        const dir = p.slice(0, p.lastIndexOf('/'))
        if (dir) pendingDirs.add(dir)
      }
      const now = Date.now()
      if (!firstAt) firstAt = now
      // 已积压超过 1.2s → 立即 flush(防持续写把刷新无限推后)
      if (now - firstAt >= 1200) {
        flush()
        return
      }
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(flush, 400)
    }).then((f) => (un = f))
    return () => {
      if (timer) window.clearTimeout(timer)
      un?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host])

  // 取某 entry 的“所在目录”:文件夹用自身,文件用其父目录
  const dirOf = (entry: DirEntry): string =>
    entry.isDir ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/'))

  // 拖拽移动:把 src 移到 destDir 下,刷新两端
  const handleMove = async (src: string, destDir: string): Promise<void> => {
    const srcDir = src.slice(0, src.lastIndexOf('/'))
    if (srcDir === destDir) return // 已在目标目录
    try {
      await movePath(src, destDir, host)
      if (tabs.includes(src)) closeTab(src)
      refresh(srcDir, destDir)
    } catch (e) {
      window.alert(`移动失败:${e}`)
    }
  }

  const handleAction = async (
    action: ContextAction,
    target: DirEntry
  ): Promise<void> => {
    try {
      switch (action) {
        case 'new-file': {
          const name = (await prompt('新建文件名'))?.trim()
          if (!name) return
          const created = await createFile(target.path, name, host)
          refresh(target.path)
          // 展开目标目录并定位到新文件,顺手作为标签打开
          revealAndOpen(created)
          break
        }
        case 'new-folder': {
          const name = (await prompt('新建文件夹名'))?.trim()
          if (!name) return
          const created = await createDir(target.path, name, host)
          refresh(target.path)
          revealAndOpen(created)
          break
        }
        case 'reveal':
          await revealInFinder(target.path)
          break
        case 'preview':
          onPreview?.(target.path)
          break
        case 'open-terminal':
          onOpenInTerminal?.(target.path)
          break
        case 'cut':
          setClipboard({ path: target.path, mode: 'cut' })
          break
        case 'copy':
          setClipboard({ path: target.path, mode: 'copy' })
          break
        case 'paste': {
          if (!clipboard) return
          if (clipboard.mode === 'copy') {
            await fsCopy(clipboard.path, target.path, host)
          } else {
            await movePath(clipboard.path, target.path, host)
            // 剪切后清空源目录刷新
            const srcDir = clipboard.path.slice(
              0,
              clipboard.path.lastIndexOf('/')
            )
            refresh(srcDir)
            setClipboard(null)
          }
          refresh(target.path)
          break
        }
        case 'copy-path':
          await navigator.clipboard.writeText(target.path)
          break
        case 'copy-relative-path':
          await navigator.clipboard.writeText(
            root && target.path.startsWith(root)
              ? target.path.slice(root.length).replace(/^\//, '')
              : target.path
          )
          break
        case 'rename': {
          const name = (await prompt('重命名为', target.name))?.trim()
          if (!name || name === target.name) return
          await renamePath(target.path, name, host)
          refresh(dirOf(target))
          break
        }
        case 'delete': {
          const ok = window.confirm(`确定删除「${target.name}」?`)
          if (!ok) return
          await deletePath(target.path, host)
          if (tabs.includes(target.path)) closeTab(target.path)
          refresh(dirOf(target))
          break
        }
      }
    } catch (e) {
      window.alert(`操作失败:${e}`)
    }
  }

  if (!root) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
        <button
          onClick={onPickRoot}
          className="flex items-center gap-2 rounded-lg bg-sidebar px-4 py-2.5 text-[14px] text-ink hover:bg-black/5"
        >
          <FolderOpen size={16} />
          选择工作目录以浏览文件
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 左:文件树 */}
      <div
        className="flex w-[260px] shrink-0 flex-col border-r border-black/8 outline-none"
        tabIndex={-1}
        ref={(el) => {
          treePanelRef.current = el
        }}
        onMouseDown={() => treePanelRef.current?.focus()}
        onKeyDown={(e) => {
          if (!treeSel) return
          const meta = e.metaKey || e.ctrlKey
          if (e.key === 'F2') {
            e.preventDefault()
            void handleAction('rename', treeSel)
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            void handleAction('delete', treeSel)
          } else if (meta && (e.key === 'c' || e.key === 'C')) {
            e.preventDefault()
            void handleAction('copy', treeSel)
          } else if (meta && (e.key === 'x' || e.key === 'X')) {
            e.preventDefault()
            void handleAction('cut', treeSel)
          } else if (meta && (e.key === 'v' || e.key === 'V')) {
            // 粘贴到:选中文件夹则进其内,选中文件则进其父目录
            e.preventDefault()
            const destDir = treeSel.isDir
              ? treeSel.path
              : treeSel.path.slice(0, treeSel.path.lastIndexOf('/'))
            void handleAction('paste', { name: '', path: destDir, isDir: true })
          }
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
          <span className="truncate">{root.split('/').pop() || root}</span>
        </div>
        <div className="min-h-0 flex-1">
          <FileTree
            root={root}
            selectedPath={active}
            onSelectFile={openFile}
            onSelect={setTreeSel}
            onContext={setMenu}
            onMove={handleMove}
            refreshKey={refreshKey}
            refreshPaths={refreshPaths}
            host={host}
            revealRequest={revealReq}
            gitMap={gitMap}
          />
        </div>
      </div>

      {/* 右:多标签编辑器 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
            从左侧选择文件查看 / 编辑
          </div>
        ) : (
          <>
            {/* 标签条 */}
            <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-black/8 bg-sidebar/40 px-1 py-1">
              {tabs.map((p) => (
                <div
                  key={p}
                  onClick={() => setActive(p)}
                  onMouseDown={(e) => {
                    // 鼠标中键(滚轮按下)关闭标签,与 VS Code / 浏览器一致
                    if (e.button === 1) {
                      e.preventDefault()
                      closeTab(p)
                    }
                  }}
                  className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1 text-[12.5px] ${
                    p === active
                      ? 'bg-canvas text-ink shadow-sm'
                      : 'text-ink-muted hover:bg-black/5'
                  }`}
                  title={p}
                >
                  <span className="max-w-[160px] truncate">
                    {p.split('/').pop()}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(p)
                    }}
                    className="rounded p-0.5 text-ink-faint opacity-0 hover:bg-black/10 hover:text-ink group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            {/* 内容:所有标签常驻挂载,显隐切换 → 切 tab 瞬时、保留滚动/编辑态 */}
            <div className="relative min-h-0 flex-1">
              {tabs.map((p) => (
                <div
                  key={p}
                  className={`absolute inset-0 ${
                    p === active
                      ? 'z-10 opacity-100'
                      : 'pointer-events-none opacity-0'
                  }`}
                >
                  <FileViewer path={p} host={host} repo={root} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          isDir={menu.entry.isDir}
          fileName={menu.entry.name}
          canPaste={!!clipboard}
          onAction={(a) => handleAction(a, menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 输入弹窗(新建/重命名) */}
      {dialog}
    </div>
  )
}
