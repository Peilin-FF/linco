import { useEffect, useMemo, useRef, useState } from 'react'
import { Save, FileText } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  defaultKeymap,
  historyKeymap,
  indentWithTab
} from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { rust } from '@codemirror/lang-rust'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { invalidateFile, readFileCached, writeFile } from '@/lib/fs'
import { onRemoteFsChange } from '@/lib/watch'
import { useIsDark } from '@/lib/theme'
import {
  vscodeDarkEditorTheme,
  vscodeLightEditorTheme
} from '@/lib/codeMirrorTheme'
import { useI18n } from '@/lib/i18n'
import ChangeOverviewRuler, {
  type ChangeOverviewMarker
} from './ChangeOverviewRuler'

// VS Code 式编辑能力(显式接入,不依赖 basicSetup 默认):
//   ⌘F 查找 / ⌘⌥F 替换(search panel)、⌘G 下一个、⇧⌘G 上一个
//   ⌘/ 切换行注释、⇧⌥A 块注释(defaultKeymap 内含 toggleComment 绑到 mod-/)
//   移动行 ⌥↑↓、复制行 ⇧⌥↓、缩进 ⌘]/⌘[、多光标 ⌘D、跳行 ⌃G —— 均在 defaultKeymap
//   Tab 缩进(indentWithTab)、撤销重做(historyKeymap)
//   选中词高亮其它出现处(highlightSelectionMatches)
const EDIT_EXTENSIONS: Extension[] = [
  search({ top: true }),
  highlightSelectionMatches(),
  keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab])
]

interface FileEditorProps {
  path: string
  host?: string
  diff?: string
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

function changeMarkersFromDiff(diff: string): ChangeOverviewMarker[] {
  const lines: { line: number; kind: ChangeOverviewMarker['kind'] }[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of diff.split('\n')) {
    if (text.startsWith('@@')) {
      const match = text.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = Number.parseInt(match[1], 10)
        newLine = Number.parseInt(match[2], 10)
        inHunk = true
      }
      continue
    }
    if (!inHunk || text.startsWith('\\ No newline')) continue
    if (text.startsWith('+') && !text.startsWith('+++')) {
      lines.push({ line: Math.max(1, newLine), kind: 'add' })
      newLine += 1
    } else if (text.startsWith('-') && !text.startsWith('---')) {
      lines.push({ line: Math.max(1, newLine), kind: 'delete' })
      oldLine += 1
    } else if (text.startsWith(' ')) {
      oldLine += 1
      newLine += 1
    }
  }

  const markers: ChangeOverviewMarker[] = []
  for (const point of lines) {
    const previous = markers[markers.length - 1]
    if (
      previous &&
      previous.kind === point.kind &&
      point.line <= previous.endLine + 1
    ) {
      previous.endLine = Math.max(previous.endLine, point.line)
    } else {
      markers.push({
        startLine: point.line,
        endLine: point.line,
        kind: point.kind
      })
    }
  }
  return markers
}

// 按扩展名选择 CodeMirror 语言扩展(语法高亮)
function langFor(name: string): Extension[] {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'py':
      return [python()]
    case 'json':
      return [json()]
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'mjs':
    case 'cjs':
      return [javascript({ jsx: true, typescript: ext.startsWith('ts') })]
    case 'rs':
      return [rust()]
    case 'md':
    case 'markdown':
      return [markdown()]
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return [html()]
    case 'css':
    case 'scss':
    case 'less':
      return [css()]
    case 'yaml':
    case 'yml':
      return [yaml()]
    default:
      return []
  }
}

