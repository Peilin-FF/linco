import { useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw, X } from 'lucide-react'
import { writeText as clipWriteText } from '@tauri-apps/plugin-clipboard-manager'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
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
  parentDir,
  baseName,
  type DirEntry
} from '@/lib/fs'
import { transferDownload, onFsTouched } from '@/lib/transfer'
import { onRemoteFsChange } from '@/lib/watch'
import { shadowChanged } from '@/lib/shadow'
import { useI18n } from '@/lib/i18n'

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
  /** 远程文件「下载到本机」发起后,登记一个传输 job(jobId, 标签, 本地目标目录) */
  onDownload?: (jobId: number, label: string, destDir: string) => void
}

interface Clipboard {
  // 多项剪贴板:支持 Ctrl 多选后一起复制/剪切(VS Code 式)。单选时即长度为 1。
  paths: string[]
  mode: 'cut' | 'copy'
}

// 文件树栏宽度的模块级记忆:组件重挂载(切 tab/换连接)后保留用户拖出来的宽度。
const treeWidthMem = { value: 260 }
const TREE_MIN_W = 160
const TREE_MAX_W = 640

export default function FilesView({
  root,
  onPickRoot,
  onOpenInTerminal,
  onPreview,
  openPath,
  host,
  onDownload
}: FilesViewProps): JSX.Element {
  const { t } = useI18n()
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
  const [gitMapReady, setGitMapReady] = useState(false)
  // 文件树定位请求(active 变化时让左侧树跳转到该文件,VS Code 式)
  const [revealReq, setRevealReq] = useState('')
  const revealSeq = useRef(0)
  const treePanelRef = useRef<HTMLDivElement | null>(null)
  // 左侧文件树栏宽度(可拖拽分隔条调整),供查看长文件名时拉宽。模块级持有,跨重挂载保留。
  const [treeWidth, setTreeWidth] = useState(treeWidthMem.value)
  // 多选(Ctrl/Cmd+点击):VS Code 式。普通点击=单选+打开;Ctrl/Cmd+点击=切换选中(不打开)。
  // 主要服务批量删除/复制。空集表示无多选,回退到单选(active/treeSel)语义。
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set())
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
    setMultiSel(new Set()) // 普通点击=单选语义,清掉之前的多选
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setActive(path)
  }

  // Ctrl/Cmd+点击:切换该节点在多选集合中的状态(不打开/不展开)。
  // 同时把它设为 treeSel,这样键盘快捷键(⌘C/⌘X/⌘V/Delete)有锚点、且 actionTargets
  // 能识别出"当前操作的项在多选里" → 对整组生效(VS Code 行为)。
  const toggleMulti = (entry: DirEntry): void => {
    setTreeSel(entry)
    setMultiSel((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
  }

  // 一个右键/快捷键操作实际作用的目标集合:若 target 落在多选里 → 整组;否则只它自己。
  // 这是 VS Code 行为——多选后对组内任一项执行复制/剪切/删除,作用于整个选择。
  const actionTargets = (target: DirEntry): string[] =>
    multiSel.size > 0 && multiSel.has(target.path)
      ? Array.from(multiSel)
      : [target.path]

  // 新建后定位:文件→作为标签打开(并触发树展开+定位);文件夹→仅请求树定位展开。
  // 关键:这会让新建项所在目录被展开,否则在未展开的目录里新建会"看不见"。
  // isDir 由调用方明确传入(new-file/new-folder 各自知道),不再靠扩展名猜——
  // 否则无扩展名的文件、或带点的文件夹(如 my.dir)都会被误判。
  const revealAndOpen = (createdPath: string, isDir: boolean): void => {
    if (!isDir) {
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

  // 拖拽分隔条调整左栏宽度。鼠标按下后全局监听 move/up,直到松手;夹在 [MIN, MAX]。
  // 写回 treeWidthMem,组件重挂载后保留。
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = treeWidth
    const onMove = (ev: MouseEvent): void => {
      const w = Math.min(TREE_MAX_W, Math.max(TREE_MIN_W, startW + (ev.clientX - startX)))
      treeWidthMem.value = w
      setTreeWidth(w)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    // 拖拽期间锁定光标/禁选,避免选中文本或光标闪烁
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 拉取「本轮 agent 改动」逐文件状态,建 绝对路径→状态字符 的 map(供文件树显标)。
  // 数据源是 shadow(本轮基线 diff),不是 git 工作区状态:没发过消息 = 空 map = 全树无标记;
  // 发消息后只标这一轮 agent 改过的文件(M/A/D)。git 工作区的未提交改动归 Git 页面管。
  const loadGit = async (): Promise<void> => {
    if (!root) {
      setGitMapReady(true)
      return
    }
    try {
      const changed = await shadowChanged(root, host)
      const m = new Map<string, string>()
      // 归一成 `/`:与 FileTree 的节点路径归一保持一致(Windows 本地项目 entry.path 是 `\`)。
      const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
      for (const [rel, ch] of Object.entries(changed)) {
        // shadowChanged 已返回绝对路径(repo/rel,后端已归一为 `/`)。
        // 兜底相对路径补全:用「是否已以 base 开头」判断绝对,而非 startsWith('/')——
        // 后者在 Windows 盘符路径(C:/...)上误判为相对,会把 base 重复拼一遍。
        const k = rel.replace(/\\/g, '/')
        const abs = k === base || k.startsWith(base + '/') ? k : `${base}/${k}`
        m.set(abs, ch)
      }
      setGitMap(m)
    } catch {
      setGitMap(new Map())
    } finally {
      setGitMapReady(true)
    }
  }

  // 进入/换工作目录时拉一次 git 状态
  useEffect(() => {
    setGitMapReady(false)
    void loadGit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, host])

  // 发消息(新一轮)时主动重拉 git 标记:贴合"按对话回合看改动"的心智,
  // 不必干等文件监听轮询。由 App 在 shadowBeginTurn 完成后派发。
  useEffect(() => {
    const onTurn = (): void => void loadGit()
    window.addEventListener('linco:turn-refresh', onTurn)
    return () => window.removeEventListener('linco:turn-refresh', onTurn)
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
        const dir = parentDir(p)
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

  // 传输落盘(拖入复制/移动/上传/下载)后主动刷新对应目录,不等 fs 轮询。
  useEffect(() => {
    const off = onFsTouched((e) => {
      // 只刷新与当前连接一致的(本地都是空串)
      if ((e.host || undefined) !== (host || undefined)) return
      if (e.dirs.length) refresh(...e.dirs)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host])

  // 取某 entry 的“所在目录”:文件夹用自身,文件用其父目录
  const dirOf = (entry: DirEntry): string =>
    entry.isDir ? entry.path : parentDir(entry.path)

  // 拖拽移动:把 src 移到 destDir 下,刷新两端
  const handleMove = async (src: string, destDir: string): Promise<void> => {
    const srcDir = parentDir(src)
    if (srcDir === destDir) return // 已在目标目录
    try {
      await movePath(src, destDir, host)
      if (tabs.includes(src)) closeTab(src)
      refresh(srcDir, destDir)
    } catch (e) {
      window.alert(t('files.moveFailed', { error: String(e) }))
    }
  }

  const handleAction = async (
    action: ContextAction,
    target: DirEntry
  ): Promise<void> => {
    try {
      switch (action) {
        case 'new-file': {
          const name = (await prompt(t('files.newFileName')))?.trim()
          if (!name) return
          const created = await createFile(target.path, name, host)
          refresh(target.path)
          // 展开目标目录并定位到新文件,顺手作为标签打开
          revealAndOpen(created, false)
          break
        }
        case 'new-folder': {
          const name = (await prompt(t('files.newFolderName')))?.trim()
          if (!name) return
          const created = await createDir(target.path, name, host)
          refresh(target.path)
          revealAndOpen(created, true)
          break
        }
        case 'reveal':
          await revealInFinder(target.path)
          break
        case 'download': {
          // 远程文件「下载到本机」:选目标文件夹 → 并行 SFTP 下载 → 进度坞
          if (!host) return
          const dest = await openDialog({
            directory: true,
            multiple: false,
            title: t('files.chooseDownloadDir')
          })
          if (!dest || typeof dest !== 'string') return
          const id = await transferDownload(host, [target.path], dest)
          onDownload?.(id, t('files.downloadingTo', { dir: dest }), dest)
          break
        }
        case 'preview':
          onPreview?.(target.path)
          break
        case 'open-terminal':
          onOpenInTerminal?.(target.path)
          break
        case 'cut':
          setClipboard({ paths: actionTargets(target), mode: 'cut' })
          break
        case 'copy':
          setClipboard({ paths: actionTargets(target), mode: 'copy' })
          break
        case 'paste': {
          if (!clipboard) return
          // 目标目录:target 是文件夹则进其内,是文件则进其父目录(与键盘粘贴一致)。
          const destDir = target.isDir ? target.path : parentDir(target.path)
          const srcDirs = new Set<string>()
          for (const src of clipboard.paths) {
            if (clipboard.mode === 'copy') {
              await fsCopy(src, destDir, host)
            } else {
              await movePath(src, destDir, host)
              srcDirs.add(parentDir(src)) // 剪切:源目录也要刷新
            }
          }
          if (clipboard.mode === 'cut') {
            setClipboard(null)
            refresh(...srcDirs)
          }
          refresh(destDir)
          break
        }
        case 'copy-path':
          await clipWriteText(target.path)
          break
        case 'copy-relative-path':
          await clipWriteText(
            root && target.path.startsWith(root)
              ? target.path.slice(root.length).replace(/^\//, '')
              : target.path
          )
          break
        case 'rename': {
          const name = (await prompt(t('files.renameTo'), target.name))?.trim()
          if (!name || name === target.name) return
          await renamePath(target.path, name, host)
          refresh(dirOf(target))
          break
        }
        case 'delete': {
          // 多选且 target 在其中 → 批量删除整组;否则只删 target(actionTargets 统一判定)。
          const batch = actionTargets(target)
          const msg =
            batch.length > 1
              ? t('files.confirmDeleteMany', { count: String(batch.length) })
              : target.isDir
                ? t('files.confirmDeleteFolder', { name: target.name })
                : t('files.confirmDelete', { name: target.name })
          const ok = window.confirm(msg)
          if (!ok) return
          // 先收集要刷新的父目录(删除前算,删后路径还在)
          const dirs = new Set(batch.map((p) => parentDir(p) || '/'))
          for (const p of batch) {
            await deletePath(p, host)
            if (tabs.includes(p)) closeTab(p)
          }
          setMultiSel(new Set())
          refresh(...dirs) // 刷新所有受影响父目录,删除的节点才会消失
          break
        }
      }
    } catch (e) {
      window.alert(t('files.actionFailed', { error: String(e) }))
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
          {t('files.pickDir')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 左:文件树 */}
      <div
        className="flex shrink-0 flex-col border-r border-black/8 outline-none"
        style={{ width: treeWidth }}
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
          } else if (e.key === 'Delete') {
            // 只用 Delete 键删除;不用 Backspace —— Backspace 太易误触,
            // 曾导致选中文件夹被整删。删除会走系统垃圾篓(可还原),但仍以最小惊讶为准。
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
            const destDir = treeSel.isDir ? treeSel.path : parentDir(treeSel.path)
            void handleAction('paste', { name: '', path: destDir, isDir: true })
          }
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
          <span className="truncate">{baseName(root) || root}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              refresh()
              void loadGit()
            }}
            className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-black/5 hover:text-ink"
            title={t('files.refresh')}
            aria-label={t('files.refresh')}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <FileTree
            root={root}
            selectedPath={active}
            onSelectFile={openFile}
            onSelect={(entry) => {
              // 普通(非 Ctrl/Cmd)点击任意节点 → 清除多选,回到单选语义。
              // Ctrl/Cmd+点击在 FileTree 内已提前返回,不会走到这里。
              setMultiSel(new Set())
              setTreeSel(entry)
            }}
            onContext={setMenu}
            onMove={handleMove}
            multiSel={multiSel}
            onToggleMulti={toggleMulti}
            refreshKey={refreshKey}
            refreshPaths={refreshPaths}
            host={host}
            revealRequest={revealReq}
            gitMap={gitMap}
          />
        </div>
      </div>

      {/* 可拖拽分隔条:拉宽左栏以查看长文件名。视觉上是细线,hover/拖拽时高亮。 */}
      <div
        onMouseDown={startResize}
        className="group relative w-px shrink-0 cursor-col-resize bg-black/8 hover:bg-[#5c8bd6]/50"
        title={t('files.resizeHint')}
      >
        {/* 加宽命中区(左右各 3px),让细线更好点中,但不占布局宽度 */}
        <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      </div>

      {/* 右:多标签编辑器 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
            {t('files.empty')}
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
                    {baseName(p)}
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
                  <FileViewer
                    path={p}
                    host={host}
                    repo={root}
                    changeStatus={gitMap.get(p.replace(/\\/g, '/'))}
                    changeStatusReady={gitMapReady}
                  />
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
          remote={!!host}
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
