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
  TerminalSquare
} from 'lucide-react'
import { providerCaps, type AgentConfig } from '@/lib/config'
import { useI18n } from '@/lib/i18n'

/**
 * 这次 keydown 是否发生在输入法(IME)合成态中 —— 用中文/日文等输入法打字、按回车
 * 确认候选词那一下,就属于合成态。此时回车意在"确认选词",绝不能当成"提交消息"。
 *
 * 为什么不能只靠 React 的 onCompositionStart/End 维护的 composingRef:
 * 在部分平台(尤其 Windows IME)上,compositionend 可能**先于**确认键的 keydown 触发,
 * 于是 keydown 到达时 ref 已被置回 false,守卫失效 → 误提交。
 * 而原生事件自带的 `isComposing` 是事件派发那一刻就定死的快照,不受跨事件时序竞争影响;
 * keyCode === 229 是旧式 IME 占位码,作双保险。两者任一为真即视作合成中。
 */
function isImeComposing(
  e: { nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number },
  composingRef: { current: boolean }
): boolean {
  const native = e.nativeEvent
  return (
    composingRef.current ||
    native?.isComposing === true ||
    native?.keyCode === 229 ||
    e.keyCode === 229
  )
}

interface ChatInputProps {
  onSend?: (text: string) => void
  /** 实时转发原始按键到 PTY(用于 TUI 实时回显/命令提示) */
  onForward?: (data: string) => void
  /** 当前工作目录(agent 在此运行) */
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
  /** 当前 agent/model 展示名 */
  agentLabel?: string
  /** 当前默认 agent(用于模型/权限/effort 下拉) */
  agent?: AgentConfig
  /** 改某字段 → 写配置(下次启动该会话生效) */
  onPatchAgent?: (patch: Partial<AgentConfig>) => void
}

