import { useCallback } from 'react'

interface ResizeHandleProps {
  /** 拖拽回调:横向时传 deltaY(向上拖为负),竖向时传 deltaX(向左拖为负) */
  onResize: (delta: number) => void
  /** 'horizontal'(默认,上下拖改高度)| 'vertical'(左右拖改宽度) */
  orientation?: 'horizontal' | 'vertical'
}

/**
 * 分隔条:
 * - horizontal(默认):放在固定高度面板的上沿,上下拖改其高度。deltaY<0=向上拖。
 * - vertical:竖向分隔条,左右拖改宽度。deltaX>0=向右拖。
 */
export default function ResizeHandle({
  onResize,
  orientation = 'horizontal'
}: ResizeHandleProps): JSX.Element {
  const vertical = orientation === 'vertical'
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      let last = vertical ? e.clientX : e.clientY
      const move = (ev: PointerEvent): void => {
        const cur = vertical ? ev.clientX : ev.clientY
        onResize(cur - last)
        last = cur
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = vertical ? 'ew-resize' : 'ns-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [onResize, vertical]
  )

  if (vertical) {
    // 命中热区加宽到 ~16px(视觉细条仍只 3px),好抓;-mx 让热区向两侧外扩不挤占布局。
    return (
      <div
        onPointerDown={onPointerDown}
        className="group relative flex h-full w-4 shrink-0 cursor-ew-resize items-center justify-center"
      >
        <div className="h-10 w-[3px] rounded-full bg-black/15 transition-colors group-hover:bg-[#5c8bd6]/70" />
      </div>
    )
  }
  return (
    <div
      onPointerDown={onPointerDown}
      className="group relative flex h-4 shrink-0 cursor-ns-resize items-center justify-center"
    >
      <div className="h-[3px] w-10 rounded-full bg-black/15 transition-colors group-hover:bg-[#5c8bd6]/70" />
    </div>
  )
}
