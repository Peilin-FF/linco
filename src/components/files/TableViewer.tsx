import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { Save, Table2, Plus, Loader2 } from 'lucide-react'
import {
  invalidateFile,
  readBytesCached,
  readFileCached,
  writeBytes,
  writeFile
} from '@/lib/fs'

interface TableViewerProps {
  path: string
  host?: string
}

interface Sheet {
  name: string
  rows: string[][] // 行优先的二维数组(全部按字符串编辑)
}

// 行/列头的右键菜单
interface CtxMenu {
  kind: 'row' | 'col'
  index: number
  x: number
  y: number
}

function baseName(p: string): string {
  return p.split('/').pop() || p
}

function extOf(p: string): string {
  return p.slice(p.lastIndexOf('.') + 1).toLowerCase()
}

/** csv/xlsx 是否归本组件处理。 */
export function isTableFile(name: string): boolean {
  const e = extOf(name)
  return e === 'csv' || e === 'tsv' || e === 'xlsx' || e === 'xls'
}

// 把一个 worksheet 转成规整的二维字符串数组(补齐每行列数,空单元格为 '')
function sheetToRows(ws: XLSX.WorkSheet): string[][] {
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    blankrows: false,
    defval: ''
  })
  const cols = aoa.reduce((m, r) => Math.max(m, r.length), 0)
  return aoa.map((r) => {
    const row = r.map((c) => (c == null ? '' : String(c)))
    while (row.length < cols) row.push('')
    return row
  })
}

