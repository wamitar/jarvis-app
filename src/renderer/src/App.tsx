import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '../../shared/api'
import type { Job, RefreshProgress, Usage } from '../../shared/types'
import { JobsPage } from './pages/Jobs'
import { TrackerPage } from './pages/Tracker'
import { ResumePage } from './pages/ResumePage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'

export type Toast = (msg: string, err?: boolean) => void
export type PageId = 'jobs' | 'tracker' | 'resume' | 'profile' | 'settings'
export const errText = (e: unknown): string => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const fmt = (n: number): string => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [page, setPage] = useState<PageId>('jobs')
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<RefreshProgress | null>(null)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [usage, setUsage] = useState<Usage>({ calls: 0, input: 0, output: 0 })

  const reload = useCallback(async () => {
    const [s, j] = await Promise.all([window.api.getState(), window.api.listJobs()])
    setState(s); setJobs(j); setUsage(s.usage)
  }, [])
  const notify: Toast = useCallback((msg, err = false) => { setToast({ msg, err }); setTimeout(() => setToast(t => (t?.msg === msg ? null : t)), err ? 9000 : 4500) }, [])

  useEffect(() => {
    reload().then(async () => { const s = await window.api.getState(); if (!s.hasResume) setPage('resume') })
    const a = window.api.onProgress(setProgress), b = window.api.onUsage(setUsage)
    return () => { a(); b() }
  }, [reload])

  if (!state) return null
  const active = jobs.filter(j => j.status !== 'hidden')
  const tracked = jobs.filter(j => ['applied', 'interview', 'offer', 'rejected'].includes(j.status)).length
  const openJob = (id: string): void => { setSelected(id); setPage('jobs') }
  const nav: [PageId, string, string?][] = [['jobs', 'Jobs', String(active.length || '')], ['tracker', 'Tracker', String(tracked || '')], ['resume', 'Resume'], ['profile', 'Profile'], ['settings', 'Settings']]

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><i>J</i>J.A.R.V.I.S.</div>
        <nav className="nav">
          {nav.map(([id, label, count]) => (
            <button key={id} className={page === id ? 'on' : ''} onClick={() => setPage(id)}>{label}<span className="count">{count}</span></button>
          ))}
        </nav>
        <div className="foot">
          <div><span className={'dot' + (state.cliFound ? '' : ' off')} />{state.cliFound ? 'Claude account connected' : 'Claude Code not found'}</div>
          <div className="usage" title="Totals since you started using the app. Input includes the instructions and resume sent with every call.">
            <div className="num"><b>{fmt(usage.input + usage.output)}</b> tokens used</div>
            <div className="num">{fmt(usage.input)} in · {fmt(usage.output)} out · {usage.calls} {usage.calls === 1 ? 'call' : 'calls'}</div>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="drag" />
        {progress && (<>
          <div className="progress"><div style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 5}%` }} /></div>
          <div className="progress-label num">{progress.stage}: {progress.detail} ({progress.done}/{progress.total})</div>
        </>)}
        {page === 'jobs' && <JobsPage state={state} jobs={jobs} selected={selected} setSelected={setSelected} reload={reload} notify={notify} busy={!!progress} go={setPage} />}
        {page === 'tracker' && <TrackerPage jobs={jobs} reload={reload} openJob={openJob} />}
        {page === 'resume' && <ResumePage state={state} reload={reload} notify={notify} go={setPage} />}
        {page === 'profile' && <ProfilePage state={state} reload={reload} notify={notify} />}
        {page === 'settings' && <SettingsPage state={state} reload={reload} notify={notify} />}
      </main>
      {toast && <div className={'toast' + (toast.err ? ' err' : '')} role="status">{toast.msg}</div>}
    </div>
  )
}
