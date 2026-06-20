import { useCallback, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'

interface PromptState {
  title: string
  defaultValue: string
  placeholder?: string
  resolve: (value: string | null) => void
}

/**
 * 应用内输入弹窗(替代 window.prompt)。
 *
 * 为什么需要:Tauri 的 macOS WebView(WKWebView)默认不实现 window.prompt,
 * 调用会静默返回 null —— 这正是"新建文件/文件夹/重命名"看着没反应的根因。
 * (window.confirm 在 WKWebView 里是支持的,所以删除确认能用。)
 *
 * 用法:
 *   const { prompt, dialog } = usePrompt()
 *   const name = await prompt('新建文件名')   // 取消返回 null
 *   ... 然后在 JSX 里渲染 {dialog}
 */
export function usePrompt(): {
  prompt: (title: string, defaultValue?: string, placeholder?: string) => Promise<string | null>
  dialog: JSX.Element | null
} {
  const [state, setState] = useState<PromptState | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useI18n()

  const prompt = useCallback(
    (title: string, defaultValue = '', placeholder?: string): Promise<string | null> =>
      new Promise((resolve) => {
        setState({ title, defaultValue, placeholder, resolve })
      }),
    []
  )

  const close = (value: string | null): void => {
    state?.resolve(value)
    setState(null)
  }

  const dialog = state ? (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 pt-[20vh]"
      onMouseDown={() => close(null)}
    >
      <div
        className="w-[360px] rounded-xl bg-canvas p-4 shadow-card ring-1 ring-black/10"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-[13px] font-medium text-ink">{state.title}</div>
        <input
          ref={inputRef}
          autoFocus
          defaultValue={state.defaultValue}
          placeholder={state.placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              close((e.target as HTMLInputElement).value.trim())
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close(null)
            }
          }}
          className="w-full rounded-md border border-black/15 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => close(null)}
            className="rounded-md px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-black/5"
          >
            {t('prompt.cancel')}
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => close(inputRef.current?.value.trim() ?? '')}
            className="rounded-md bg-ink px-3 py-1.5 text-[12.5px] text-canvas hover:opacity-90"
          >
            {t('prompt.confirm')}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { prompt, dialog }
}