// 列序号 → 类似 Excel 的字母(A, B, …, Z, AA…),用于列右键菜单提示
function colLabel(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/**
 * csv / xlsx 预览 + 编辑:
 * - csv/tsv:读文本 → 单 sheet;保存写回文本(SheetJS 生成 csv)。
 * - xlsx/xls:读 base64 → 多 sheet 可切换;保存写回二进制(base64 → fs_write_bytes)。
 * 双击单元格编辑;行号/表头右键可插入/删除行列;⌘S 或按钮保存。
 */
export default function TableViewer({ path, host }: TableViewerProps): JSX.Element {
  const ext = extOf(path)
  const isXlsx = ext === 'xlsx' || ext === 'xls'

  const [sheets, setSheets] = useState<Sheet[]>([])
  const [active, setActive] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // 编辑中的单元格:`${行}:${列}`
  const [editing, setEditing] = useState<string | null>(null)
  const [ctx, setCtx] = useState<CtxMenu | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    setLoaded(false)
    setDirty(false)
    setEditing(null)
    setActive(0)

    const parse = (wb: XLSX.WorkBook): Sheet[] =>
      wb.SheetNames.map((name) => ({
        name,
        rows: sheetToRows(wb.Sheets[name])
      }))

    const load = isXlsx
      ? readBytesCached(path, host).then((b64) =>
          XLSX.read(b64, { type: 'base64' })
        )
      : readFileCached(path, host).then((text) =>
          XLSX.read(text, { type: 'string', raw: true })
        )

    load
      .then((wb) => {
        if (!alive) return
        const s = parse(wb)
        setSheets(s.length ? s : [{ name: 'Sheet1', rows: [['']] }])
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
  }, [path, host, isXlsx])

  const cur = sheets[active]

  // 统一改当前 sheet 的行(深拷贝到可写,再交给 fn 变换)
  const mutate = (fn: (rows: string[][]) => string[][]): void => {
    setSheets((prev) => {
      const next = prev.map((s) => ({ name: s.name, rows: s.rows }))
      const rows = next[active].rows.map((row) => row.slice())
      next[active] = { name: next[active].name, rows: fn(rows) }
      return next
    })
    setDirty(true)
  }

  const colCount = (rows: string[][]): number =>
    rows.reduce((m, r) => Math.max(m, r.length), 0) || 1

  const setCell = (r: number, c: number, val: string): void => {
    mutate((rows) => {
      rows[r][c] = val
      return rows
    })
  }

  // —— 行操作 ——
  const insertRow = (at: number): void =>
    mutate((rows) => {
      const cols = colCount(rows)
      rows.splice(at, 0, Array.from({ length: cols }, () => ''))
      return rows
    })
  const deleteRow = (r: number): void =>
    mutate((rows) => {
      rows.splice(r, 1)
      return rows.length ? rows : [['']]
    })

  // —— 列操作(对每一行同步插/删一格)——
  const insertCol = (at: number): void =>
    mutate((rows) => rows.map((row) => (row.splice(at, 0, ''), row)))
  const deleteCol = (c: number): void =>
    mutate((rows) => {
      const next = rows.map((row) => (row.splice(c, 1), row))
      // 不允许删到 0 列
      return colCount(next) >= 1 ? next : rows.map(() => [''])
    })

  // 末尾快捷加行/加列(工具栏)
  const addRow = (): void => insertRow(cur?.rows.length ?? 0)
  const addCol = (): void => insertCol(colCount(cur?.rows ?? [['']]))

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      // 用当前所有 sheet 重建 workbook
      const wb = XLSX.utils.book_new()
      for (const s of sheets) {
        const ws = XLSX.utils.aoa_to_sheet(s.rows)
        XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31) || 'Sheet1')
      }
      if (isXlsx) {
        const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })
        await writeBytes(path, b64, host)
      } else {
        // csv/tsv:写回文本(只取第一个 sheet)
        const fs = ext === 'tsv' ? '\t' : ','
        const text = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], {
          FS: fs
        })
        await writeFile(path, text, host)
      }
      invalidateFile(path, host)
      setDirty(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      {/* 标签条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/8 px-3 py-1.5 text-[13px]">
        <Table2 size={14} className="text-ink-muted" />
        <span className="truncate text-ink">{baseName(path)}</span>
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />}
        <div className="flex-1" />
        <button
          onClick={addRow}
          disabled={!loaded || !!error}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 disabled:text-ink-faint"
          title="末尾加一行"
        >
          <Plus size={13} />行
        </button>
        <button
          onClick={addCol}
          disabled={!loaded || !!error}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 disabled:text-ink-faint"
          title="末尾加一列"
        >
          <Plus size={13} />列
        </button>
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

      {/* 多 sheet 切换(仅 xlsx 且多于一个) */}
      {sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-black/8 px-2 py-1">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              onClick={() => {
                setActive(i)
                setEditing(null)
              }}
              className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] ${
                i === active
                  ? 'bg-sidebar text-ink'
                  : 'text-ink-muted hover:bg-black/5'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 内容 */}
      {!loaded ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-faint">
          <Loader2 size={14} className="animate-spin" />
          加载中…
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-faint">
          {error}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Grid
            rows={cur?.rows ?? []}
            editing={editing}
            setEditing={setEditing}
            setCell={setCell}
            onCtx={setCtx}
          />
        </div>
      )}

      {/* 行/列右键菜单 */}
      {ctx && (
        <RowColMenu
          ctx={ctx}
          onClose={() => setCtx(null)}
          onInsertRow={insertRow}
          onDeleteRow={deleteRow}
          onInsertCol={insertCol}
          onDeleteCol={deleteCol}
        />
      )}
    </div>
  )
}

