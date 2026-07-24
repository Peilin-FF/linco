import type { PointerEvent as ReactPointerEvent } from 'react'

export interface ChangeOverviewMarker {
  startLine: number
  endLine: number
  kind: 'add' | 'delete'
}

interface ChangeOverviewRulerProps {
  markers: ChangeOverviewMarker[]
  totalLines: number
  label: string
  onJump: (line: number) => void
}

export default function ChangeOverviewRuler({
  markers,
  totalLines,
  label,
  onJump
}: ChangeOverviewRulerProps): JSX.Element | null {
  if (markers.length === 0 || totalLines <= 0) return null

  const jumpFromPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    onJump(Math.round(ratio * Math.max(0, totalLines - 1)) + 1)
  }

  return (
    <div
      role="scrollbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={totalLines}
      title={label}
      className="absolute bottom-1 right-[16px] top-1 z-30 w-[7px] cursor-ns-resize touch-none rounded-sm bg-black/[0.035] ring-1 ring-black/[0.06]"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        jumpFromPointer(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          jumpFromPointer(event)
        }
      }}
    >
      {markers.map((marker, index) => {
        const start = Math.max(1, Math.min(totalLines, marker.startLine))
        const end = Math.max(start, Math.min(totalLines, marker.endLine))
        const top = ((start - 1) / totalLines) * 100
        const height = ((end - start + 1) / totalLines) * 100
        return (
          <span
            key={`${marker.kind}-${start}-${end}-${index}`}
            className={`pointer-events-none absolute rounded-[1px] ${
              marker.kind === 'add'
                ? 'left-0 w-[4px] bg-[#2da44e]/80'
                : 'right-0 w-[4px] bg-[#cf222e]/75'
            }`}
            style={{
              top: `${top}%`,
              height: `max(3px, ${height}%)`
            }}
          />
        )
      })}
    </div>
  )
}
