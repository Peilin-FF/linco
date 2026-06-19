import { useState } from 'react'
import { Languages, Bot } from 'lucide-react'

interface LanguagePickerProps {
  /** 选定 agent + 语言后回调(已写回 config + 装好本地那套) */
  onPick: (agent: 'claude' | 'codex', lang: 'zh' | 'en') => Promise<void>
}

// 首启选择:用哪个 agent(Claude / Codex)+ 开发语言(中 / 英)。
// 据此安装对应那套指令(claude→~/.claude/plugins;codex→~/.codex 的 AGENTS.md+skill),
// 中英分明,避免 HTML 设计规范混淆。中英文案并列,未选语言也能看懂。
export default function LanguagePicker({ onPick }: LanguagePickerProps): JSX.Element {
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const [lang, setLang] = useState<'zh' | 'en'>('zh')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await onPick(agent, lang)
    } catch (e) {
      setErr(String(e))
      setBusy(false)
    }
  }

  const card = (active: boolean): string =>
    `flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
      active
        ? 'border-accent bg-accent/5 ring-1 ring-accent'
        : 'border-black/10 bg-sidebar hover:border-black/20'
    }`

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-slate/40 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-[500px] rounded-2xl bg-canvas p-7 shadow-card ring-1 ring-black/10">
        <h2 className="mb-1 text-[17px] font-semibold text-ink">
          欢迎使用 Linco · Welcome
        </h2>
        <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
          选择你的 agent 和开发语言,Linco 会安装对应的工作流与 HTML 设计规范。
          <br />
          Pick your agent and language; Linco installs the matching workflow &amp; HTML design
          conventions.
        </p>

        {/* agent */}
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
            <Bot size={13} /> Agent
          </div>
          <div className="flex gap-3">
            <button onClick={() => setAgent('claude')} className={card(agent === 'claude')}>
              <div className="text-[15px] font-medium text-ink">Claude Code</div>
              <div className="text-[12px] text-ink-faint">装到 ~/.claude/plugins</div>
            </button>
            <button onClick={() => setAgent('codex')} className={card(agent === 'codex')}>
              <div className="text-[15px] font-medium text-ink">Codex</div>
              <div className="text-[12px] text-ink-faint">装到 ~/.codex(AGENTS.md + skill)</div>
            </button>
          </div>
        </div>

        {/* language */}
        <div className="mb-5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
            <Languages size={13} /> 语言 · Language
          </div>
          <div className="flex gap-3">
            <button onClick={() => setLang('zh')} className={card(lang === 'zh')}>
              <div className="text-[15px] font-medium text-ink">中文开发</div>
              <div className="text-[12px] text-ink-faint">产物与设计规范用中文</div>
            </button>
            <button onClick={() => setLang('en')} className={card(lang === 'en')}>
              <div className="text-[15px] font-medium text-ink">English</div>
              <div className="text-[12px] text-ink-faint">Artifacts &amp; design in English</div>
            </button>
          </div>
        </div>

        <button
          onClick={confirm}
          disabled={busy}
          className="w-full rounded-xl bg-accent px-4 py-2.5 text-[14px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {busy ? '安装中… · installing…' : '开始 · Get started'}
        </button>

        {err && (
          <p className="mt-3 text-[12px] text-red-600">
            安装失败 / install failed: {err}
          </p>
        )}
        <p className="mt-3 text-[11px] text-ink-faint">
          稍后可在设置中更改 · You can change this later in Settings.
        </p>
      </div>
    </div>
  )
}
