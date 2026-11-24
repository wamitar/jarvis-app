import { useEffect, useState } from 'react'
import type { AppState } from '../../../shared/api'
import type { Activity, AutoApplyResult, Job, LiveJob, LiveRun } from '../../../shared/types'
import { ai } from '../ai'
import { AnswerQuestions } from '../components/AnswerQuestions'
import { GuessNotes } from '../components/GuessNotes'

const STATE: Record<LiveJob['state'], [string, string]> = {
  waiting: ['Waiting', ''], tailoring: ['Tailoring resume', 'accent'], working: ['Filling the application', 'accent'],
  applied: ['Submitted', 'good'], flagged: ['Needs you', 'flag'], dryrun: ['Dry run', ''], skipped: ['Not reached', '']
}
const when = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const took = (j: LiveJob): string => {
  if (!j.startedAt) return ''
  const s = Math.round(((j.endedAt ? new Date(j.endedAt).getTime() : Date.now()) - new Date(j.startedAt).getTime()) / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** What the app is doing now, the auto-apply run job by job, what was submitted, and what needs you. */
export function StatusPage({ state, jobs, activity, reload, openJob }: { state: AppState; jobs: Job[]; activity: Activity; reload: () => Promise<void>; openJob: (id: string) => void }) {
  const [run, setRun] = useState<LiveRun | null>(null)
  const [auto, setAuto] = useState<Record<string, AutoApplyResult>>(state.autoApply || {})
  const [, tick] = useState(0)
  useEffect(() => {
    window.api.getLiveRun().then(setRun)
    const a = window.api.onLiveRun(setRun)
    const b = window.api.onAutoApply(r => setAuto(x => ({ ...x, [r.jobId]: r })))
    const t = setInterval(() => tick(n => n + 1), 5000)   // keeps "x min ago" and timers fresh
    return () => { a(); b(); clearInterval(t) }
  }, [])
  useEffect(() => { setAuto(state.autoApply || {}) }, [state.autoApply])

  const byId = new Map(jobs.map(j => [j.id, j]))
  const applied = jobs.filter(j => ['applied', 'interview', 'offer', 'rejected'].includes(j.status))
    .sort((a, b) => (b.appliedAt || auto[b.id]?.at || '').localeCompare(a.appliedAt || auto[a.id]?.at || ''))
  const weekAgo = Date.now() - 7 * 24 * 3600_000
  const thisWeek = applied.filter(j => new Date(j.appliedAt || auto[j.id]?.at || 0).getTime() > weekAgo).length
  const byApp = applied.filter(j => auto[j.id]?.outcome === 'applied').length
  const needs = Object.values(auto).filter(r => r.outcome !== 'applied' && byId.has(r.jobId) && !['applied', 'interview', 'offer', 'rejected', 'hidden'].includes(byId.get(r.jobId)!.status))
    .sort((a, b) => b.at.localeCompare(a.at))
  const current = run?.running ? run.jobs.find(j => j.state === 'tailoring' || j.state === 'working') : undefined
  const doneCount = run ? run.jobs.filter(j => !['waiting', 'tailoring', 'working'].includes(j.state)).length : 0
  const clear = async (id: string): Promise<void> => { await window.api.clearAutoApplyFlag(id); setAuto(a => { const n = { ...a }; delete n[id]; return n }); await reload() }
  const tasks = activity.tasks.filter(t => !/^Waiting for (Claude|Codex)$/.test(t))

  return (
    <div className="page">
      <div className="head"><div><h1>Status</h1><p>What the app is doing now, every auto-apply job and how it went, and what is waiting for you.</p></div></div>

      <div className="tiles">
        <div className="tile"><b className="num">{applied.length}</b><span>Applied in total</span></div>
        <div className="tile"><b className="num">{byApp}</b><span>Submitted by the app</span></div>
        <div className="tile"><b className="num">{thisWeek}</b><span>Applied in the last 7 days</span></div>
        <div className={'tile' + (needs.length ? ' warn' : '')}><b className="num">{needs.length}</b><span>Need you</span></div>
      </div>

      <div className="card">
        <h3>Right now</h3>
        {current ? (<>
          <div className="now">
            <span className="lamp on" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div><b>{current.company}</b> · <a onClick={() => openJob(current.jobId)}>{current.title}</a></div>
              <div className="muted small">Job {doneCount + 1} of {run!.jobs.length} · {current.state === 'tailoring' ? `${ai()} is tailoring the resume` : current.page || 'Opening the application'} · {took(current)}</div>
            </div>
          </div>
          {current.steps.length > 0 && <ol className="steps">{current.steps.slice(-8).map((s, i) => <li key={i}>{s}</li>)}</ol>}
        </>) : activity.working ? (
          <div className="now"><span className="lamp on" /><div>{tasks[tasks.length - 1] || 'Working'}{activity.tasks.some(t => /^Waiting for/.test(t)) ? ` (waiting for ${ai()})` : ''}</div></div>
        ) : (
          <div className="now"><span className="lamp" /><div className="muted">Idle.{run?.endedAt ? ` The last auto-apply run ended ${when(run.endedAt)}: ${run.jobs.filter(j => j.state === 'applied').length} submitted, ${run.jobs.filter(j => j.state === 'flagged').length} need you${run.jobs.some(j => j.state === 'skipped') ? `, ${run.jobs.filter(j => j.state === 'skipped').length} not reached` : ''}.` : ' Start auto-apply from the Jobs page and follow it here.'}</div></div>
        )}
      </div>

      {run && run.jobs.length > 0 && (
        <div className="card">
          <h3>{run.running ? 'This run' : 'Last run'} <span className="muted small" style={{ fontWeight: 400 }}>started {when(run.startedAt)} · {doneCount} of {run.jobs.length} done</span></h3>
          <div className="runlist">{run.jobs.map(j => (
            <div key={j.jobId} className={'runrow' + (j === current ? ' on' : '')}>
              <span className={'pill ' + STATE[j.state][1]}>{STATE[j.state][0]}</span>
              <div style={{ minWidth: 0 }}>
                <div className="ellipsis"><b>{j.company}</b> · <a onClick={() => openJob(j.jobId)}>{j.title}</a></div>
                {(j.reason || (j.page && j.state !== 'waiting')) && <div className="muted small ellipsis">{j.reason ? `${j.reason}${j.page ? ` (on ${j.page})` : ''}` : j.page}</div>}
              </div>
              <span className="muted small num">{took(j)}</span>
            </div>
          ))}</div>
        </div>
      )}

      <div className="card">
        <h3>Needs you {needs.length > 0 && <span className="muted small" style={{ fontWeight: 400 }}>· finish these yourself, or fix the cause and clear them to retry</span>}</h3>
        {!needs.length ? <p className="muted">Nothing waiting for you.</p> : <div className="runlist">{needs.map(r => { const j = byId.get(r.jobId)!; return (
          <div key={r.jobId} className="runrow">
            <span className={'pill ' + (r.outcome === 'dryrun' ? '' : 'flag')}>{r.outcome === 'dryrun' ? 'Dry run' : 'Needs you'}</span>
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis"><b>{j.company}</b> · <a onClick={() => openJob(j.id)}>{j.title}</a></div>
              <div className="muted small">{r.reason}{r.page && r.page !== 'Starting' ? ` (on ${r.page})` : ''} · {when(r.at)}</div>
              <GuessNotes notes={r.notes} />
              {r.questions && r.questions.length > 0 && <AnswerQuestions key={r.questions.join('|')} jobId={r.jobId} questions={r.questions} onSaved={async () => { setAuto(a => { const n = { ...a }; delete n[r.jobId]; return n }); await reload() }} />}
            </div>
            <span className="rowx">
              {r.shot && <button className="btn sm" onClick={() => window.api.showAutoApplyShot(r.jobId)}>Screenshot</button>}
              <button className="btn ghost sm" onClick={() => clear(r.jobId)} title="Remove the mark so auto-apply tries this job again">Clear</button>
            </span>
          </div>) })}</div>}
      </div>

      <div className="card">
        <h3>Applied</h3>
        {!applied.length ? <p className="muted">No applications yet.</p> : <div className="runlist">{applied.map(j => (
          <div key={j.id} className="runrow">
            <span className={'pill ' + (j.status === 'offer' || j.status === 'interview' ? 'good' : j.status === 'rejected' ? '' : 'accent')}>{{ applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' }[j.status as string]}</span>
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis"><b>{j.company}</b> · <a onClick={() => openJob(j.id)}>{j.title}</a></div>
              <div className="muted small">{auto[j.id]?.outcome === 'applied' ? 'Submitted by the app, confirmation seen' : 'Marked applied by you'}{j.location ? ` · ${j.location}` : ''}</div>
              <GuessNotes notes={auto[j.id]?.notes} />
            </div>
            <span className="muted small num">{when(j.appliedAt || auto[j.id]?.at)}</span>
          </div>
        ))}</div>}
      </div>
    </div>
  )
}
