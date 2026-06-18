import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Folder,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Plus,
  ShieldAlert,
  Brain,
  ArrowUp,
  FolderOpen,
  Check,
  TerminalSquare,
  SquareSlash,
  Sparkles,
  File as FileIcon
} from 'lucide-react'
import { loadCompletions, type CompletionItem, type CompletionData } from '../lib/completion'
import { listDirCached } from '../lib/fs'

interface ChatInputProps {
  onSend?: (text: string) => void
  /** 实时转发原始按键到 PTY(用于 TUI 实时回显/命令提示) */
  onForward?: (data: string) => void
  /** 当前工作目录(claude 在此干活) */
  cwd?: string
  /** 最近用过的目录 */
  recentDirs?: string[]
  /** 选择/切换工作目录 */
  onPickDir?: (dir: string) => void
  /** 远程模式:此时"选择文件夹"走远端目录浏览器 */
  remote?: boolean
  /** 远程时打开远端目录浏览器 */
  onBrowseRemote?: () => void
  /** 紧凑模式:隐藏 +/完全访问/模型/effort,只留终端开关与发送 */
  compact?: boolean
  /** 底部终端是否打开 */
  terminalOpen?: boolean
  /** 切换底部终端面板 */
  onToggleTerminal?: () => void
  /** 输入区额外高度(拖拽 screen↔对话框分隔条时增大,px) */
  extraHeight?: number
  /** 当前 agent 启动命令(claude/codex…),用于取补全数据 */
  commandBase?: string
  /** 远程主机(空=本地),补全数据/文件按此取 */
  host?: string
}

