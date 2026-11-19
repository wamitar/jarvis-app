import { useState } from 'react'
import type { AppState } from '../../../shared/api'
import type { Profile } from '../../../shared/types'
import type { Toast } from '../App'

const YESNO = ['', 'Yes', 'No']

export function ProfilePage({ state, reload, notify }: { state: AppState; reload: () => Promise<void>; notify: Toast }) {
  const [p, setP] = useState<Profile>(state.profile)
  const [dirty, setDirty] = useState(false)
  type TextKey = Exclude<keyof Profile, 'moreProjects'>
  type Project = Profile['moreProjects'][number]
  const set = (k: TextKey, v: string): void => { setP({ ...p, [k]: v }); setDirty(true) }
  const projects = p.moreProjects || []
  const setProjects = (list: Project[]): void => { setP({ ...p, moreProjects: list }); setDirty(true) }
  const editProject = (i: number, patch: Partial<Project>): void => setProjects(projects.map((x, n) => (n === i ? { ...x, ...patch } : x)))
  const T = (k: TextKey, label: string, placeholder = '') => (
    <label className="f"><span>{label}</span><input value={p[k]} placeholder={placeholder} onChange={e => set(k, e.target.value)} /></label>
  )
  const S = (k: TextKey, label: string) => (
    <label className="f"><span>{label}</span>
      <select style={{ width: '100%' }} value={p[k]} onChange={e => set(k, e.target.value)}>{YESNO.map(o => <option key={o} value={o}>{o || 'Not set'}</option>)}</select>
    </label>
  )
  const save = async (): Promise<void> => {
    const clean = projects.map(x => ({ ...x, name: x.name.trim(), bullets: x.bullets.map(b => b.trim()).filter(Boolean) })).filter(x => x.name || x.bullets.length)
    await window.api.saveProfile({ ...p, moreProjects: clean }); setP({ ...p, moreProjects: clean }); setDirty(false); await reload(); notify('Profile saved.') }

  return (
    <div className="page narrow">
      <div className="head">
        <div><h1>Application profile</h1><p>Answers the app types into application forms. Stored only on this Mac. Claude fills every other question it can work out from these answers and your resume.</p></div>
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
        {T('citizenship', 'Citizenship', 'United States and Canada')}
        <div className="grid3">{S('workAuthCanada', 'Authorized to work in Canada')}{S('workAuthUsa', 'Authorized to work in the USA')}{S('needsSponsorship', 'Need visa sponsorship')}</div>
        <div className="grid3">{T('availability', 'Available from', 'May 2027')}{T('termLength', 'Term length', '4 months')}{S('willingToRelocate', 'Willing to relocate')}</div>
      </div></div>
      <div className="card"><h3>Other facts Claude may use</h3>
        <label className="f"><span>Used for cover letters and screening questions. Write only things that are true: why mechanical engineering, industries you like, clubs, anything not on the resume.</span>
          <textarea rows={5} value={p.extra} onChange={e => set('extra', e.target.value)} /></label>
      </div>
      <div className="card"><h3>More projects</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Projects that are not on your resume. When you tailor a resume, Claude looks at these together with the resume's own projects and keeps the ones that fit the posting best, so the resume stays one page. Write them the way you would on a resume. Mark bold with **two asterisks**.</p>
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
    </div>
  )
}
