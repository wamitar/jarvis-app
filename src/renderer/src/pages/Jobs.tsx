import { useEffect, useMemo, useState } from 'react'
import { diffWordsWithSpace } from 'diff'
import type { AppState } from '../../../shared/api'
import type { Job, JobStatus, PrefillResult, Resume, Tailored } from '../../../shared/types'
import { resumeToText } from '../../../shared/types'
import { ResumeEditor } from '../components/ResumeEditor'
import { errText, type PageId, type Toast } from '../App'
import { STATUS_LABEL } from './Tracker'

const REGION_LABEL: Record<string, string> = { ontario: 'Ontario', canada: 'Canada', usa: 'USA', other: 'Other' }
const scoreClass = (s: number | null): string => (s == null ? '' : s >= 75 ? ' hi' : s >= 50 ? ' mid' : ' lo')

interface Props { state: AppState; jobs: Job[]; selected: string | null; setSelected: (id: string | null) => void; reload: () => Promise<void>; notify: Toast; busy: boolean; go: (p: PageId) => void }

export function JobsPage({ state, jobs, selected, setSelected, reload, notify, busy, go }: Props) {
  const [q, setQ] = useState('')
  const [region, setRegion] = useState('all')
  const [show, setShow] = useState<'open' | 'new' | 'saved' | 'applied' | 'hidden'>('open')
  const [minScore, setMinScore] = useState(0)
  const [adding, setAdding] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const visible = useMemo(() => jobs.filter(j => {
    if (show === 'hidden') { if (j.status !== 'hidden') return false }
    else if (j.status === 'hidden') return false
    else if (show === 'applied') { if (!['applied', 'interview', 'offer', 'rejected'].includes(j.status)) return false }
    else if (show === 'new' && j.status !== 'new') return false
    else if (show === 'saved' && j.status === 'new') return false
    else if (show === 'open' && ['applied', 'interview', 'offer', 'rejected'].includes(j.status)) return false
    if (region !== 'all' && j.region !== region) return false
    if (minScore && (j.score ?? 0) < minScore) return false
    if (q && !`${j.title} ${j.company} ${j.location}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  }), [jobs, q, region, show, minScore])
  const current = jobs.find(j => j.id === selected) || null

  const refresh = async (): Promise<void> => {
    setSummary(null); setErrors([])
    try {
      const r = await window.api.refresh()
      await reload()
      setSummary(`Checked ${r.fetched.toLocaleString()} postings. ${r.passed} matched your rules and ${r.added} ${r.added === 1 ? 'is' : 'are'} new. Nothing was sent to Claude: press Score when you want match scores.`)
      setErrors(r.errors)
    } catch (e) { notify(errText(e), true) }
  }

  const unscored = jobs.filter(j => j.score == null && j.status !== 'hidden').length
  const score = async (): Promise<void> => {
    setSummary(null)
    try { const n = await window.api.score(); await reload(); setSummary(`Claude scored ${n} ${n === 1 ? 'job' : 'jobs'}.`) } catch (e) { await reload(); notify(errText(e), true) }
  }
  const quick = async (e: { stopPropagation(): void }, j: Job, status: JobStatus): Promise<void> => {
    e.stopPropagation()
    await window.api.updateJob(j.id, { status })
    if (selected === j.id && (status === 'hidden' || status === 'applied')) setSelected(null)
    await reload()
    notify(status === 'hidden' ? `Removed "${j.title}". Find it under Hidden to bring it back.` : status === 'applied' ? `Marked "${j.title}" as applied. It is now in the Tracker.` : 'Moved back to your list.')
  }

  return (
    <>
      <div style={{ padding: '4px 20px 0 20px' }}>
        <div className="head" style={{ marginBottom: 8 }}>
          <div><h1>Jobs</h1><p>Mechanical engineering internships and co-ops: large employers and hardware startups in the USA and Canada, any company in Ontario.</p></div>
          <div className="rowx">
            <button className="btn" onClick={() => setAdding(a => !a)}>Add a job by link</button>
            <button className="btn" onClick={score} disabled={busy || !unscored || !state.hasResume} title={state.hasResume ? `About ${Math.ceil(unscored / 15)} Claude calls` : 'Add your resume first'}>
              {unscored ? `Score ${unscored} unscored ${unscored === 1 ? 'job' : 'jobs'} with Claude` : 'All jobs scored'}</button>
            <button className="btn primary" onClick={refresh} disabled={busy}>{busy && <span className="spin" />}{busy ? 'Working…' : 'Get jobs'}</button>
          </div>
        </div>
        {!state.hasResume && <div className="banner info"><span>Add your resume so Claude can score how well each job fits you.</span><button className="btn sm" onClick={() => go('resume')}>Add resume</button></div>}
        {summary && <div className="banner good"><span>{summary}</span><button className="btn ghost sm" onClick={() => setSummary(null)}>Dismiss</button></div>}
        {errors.length > 0 && <div className="banner warn"><details><summary>{errors.length} {errors.length === 1 ? 'source' : 'sources'} could not be read this time</summary><ul className="plain small">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details><button className="btn ghost sm" onClick={() => setErrors([])}>Dismiss</button></div>}
        {adding && <AddJob notify={notify} done={async id => { setAdding(false); await reload(); if (id) setSelected(id) }} />}
      </div>
      <div className="split">
        <div className="list">
          <div className="filters">
            <input placeholder="Search title, company, place" value={q} onChange={e => setQ(e.target.value)} />
            <select value={show} onChange={e => setShow(e.target.value as typeof show)}><option value="open">Not applied yet</option><option value="new">New only</option><option value="saved">Saved or tailored</option><option value="applied">Applied</option><option value="hidden">Hidden (not interested)</option></select>
            <select value={region} onChange={e => setRegion(e.target.value)}><option value="all">Everywhere</option><option value="ontario">Ontario</option><option value="canada">Rest of Canada</option><option value="usa">USA</option></select>
            <select value={minScore} onChange={e => setMinScore(Number(e.target.value))}><option value={0}>Any match</option><option value={50}>50+</option><option value={75}>75+</option></select>
          </div>
          {visible.length === 0 && <div className="empty"><h2>{jobs.length ? 'No jobs match these filters' : 'No jobs yet'}</h2><p>{jobs.length ? 'Loosen a filter above.' : 'Press Get jobs to search about ' + state.boards.length + ' company job boards. The first run takes a few minutes.'}</p></div>}
          {visible.map(j => {
            const applied = ['applied', 'interview', 'offer', 'rejected'].includes(j.status)
            return (
              <div key={j.id} role="button" tabIndex={0} className={'job' + (j.id === selected ? ' on' : '')} onClick={() => setSelected(j.id)}
                onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelected(j.id) } }}>
                <div className={'score' + scoreClass(j.score)}>{j.score ?? '–'}</div>
                <div><div className="t">{j.title}</div><div className="c">{j.company} · {j.location || 'Location not given'}</div>
                  <div style={{ marginTop: 4 }}><span className="pill">{REGION_LABEL[j.region]}</span>{j.status !== 'new' && <span className="pill accent">{STATUS_LABEL[j.status]}</span>}</div></div>
                <div className="acts">
                  {j.status === 'hidden'
                    ? <button className="icon ok" title="Bring back" aria-label={`Bring back ${j.title}`} onClick={e => quick(e, j, 'new')}>↩</button>
                    : <button className="icon" title="Not interested" aria-label={`Not interested in ${j.title}`} onClick={e => quick(e, j, 'hidden')}>✕</button>}
                  {j.status !== 'hidden' && <button className={'icon ok' + (applied ? ' done' : '')} title={applied ? 'Applied. Click to undo.' : 'I already applied'} aria-label={applied ? `Undo applied for ${j.title}` : `Mark ${j.title} as applied`}
                    onClick={e => quick(e, j, applied ? 'saved' : 'applied')}>✓</button>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="detail">
          {current ? <JobDetail key={current.id} job={current} state={state} reload={reload} notify={notify} go={go} />
            : <div className="empty"><h2>Pick a job</h2><p>Jobs are ranked by how well they fit your resume.</p></div>}
        </div>
      </div>
    </>
  )
}

function AddJob({ notify, done }: { notify: Toast; done: (id: string | null) => void }) {
  const [url, setUrl] = useState(''); const [text, setText] = useState(''); const [busy, setBusy] = useState(false)
  const add = async (): Promise<void> => {
    setBusy(true)
    try { const j = await window.api.addJob({ url, text }); notify(`Added ${j.title} at ${j.company}.`); done(j.id) } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>Add a job from anywhere</h3>
      <p className="muted small" style={{ marginBottom: 8 }}>For postings on LinkedIn, Indeed or a company site. Paste the link. If the site blocks the app from reading it, also paste the posting text.</p>
      <div className="stack">
        <input placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} />
        <textarea rows={3} placeholder="Posting text (optional if the link can be read)" value={text} onChange={e => setText(e.target.value)} />
        <div className="rowx"><button className="btn primary" onClick={add} disabled={busy || (!url.trim() && !text.trim())}>{busy && <span className="spin" />}Add job</button><button className="btn ghost" onClick={() => done(null)}>Cancel</button></div>
      </div>
    </div>
  )
}

function JobDetail({ job, state, reload, notify, go }: { job: Job; state: AppState; reload: () => Promise<void>; notify: Toast; go: (p: PageId) => void }) {
  const [tab, setTab] = useState<'posting' | 'resume' | 'apply'>('posting')
  const [tailored, setTailored] = useState<Tailored | null>(null)
  const [notes, setNotes] = useState(job.notes)
  useEffect(() => { window.api.getJob(job.id).then(r => setTailored(r?.tailored || null)) }, [job.id])
  const setStatus = async (status: JobStatus): Promise<void> => { await window.api.updateJob(job.id, { status }); await reload() }

  return (
    <div>
      <div className="rowx" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <div><h2>{job.title}</h2><p className="muted">{job.company} · {job.location || 'Location not given'}</p>
          <p style={{ marginTop: 6 }}><span className="pill">{REGION_LABEL[job.region]}</span><span className="pill">{job.source === 'manual' ? 'Added by you' : job.source}</span>
            {job.postedAt && <span className="pill">Posted {new Date(job.postedAt).toLocaleDateString()}</span>}<span className="pill accent">{STATUS_LABEL[job.status]}</span></p></div>
        <div className={'score' + scoreClass(job.score)} style={{ width: 52, height: 52, fontSize: 16, flex: 'none' }}>{job.score ?? '–'}</div>
      </div>
      <div className="rowx" style={{ marginTop: 12 }}>
        {job.url && <button className="btn" onClick={() => window.api.openExternal(job.url)}>Open posting</button>}
        {job.status === 'new' && <button className="btn" onClick={() => setStatus('saved')}>Save</button>}
        {job.status !== 'hidden' ? <button className="btn ghost" onClick={() => setStatus('hidden')}>Hide</button> : <button className="btn ghost" onClick={() => setStatus('new')}>Unhide</button>}
      </div>
      <div className="tabs">
        <button className={tab === 'posting' ? 'on' : ''} onClick={() => setTab('posting')}>Posting</button>
        <button className={tab === 'resume' ? 'on' : ''} onClick={() => setTab('resume')}>Tailored resume{tailored?.pdfPath ? ' ✓' : ''}</button>
        <button className={tab === 'apply' ? 'on' : ''} onClick={() => setTab('apply')}>Apply</button>
      </div>
      {tab === 'posting' && (<>
        {job.score != null && (job.reasons.length > 0 || job.missing.length > 0) && (
          <div className="card why" style={{ marginBottom: 14 }}>
            <div><b>Why it fits</b><ul>{job.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            <div><b>Gaps</b>{job.missing.length ? <ul>{job.missing.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="muted">None found.</p>}</div>
          </div>
        )}
        <label className="f" style={{ marginBottom: 14 }}><span>Your notes</span>
          <input value={notes} placeholder="Referral, deadline, anything to remember" onChange={e => setNotes(e.target.value)} onBlur={async () => { if (notes !== job.notes) { await window.api.updateJob(job.id, { notes }); await reload() } }} /></label>
        <div className="posting">{job.description || 'This posting has no text saved. Open the posting to read it.'}</div>
      </>)}
      {tab === 'resume' && <ResumeTab job={job} state={state} tailored={tailored} setTailored={setTailored} reload={reload} notify={notify} go={go} />}
      {tab === 'apply' && <ApplyTab job={job} ownPdf={state.resumePdf?.name || ''} tailored={tailored} setStatus={setStatus} notify={notify} goResume={() => setTab('resume')} />}
    </div>
  )
}

function Diff({ base, next }: { base: Resume; next: Resume }) {
  const parts = useMemo(() => diffWordsWithSpace(resumeToText(base), resumeToText(next)), [base, next])
  return <div className="diff">{parts.map((p, i) => (p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>))}</div>
}

function ResumeTab({ job, state, tailored, setTailored, reload, notify, go }: { job: Job; state: AppState; tailored: Tailored | null; setTailored: (t: Tailored) => void; reload: () => Promise<void>; notify: Toast; go: (p: PageId) => void }) {
  const [busy, setBusy] = useState<'' | 'tailor' | 'save'>('')
  const [withCover, setWithCover] = useState(true)
  const [view, setView] = useState<'diff' | 'edit'>('diff')
  const [draft, setDraft] = useState<Resume | null>(tailored?.resume || null)
  const [letter, setLetter] = useState(tailored?.coverLetter || '')
  const [version, setVersion] = useState(0)
  const [pages, setPages] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (tailored && !dirty) { setDraft(tailored.resume); setLetter(tailored.coverLetter) } }, [tailored])

  const run = async (): Promise<void> => {
    setBusy('tailor')
    try { const t = await window.api.tailor(job.id, withCover); setTailored(t); setDraft(t.resume); setLetter(t.coverLetter); setVersion(v => v + 1); setDirty(true); setPages(null) }
    catch (e) { notify(errText(e), true) } finally { setBusy('') }
  }
  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy('save')
    try { const t = await window.api.saveTailored(job.id, draft, letter); setTailored(t); setPages(t.pages); setDirty(false); await reload(); notify('PDF saved in Documents › Internship Hunter.') }
    catch (e) { notify(errText(e), true) } finally { setBusy('') }
  }
  if (!state.hasResume) return <div className="empty"><h2>Add your resume first</h2><p><a onClick={() => go('resume')}>Go to the Resume page</a> and import your PDF.</p></div>

  const controls = (
    <div className="rowx">
      <button className={'btn' + (tailored ? '' : ' primary')} onClick={run} disabled={!!busy}>{busy === 'tailor' && <span className="spin" />}{busy === 'tailor' ? 'Claude is writing… about a minute' : tailored ? 'Tailor again' : 'Tailor my resume for this job'}</button>
      <label className="rowx small"><input type="checkbox" style={{ width: 'auto' }} checked={withCover} onChange={e => setWithCover(e.target.checked)} />Also write a cover letter</label>
    </div>
  )
  if (!tailored || !draft) return <div><p className="muted" style={{ marginBottom: 12 }}>Claude rewords and reorders your resume for this posting. It is told never to add experience, skills or numbers you do not have, and the app flags anything that looks new.</p>{controls}</div>

  return (
    <div>
      {controls}
      {tailored.warnings.length > 0 && <div className="banner warn" style={{ marginTop: 14, display: 'block' }}><b>Check these before you send it.</b> They do not appear in your original resume:
        <ul className="plain small" style={{ marginTop: 4 }}>{tailored.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      {tailored.changes.length > 0 && <div className="card" style={{ marginTop: 14 }}><h3>What Claude changed</h3><ul className="plain">{tailored.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
      <div className="rowx" style={{ margin: '16px 0 10px', justifyContent: 'space-between' }}>
        <div className="rowx"><button className={'btn sm' + (view === 'diff' ? ' primary' : '')} onClick={() => setView('diff')}>Compare with original</button><button className={'btn sm' + (view === 'edit' ? ' primary' : '')} onClick={() => setView('edit')}>Edit</button></div>
        <div className="rowx">
          {pages != null && <span className={'small ' + (pages > 1 ? '' : 'muted')} style={pages > 1 ? { color: 'var(--warn)' } : {}}>{pages > 1 ? `PDF is ${pages} pages. Trim it in Edit to fit one.` : 'PDF is 1 page.'}</span>}
          {tailored.pdfPath && !dirty && <button className="btn sm" onClick={() => window.api.revealPdf(job.id)}>Show in Finder</button>}
          <button className="btn primary" onClick={save} disabled={!!busy || (!dirty && !!tailored.pdfPath)}>{busy === 'save' && <span className="spin" />}{tailored.pdfPath && !dirty ? 'PDF saved' : 'Save PDF'}</button>
        </div>
      </div>
      {view === 'diff' ? <Diff base={state.resume} next={draft} /> : <ResumeEditor key={version} value={draft} onChange={r => { setDraft(r); setDirty(true) }} />}
      <div className="card" style={{ marginTop: 14 }}><h3>Cover letter</h3>
        <textarea rows={letter ? 12 : 3} value={letter} placeholder="No cover letter. Tick the box above and tailor again, or write one here." onChange={e => { setLetter(e.target.value); setDirty(true) }} /></div>
    </div>
  )
}

function ApplyTab({ job, ownPdf, tailored, setStatus, notify, goResume }: { job: Job; ownPdf: string; tailored: Tailored | null; setStatus: (s: JobStatus) => Promise<void>; notify: Toast; goResume: () => void }) {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<PrefillResult | null>(null)
  const [earlier, setEarlier] = useState<PrefillResult[]>([])
  // Workday applications are filled page by page; each later page reports here.
  useEffect(() => window.api.onPrefillUpdate(u => { if (u.jobId === job.id) setRes(prev => { if (prev) setEarlier(e => [prev, ...e].slice(0, 12)); return u.result }) }), [job.id])
  const run = async (again: boolean): Promise<void> => {
    setBusy(true)
    try { if (!again) setEarlier([]); const r = again ? await window.api.fillAgain(job.id) : await window.api.prefill(job.id); setRes(prev => { if (prev && again) setEarlier(e => [prev, ...e].slice(0, 12)); return r }) } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  return (
    <div>
      {!tailored?.pdfPath && (ownPdf
        ? <div className="banner info"><span>No tailored resume for this job, so your own resume ({ownPdf}) will be attached.</span><button className="btn sm" onClick={goResume}>Tailor resume</button></div>
        : <div className="banner warn"><span>No resume PDF to attach: tailor one for this job, or add your PDF on the Resume page.</span><button className="btn sm" onClick={goResume}>Tailor resume</button></div>)}
      <p className="muted" style={{ marginBottom: 12 }}>The app opens the application in a Chrome window, types in your profile, attaches the tailored PDF and drafts answers to written questions. It never presses Submit, and CAPTCHAs are yours to do.{job.source === 'workday' && ' This one is on Workday: the app presses Apply, signs in or fills the account page with the login saved in Settings, then fills each page as you move through it.'}</p>
      <div className="rowx">
        <button className="btn primary" onClick={() => run(false)} disabled={busy}>{busy && <span className="spin" />}{busy ? 'Filling the form…' : 'Pre-fill application'}</button>
        {res && <button className="btn" onClick={() => run(true)} disabled={busy}>Fill this page again</button>}
        {job.status !== 'applied' ? <button className="btn" onClick={async () => { await setStatus('applied'); notify('Marked as applied.') }}>I submitted it: mark as applied</button> : <span className="pill good">Applied {job.appliedAt ? new Date(job.appliedAt).toLocaleDateString() : ''}</span>}
      </div>
      {res && (<div style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 8 }}>{res.page}</h3>
        {res.note && <div className="banner info">{res.note}</div>}
        <div className="grid2">
          <div className="card" style={{ margin: 0 }}><h3>Filled ({res.filled.length})</h3>{res.filled.length ? <ul className="plain small">{res.filled.map((f, i) => <li key={i}>{f}</li>)}</ul> : <p className="muted small">Nothing yet.</p>}</div>
          <div className="card" style={{ margin: 0 }}><h3>Left for you ({res.skipped.length})</h3>{res.skipped.length ? <ul className="plain small">{res.skipped.map((f, i) => <li key={i}>{f}</li>)}</ul> : <p className="muted small">Nothing.</p>}</div>
        </div>
        {res.drafted.length > 0 && <div className="card"><h3>Answers Claude drafted: read these before you submit</h3>{res.drafted.map((d, i) => <div key={i} style={{ marginBottom: 10 }}><b className="small">{d.question}</b><div className="posting">{d.answer}</div></div>)}</div>}
      </div>)}
      {earlier.length > 0 && <div className="log"><b className="small muted">Earlier pages</b>{earlier.map((r, i) => (
        <div key={i} className="small" style={{ marginTop: 6 }}><b>{r.page}</b>: {r.filled.length ? r.filled.join(', ') : 'nothing filled'}{r.skipped.length ? `. Left for you: ${r.skipped.length}` : ''}</div>))}</div>}
    </div>
  )
}
