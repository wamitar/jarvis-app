import { useState } from 'react'
import type { AppState } from '../../../shared/api'
import type { Profile } from '../../../shared/types'
import type { Toast } from '../App'

const YESNO = ['', 'Yes', 'No']

export function ProfilePage({ state, reload, notify }: { state: AppState; reload: () => Promise<void>; notify: Toast }) {
  const [p, setP] = useState<Profile>(state.profile)
  const [dirty, setDirty] = useState(false)
  const set = (k: keyof Profile, v: string): void => { setP({ ...p, [k]: v }); setDirty(true) }
  const T = (k: keyof Profile, label: string, placeholder = '') => (
    <label className="f"><span>{label}</span><input value={p[k]} placeholder={placeholder} onChange={e => set(k, e.target.value)} /></label>
  )
  const S = (k: keyof Profile, label: string) => (
    <label className="f"><span>{label}</span>
      <select style={{ width: '100%' }} value={p[k]} onChange={e => set(k, e.target.value)}>{YESNO.map(o => <option key={o} value={o}>{o || 'Not set'}</option>)}</select>
    </label>
  )
  const save = async (): Promise<void> => { await window.api.saveProfile(p); setDirty(false); await reload(); notify('Profile saved.') }

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
    </div>
  )
}
