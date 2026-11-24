import { ai } from '../ai'
import { useState } from 'react'
import type { AppState } from '../../../shared/api'
import type { DocKind, Profile, SavedAnswer } from '../../../shared/types'
import { DOC_KIND_LABEL } from '../../../shared/types'
import type { Toast } from '../App'

const YESNO = ['', 'Yes', 'No']

export function ProfilePage({ state, reload, notify }: { state: AppState; reload: () => Promise<void>; notify: Toast }) {
  const [p, setP] = useState<Profile>(state.profile)
  const [dirty, setDirty] = useState(false)
  type TextKey = Exclude<keyof Profile, 'moreProjects' | 'answers'>
  type Project = Profile['moreProjects'][number]
  const set = (k: TextKey, v: string): void => { setP({ ...p, [k]: v }); setDirty(true) }
  const projects = p.moreProjects || []
  const setProjects = (list: Project[]): void => { setP({ ...p, moreProjects: list }); setDirty(true) }
  const editProject = (i: number, patch: Partial<Project>): void => setProjects(projects.map((x, n) => (n === i ? { ...x, ...patch } : x)))
  const answers = p.answers || []
  const setAnswers = (list: SavedAnswer[]): void => { setP({ ...p, answers: list }); setDirty(true) }
  const editAnswer = (i: number, patch: Partial<SavedAnswer>): void => setAnswers(answers.map((x, n) => (n === i ? { ...x, ...patch } : x)))
  const EEO = (k: TextKey, label: string, placeholder: string) => (
    <label className="f"><span>{label}</span><input value={(p[k] as string | undefined) ?? ''} placeholder={placeholder} onChange={e => set(k, e.target.value)} /></label>
  )
  const T = (k: TextKey, label: string, placeholder = '') => (
    <label className="f"><span>{label}</span><input value={(p[k] as string | undefined) ?? ''} placeholder={placeholder} onChange={e => set(k, e.target.value)} /></label>
  )
  const S = (k: TextKey, label: string) => (
    <label className="f"><span>{label}</span>
      <select style={{ width: '100%' }} value={p[k]} onChange={e => set(k, e.target.value)}>{YESNO.map(o => <option key={o} value={o}>{o || 'Not set'}</option>)}</select>
    </label>
  )
  const save = async (): Promise<void> => {
    const clean = projects.map(x => ({ ...x, name: x.name.trim(), bullets: x.bullets.map(b => b.trim()).filter(Boolean) })).filter(x => x.name || x.bullets.length)
    const saved = answers.map(x => ({ ...x, q: x.q.trim(), a: x.a.trim() })).filter(x => x.q && x.a)
    await window.api.saveProfile({ ...p, moreProjects: clean, answers: saved }); setP({ ...p, moreProjects: clean, answers: saved }); setDirty(false); await reload(); notify('Profile saved.') }

  return (
    <div className="page narrow">
      <div className="head">
        <div><h1>Application profile</h1><p>Answers the app types into application forms. Stored only on this Mac. {ai()} fills every other question it can work out from these answers and your resume.</p></div>
        <button className="btn primary" onClick={save} disabled={!dirty}>Save changes</button>
      </div>
      <div className="card"><h3>Contact</h3><div className="stack">
        <div className="grid2">{T('firstName', 'First name')}{T('lastName', 'Last name')}</div>
        <div className="grid2">{T('email', 'Email')}{T('phone', 'Phone')}</div>
        {T('address', 'Street address', '123 Main St')}
        <div className="grid2">{T('city', 'City')}{T('province', 'Province or state', 'Ontario')}</div>
        <div className="grid2">{T('postalCode', 'Postal or ZIP code')}{T('country', 'Country')}</div>
        <div className="grid3">{T('linkedin', 'LinkedIn')}{T('github', 'GitHub')}{T('website', 'Website or portfolio')}</div>
      </div></div>
      <div className="card"><h3>School</h3><div className="stack">
        <div className="grid2">{T('school', 'School')}{T('degree', 'Degree', 'Bachelor of Applied Science')}</div>
        <div className="grid3">{T('major', 'Major')}{T('gpa', 'GPA', '3.7 / 4.0')}{T('graduation', 'Expected graduation', 'April 2028')}</div>
      </div></div>
      <div className="card"><h3>Work eligibility and timing</h3><div className="stack">
        {T('citizenship', 'Citizenship (every country you are a citizen of)', 'Canada')}
        {T('citizenshipDates', 'When you got each citizenship (some employers ask, e.g. nuclear and defence)', 'Canada: 2005-03-14 (by birth); United States: 2005-03-14 (by birth)')}
        <div className="grid3">{S('workAuthCanada', 'Authorized to work in Canada')}{S('workAuthUsa', 'Authorized to work in the USA')}{S('workAuthUk', 'Authorized to work in the UK')}</div>
        <div className="grid3">{S('needsSponsorship', 'Need sponsorship in Canada')}{S('sponsorshipUsa', 'Need sponsorship in the USA')}{S('sponsorshipUk', 'Need sponsorship in the UK')}</div>
        <p className="muted">Forms are answered for the country the job is in. Answer truthfully: a false answer can get an offer withdrawn.</p>
        <div className="grid3">{T('availability', 'Available from', 'May 2027')}{T('termLength', 'Term length', '4 months')}{S('willingToRelocate', 'Willing to relocate')}</div>
      </div></div>
      <div className="card"><h3>Other facts {ai()} may use</h3>
        <label className="f"><span>Used for cover letters and screening questions. Write only things that are true: why mechanical engineering, industries you like, clubs, anything not on the resume.</span>
          <textarea rows={5} value={p.extra} onChange={e => set('extra', e.target.value)} /></label>
      </div>
      <div className="card"><h3>Voluntary self-identification</h3>
        <p className="muted" style={{ marginBottom: 10 }}>US employers ask these on almost every form. Leave a box empty to decline to answer wherever the form allows it. If a form insists (no "decline" choice), auto-apply only answers what you put here, and otherwise stops and asks you.</p>
        <div className="grid3">{EEO('eeoGender', 'Gender', 'Decline to answer')}{EEO('eeoHispanic', 'Hispanic or Latino', 'Decline to answer')}{EEO('eeoRace', 'Race / ethnicity', 'Decline to answer')}</div>
        <div className="grid2" style={{ marginTop: 12 }}>{EEO('eeoVeteran', 'Veteran status', 'Decline to answer')}{EEO('eeoDisability', 'Disability', 'Decline to answer')}</div>
      </div>
      <div className="card"><h3>Saved answers</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Your own answers to application questions. {ai()} works out most questions from your profile and resume; when it cannot, auto-apply flags the job and asks you on the Status page, and what you type there is kept here. Every later form that asks the same thing (in any wording) gets this answer.</p>
        <div className="stack">
          {answers.map((x, i) => (
            <div key={i} className="grid2" style={{ alignItems: 'end' }}>
              <label className="f"><span>Question</span><input value={x.q} onChange={e => editAnswer(i, { q: e.target.value })} /></label>
              <div className="rowx" style={{ flexWrap: 'nowrap' }}>
                <label className="f" style={{ flex: 1 }}><span>Answer</span><input value={x.a} onChange={e => editAnswer(i, { a: e.target.value })} /></label>
                <button className="btn ghost sm" onClick={() => setAnswers(answers.filter((_, n) => n !== i))}>Remove</button>
              </div>
            </div>
          ))}
          <div><button className="btn" onClick={() => setAnswers([...answers, { q: '', a: '' }])}>Add an answer</button></div>
        </div>
      </div>
      <div className="card"><h3>More projects</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Projects that are not on your resume. When you tailor a resume, {ai()} looks at these together with the resume's own projects and keeps the ones that fit the posting best, so the resume stays one page. Write them the way you would on a resume. Mark bold with **two asterisks**.</p>
        <div className="stack">
          {projects.map((x, i) => (
            <div key={i} className="stack" style={{ borderTop: i ? '1px solid var(--border)' : 'none', paddingTop: i ? 12 : 0 }}>
              <div className="grid2">
                <label className="f"><span>Project name</span><input value={x.name} onChange={e => editProject(i, { name: e.target.value })} /></label>
                <label className="f"><span>Tools and software</span><input value={x.tech} placeholder="SolidWorks, ANSYS, Python" onChange={e => editProject(i, { tech: e.target.value })} /></label>
              </div>
              <label className="f"><span>Bullets, one per line</span>
                <textarea rows={4} value={x.bullets.join('\n')} onChange={e => editProject(i, { bullets: e.target.value.split('\n') })} /></label>
              <div><button className="btn ghost sm" onClick={() => setProjects(projects.filter((_, n) => n !== i))}>Remove this project</button></div>
            </div>
          ))}
          <div><button className="btn" onClick={() => setProjects([...projects, { name: '', dates: '', tech: '', bullets: [] }])}>Add a project</button></div>
        </div>
      </div>
      <div className="card"><h3>More software and skills</h3>
        <label className="f"><span>Everything you can use that is not on your resume, separated by commas. Tailoring keeps every skill already on your resume and may add these, and it adds software and skills a posting asks for. Anything it adds is listed for you to check before you save the PDF.</span>
          <textarea rows={3} value={p.moreSkills || ''} placeholder="MATLAB, Fusion 360, GD&T, Arduino, LabVIEW" onChange={e => set('moreSkills', e.target.value)} /></label>
      </div>
      <Documents state={state} reload={reload} notify={notify} />
    </div>
  )
}

