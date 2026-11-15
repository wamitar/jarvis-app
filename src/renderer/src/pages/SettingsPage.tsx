import { useState } from 'react'
import type { AppState } from '../../../shared/api'
import type { Board, Settings, WorkdayLogin } from '../../../shared/types'
import { errText, type Toast } from '../App'

const BIG_TECH = ['Amazon', 'AMD', 'Apple', 'Google', 'Microsoft', 'Netflix', 'NVIDIA', 'Intel', 'Qualcomm', 'OpenAI', 'Anthropic', 'SpaceX']
// Sites that forbid or block automated readers. The app links to their own search instead.
export const BLOCKED: [string, string][] = [
  ['Meta', 'https://www.metacareers.com/jobs?q=mechanical%20intern'],
  ['Tesla', 'https://www.tesla.com/careers/search/?query=mechanical%20intern&site=US']
]

/** What the last "Get jobs" run found at each company: proof a company was searched even when nothing matched. */
function Coverage({ state }: { state: AppState }) {
  const cov = state.coverage
  if (!cov.length) return <p className="muted small" style={{ marginTop: 10 }}>Press Get jobs once to see what each company returned.</p>
  const row = (c: (typeof cov)[number]) => (
    <tr key={c.company}><td>{c.company}</td><td className="num">{c.error ? '–' : c.read.toLocaleString()}</td><td className="num">{c.error ? '–' : c.interns}</td><td className="num"><b>{c.matched}</b></td>
      <td className="muted small">{c.error ? `Could not be read: ${c.error}` : c.matched ? '' : c.interns ? 'Internships posted, but none are mechanical-related undergrad roles in the USA or Canada' : 'No internships posted for these searches right now'}</td></tr>
  )
  const head = <thead><tr><th>Company</th><th>Postings read</th><th>Internships</th><th>In your list</th><th /></tr></thead>
  const big = BIG_TECH.map(n => cov.find(c => c.company === n)).filter((c): c is (typeof cov)[number] => !!c)
  const rest = cov.filter(c => !BIG_TECH.includes(c.company)).sort((a, b) => b.matched - a.matched || a.company.localeCompare(b.company))
  return (
    <div style={{ marginTop: 14 }}>
      <h3>Big tech in the last search</h3>
      <table>{head}<tbody>
        {big.map(row)}
        {BLOCKED.map(([name, url]) => <tr key={name}><td>{name}</td><td>–</td><td>–</td><td>–</td>
          <td className="small">Its site does not allow automated reading. <a onClick={() => window.api.openExternal(url)}>Open {name}'s internship search</a>, then use Add a job by link.</td></tr>)}
      </tbody></table>
      <details style={{ marginTop: 10 }}><summary className="small" style={{ cursor: 'pointer' }}>All {rest.length} other companies</summary><table>{head}<tbody>{rest.map(row)}</tbody></table></details>
    </div>
  )
}

export function SettingsPage({ state, reload, notify }: { state: AppState; reload: () => Promise<void>; notify: Toast }) {
  const [s, setS] = useState<Settings>(state.settings)
  const [nb, setNb] = useState<Board>({ company: '', ats: 'greenhouse', id: '', big: false })
  const [busy, setBusy] = useState(false)
  const save = async (next: Settings, msg = 'Settings saved.'): Promise<void> => { setS(next); await window.api.saveSettings(next); await reload(); notify(msg) }
  const addBoard = (): void => {
    if (!nb.company.trim() || !nb.id.trim()) return notify('Enter the company name and its board id.', true)
    save({ ...s, customBoards: [...s.customBoards, { ...nb, company: nb.company.trim(), id: nb.id.trim() }] }, `${nb.company} added. It is read on the next refresh.`)
    setNb({ company: '', ats: 'greenhouse', id: '', big: false })
  }
  const rescore = async (): Promise<void> => {
    setBusy(true)
    try { const n = await window.api.rescore(); await reload(); notify(`Rescored ${n} jobs.`) } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  const [wd, setWd] = useState<WorkdayLogin>(state.workday)
  const [wdEmail, setWdEmail] = useState(state.workday.email)
  const [wdPass, setWdPass] = useState('')
  const saveWd = async (): Promise<void> => {
    try { const r = await window.api.setWorkdayLogin(wdEmail, wdPass); setWd(r); setWdPass(''); await reload(); notify('Workday login saved. The password is in your Mac Keychain.') } catch (e) { notify(errText(e), true) }
  }
  const clearWd = async (): Promise<void> => { const r = await window.api.clearWorkdayLogin(); setWd(r); setWdEmail(''); setWdPass(''); await reload(); notify('Workday login removed from this app and from the Keychain.') }
  const curated = state.boards.length - s.customBoards.length

  return (
    <div className="page narrow">
      <div className="head"><div><h1>Settings</h1><p>{state.lastRefresh ? `Jobs last refreshed ${new Date(state.lastRefresh).toLocaleString()}.` : 'Jobs have not been refreshed yet.'}</p></div></div>

      <div className="card"><h3>Claude</h3>
        <p className="muted" style={{ marginBottom: 10 }}>The app uses the Claude Code sign-in on this Mac, so usage counts against your Claude plan. There is no API key and no extra bill.</p>
        <div className="grid2">
          <label className="f"><span>Model for scoring jobs</span>
            <select style={{ width: '100%' }} value={s.scoreModel} onChange={e => save({ ...s, scoreModel: e.target.value })}><option value="haiku">Haiku (lightest on your plan)</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label>
          <label className="f"><span>Model for resumes and answers</span>
            <select style={{ width: '100%' }} value={s.writeModel} onChange={e => save({ ...s, writeModel: e.target.value })}><option value="haiku">Haiku</option><option value="sonnet">Sonnet (recommended)</option><option value="opus">Opus (heaviest on your plan)</option></select></label>
        </div>
        <div style={{ marginTop: 12 }}><button className="btn" onClick={rescore} disabled={busy}>{busy && <span className="spin" />}Rescore all jobs</button>
          <span className="muted small" style={{ marginLeft: 10 }}>Clears every score and scores again. Use after you change your resume.</span></div>
      </div>

      <div className="card"><h3>Workday account</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Many large employers (Boeing, GM, NVIDIA, Magna and others) take applications through Workday, and each one needs its own account. Store one email and password here and the app uses them on every Workday site.</p>
        <ul className="plain small muted" style={{ marginBottom: 12 }}>
          <li><b>Stored once.</b> The password is kept in your Mac Keychain, not in the app's database, and is never shown again or sent to Claude.</li>
          <li><b>Account pages.</b> On a Workday Create Account page the app types the email, password and confirm-password. On a Sign In page it signs you in.</li>
          <li><b>Then the form.</b> Once you are in, it fills each application page as it appears. You press Save and Continue, and Submit.</li>
        </ul>
        <div className="grid2">
          <label className="f"><span>Workday email</span><input type="email" autoComplete="off" value={wdEmail} onChange={e => setWdEmail(e.target.value)} /></label>
          <label className="f"><span>{wd.hasPassword ? 'New password (leave empty to keep the saved one)' : 'Password'}</span>
            <input type="password" autoComplete="new-password" value={wdPass} placeholder={wd.hasPassword ? 'Saved in Keychain' : 'At least 8 characters, with a capital, a digit and a symbol'} onChange={e => setWdPass(e.target.value)} /></label>
        </div>
        <div className="rowx" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={saveWd} disabled={!wdEmail.trim() || !wdPass}>Save to Keychain</button>
          {wd.hasPassword && <button className="btn" onClick={clearWd}>Remove login</button>}
          <span className={'pill' + (wd.hasPassword ? ' good' : '')}>{wd.hasPassword ? `Saved for ${wd.email}` : 'No login saved'}</span>
        </div>
        <label className="rowx small" style={{ marginTop: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={s.workdayAutoCreate} onChange={e => save({ ...s, workdayAutoCreate: e.target.checked }, e.target.checked ? 'The app will press Create Account for you.' : 'You press Create Account yourself.')} />
          <span>Also tick the agreement box and press <b>Create Account</b> for me. This accepts that employer's Workday terms on your behalf each time. Left off, the app fills the three fields and you press the button. Email verification links are always yours to open.</span>
        </label>
      </div>

      <div className="card"><h3>Job sources</h3>
        <p className="muted">{curated} company job boards are built in, plus Job Bank Canada for Ontario. They include Amazon, AMD, Apple, Google, Microsoft, Netflix, NVIDIA, OpenAI, Anthropic, SpaceX and Y Combinator-backed hardware companies. Large employers and larger startups are searched across the USA and Canada. Every other company is kept only for Ontario jobs. Meta and Tesla block automated readers, so add their postings with Add a job by link.</p>
        <Coverage state={state} />
        <h3 style={{ marginTop: 16 }}>Add a company</h3>
        <p className="muted small" style={{ marginBottom: 8 }}>Works for companies whose careers page runs on Greenhouse, Lever or Ashby. The board id is the company part of the careers link, e.g. <b>boards.greenhouse.io/<u>acme</u></b> or <b>jobs.lever.co/<u>acme</u></b>.</p>
        <div className="rowx">
          <input style={{ width: 170 }} placeholder="Company name" value={nb.company} onChange={e => setNb({ ...nb, company: e.target.value })} />
          <select value={nb.ats} onChange={e => setNb({ ...nb, ats: e.target.value as Board['ats'] })}><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option><option value="ashby">Ashby</option></select>
          <input style={{ width: 130 }} placeholder="Board id" value={nb.id} onChange={e => setNb({ ...nb, id: e.target.value })} />
          <label className="rowx small"><input type="checkbox" style={{ width: 'auto' }} checked={nb.big} onChange={e => setNb({ ...nb, big: e.target.checked })} />Large employer</label>
          <button className="btn" onClick={addBoard}>Add</button>
        </div>
        {s.customBoards.length > 0 && <table style={{ marginTop: 12 }}><tbody>
          {s.customBoards.map((b, i) => (
            <tr key={i}><td>{b.company}</td><td className="muted">{b.ats} / {b.id}</td><td className="muted">{b.big ? 'USA and Canada' : 'Ontario only'}</td>
              <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => save({ ...s, customBoards: s.customBoards.filter((_, n) => n !== i) }, 'Removed.')}>Remove</button></td></tr>
          ))}</tbody></table>}
      </div>

      <div className="card"><h3>Adzuna (optional)</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Adds a wider search of Ontario listings from smaller companies. It needs a free app id and key from developer.adzuna.com. Leave blank to skip it.</p>
        <div className="grid2">
          <label className="f"><span>App id</span><input value={s.adzunaAppId} onChange={e => setS({ ...s, adzunaAppId: e.target.value })} onBlur={() => save(s)} /></label>
          <label className="f"><span>App key</span><input value={s.adzunaAppKey} onChange={e => setS({ ...s, adzunaAppKey: e.target.value })} onBlur={() => save(s)} /></label>
        </div>
      </div>
    </div>
  )
}
