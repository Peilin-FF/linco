import { useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { importedThemes, importTheme, removeImportedTheme, ThemeImportError, THEME_IMPORT_LIMIT } from '@/lib/importedThemes'
import type { AppConfig } from '@/lib/config'
import ThemeGallery from './ThemeGallery'
import {
  THEMES,
  applyTheme,
  applyFont,
  UI_FONTS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME_ID,
  themeById
} from '@/lib/theme'

interface Props {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

// 设置 → 常规:界面语言 + 主题(预览卡)+ 字体/字号(预览)。改动即时生效 + 持久化。
export default function GeneralSettings({ config, onChange }: Props): JSX.Element {
  const { t, lang, setLang } = useI18n()
  const themeFile = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState('')
  const [personalThemes, setPersonalThemes] = useState(importedThemes)
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
  const readTheme = async (file?: File): Promise<void> => {
    if (!file) return
    setImportError('')
    try {
      if (file.size > THEME_IMPORT_LIMIT) throw new ThemeImportError('tooLarge')
      const theme = importTheme(await file.text())
      setPersonalThemes(importedThemes())
      pickTheme(theme.id)
    } catch (error) {
      setImportError(t(`settings.general.theme.import.${error instanceof ThemeImportError ? error.code : 'invalid'}`))
    }
  }
  const removeTheme = (id: string): void => {
    try {
      removeImportedTheme(id)
      setPersonalThemes(importedThemes())
      setImportError('')
      if (curTheme === id) pickTheme(DEFAULT_THEME_ID)
    } catch { setImportError(t('settings.general.theme.import.storage')) }
  }
  const pickFont = (f: string): void => {
    applyFont(f, curSize)
    onChange({ ...config, uiFont: f })
  }
  const pickSize = (s: number): void => {
    applyFont(curFont, s)
    onChange({ ...config, uiFontSize: s })
  }


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
              aria-pressed={lang === l}
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
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[14px] font-medium text-ink">{t('settings.general.theme')}</h3>
          <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] text-link" onClick={() => themeFile.current?.click()}>{t('settings.general.theme.import')}</button>
          <input ref={themeFile} type="file" accept=".json,application/json" className="hidden" aria-label={t('settings.general.theme.import')} onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            void readTheme(file)
          }} />
        </div>
        <p className="mb-3 text-[12px] text-ink-muted">{t('settings.general.theme.galleryHint')}</p>
        {importError && <p role="alert" className="mb-3 text-[12px] text-[var(--error)]">{importError}</p>}
        <ThemeGallery themes={[...personalThemes, ...THEMES]} activeId={curTheme} onPick={pickTheme} onRemove={removeTheme} />
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
              fontSize: curSize
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
