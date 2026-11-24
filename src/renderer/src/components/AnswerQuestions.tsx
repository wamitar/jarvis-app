import { useState } from 'react'

/**
 * The required questions auto-apply could not answer on one job, each with a box. Saved answers go into the profile
 * (Profile › Saved answers) and are reused on every later form that asks the same thing; the job's flag is cleared
 * so the next auto-apply run tries it again.
 */
export function AnswerQuestions({ jobId, questions, onSaved }: { jobId: string; questions: string[]; onSaved: () => void | Promise<void> }) {
  const [vals, setVals] = useState<string[]>(questions.map(() => ''))
  const [busy, setBusy] = useState(false)
  const filled = questions.map((q, i) => ({ q, a: (vals[i] ?? '').trim() })).filter(x => x.a)
  const save = async (): Promise<void> => {
    setBusy(true)
    try { await window.api.saveAnswers(jobId, filled); await onSaved() } finally { setBusy(false) }
  }
  return (
    <div className="stack" style={{ marginTop: 8, gap: 8 }}>
      {questions.map((q, i) => (
        <label key={i} className="f"><span>{q}</span>
          <input value={vals[i] ?? ''} placeholder="Your answer (saved for every later application)" onChange={e => setVals(v => v.map((x, n) => (n === i ? e.target.value : x)))} />
        </label>
      ))}
      <div><button className="btn sm primary" disabled={busy || !filled.length} onClick={save}>{busy ? 'Saving…' : `Save ${filled.length > 1 ? 'answers' : 'answer'} and retry this job`}</button></div>
    </div>
  )
}
