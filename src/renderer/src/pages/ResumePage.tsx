import { useEffect, useState } from 'react'
import type { AppState } from '../../../shared/api'
import type { Resume } from '../../../shared/types'
import { ResumeEditor } from '../components/ResumeEditor'
import { errText, type PageId, type Toast } from '../App'

export function ResumePage({ state, reload, notify, go }: { state: AppState; reload: () => Promise<void>; notify: Toast; go: (p: PageId) => void }) {
  const [resume, setResume] = useState<Resume>(state.resume)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setResume(state.resume) }, [state.resume])

  const importPdf = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.importResume()
      if (r) { setResume(r); setVersion(v => v + 1); setDirty(false); await reload(); notify('Resume read. Check it below and fix anything Claude got wrong.') }
    } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  const choosePdf = async (): Promise<void> => {
    try { const r = await window.api.chooseResumePdf(); if (r) { await reload(); notify(`${r.name} will be attached to applications that have no tailored resume.`) } }
    catch (e) { notify(errText(e), true) }
  }
  const save = async (): Promise<void> => { await window.api.saveResume(resume); setDirty(false); await reload(); notify('Resume saved.') }

  return (
    <div className="page narrow">
      <div className="head">
        <div><h1>Your resume</h1><p>This is the source for every tailored version. Claude may reword and reorder it, but never add to it.</p></div>
        <div className="rowx">
          <button className="btn" onClick={importPdf} disabled={busy}>{busy && <span className="spin" />}{busy ? 'Reading PDF…' : state.hasResume ? 'Replace from PDF' : 'Import PDF'}</button>
          {state.hasResume && <button className="btn primary" onClick={save} disabled={!dirty}>Save changes</button>}
        </div>
      </div>
      {!state.cliFound && <div className="banner bad">Claude Code was not found on this Mac. Install it and sign in with your Claude account, then reopen this app.</div>}
      {!state.hasResume ? (
        <div className="empty"><h2>Start with your resume</h2><p>Import your PDF. Claude reads it once and turns it into editable sections.<br />Reading takes about a minute.</p></div>
      ) : (<>
        <div className="banner info"><span>Next: fill in your <a onClick={() => go('profile')}>Profile</a> so application forms can be pre-filled, then find jobs.</span>
          <button className="btn sm" onClick={() => go('jobs')}>Go to Jobs</button></div>
        <div className="card"><h3>Resume PDF</h3>
          <p className="muted small" style={{ margin: '4px 0 10px' }}>Attached to applications as-is when a job has no tailored resume. Changing it here leaves the text below untouched.</p>
          <div className="rowx">
            <span style={{ flex: 1 }}>{state.resumePdf ? state.resumePdf.name : <span className="muted">No PDF saved yet</span>}</span>
            {state.resumePdf && <button className="btn sm" onClick={() => window.api.revealResumePdf()}>Show in Finder</button>}
            <button className="btn sm" onClick={choosePdf}>{state.resumePdf ? 'Replace PDF' : 'Choose PDF'}</button>
          </div>
        </div>
        <ResumeEditor key={version} value={resume} onChange={r => { setResume(r); setDirty(true) }} />
      </>)}
    </div>
  )
}
