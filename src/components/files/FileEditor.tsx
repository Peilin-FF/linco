import { useEffect, useMemo, useRef, useState } from 'react'
import { Save, FileText } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { githubLight } from '@uiw/codemirror-theme-github'
import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
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
}

function baseName(p: string): string {
  return p.split('/').pop() || p
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

export default function FileEditor({ path, host }: FileEditorProps): JSX.Element {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savedRef = useRef('')

  const extensions = useMemo(
    () => [...EDIT_EXTENSIONS, ...langFor(baseName(path))],
    [path]
  )

  useEffect(() => {
    let alive = true
    setError(null)
    readFileCached(path, host)
      .then((text) => {
        if (!alive) return
        setContent(text)
        savedRef.current = text
        setDirty(false)
        setLoaded(true)
      })
      .catch((e) => {
        if (!alive) return
        setError(String(e))
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [path, host])

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      await writeFile(path, content, host)
      savedRef.current = content
      invalidateFile(path, host) // 保存后失效缓存,避免下次读到旧内容
      setDirty(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const onChange = (v: string): void => {
    setContent(v)
    setDirty(v !== savedRef.current)
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
          title="保存 (⌘S)"
        >
          <Save size={13} />
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {/* 内容 */}
      {!loaded ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-ink-faint">
          加载中…
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-faint">
          {error}
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto"
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
            extensions={extensions}
            theme={githubLight}
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
        </div>
      )}
    </div>
  )
}
