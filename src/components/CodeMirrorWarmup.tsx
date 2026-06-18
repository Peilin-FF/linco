import { useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'

/**
 * CodeMirror 预热:app 启动后在屏幕外悄悄初始化一个极小的编辑器实例,
 * 把"首次创建编辑器 + 初始化语法高亮系统"这次性大开销提前到用户还没点
 * 文件时完成。等真正打开第一个文件,引擎已热 → 第一次也快。
 * 预热完成后卸载,不占资源。
 */
export default function CodeMirrorWarmup(): JSX.Element | null {
  const [done, setDone] = useState(false)

  useEffect(() => {
    // 让出首屏渲染,空闲时再预热
    const ric =
      window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300))
    const id = ric(() => {
      // 渲染后短暂保留让其完成初始化,再卸载
      setTimeout(() => setDone(true), 400)
    })
    return () => {
      if (window.cancelIdleCallback && typeof id === 'number')
        window.cancelIdleCallback(id)
    }
  }, [])

  if (done) return null
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: -9999,
        top: -9999,
        width: 200,
        height: 100,
        pointerEvents: 'none',
        opacity: 0
      }}
    >
      <CodeMirror value={"warmup"} height="80px" editable={false} />
    </div>
  )
}