// 取路径最后一段作为短名显示
function baseName(p: string): string {
  if (!p) return '选择工作目录'
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

// 按查询词排序候选:前缀匹配优先,其次包含匹配。前缀组内按"越短越靠前"
// (再按字母)排序,让 /re 时 /recap /review 这类紧凑匹配排在
// /requesting-code-review 前面,与 claude TUI 观感一致。空查询返回全部(原顺序)。
function rankByQuery(names: string[], q: string): string[] {
  if (!q) return names
  const prefix: string[] = []
  const contains: string[] = []
  for (const n of names) {
    const low = n.toLowerCase()
    if (low.startsWith(q)) prefix.push(n)
    else if (low.includes(q)) contains.push(n)
  }
  prefix.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return [...prefix, ...contains]
}

export default function ChatInput({
  onSend,
  onForward,
  cwd,
  recentDirs = [],
  onPickDir,
  remote,
  onBrowseRemote,
  compact,
  terminalOpen,
  onToggleTerminal,
  extraHeight = 0,
  commandBase,
  host
}: ChatInputProps): JSX.Element {
  const [value, setValue] = useState('')
  const [dirOpen, setDirOpen] = useState(false)
  const composingRef = useRef(false) // 中文输入法合成中
  const prevRef = useRef('') // 已转发到 PTY 的内容
  const taRef = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim().length > 0

  // —— 补全状态 ——
  const [comp, setComp] = useState<{
    items: CompletionItem[]
    sel: number
    // 触发符在 value 里的起始下标(含触发符)
    start: number
  } | null>(null)
  const compDataRef = useRef<{ key: string; data: CompletionData } | null>(null)
  const compGenRef = useRef(0) // 异步竞态守卫:只接受最新一次请求的结果

  // 计算 prev→next 的增量并转发(前缀 diff:末尾增删)
  const forwardDiff = (next: string): void => {
    if (!onForward) return
    const prev = prevRef.current
    let i = 0
    const min = Math.min(prev.length, next.length)
    while (i < min && prev[i] === next[i]) i++
    const del = prev.length - i
    let out = ''
    for (let k = 0; k < del; k++) out += '\x7f' // 退格
    out += next.slice(i) // 新增字符
    if (out) onForward(out)
    prevRef.current = next
  }

  const handleChange = (next: string): void => {
    setValue(next)
    // 合成中不转发,等 compositionend
    if (!composingRef.current) forwardDiff(next)
    // 合成中不触发补全(避免拼音半成品)
    if (!composingRef.current) updateCompletion(next)
  }

  // 预加载补全数据(命令/技能),按 host|command 缓存,切换连接/agent 自动失效
  const ensureData = async (): Promise<CompletionData | null> => {
    if (!commandBase) return null
    const key = `${host || ''}|${commandBase}`
    if (compDataRef.current && compDataRef.current.key === key) {
      return compDataRef.current.data
    }
    try {
      const d = await loadCompletions(commandBase, cwd, host)
      compDataRef.current = { key, data: d }
      return d
    } catch {
      return null
    }
  }

  // 预热补全数据:agent/连接就绪或切换时,后台先把命令/技能取好,
  // 这样用户敲下第一个 `/` 时弹层是瞬时的(否则要等 claude 启动 ~0.3s)。
  useEffect(() => {
    if (!commandBase) return
    loadCompletions(commandBase, cwd, host).catch(() => {})
    // cwd 变化不重取(命令/技能与目录无关),只在 agent/host 变时预热
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandBase, host])

  // 检测光标前最近的触发符(/ $ @),弹出/更新补全
  const updateCompletion = (text: string, atPos?: number): void => {
    const pos = atPos ?? taRef.current?.selectionStart ?? text.length
    const before = text.slice(0, pos)
    // 取光标前的"词"(到最近空白为止);首字符须是触发符
    const wsIdx = Math.max(
      before.lastIndexOf(' '),
      before.lastIndexOf('\n'),
      before.lastIndexOf('\t')
    )
    const tokenStart = wsIdx + 1
    const token = before.slice(tokenStart)
    const trigger = token[0]
    if (trigger !== '/' && trigger !== '$' && trigger !== '@') {
      setComp(null)
      return
    }
    const query = token.slice(1)
    const gen = ++compGenRef.current
    void buildItems(trigger, query, tokenStart, gen)
  }

  const buildItems = async (
    trigger: string,
    query: string,
    start: number,
    gen: number
  ): Promise<void> => {
    let items: CompletionItem[] = []
    const q = query.toLowerCase()
    if (trigger === '/' || trigger === '$') {
      const d = await ensureData()
      if (gen !== compGenRef.current) return // 已被更新的输入取代
      if (!d) {
        setComp(null)
        return
      }
      const src = trigger === '/' ? d.commands : d.skills
      const kind = trigger === '/' ? 'command' : 'skill'
      // 排序与 claude 一致:前缀匹配优先,再才是包含匹配(否则 /re 会被
      // remind-ers / architectu-re 这类"含 re"的名字淹没,看着像乱序的技能列表)
      items = rankByQuery(src, q)
        .slice(0, 50)
        .map((n) => ({
          kind: kind as 'command' | 'skill',
          label: n,
          insert: `${trigger}${n} `
        }))
    } else if (trigger === '@') {
      // 文件:在 cwd 下列目录;query 可含子路径(@src/ut → 列 cwd/src,过滤 ut)
      const slash = query.lastIndexOf('/')
      const sub = slash >= 0 ? query.slice(0, slash) : ''
      const leaf = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase()
      const base = cwd || ''
      const dir = sub ? `${base}/${sub}` : base
      try {
        const entries = await listDirCached(dir, host)
        const ranked = rankByQuery(
          entries.map((e) => e.name),
          leaf
        )
        const byName = new Map(entries.map((e) => [e.name, e]))
        items = ranked
          .slice(0, 50)
          .map((name) => byName.get(name)!)
          .map((e) => ({
            kind: 'file' as const,
            label: e.name + (e.isDir ? '/' : ''),
            // 目录:插入后保留 @ 以便继续往下钻;文件:补空格结束
            insert: e.isDir
              ? `@${sub ? sub + '/' : ''}${e.name}/`
              : `@${sub ? sub + '/' : ''}${e.name} `,
            isDir: e.isDir
          }))
      } catch {
        items = []
      }
    }
    if (gen !== compGenRef.current) return // 异步期间又有新输入,丢弃本次结果
    if (items.length === 0) {
      setComp(null)
    } else {
      setComp({ items, sel: 0, start })
    }
  }

  // 选中补全项:把 [start, 光标) 替换为 insert
  const applyCompletion = (item: CompletionItem): void => {
    if (!comp) return
    const pos = taRef.current?.selectionStart ?? value.length
    const next = value.slice(0, comp.start) + item.insert + value.slice(pos)
    const caret = comp.start + item.insert.length
    setValue(next)
    if (!composingRef.current) forwardDiff(next)
    // 文件目录补全后继续列子目录;否则关闭
    if (item.kind === 'file' && item.isDir) {
      updateCompletion(next, caret)
    } else {
      setComp(null)
    }
    // 光标移到插入末尾
    setTimeout(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(caret, caret)
    }, 0)
  }

  const handleSend = (): void => {
    if (!canSend) return
    const text = value.trim()
    // 兜底重发:先清空 claude 输入行(Ctrl-U),重打完整文本,再回车提交,
    // 保证即使逐字转发期间有偏差,最终命令也准确无误。
    onForward?.('\x15' + text + '\r')
    onSend?.(text)
    setValue('')
    prevRef.current = ''
    setComp(null)
  }

  const pickFolder = async (): Promise<void> => {
    setDirOpen(false)
    if (remote) {
      onBrowseRemote?.() // 远程:走远端目录浏览器
      return
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择工作目录'
    })
    if (typeof selected === 'string') onPickDir?.(selected)
  }

  return (
    <div className="rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 顶部:工作目录选择 + (紧凑模式)终端开关 */}
      <div className={compact ? 'relative flex items-center pr-2' : 'relative'}>
        <button
          onClick={() => setDirOpen((o) => !o)}
          className={`flex items-center gap-1.5 rounded-t-2xl px-4 pt-3 pb-1 text-[14px] text-ink-muted hover:text-ink ${
            compact ? 'min-w-0' : 'max-w-full'
          }`}
          title={cwd || '未选择工作目录'}
        >
          <Folder size={16} className="shrink-0 text-ink-faint" />
          <span className="truncate">{baseName(cwd ?? '')}</span>
          {dirOpen ? (
            <ChevronUp size={15} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={15} className="shrink-0 text-ink-faint" />
          )}
        </button>
        {/* 终端按钮:仅精简模式下放项目名旁边、与文字平齐 */}
        {compact && onToggleTerminal && (
          <button
            onClick={onToggleTerminal}
            title={terminalOpen ? '关闭终端' : '打开终端'}
            className={`ml-1 mt-1 flex shrink-0 items-center rounded-md p-1 ${
              terminalOpen
                ? 'bg-ink/10 text-ink'
                : 'text-ink-faint hover:bg-black/5 hover:text-ink'
            }`}
          >
            <TerminalSquare size={15} />
          </button>
        )}
        {compact && <div className="flex-1" />}
        {dirOpen && (
          <div className="absolute bottom-full left-3 z-20 mb-1 flex max-h-[240px] min-w-[260px] max-w-[420px] flex-col overflow-hidden rounded-xl bg-canvas py-1 shadow-card ring-1 ring-black/5">
            <button
              onClick={pickFolder}
              className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-black/5"
            >
              <FolderOpen size={15} className="text-ink-muted" />
              选择文件夹…
            </button>
            {recentDirs.length > 0 && (
              <>
                <div className="my-1 h-px shrink-0 bg-black/8" />
                <div className="shrink-0 px-3 py-1 text-[11px] text-ink-faint">
                  最近
                </div>
                {/* 固定约 3 个高度,第 4 个起在框内滚动(不累加撑高) */}
                <div className="max-h-[90px] overflow-y-auto">
                  {recentDirs.map((d) => (
                    <button
                      key={d}
                      onClick={() => {
                        setDirOpen(false)
                        onPickDir?.(d)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-black/5"
                      title={d}
                    >
                      {d === cwd ? (
                        <Check size={14} className="shrink-0 text-accent" />
                      ) : (
                        <Folder size={14} className="shrink-0 text-ink-faint" />
                      )}
                      <span className="flex-1 truncate text-ink-muted">
                        {baseName(d)}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className={compact ? 'relative flex items-center' : 'relative'}>
        {/* 补全弹层:向上弹(输入框在底部),和项目下拉一致 */}
        {comp && (
          <div className="absolute bottom-full left-3 right-3 z-30 mb-1 flex max-h-[260px] flex-col overflow-y-auto rounded-xl bg-canvas py-1 shadow-card ring-1 ring-black/5">
            {/* 分组标题:像 VS Code 那样标明这一列是命令/技能/文件 */}
            <div className="shrink-0 px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              {comp.items[0]?.kind === 'command'
                ? 'Slash Commands'
                : comp.items[0]?.kind === 'skill'
                  ? 'Skills'
                  : 'Files'}
            </div>
            {comp.items.map((it, i) => (
              <button
                key={it.kind + it.label}
                // 用 mousedown 防止 textarea 失焦后光标位置丢失
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyCompletion(it)
                }}
                onMouseEnter={() =>
                  setComp((c) => (c ? { ...c, sel: i } : c))
                }
                className={`flex w-full shrink-0 items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
                  i === comp.sel ? 'bg-accent/12 text-ink' : 'text-ink-muted'
                }`}
              >
                {it.kind === 'command' ? (
                  <SquareSlash size={14} className="shrink-0 text-accent" />
                ) : it.kind === 'skill' ? (
                  <Sparkles size={14} className="shrink-0 text-accent" />
                ) : it.isDir ? (
                  <Folder size={14} className="shrink-0 text-ink-faint" />
                ) : (
                  <FileIcon size={14} className="shrink-0 text-ink-faint" />
                )}
                <span className="truncate">{it.label}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false
            const v = (e.target as HTMLTextAreaElement).value
            forwardDiff(v)
            updateCompletion(v)
          }}
          onKeyDown={(e) => {
            // 补全弹层打开时,方向键/回车/Tab/Esc 优先给补全
            if (comp) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setComp((c) =>
                  c ? { ...c, sel: (c.sel + 1) % c.items.length } : c
                )
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setComp((c) =>
                  c
                    ? { ...c, sel: (c.sel - 1 + c.items.length) % c.items.length }
                    : c
                )
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                applyCompletion(comp.items[comp.sel])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setComp(null)
                return
              }
            }
            // 回车提交;Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
              e.preventDefault()
              handleSend()
            }
          }}
          onKeyUp={(e) => {
            // 左右键/点击移动光标后重算触发(不改内容,handleChange 不触发)
            if (
              !composingRef.current &&
              (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
            ) {
              updateCompletion(value)
            }
          }}
          rows={compact ? 1 : 2}
          placeholder="向 Linco 提问,输入 @ 添加文件,/ 使用命令,$ 使用技能,# 关联对话"
          style={extraHeight ? { minHeight: extraHeight } : undefined}
          className={`block resize-none bg-transparent px-4 py-2 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none ${
            compact ? 'min-w-0 flex-1' : 'w-full'
          }`}
        />
        {/* 紧凑模式:发送按钮与输入行平齐,省掉底部单独一行 */}
        {compact && (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors ${
              canSend
                ? 'bg-ink text-canvas hover:opacity-90'
                : 'bg-black/10 text-ink-faint'
            }`}
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>

      {/* 底部工具条(仅非紧凑模式) */}
      {!compact && (
        <div className="flex items-center gap-2 px-3 pb-3 pt-1">
          <button className="rounded-lg p-1.5 text-ink-muted hover:bg-black/5">
            <Plus size={18} />
          </button>
          <button className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-accent hover:bg-accent/5">
            <ShieldAlert size={15} />
            <span>完全访问</span>
            <ChevronDown size={14} />
          </button>

          <div className="flex-1" />

          <TerminalToggle open={terminalOpen} onClick={onToggleTerminal} />
          <button className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-ink-muted hover:bg-black/5">
            <span>claude-opus-4-8-cc</span>
            <ChevronDown size={14} className="text-ink-faint" />
          </button>
          <button className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-ink-muted hover:bg-black/5">
            <Brain size={15} />
            <span>高</span>
            <ChevronDown size={14} className="text-ink-faint" />
          </button>

          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              canSend
                ? 'bg-ink text-canvas hover:opacity-90'
                : 'bg-black/10 text-ink-faint'
            }`}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      )}
    </div>
  )
}

// 终端面板开关按钮
function TerminalToggle({
  open,
  onClick
}: {
  open?: boolean
  onClick?: () => void
}): JSX.Element | null {
  if (!onClick) return null
  return (
    <button
      onClick={onClick}
      title={open ? '关闭终端' : '打开终端'}
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] ${
        open
          ? 'bg-ink/10 text-ink'
          : 'text-ink-muted hover:bg-black/5 hover:text-ink'
      }`}
    >
      <TerminalSquare size={15} />
    </button>
  )
}