// 取路径最后一段作为短名显示(空路径返回 ''，由调用方用 t() 兜底)
function baseName(p: string): string {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
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
  agentLabel = 'Agent',
  agent,
  onPatchAgent
}: ChatInputProps): JSX.Element {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  // 三个下拉的开合(模型/权限/effort),互斥
  const [openMenu, setOpenMenu] = useState<'model' | 'perm' | 'effort' | null>(null)
  const [dirOpen, setDirOpen] = useState(false)
  // 点下拉外部 / 按 Esc → 关闭下拉(不用回去再点一次)
  useEffect(() => {
    if (!openMenu && !dirOpen) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t?.closest('[data-chatmenu]')) setOpenMenu(null)
      if (!t?.closest('[data-dirmenu]')) setDirOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpenMenu(null)
        setDirOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu, dirOpen])
  const composingRef = useRef(false) // 中文输入法合成中
  const prevRef = useRef('') // 已转发到 PTY 的内容
  const taRef = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim().length > 0
  // 已发送消息历史(本会话)+ 当前翻阅位置。histIdx === null = 没在翻历史(停在草稿)。
  const historyRef = useRef<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const draftRef = useRef('') // 进入历史前的草稿,翻到底退出时还原

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
    // 用户手动改了内容 → 退出历史翻阅态(此后 ↑/↓ 基于当前编辑内容)
    if (histIdx !== null) setHistIdx(null)
    // 合成中不转发,等 compositionend
    if (!composingRef.current) forwardDiff(next)
  }

  const handleSend = (): void => {
    if (!canSend) return
    const text = value.trim()
    // 文本在打字时已由 forwardDiff 逐字转发进 TUI(且补全已生效),回车时**只需提交**。
    // 不再 Ctrl-U 清行 + 重打全文 —— claude/codex 不认 Ctrl-U,重打会叠成 "hellohello"。
    onSend?.(text) // 记 git 基线 / 用量(不写 PTY)
    // 单独发一个 \r 提交:用下一帧发,避免和刚转发的字符 burst 混在一起被当 paste 换行。
    setTimeout(() => onForward?.('\r'), 16)
    // 记入发送历史(去掉与上一条完全相同的连续重复),重置翻阅位置。
    if (historyRef.current[historyRef.current.length - 1] !== text) {
      historyRef.current.push(text)
    }
    setHistIdx(null)
    draftRef.current = ''
    setValue('')
    prevRef.current = ''
  }

  // 把 textarea 内容整体替换(翻历史用):同步转发给 TUI + 光标置末尾。
  const replaceValue = (next: string): void => {
    setValue(next)
    if (!composingRef.current) forwardDiff(next)
    // 光标移到末尾(下一帧,等 value 更新到 DOM)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) {
        ta.selectionStart = ta.selectionEnd = next.length
      }
    })
  }

  // 光标是否在第一行(↑ 翻上一条的边界)/最后一行(↓ 翻下一条的边界)。
  const atFirstLine = (ta: HTMLTextAreaElement): boolean =>
    ta.value.lastIndexOf('\n', ta.selectionStart - 1) === -1
  const atLastLine = (ta: HTMLTextAreaElement): boolean =>
    ta.value.indexOf('\n', ta.selectionEnd) === -1

  // ↑:翻到更早的已发送消息。histIdx===null 时先存草稿。
  const historyPrev = (): void => {
    const h = historyRef.current
    if (h.length === 0) return
    const cur = histIdx === null ? h.length : histIdx
    if (cur <= 0) return // 已是最早
    if (histIdx === null) draftRef.current = value // 进入历史前存草稿
    const idx = cur - 1
    setHistIdx(idx)
    replaceValue(h[idx])
  }

  // ↓:翻到更晚的已发送消息;翻过最后一条则回到草稿、退出历史。
  const historyNext = (): void => {
    const h = historyRef.current
    if (histIdx === null) return // 不在历史里
    const idx = histIdx + 1
    if (idx >= h.length) {
      setHistIdx(null)
      replaceValue(draftRef.current)
      return
    }
    setHistIdx(idx)
    replaceValue(h[idx])
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
      title: t('chat.pickDir')
    })
    if (typeof selected === 'string') onPickDir?.(selected)
  }

  return (
    <div className="rounded-2xl bg-canvas shadow-card ring-1 ring-black/5">
      {/* 顶部:工作目录选择 + (紧凑模式)终端开关 */}
      <div
        data-dirmenu
        className={compact ? 'relative flex items-center pr-2' : 'relative'}
      >
        <button
          onClick={() => setDirOpen((o) => !o)}
          className={`flex items-center gap-1.5 rounded-t-2xl px-4 pt-3 pb-1 text-[14px] text-ink-muted hover:text-ink ${
            compact ? 'min-w-0' : 'max-w-full'
          }`}
          title={cwd || t('chat.pickDir.none')}
        >
          <Folder size={16} className="shrink-0 text-ink-faint" />
          <span className="truncate">{baseName(cwd ?? '') || t('chat.pickDir')}</span>
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
            title={terminalOpen ? t('chat.terminal.close') : t('chat.terminal.open')}
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
              {t('chat.pickFolder')}
            </button>
            {recentDirs.length > 0 && (
              <>
                <div className="my-1 h-px shrink-0 bg-black/8" />
                <div className="shrink-0 px-3 py-1 text-[11px] text-ink-faint">
                  {t('chat.recent')}
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
          }}
          onKeyDown={(e) => {
            // 合成态(IME 选词)中的所有按键都不触发提交/快捷键 —— 用 isImeComposing
            // 同时检查原生事件的 isComposing/keyCode,避免 compositionend 早于 keydown 的竞态。
            const composing = isImeComposing(e, composingRef)
            // 回车提交;Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey && !composing) {
              e.preventDefault()
              handleSend()
              return
            }
            // Esc:像在 TUI 里一样打断当前对话(转发 ESC 给 agent)。
            // 但有下拉菜单打开时,Esc 优先关菜单(由上面的全局监听处理),不打断。
            if (
              e.key === 'Escape' &&
              !composing &&
              !openMenu &&
              !dirOpen
            ) {
              e.preventDefault()
              onForward?.('\x1b')
              return
            }
            // ↑/↓:多行优先光标移动,仅在首行↑/末行↓时翻已发送消息历史。合成中不处理。
            if (e.key === 'ArrowUp' && !composing) {
              const ta = e.currentTarget
              if (atFirstLine(ta) && historyRef.current.length > 0) {
                e.preventDefault()
                historyPrev()
              }
              return
            }
            if (e.key === 'ArrowDown' && !composing) {
              const ta = e.currentTarget
              if (atLastLine(ta) && histIdx !== null) {
                e.preventDefault()
                historyNext()
              }
              return
            }
          }}
          rows={compact ? 1 : 2}
          placeholder={t('chat.placeholder')}
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
                ? 'bg-accent text-white hover:bg-[var(--button-hover)]'
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

          {/* 完全访问 / 权限模式下拉 */}
          {(() => {
            if (!agent || !onPatchAgent) {
              return (
                <button className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-accent">
                  <ShieldAlert size={15} />
                  <span>{t('chat.fullAccess')}</span>
                </button>
              )
            }
            const caps = providerCaps(agent)
            const cur =
              caps.permissions.find((o) => o.value === agent.permission) ??
              caps.permissions[0]
            return (
              <div className="relative" data-chatmenu>
                <button
                  onClick={() =>
                    setOpenMenu((m) => (m === 'perm' ? null : 'perm'))
                  }
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-accent hover:bg-accent/5"
                >
                  <ShieldAlert size={15} />
                  <span>{cur.label}</span>
                  {openMenu === 'perm' ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
                {openMenu === 'perm' && (
                  <Menu
                    options={caps.permissions}
                    current={agent.permission}
                    onPick={(v) => {
                      onPatchAgent({ permission: v })
                      setOpenMenu(null)
                    }}
                  />
                )}
              </div>
            )
          })()}

          <div className="flex-1" />

          <TerminalToggle
            open={terminalOpen}
            onClick={onToggleTerminal}
            openLabel={t('chat.terminal.open')}
            closeLabel={t('chat.terminal.close')}
          />

          {/* 模型下拉:列 agent.models(空则只显当前) */}
          {agent && onPatchAgent && (agent.models?.length ?? 0) > 0 ? (
            <div className="relative" data-chatmenu>
              <button
                onClick={() => setOpenMenu((m) => (m === 'model' ? null : 'model'))}
                className="flex max-w-[220px] items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-ink-muted hover:bg-black/5"
                title={agentLabel}
              >
                <span className="truncate">{agentLabel}</span>
                {openMenu === 'model' ? (
                  <ChevronUp size={14} className="text-ink-faint" />
                ) : (
                  <ChevronDown size={14} className="text-ink-faint" />
                )}
              </button>
              {openMenu === 'model' && (
                <Menu
                  options={agent.models.map((m) => ({ value: m, label: m }))}
                  current={agent.model}
                  onPick={(v) => {
                    onPatchAgent({ model: v })
                    setOpenMenu(null)
                  }}
                />
              )}
            </div>
          ) : (
            <span
              className="flex max-w-[220px] items-center gap-1.5 px-2 py-1 text-[13px] text-ink-muted"
              title={agentLabel}
            >
              <span className="truncate">{agentLabel}</span>
            </span>
          )}

          {/* effort 下拉 */}
          {agent && onPatchAgent ? (
            (() => {
              const caps = providerCaps(agent)
              const cur =
                caps.efforts.find((o) => o.value === agent.effort) ??
                caps.efforts[0]
              return (
                <div className="relative" data-chatmenu>
                  <button
                    onClick={() =>
                      setOpenMenu((m) => (m === 'effort' ? null : 'effort'))
                    }
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-ink-muted hover:bg-black/5"
                  >
                    <Brain size={15} />
                    <span>{cur.label}</span>
                    {openMenu === 'effort' ? (
                      <ChevronUp size={14} className="text-ink-faint" />
                    ) : (
                      <ChevronDown size={14} className="text-ink-faint" />
                    )}
                  </button>
                  {openMenu === 'effort' && (
                    <Menu
                      options={caps.efforts}
                      current={agent.effort}
                      onPick={(v) => {
                        onPatchAgent({ effort: v })
                        setOpenMenu(null)
                      }}
                    />
                  )}
                </div>
              )
            })()
          ) : null}

          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              canSend
                ? 'bg-accent text-white hover:bg-[var(--button-hover)]'
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

// 控件下拉菜单:向上弹出(对话框在底部),列选项,当前项打勾。
function Menu({
  options,
  current,
  onPick
}: {
  options: { value: string; label: string }[]
  current: string
  onPick: (value: string) => void
}): JSX.Element {
  return (
    <div
      data-chatmenu
      className="absolute bottom-full right-0 z-50 mb-1 min-w-[160px] overflow-hidden rounded-xl bg-canvas py-1 shadow-card ring-1 ring-black/10"
    >
      {options.map((o) => (
        <button
          key={o.value || '__default'}
          // 用 mousedown 提交:确保在任何「失焦/外部点击」关闭之前先选中,不会点了没反应
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onPick(o.value)
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-black/5"
        >
          <span className="flex-1 truncate">{o.label}</span>
          {o.value === current && <Check size={13} className="text-accent" />}
        </button>
      ))}
    </div>
  )
}

// 终端面板开关按钮
function TerminalToggle({
  open,
  onClick,
  openLabel,
  closeLabel
}: {
  open?: boolean
  onClick?: () => void
  openLabel: string
  closeLabel: string
}): JSX.Element | null {
  if (!onClick) return null
  return (
    <button
      onClick={onClick}
      title={open ? closeLabel : openLabel}
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
