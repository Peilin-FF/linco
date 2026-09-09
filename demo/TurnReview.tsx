import { useEffect, useState } from 'react'
import { getDemoReview } from './mock-workspace'
import DiffView from '../src/components/git/DiffView'
import { I18nProvider } from '../src/lib/i18n'

export default function TurnReview() {
  const [files, setFiles] = useState(getDemoReview)
  useEffect(() => {
    const update = () => setFiles(getDemoReview())
    window.addEventListener('linco:demo-changes', update)
    return () => window.removeEventListener('linco:demo-changes', update)
  }, [])
  return <details className="demo-turn-review">
    <summary>Review this turn · {files.length} changed {files.length === 1 ? 'file' : 'files'}</summary>
    <p>Shadow diff compares files with the snapshot taken before your latest message—not all uncommitted Git changes. Send “Add a sunflower”, then inspect the green additions and red removals here or in Code → Files.</p>
    {!files.length && <p>No changes in this turn yet. Send a suggested prompt to begin. A new message starts a fresh comparison without undoing earlier edits.</p>}
    <I18nProvider>{files.map(file => <section key={file.path} aria-label={`This-turn diff for ${file.path}`}>
      <h3>{file.path}</h3><div className="demo-turn-diff"><DiffView diff={file.diff} /></div>
    </section>)}</I18nProvider>
  </details>
}
