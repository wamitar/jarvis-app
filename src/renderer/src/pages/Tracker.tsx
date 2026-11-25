import { useEffect, useState } from 'react'
import type { Job, JobStatus } from '../../../shared/types'
import type { RejectionCheck } from '../../../shared/api'
import { errText } from '../App'

const ORDER: JobStatus[] = ['offer', 'interview', 'applied', 'tailored', 'saved', 'rejected']
export const STATUS_LABEL: Record<JobStatus, string> = { new: 'New', saved: 'Saved', tailored: 'Resume ready', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', hidden: 'Hidden' }

const day = (iso: string): string => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleDateString() }

// Kept outside the component so the check and its result survive leaving the page and coming back.
let running = false
let lastResult: RejectionCheck | null = null
let lastMsg: { text: string; stopped: boolean } | null = null

export function TrackerPage({ jobs, reload, openJob, gmailEmail }: { jobs: Job[]; reload: () => Promise<void>; openJob: (id: string) => void; gmailEmail: string }) {
  const [checking, setChecking] = useState(running)
  const [result, setResultState] = useState<RejectionCheck | null>(lastResult)
  const [msg, setMsgState] = useState<{ text: string; stopped: boolean } | null>(lastMsg)
  const [showUnmatched, setShowUnmatched] = useState(false)
  const setResult = (r: RejectionCheck | null): void => { lastResult = r; setResultState(r) }
  const setMsg = (m: { text: string; stopped: boolean } | null): void => { lastMsg = m; setMsgState(m) }
  const check = async (): Promise<void> => {
    running = true; setChecking(true); setResult(null); setMsg(null); setShowUnmatched(false)
    try { const r = await window.api.checkRejections(); lastResult = r; setResultState(r) } catch (e) { const t = errText(e); const m = { text: t, stopped: /^stopped\.?$/i.test(t.trim()) }; lastMsg = m; setMsgState(m) }
    finally { running = false; setChecking(false); await reload() }
  }
  // Coming back while a check is still running: the main process hands out the same run, so wait on it again.
  useEffect(() => { if (running) void check() }, [])
  const summary = (r: RejectionCheck): string => {
    if (!r.rejections) return `Read ${r.searched} emails (${r.newEmails} new). No new rejection emails.`
    const parts = [`${r.marked.length} ${r.marked.length === 1 ? 'job' : 'jobs'} marked Rejected`]
    if (r.alreadyRejected) parts.push(`${r.alreadyRejected} already rejected`)
    if (r.unmatched.length) parts.push(`${r.unmatched.length} not matched to a job`)
    return `Read ${r.searched} emails (${r.newEmails} new): ${r.rejections} ${r.rejections === 1 ? 'rejection' : 'rejections'} — ${parts.join(', ')}.`
  }
  const rows = jobs.filter(j => ORDER.includes(j.status)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.appliedAt || '').localeCompare(a.appliedAt || ''))
  const count = (s: JobStatus): number => jobs.filter(j => j.status === s).length
  const set = async (id: string, status: JobStatus): Promise<void> => { await window.api.updateJob(id, { status }); await reload() }
  return (
    <div className="page">
      <div className="head"><div><h1>Tracker</h1>
        <p className="num">{count('applied')} applied · {count('interview')} interviewing · {count('offer')} offers · {count('tailored')} ready to send</p></div>
        <div className="rowx">
          <button className="btn" onClick={check} disabled={checking || !gmailEmail} title={gmailEmail ? 'Reads your Gmail (read-only) for rejection emails. Emails already checked are skipped, so pressing it again only reads new mail.' : 'Connect Gmail in Settings to use this'}>{checking && <span className="spin" />}{checking ? 'Checking email…' : 'Check email for rejections'}</button>
          {!gmailEmail && <span className="muted small">Connect Gmail in Settings to use this</span>}
        </div></div>
      {msg && <div className={'banner ' + (msg.stopped ? 'info' : 'bad')}><span>{msg.text}</span><button className="btn ghost sm" onClick={() => setMsg(null)}>Dismiss</button></div>}
      {result && <div className="banner good" style={{ display: 'block' }}>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}><span>{summary(result)}</span><button className="btn ghost sm" onClick={() => setResult(null)}>Dismiss</button></div>
        {result.marked.length > 0 && <><b className="small">Marked Rejected</b><ul className="plain small">{result.marked.map(m => (
          <li key={m.jobId}>{m.company} — <a onClick={() => openJob(m.jobId)}>{m.title}</a><div className="small">{m.subject} · {day(m.at)} · was {STATUS_LABEL[m.previous]}</div></li>
        ))}</ul></>}
        {result.unmatched.length > 0 && <div><button className="btn ghost sm" onClick={() => setShowUnmatched(v => !v)}>{showUnmatched ? 'Hide' : 'Show'} {result.unmatched.length} not matched to a job</button>
          {showUnmatched && <ul className="plain small">{result.unmatched.map((u, i) => (
            <li key={i}>{u.company || u.from} — {u.subject} · {day(u.at)}<div className="small">{u.why}</div></li>
          ))}</ul>}</div>}
        <p className="small">Emails already checked are remembered, so next time only new mail is read.</p>
      </div>}
      {!rows.length ? <div className="empty"><h2>Nothing tracked yet</h2><p>Jobs you save, tailor or apply to show up here.</p></div> : (
        <table>
          <thead><tr><th>Role</th><th>Company</th><th>Location</th><th>Match</th><th>Applied</th><th>Status</th></tr></thead>
          <tbody>{rows.map(j => (
            <tr key={j.id}>
              <td><a onClick={() => openJob(j.id)}>{j.title}</a>{j.notes && <div className="muted small">{j.notes}</div>}</td>
              <td>{j.company}</td><td className="muted">{j.location}</td><td className="num">{j.score ?? '–'}</td>
              <td className="muted num">{j.appliedAt ? new Date(j.appliedAt).toLocaleDateString() : '–'}</td>
              <td><select value={j.status} onChange={e => set(j.id, e.target.value as JobStatus)}>
                {(['saved', 'tailored', 'applied', 'interview', 'offer', 'rejected', 'hidden'] as JobStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )
}
