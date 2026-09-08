import { useEffect, useState } from 'react'
import { Flower2, Leaf, RotateCcw, Droplets, Sprout } from 'lucide-react'
import { readGarden } from './garden'

// Only the native preview-server boundary is replaced in the public build.
export default function Preview(_props: { cwd?: string; host?: string; previewPath?: string; onSubmitToAgent?: (text: string) => void }) {
  const [garden, setGarden] = useState(readGarden)
  const [water, setWater] = useState<Record<string, number>>({})
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(garden, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'garden.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  useEffect(() => {
    const change = () => setGarden({ ...readGarden() })
    window.addEventListener('linco:garden-change', change)
    return () => window.removeEventListener('linco:garden-change', change)
  }, [])
  return <div className={`garden-preview ${garden.night ? 'garden-night' : ''}`}>
    <div className="garden-address"><span>◉</span> pocket-garden / live preview <span>Sample project</span></div>
    <div className="garden-content">
      <div className="garden-brand"><Sprout size={17} /> POCKET GARDEN</div>
      <h2>{garden.title}</h2><p>A tiny project. A few seeds. Something to make your own.</p>
      <div className="garden-plants">{garden.plants.map((plant, i) => {
        const count = water[plant] || 0
        return <button key={`${plant}-${i}`} aria-label={`Water ${plant}`} className={`garden-plant growth-${Math.min(count, 3)}`} onClick={() => setWater(cur => ({ ...cur, [plant]: Math.min((cur[plant] || 0) + 1, 3) }))}>
          <span className="plant-pot">{count >= 3 ? <Flower2 size={48} /> : <Leaf size={25 + count * 7} />}</span>
          <strong>{plant}</strong><span><Droplets size={12} /> {count >= 3 ? 'In bloom!' : `${count}/3 · Click to water`}</span>
        </button>
      })}</div>
      <button className="garden-reset" onClick={() => setWater({})}><RotateCcw size={13} /> Start growing again</button>
      <button className="garden-reset" onClick={download}>↓ Download garden.json</button>
      <div className="garden-footnote">Try asking the demo agent to <b>add a sunflower</b> or <b>make it midnight</b>.<br />Or edit <code>src/garden.json</code> in Code, save, and come back here.</div>
    </div>
  </div>
}