/** Extra files for applications. The app works out what each one is; the kind can be corrected by hand. */
function Documents({ state, reload, notify }: { state: AppState; reload: () => Promise<void>; notify: Toast }) {
  const [busy, setBusy] = useState(false)
  const docs = state.documents || []
  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      const added = await window.api.addDocuments()
      await reload()
      if (added.length) notify(added.map(d => `${d.name}: ${DOC_KIND_LABEL[d.kind]}`).join(' · '))
    } catch (e) { notify(`Could not add: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  return (
    <div className="card"><h3>Additional documents</h3>
      <p className="muted small" style={{ marginBottom: 10 }}>Transcripts, portfolios, reference letters, certificates and so on. The app reads each file and works out what it is, then attaches it when an application has an upload box for that kind (for example "Upload your transcript"). Your resume and cover letter are handled separately. Correct the kind if it guessed wrong.</p>
      {docs.length > 0 && <table style={{ marginBottom: 12 }}><tbody>
        {docs.map(d => (
          <tr key={d.id}>
            <td><b>{d.name}</b><div className="muted small">{d.summary}</div></td>
            <td style={{ width: 190 }}>
              <select style={{ width: '100%' }} value={d.kind} onChange={async e => { await window.api.setDocumentKind(d.id, e.target.value as DocKind); await reload() }}>
                {(Object.keys(DOC_KIND_LABEL) as DocKind[]).map(k => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
              </select>
              {!d.byUser && <div className="muted small">detected by the app</div>}
            </td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <button className="btn ghost sm" onClick={() => window.api.revealDocument(d.id)}>Show</button>
              <button className="btn ghost sm" onClick={async () => { await window.api.removeDocument(d.id); await reload(); notify(`${d.name} removed.`) }}>Remove</button>
            </td>
          </tr>
        ))}</tbody></table>}
      <button className="btn" disabled={busy} onClick={add}>{busy ? 'Reading…' : 'Add documents'}</button>
    </div>
  )
}
