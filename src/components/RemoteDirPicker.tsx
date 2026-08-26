import { useEffect, useRef, useState } from 'react'
import { Folder, CornerLeftUp, X, Check, Loader2 } from 'lucide-react'
import { listDir } from '@/lib/fs'
import { useI18n } from '@/lib/i18n'

interface RemoteDirPickerProps {
  host: string
  initialPath: string
  onPick: (dir: string) => void
  onClose: () => void
}

// 把输入框内容拆成「要列的目录」+「过滤词」。
//   "/home/f/exp"  → dir="/home/f", filter="exp"
//   "/home/f/"     → dir="/home/f", filter=""
//   "/"            → dir="/",       filter=""
function splitInput(input: string): { dir: string; filter: string } {
  if (!input) return { dir: '/', filter: '' }
  const idx = input.lastIndexOf('/')
  if (idx < 0) return { dir: '/', filter: input } // 无斜杠:在根下过滤
  const dir = input.slice(0, idx) || '/'
  const filter = input.slice(idx + 1)
  return { dir, filter }
}

/**
 * 远端目录选择器(VS Code Quick Open 式):
 * 单一输入框 = 实时路径过滤器。打字时下方列表立即按「目录段 + 过滤词」筛选,
 * 跨层级:输入 /a/b/c 会列 /a/b 并用 c 过滤;点匹配项即进入该目录。
 */
export default function RemoteDirPicker({
  host,
  initialPath,
  onPick,
  onClose
}: RemoteDirPickerProps): JSX.Element {
  const { t } = useI18n()
  const init = (initialPath || '/').replace(/\/+$/, '') || '/'
  const [input, setInput] = useState(init + '/')
  const [listedDir, setListedDir] = useState('') // 当前已列出的目录
  const [dirs, setDirs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debRef = useRef<number | null>(null)

  const { dir, filter } = splitInput(input)

  // 选中的"确认目录":输入以 / 结尾用 input 本身,否则用 listedDir(目录段)
  const targetDir = input.replace(/\/+$/, '') || '/'

  // 目录段变化 → 防抖列目录
  useEffect(() => {
    if (debRef.current != null) clearTimeout(debRef.current)
    debRef.current = window.setTimeout(() => {
      if (dir === listedDir) return
      let alive = true
      setLoading(true)
      setErr(null)
      listDir(dir, host)
        .then((entries) => {
          if (!alive) return
          setDirs(entries.filter((e) => e.isDir).map((e) => e.name))
          setListedDir(dir)
        })
        .catch((e) => alive && (setErr(String(e)), setDirs([])))
        .finally(() => alive && setLoading(false))
      return () => {
        alive = false
      }
    }, 180)
    return () => {
      if (debRef.current != null) clearTimeout(debRef.current)
    }
  }, [dir, host, listedDir])

  useEffect(() => {
    inputRef.current?.focus()
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [onClose])

  // 进入某子目录:把输入设为 dir/name/ (尾随斜杠 → 列其内容)
  const enter = (name: string): void => {
    const base = dir === '/' ? '' : dir
    setInput(`${base}/${name}/`)
    inputRef.current?.focus()
  }

  const goUp = (): void => {
    const p = (listedDir || dir).replace(/\/+$/, '')
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    setInput(parent === '/' ? '/' : parent + '/')
    inputRef.current?.focus()
  }

  const shown = dirs.filter((d) =>
    d.toLowerCase().includes(filter.trim().toLowerCase())
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[440px] w-[560px] flex-col overflow-hidden rounded-2xl bg-canvas shadow-card ring-1 ring-black/10"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-2">
          <span className="text-[13px] font-medium text-ink">
            {t('remoteDir.title')}
          </span>
          <span className="rounded bg-sidebar px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {host}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        {/* 智能输入框:打字即过滤(VS Code 式) */}
        <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-2">
          <button
            onClick={goUp}
            className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-black/5 hover:text-ink"
            title={t('remoteDir.parent')}
          >
            <CornerLeftUp size={15} />
          </button>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('remoteDir.pathPlaceholder')}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-black/10 bg-canvas px-2 py-1.5 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
          />
          {loading && (
            <Loader2 size={14} className="shrink-0 animate-spin text-ink-faint" />
          )}
        </div>

        {/* 实时匹配列表 */}
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {err ? (
            <div className="px-3 py-2 text-[12.5px] text-[#cf222e]">{err}</div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-2 text-[12.5px] text-ink-faint">
              {dirs.length === 0 ? t('remoteDir.noSubdir') : t('remoteDir.noMatch')}
            </div>
          ) : (
            shown.map((d) => (
              <button
                key={d}
                onClick={() => enter(d)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-black/[0.05]"
              >
                <Folder size={15} className="shrink-0 text-accent" />
                <span className="flex-1 truncate">
                  {filter ? <Highlight text={d} q={filter} /> : d}
                </span>
              </button>
            ))
          )}
        </div>

        {/* 底部:确认 */}
        <div className="flex shrink-0 items-center justify-between border-t border-black/8 px-3 py-2">
          <span className="truncate font-mono text-[11px] text-ink-faint">
            {t('remoteDir.willSelect', { dir: targetDir })}
          </span>
          <button
            onClick={() => onPick(targetDir)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] text-canvas hover:opacity-90"
          >
            <Check size={13} />
            {t('remoteDir.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

// 高亮匹配片段
function Highlight({ text, q }: { text: string; q: string }): JSX.Element {
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <span className="rounded-sm bg-[#f8d775] text-ink">
        {text.slice(i, i + q.length)}
      </span>
      {text.slice(i + q.length)}
    </>
  )
}