export default function FileEditor({ path, host, diff = '' }: FileEditorProps): JSX.Element {
  const { t } = useI18n()
  const dark = useIsDark()
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savedRef = useRef('')
  const dirtyRef = useRef(false) // 与 dirty 同步,供事件回调里读最新值(避免闭包旧值)
  const editorViewRef = useRef<EditorView | null>(null)

  const extensions = useMemo(
    () => [...EDIT_EXTENSIONS, ...langFor(baseName(path))],
    [path]
  )
  const changeMarkers = useMemo(() => changeMarkersFromDiff(diff), [diff])
  const totalLines = useMemo(() => Math.max(1, content.split('\n').length), [content])

  useEffect(() => {
    let alive = true
    let un: (() => void) | undefined
    // 读取文件到编辑器。reload=true 表示是「外部改动后重读」:先失效缓存拿最新盘内容,
    // 且只在用户没有未保存编辑(非 dirty)时才覆盖,避免吞掉用户正在输入的内容。
    const load = (reload = false): void => {
      if (reload) {
        if (dirtyRef.current) return // 用户正在编辑,别覆盖
        invalidateFile(path, host)
      }
      setError(null)
      readFileCached(path, host)
        .then((text) => {
          if (!alive) return
          setContent(text)
          savedRef.current = text
          setDirty(false)
          dirtyRef.current = false
          setLoaded(true)
        })
        .catch((e) => {
          if (!alive) return
          setError(String(e))
          setLoaded(true)
        })
    }
    load()
    // agent 改完文件(watch 推送)或发新消息(turn-refresh)→ 重读最新内容,
    // 这样 agent 改动后编辑器不再停留在旧文本(之前 readFileCached 命中旧缓存的 bug)。
    onRemoteFsChange((e) => {
      if ((e.host || undefined) !== (host || undefined)) return
      if (e.paths.some((p) => p === path)) load(true)
    }).then((f) => (un = f))
    const onTurn = (): void => load(true)
    window.addEventListener('linco:turn-refresh', onTurn)
    return () => {
      alive = false
      un?.()
      window.removeEventListener('linco:turn-refresh', onTurn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, host])

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      await writeFile(path, content, host)
      savedRef.current = content
      invalidateFile(path, host) // 保存后失效缓存,避免下次读到旧内容
      setDirty(false)
      dirtyRef.current = false
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const onChange = (v: string): void => {
    setContent(v)
    const d = v !== savedRef.current
    setDirty(d)
    dirtyRef.current = d
  }

  return (
    <div className="flex h-full flex-col">
      {/* 文件标签条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[13px]">
        <FileText size={14} className="text-ink-muted" />
        <span className="truncate text-ink">{baseName(path)}</span>
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />}
        <div className="flex-1" />
        <button
          onClick={save}
          disabled={!dirty || saving}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${
            dirty ? 'text-ink hover:bg-black/5' : 'cursor-default text-ink-faint'
          }`}
          title={t('editor.saveHint')}
        >
          <Save size={13} />
          {saving ? t('editor.saving') : t('editor.save')}
        </button>
      </div>

      {/* 内容 */}
      {!loaded ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-ink-faint">
          {t('editor.loading')}
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-faint">
          {error}
        </div>
      ) : (
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault()
              void save()
            }
          }}
        >
          <CodeMirror
            value={content}
            onChange={onChange}
            onCreateEditor={(view) => {
              editorViewRef.current = view
            }}
            extensions={extensions}
            theme={dark ? vscodeDarkEditorTheme : vscodeLightEditorTheme}
            height="100%"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: true,
              tabSize: 2,
              // 自带 keymap 关掉,改用上面显式接入的(避免重复绑定/冲突)
              defaultKeymap: false,
              searchKeymap: false,
              historyKeymap: false
            }}
            style={{ fontSize: 13, height: '100%' }}
          />
          <ChangeOverviewRuler
            markers={changeMarkers}
            totalLines={totalLines}
            label={t('fileViewer.changeOverview')}
            onJump={(line) => {
              const view = editorViewRef.current
              if (!view) return
              const target = view.state.doc.line(
                Math.max(1, Math.min(view.state.doc.lines, line))
              )
              view.dispatch({
                selection: EditorSelection.cursor(target.from),
                effects: EditorView.scrollIntoView(target.from, { y: 'center' })
              })
              view.focus()
            }}
          />
        </div>
      )}
    </div>
  )
}
