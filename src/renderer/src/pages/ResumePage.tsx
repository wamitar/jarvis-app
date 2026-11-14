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
        <ResumeEditor key={version} value={resume} onChange={r => { setResume(r); setDirty(true) }} />
      </>)}
    </div>
  )
}
