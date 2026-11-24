import type { AutoApplyResult } from '../../../shared/types'

/** The answers auto-apply had to guess on one application, so the user can check them. */
export function GuessNotes({ notes }: { notes?: AutoApplyResult['notes'] }) {
  if (!notes?.length) return null
  return (
    <div className="muted small" style={{ marginTop: 6 }}>
      <b>Answered by best guess — check these</b>
      {notes.map((n, i) => <div key={i}>{n.q} → {n.a} ({n.why})</div>)}
    </div>
  )
}
