import { ai, setAi } from './ai'
import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '../../shared/api'
import type { Activity, Job, LiveRun, RefreshProgress, Usage } from '../../shared/types'
import { JobsPage } from './pages/Jobs'
import { TrackerPage } from './pages/Tracker'
import { StatusPage } from './pages/StatusPage'
import { ResumePage } from './pages/ResumePage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'

export type Toast = (msg: string, err?: boolean) => void
export type PageId = 'jobs' | 'status' | 'tracker' | 'resume' | 'profile' | 'settings'
export const errText = (e: unknown): string => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const fmt = (n: number): string => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [page, setPage] = useState<PageId>('jobs')
  const [selected, setSelected] = useState<string | null>(null)
  setAi(state?.settings.aiProvider)   // on-screen text names the AI chosen in Settings
  const [progress, setProgress] = useState<RefreshProgress | null>(null)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [usage, setUsage] = useState<Usage>({ calls: 0, input: 0, output: 0 })
  const [activity, setActivity] = useState<Activity>({ working: false, stopping: false, tasks: [] })
  const [run, setRun] = useState<LiveRun | null>(null)
  const [skipping, setSkipping] = useState('')

  const reload = useCallback(async () => {
    const [s, j] = await Promise.all([window.api.getState(), window.api.listJobs()])
    setState(s); setJobs(j); setUsage(s.usage)
  }, [])
  const notify: Toast = useCallback((msg, err = false) => { setToast({ msg, err }); setTimeout(() => setToast(t => (t?.msg === msg ? null : t)), err ? 9000 : 4500) }, [])

  useEffect(() => {
    reload().then(async () => { const s = await window.api.getState(); if (!s.hasResume) setPage('resume') })
    const a = window.api.onProgress(setProgress), b = window.api.onUsage(setUsage), c = window.api.onActivity(setActivity)
    window.api.getActivity().then(setActivity)
    window.api.getLiveRun().then(setRun)
    const d = window.api.onLiveRun(setRun)
    return () => { a(); b(); c(); d() }
  }, [reload])

  const stop = async (): Promise<void> => {
    setActivity(await window.api.stopAll())
    notify('Stopped. Anything half-done was left as it is; the application browser stays open.')
    reload()
  }

  if (!state) return null
  // The task named in the light is the most specific one running; a Claude call inside a bigger task is shown as part of it.
  const main = activity.tasks.filter(t => !/^Waiting for (Claude|Codex)$/.test(t))
  const task = main[main.length - 1] || activity.tasks[0] || ''
  const withClaude = activity.tasks.some(t => /^Waiting for (Claude|Codex)$/.test(t)) && !/^Waiting for (Claude|Codex)$/.test(task)
  // Two lights that are always shown: auto-apply and the applications you fill yourself. Anything else (fetching, tailoring) is listed under them.
  const MANUAL = /^Filling an application$|^Watching the application/
  const autoJob = run?.running ? run.jobs.find(j => j.state === 'tailoring' || j.state === 'working') : undefined
  const manualTask = main.filter(t => MANUAL.test(t)).pop()
  const otherTask = main.filter(t => !MANUAL.test(t) && !/^Auto-appl/.test(t)).pop()
  const waiting = withClaude ? ` (waiting for ${ai()})` : ''
  // Jobs badge: only jobs still waiting on you (not applied to or past that, not hidden).
  const active = jobs.filter(j => ['new', 'saved', 'tailored'].includes(j.status))
  const tracked = jobs.filter(j => ['applied', 'interview', 'offer', 'rejected'].includes(j.status)).length
  const openJob = (id: string): void => { setSelected(id); setPage('jobs') }
  const nav: [PageId, string, string?][] = [['jobs', 'Jobs', String(active.length || '')], ['status', 'Status', activity.working ? '●' : ''], ['tracker', 'Tracker', String(tracked || '')], ['resume', 'Resume'], ['profile', 'Profile'], ['settings', 'Settings']]

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
          <div className={'status' + (run?.running ? ' on' : '')} role="status">
            <div className="label">Auto-apply</div>
            <div className="state"><span className="lamp" />{run?.running ? (autoJob?.state === 'tailoring' ? 'Tailoring' : 'Applying') : 'Idle'}
              {autoJob && <button className="skip" disabled={skipping === autoJob.jobId} onClick={() => { setSkipping(autoJob.jobId); window.api.skipAutoApply(autoJob.jobId).catch(() => setSkipping('')) }} title="Give up on this job and go on to the next one">Skip</button>}</div>
            {autoJob && <div className="what">{autoJob.company} · {autoJob.title}</div>}
          </div>
          <div className={'status' + (manualTask ? ' on' : '')} role="status">
            <div className="label">Manual applications</div>
            <div className="state"><span className="lamp" />{manualTask ? 'Working' : 'Idle'}</div>
            {manualTask && <div className="what">{manualTask}{task === manualTask ? waiting : ''}</div>}
          </div>
          {otherTask && <div className="what">Also: {otherTask}{task === otherTask ? waiting : ''}</div>}
          {activity.working && <button className="kill" onClick={stop} disabled={activity.stopping} title="Ends AI calls, form filling, the application watcher and job fetching. The application browser is left open.">{activity.stopping ? 'Stopping…' : 'Stop everything'}</button>}
          <div><span className={'dot' + (state.cliFound ? '' : ' off')} />{state.settings.aiProvider === 'codex' ? (state.cliFound ? 'Codex (ChatGPT) connected' : 'Codex not found') : (state.cliFound ? 'Claude account connected' : 'Claude Code not found')}</div>
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
        {page === 'status' && <StatusPage state={state} jobs={jobs} activity={activity} reload={reload} openJob={openJob} />}
        {page === 'tracker' && <TrackerPage jobs={jobs} reload={reload} openJob={openJob} gmailEmail={state.gmail.email} />}
        {page === 'resume' && <ResumePage state={state} reload={reload} notify={notify} go={setPage} />}
        {page === 'profile' && <ProfilePage state={state} reload={reload} notify={notify} />}
        {page === 'settings' && <SettingsPage state={state} reload={reload} notify={notify} />}
      </main>
      {toast && <div className={'toast' + (toast.err ? ' err' : '')} role="status">{toast.msg}</div>}
    </div>
  )
}
