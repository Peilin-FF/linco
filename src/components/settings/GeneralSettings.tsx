import { useI18n } from '@/lib/i18n'
import type { AppConfig } from '@/lib/config'
import {
  THEMES,
  applyTheme,
  applyFont,
  UI_FONTS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME_ID,
  themeById,
  type Theme
} from '@/lib/theme'

interface Props {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

// 设置 → 常规:界面语言 + 主题(预览卡)+ 字体/字号(预览)。改动即时生效 + 持久化。
export default function GeneralSettings({ config, onChange }: Props): JSX.Element {
  const { t, lang, setLang } = useI18n()
  const activeTheme = themeById(config.theme || DEFAULT_THEME_ID)
  const curTheme = activeTheme.id
  const curFont = config.uiFont || ''
  const curSize = config.uiFontSize || DEFAULT_FONT_SIZE

  const pickLang = (l: 'zh' | 'en'): void => {
    setLang(l)
    onChange({ ...config, language: l })
  }
  const pickTheme = (id: string): void => {
    applyTheme(id)
    onChange({ ...config, theme: id })
  }
  const pickFont = (f: string): void => {
    applyFont(f, curSize)
    onChange({ ...config, uiFont: f })
  }
  const pickSize = (s: number): void => {
    applyFont(curFont, s)
    onChange({ ...config, uiFontSize: s })
  }

  const light = THEMES.filter((x) => !x.dark)
  const dark = THEMES.filter((x) => x.dark)

  return (
    <div className="max-w-[760px]">
      <h2 className="mb-6 text-[20px] font-semibold text-ink">
        {t('settings.general.title')}
      </h2>

      {/* 界面语言 */}
      <section className="mb-8">
        <h3 className="mb-3 text-[14px] font-medium text-ink">
          {t('settings.general.language')}
        </h3>
        <div className="inline-flex rounded-lg border border-black/10 p-0.5">
          {(['zh', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => pickLang(l)}
              className={`rounded-md px-4 py-1.5 text-[13px] transition-colors ${
                lang === l ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t(`settings.general.language.${l}`)}
            </button>
          ))}
        </div>
      </section>

      {/* 主题 */}
      <section className="mb-8">
        <h3 className="mb-3 text-[14px] font-medium text-ink">
          {t('settings.general.theme')}
        </h3>
        <div className="mb-2 text-[12px] uppercase tracking-wide text-ink-faint">
          {t('settings.general.theme.light')}
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3">
          {light.map((th) => (
            <ThemeCard
              key={th.id}
              theme={th}
              active={curTheme === th.id}
              activeLabel={t('settings.general.theme.active')}
              onClick={() => pickTheme(th.id)}
            />
          ))}
        </div>
        <div className="mb-2 text-[12px] uppercase tracking-wide text-ink-faint">
          {t('settings.general.theme.dark')}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {dark.map((th) => (
            <ThemeCard
              key={th.id}
              theme={th}
              active={curTheme === th.id}
              activeLabel={t('settings.general.theme.active')}
              onClick={() => pickTheme(th.id)}
            />
          ))}
        </div>
      </section>

      {/* 字体 + 字号 */}
      <section className="mb-4">
        <h3 className="mb-3 text-[14px] font-medium text-ink">
          {t('settings.general.font')}
        </h3>
        <div className="mb-4 flex flex-wrap items-end gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-ink-muted">
              {t('settings.general.fontFamily')}
            </span>
            <select
              value={curFont}
              onChange={(e) => pickFont(e.target.value)}
              className="min-w-[200px] rounded-lg border border-black/10 bg-canvas px-3 py-1.5 text-[13px] text-ink"
            >
              {UI_FONTS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-ink-muted">
              {t('settings.general.fontSize')} · {curSize}px
            </span>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={curSize}
              onChange={(e) => pickSize(Number(e.target.value))}
              className="w-[200px]"
            />
          </label>
        </div>
        {/* 预览框:跟随当前字体/字号(用 var,因为已即时 apply 到 :root) */}
        <div className="rounded-xl border border-black/10 bg-sidebar p-4">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">
            {t('settings.general.preview')}
          </div>
          <p
            className="text-ink"
            style={{
              fontFamily: curFont || undefined,
              fontSize: curSize + 2
            }}
          >
            {t('settings.general.fontPreview.text')}
          </p>
          <pre
            className="mt-2 overflow-x-auto rounded-lg border p-3"
            style={{
              background: activeTheme.vars.canvas,
              borderColor: activeTheme.vars.border,
              color: activeTheme.vars.ink,
              fontFamily: 'ui-monospace, Menlo, monospace',
              fontSize: curSize
            }}
          >
            <span style={{ color: activeTheme.syntax.keyword }}>const</span>{' '}
            <span style={{ color: activeTheme.syntax.variable }}>theme</span> ={' '}
            <span style={{ color: activeTheme.syntax.string }}>"{curTheme}"</span>;
          </pre>
        </div>
      </section>
    </div>
  )
}

// 主题预览卡:小代码高亮样张 + 当前生效标记。配色取自主题 vars。
function ThemeCard({
  theme,
  active,
  activeLabel,
  onClick
}: {
  theme: Theme
  active: boolean
  activeLabel: string
  onClick: () => void
}): JSX.Element {
  const v = theme.vars
  const syntax = theme.syntax
  return (
    <button
      onClick={onClick}
      className={`overflow-hidden rounded-xl border text-left transition-shadow ${
        active ? 'border-accent ring-2 ring-accent/40' : 'border-black/10 hover:border-black/25'
      }`}
    >
      {/* 标题条 */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[13px] font-medium text-ink">{theme.name}</span>
        {active && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {activeLabel}
          </span>
        )}
      </div>
      {/* 代码样张(用主题真实配色) */}
      <div
        className="px-3 py-3 font-mono text-[11px] leading-relaxed"
        style={{ background: v.canvas, color: v.ink }}
      >
        <div>
          <span style={{ color: syntax.keyword }}>const</span>{' '}
          <span style={{ color: syntax.variable }}>themePreview</span> = {'{'}
        </div>
        <div style={{ paddingLeft: 12 }}>
          surface: <span style={{ color: syntax.string }}>"{theme.id}"</span>,
        </div>
        <div style={{ paddingLeft: 12, color: v.inkMuted }}>
          accent: <span style={{ color: syntax.string }}>"{v.accent}"</span>,
        </div>
        <div>{'}'};</div>
      </div>
    </button>
  )
}
