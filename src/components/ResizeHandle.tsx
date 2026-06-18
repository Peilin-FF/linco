import { useCallback } from 'react'

interface ResizeHandleProps {
  /** 拖拽时调整的高度方向:'top' = 拖上沿(向上拖变高) */
  onResize: (deltaY: number) => void
}

/**
 * 横向分隔条:放在某个固定高度面板的上沿,上下拖拽改其高度。
 * deltaY < 0 表示向上拖(面板变高)。
 */
export default function ResizeHandle({ onResize }: ResizeHandleProps): JSX.Element {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startY = e.clientY
      let lastY = startY
      const move = (ev: PointerEvent): void => {
        onResize(ev.clientY - lastY)
        lastY = ev.clientY
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'ns-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [onResize]
  )

  return (
    <div
      onPointerDown={onPointerDown}
      className="group flex h-2 shrink-0 cursor-ns-resize items-center justify-center"
    >
      <div className="h-[3px] w-10 rounded-full bg-black/10 transition-colors group-hover:bg-[#5c8bd6]/60" />
    </div>
  )
}