// 表格网格:首行当表头(加粗、置顶),其余可双击编辑。带行号列。
// 行号格 / 表头格可右键弹出插入/删除菜单。
function Grid({
  rows,
  editing,
  setEditing,
  setCell,
  onCtx
}: {
  rows: string[][]
  editing: string | null
  setEditing: (k: string | null) => void
  setCell: (r: number, c: number, v: string) => void
  onCtx: (m: CtxMenu) => void
}): JSX.Element {
  const cols = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    [rows]
  )
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
        空表格
      </div>
    )
  }
  const header = rows[0]
  return (
    <table className="border-collapse text-[12.5px]">
      <thead>
        <tr>
          <th className="sticky left-0 top-0 z-20 border border-black/10 bg-sidebar px-2 py-1 text-ink-faint" />
          {Array.from({ length: cols }, (_, c) => (
            <th
              key={c}
              onContextMenu={(e) => {
                e.preventDefault()
                onCtx({ kind: 'col', index: c, x: e.clientX, y: e.clientY })
              }}
              title={`第 ${colLabel(c)} 列 — 右键插入/删除`}
              className="sticky top-0 z-10 min-w-[80px] cursor-context-menu border border-black/10 bg-sidebar px-2 py-1 text-left font-semibold text-ink"
            >
              {header[c] ?? ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(1).map((row, ri) => {
          const r = ri + 1 // 真实行号(0 是表头)
          return (
            <tr key={r}>
              <td
                onContextMenu={(e) => {
                  e.preventDefault()
                  onCtx({ kind: 'row', index: r, x: e.clientX, y: e.clientY })
                }}
                title={`第 ${r} 行 — 右键插入/删除`}
                className="sticky left-0 z-10 cursor-context-menu border border-black/10 bg-sidebar px-2 py-1 text-right text-ink-faint"
              >
                {r}
              </td>
              {Array.from({ length: cols }, (_, c) => {
                const key = `${r}:${c}`
                const val = row[c] ?? ''
                return (
                  <td
                    key={c}
                    onDoubleClick={() => setEditing(key)}
                    className="min-w-[80px] border border-black/10 px-0 py-0 align-top"
                  >
                    {editing === key ? (
                      <input
                        autoFocus
                        defaultValue={val}
                        onBlur={(e) => {
                          setCell(r, c, e.target.value)
                          setEditing(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setCell(r, c, (e.target as HTMLInputElement).value)
                            setEditing(null)
                          } else if (e.key === 'Escape') {
                            setEditing(null)
                          }
                        }}
                        className="w-full bg-canvas px-2 py-1 outline-none ring-1 ring-accent"
                      />
                    ) : (
                      <div className="truncate px-2 py-1 text-ink" title={val}>
                        {val}
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// 行/列头的右键菜单:插入(前/后)+ 删除
function RowColMenu({
  ctx,
  onClose,
  onInsertRow,
  onDeleteRow,
  onInsertCol,
  onDeleteCol
}: {
  ctx: CtxMenu
  onClose: () => void
  onInsertRow: (at: number) => void
  onDeleteRow: (r: number) => void
  onInsertCol: (at: number) => void
  onDeleteCol: (c: number) => void
}): JSX.Element {
  const isRow = ctx.kind === 'row'
  const items: { label: string; danger?: boolean; run: () => void }[] = isRow
    ? [
        { label: '在上方插入行', run: () => onInsertRow(ctx.index) },
        { label: '在下方插入行', run: () => onInsertRow(ctx.index + 1) },
        { label: '删除此行', danger: true, run: () => onDeleteRow(ctx.index) }
      ]
    : [
        { label: '在左侧插入列', run: () => onInsertCol(ctx.index) },
        { label: '在右侧插入列', run: () => onInsertCol(ctx.index + 1) },
        { label: '删除此列', danger: true, run: () => onDeleteCol(ctx.index) }
      ]
  const style: React.CSSProperties = {
    left: Math.min(ctx.x, window.innerWidth - 180),
    top: Math.min(ctx.y, window.innerHeight - items.length * 32 - 16)
  }
  return (
    <>
      {/* 点击空白关闭 */}
      <div className="fixed inset-0 z-[55]" onMouseDown={onClose} />
      <div
        style={style}
        className="fixed z-[56] min-w-[160px] rounded-lg bg-canvas py-1 text-[13px] shadow-card ring-1 ring-black/10"
      >
        {items.map((it, i) => (
          <button
            key={i}
            onClick={() => {
              it.run()
              onClose()
            }}
            className={`flex w-full items-center px-3 py-1.5 text-left ${
              it.danger
                ? 'text-red-600 hover:bg-red-50'
                : 'text-ink hover:bg-black/5'
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>
    </>
  )
}
