// 解析并渲染 unified diff(git diff 输出),增删行红绿高亮。

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
}

function parseDiff(diff: string): Row[] {
  const rows: Row[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      // @@ -a,b +c,d @@
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
      }
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ')
    ) {
      rows.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo })
      newNo++
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo })
      oldNo++
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      rows.push({ kind: 'ctx', text, oldNo, newNo })
      oldNo++
      newNo++
    }
  }
  return rows
}

export default function DiffView({ diff }: { diff: string }): JSX.Element {
  if (!diff.trim()) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
        无差异
      </div>
    )
  }
  const rows = parseDiff(diff)

  return (
    <div className="h-full overflow-auto font-mono text-[12px] leading-[1.5]">
      {rows.map((r, i) => {
        if (r.kind === 'meta') return null
        if (r.kind === 'hunk') {
          return (
            <div
              key={i}
              className="bg-[#5c8bd6]/10 px-3 py-0.5 text-[11px] text-[#2f6fd0]"
            >
              {r.text}
            </div>
          )
        }
        const bg =
          r.kind === 'add'
            ? 'bg-[#e6ffec]'
            : r.kind === 'del'
              ? 'bg-[#ffebe9]'
              : ''
        const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
        const signColor =
          r.kind === 'add'
            ? 'text-[#1a7f37]'
            : r.kind === 'del'
              ? 'text-[#cf222e]'
              : 'text-ink-faint'
        return (
          <div key={i} className={`flex ${bg}`}>
            <span className="w-10 shrink-0 select-none px-1 text-right text-[10.5px] text-ink-faint/70">
              {r.oldNo ?? ''}
            </span>
            <span className="w-10 shrink-0 select-none px-1 text-right text-[10.5px] text-ink-faint/70">
              {r.newNo ?? ''}
            </span>
            <span className={`w-4 shrink-0 select-none text-center ${signColor}`}>
              {sign}
            </span>
            <span className="whitespace-pre-wrap break-all pr-3 text-ink">
              {r.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}
