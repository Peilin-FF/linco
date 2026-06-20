// 轻量 i18n:不引第三方。key→文案表 + React Context。
// 用法:组件里 const { t, lang, setLang } = useI18n();  t('view.chat')
// 文案表见 ./messages/zh.ts 与 ./messages/en.ts。缺 key 时回退 key 本身(开发期可见)。
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { zh } from './messages/zh'
import { en } from './messages/en'

export type Lang = 'zh' | 'en'
export type Messages = Record<string, string>

const TABLES: Record<Lang, Messages> = { zh, en }

function detectDefault(): Lang {
  // 浏览器/系统语言以 zh 开头 → 中文,否则英文
  const n = (navigator.language || '').toLowerCase()
  return n.startsWith('zh') ? 'zh' : 'en'
}

interface I18nCtx {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const Ctx = createContext<I18nCtx | null>(null)

export function I18nProvider({
  initial,
  children
}: {
  initial?: string
  children: ReactNode
}): JSX.Element {
  const [lang, setLangState] = useState<Lang>(
    initial === 'zh' || initial === 'en' ? initial : detectDefault()
  )

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const tbl = TABLES[lang]
      let s = tbl[key] ?? TABLES.zh[key] ?? key
      if (vars) {
        for (const k of Object.keys(vars)) {
          s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k]))
        }
      }
      return s
    },
    [lang]
  )

  const value = useMemo<I18nCtx>(() => ({ lang, setLang: setLangState, t }), [lang, t])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx)
  if (!c) {
    // Provider 之外的兜底(理论上不该发生):用中文表直返
    return {
      lang: 'zh',
      setLang: () => {},
      t: (key) => zh[key] ?? key
    }
  }
  return c
}
