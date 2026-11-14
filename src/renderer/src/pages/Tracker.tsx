import type { Job, JobStatus } from '../../../shared/types'

const ORDER: JobStatus[] = ['offer', 'interview', 'applied', 'tailored', 'saved', 'rejected']
export const STATUS_LABEL: Record<JobStatus, string> = { new: 'New', saved: 'Saved', tailored: 'Resume ready', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', hidden: 'Hidden' }

export function TrackerPage({ jobs, reload, openJob }: { jobs: Job[]; reload: () => Promise<void>; openJob: (id: string) => void }) {
  const rows = jobs.filter(j => ORDER.includes(j.status)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.appliedAt || '').localeCompare(a.appliedAt || ''))
  const count = (s: JobStatus): number => jobs.filter(j => j.status === s).length
  const set = async (id: string, status: JobStatus): Promise<void> => { await window.api.updateJob(id, { status }); await reload() }
  return (
    <div className="page">
      <div className="head"><div><h1>Tracker</h1>
        <p className="num">{count('applied')} applied · {count('interview')} interviewing · {count('offer')} offers · {count('tailored')} ready to send</p></div></div>
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
