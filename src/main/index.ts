import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import type { AutoApplyResult, DocFile, DocKind, Job, JobStatus, PrefillResult, Profile, RawJob, RefreshProgress, Resume, SavedAnswer, Settings, Tailored, Usage, WorkdayLogin, LiveJob, LiveRun } from '../shared/types'
import { defaultSettings, emptyProfile, emptyResume } from '../shared/types'
import type { AppState } from '../shared/api'
import * as db from './db'
import { resolveStored } from './sources/linkedin-resolve'
import { aiFound, aiName, askJson, setProvider, setUsageListener } from './ai/claude'
import * as keychain from './keychain'
import * as gmail from './mail/gmail'
import { normalizeResume, pdfToText, structureResume } from './resume/parse'
import { tailorResume, shortenResume, findInventions, bankOf } from './resume/tailor'
import { getActivity, setActivityListener, stopAll, track, StoppedError } from './activity'
import { compileLatex, findTectonic, resumeLatex } from './resume/latex'
import { htmlToPdf, letterHtml, resumeHtml, safeName } from './resume/render'
import { refreshJobs, scorePending } from './refresh'
import { allBoards, setDiscoveredBoards } from './sources'
import { UA, htmlToText, siteFetch } from './sources/util'
import { regionOf, setRulesFromProfile, textProblem } from './filter'
import { closeBrowser, fillAgain, prefill, stopWatching, useDocuments, type WorkdayHooks } from './apply/prefill'
import { addDocuments, removeDocumentFile } from './docs'
import { runAutoApply, skipCurrent } from './apply/autoapply'

// The data folder keeps its original name so a rename of the app never loses data.
// Tests point IH_USER_DATA at a throwaway folder so they never touch real data.
app.setPath('userData', process.env.IH_USER_DATA || join(app.getPath('appData'), 'internship-hunter'))
app.setName('J.A.R.V.I.S.')
const NO_USAGE: Usage = { calls: 0, input: 0, output: 0 }

let win: BrowserWindow | null = null
const send = (channel: string, value: unknown): void => { if (win && !win.isDestroyed()) win.webContents.send(channel, value) }
const progress = (p: RefreshProgress | null): void => send('progress', p)

// ---- The auto-apply run shown on the Status page. Kept in the database, so the last run is still there after a restart.
let live: LiveRun | null = null
const liveRun = (): LiveRun | null => live || db.kvGet<LiveRun | null>('lastRun', null)
const pushLive = (): void => { if (live) { db.kvSet('lastRun', live); send('liveRun', live) } }
function startLive(jobIds: string[]): void {
  live = { running: true, startedAt: new Date().toISOString(), jobs: jobIds.map(id => { const j = db.getJob(id); return { jobId: id, company: j?.company || '', title: j?.title || id, state: 'waiting', page: '', reason: '', steps: [] } }) }
  pushLive()
}
function updateLive(jobId: string, ev: { state?: LiveJob['state']; page?: string; step?: string; reason?: string; end?: boolean }): void {
  const j = live?.jobs.find(x => x.jobId === jobId)
  if (!j) return
  if (ev.state) { if (ev.state === 'tailoring' && !j.startedAt) j.startedAt = new Date().toISOString(); j.state = ev.state }
  if (ev.page) j.page = ev.page
  if (ev.reason !== undefined) j.reason = ev.reason
  if (ev.step && j.steps[j.steps.length - 1] !== ev.step) j.steps = [...j.steps, ev.step].slice(-30)
  if (ev.end) j.endedAt = new Date().toISOString()
  pushLive()
}
function endLive(): void {
  if (!live) return
  live.running = false; live.endedAt = new Date().toISOString()
  for (const j of live.jobs) if (j.state === 'waiting' || j.state === 'tailoring' || j.state === 'working') j.state = 'skipped'
  pushLive()
}
const settings = (): Settings => ({ ...defaultSettings(), ...db.kvGet<Partial<Settings>>('settings', {}) })
const hasResume = (r: Resume): boolean => !!(r.name || r.experience.length || r.projects.length || r.education.length)
let busy = false

/** The user's own resume PDF, kept as a copy in the data folder under its original file name. */
const resumePdf = (): { name: string; path: string } | null => {
  const p = db.kvGet<string>('resumePdf', '')
  return p && existsSync(p) ? { name: basename(p), path: p } : null
}
function keepResumePdf(src: string): { name: string; path: string } {
  const dir = join(app.getPath('userData'), 'resume-pdf')
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
  const dest = join(dir, basename(src))
  copyFileSync(src, dest)
  db.kvSet('resumePdf', dest)
  return { name: basename(dest), path: dest }
}
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('Another job refresh or scoring run is still going. Wait for it to finish.')
  busy = true
  try { return await fn() } finally { busy = false; progress(null) }
}
/** Read-only Gmail, for verification emails: the OAuth client is in settings, the address in the database, the token in the Keychain. */
const gmailStore: gmail.GmailStore = {
  client: () => ({ clientId: settings().gmailClientId || '', clientSecret: settings().gmailClientSecret || '' }),
  email: () => db.kvGet('gmailEmail', ''),
  setEmail: email => db.kvSet('gmailEmail', email)
}
const workdayLogin = (): WorkdayLogin => ({ email: db.kvGet('workdayEmail', ''), hasPassword: db.kvGet('workdayHasPassword', false) })
function needJob(id: string): Job { const j = db.getJob(id); if (!j) throw new Error('That job is no longer in the list.'); return j }

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640, title: 'J.A.R.V.I.S.', titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#F5F4EE',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(process.env.ELECTRON_RENDERER_URL || 'file://')) e.preventDefault() })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Typesets a resume (LaTeX template, or the plain layout without a LaTeX engine) and its cover letter into the job's folder. */
async function writePdfs(job: Job, clean: Resume, coverLetter: string): Promise<{ path: string; pages: number; coverPath: string | null }> {
  const root = process.env.IH_USER_DATA ? join(process.env.IH_USER_DATA, 'pdfs') : join(app.getPath('documents'), 'J.A.R.V.I.S')
  const dir = join(root, safeName(`${job.company} - ${job.title}`))
  const who = safeName(clean.name || 'Resume')
  const pdfOut = join(dir, `${who} - Resume.pdf`)
  const { path, pages } = findTectonic(app.getPath('userData')) ? await compileLatex(resumeLatex(clean), pdfOut, app.getPath('userData')) : await htmlToPdf(resumeHtml(clean), pdfOut)
  let coverPath: string | null = null
  if (coverLetter.trim()) {
    const c = clean.contact
    coverPath = (await htmlToPdf(letterHtml(clean.name, [c.email, c.phone, c.location].filter(Boolean).join(' | '), coverLetter), join(dir, `${who} - Cover Letter.pdf`))).path
  }
  return { path, pages, coverPath }
}

/** Tailors a job's resume (and cover letter) with Claude, typesets it to one page, and stores it. */
async function tailorJob(jobId: string, withCover: boolean): Promise<Tailored> {
    const job = needJob(jobId)
    const base = db.kvGet('resume', emptyResume())
    if (!hasResume(base)) throw new Error('Add your resume first, on the Resume page.')
    const profile = { ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) }
    const bank = bankOf(profile)
    const out = await tailorResume(base, db.kvGet('resumeRaw', ''), job, withCover, profile.extra, settings().writeModel, bank)
    // Typeset it in the LaTeX template and make sure it is one page; if not, have Claude cut it (twice at most).
    if (findTectonic(app.getPath('userData'))) {
      const probe = join(app.getPath('userData'), 'tmp', `fit-${Date.now()}.pdf`)
      try {
        let pages = (await compileLatex(resumeLatex(out.resume), probe, app.getPath('userData'))).pages
        for (let i = 0; i < 2 && pages > 1; i++) {
          out.resume = await shortenResume(base, out.resume, job, pages, settings().writeModel)
          pages = (await compileLatex(resumeLatex(out.resume), probe, app.getPath('userData'))).pages
          out.changes.push('Shortened to fit one page.')
        }
        if (pages > 1) out.warnings.unshift(`The resume is still ${pages} pages. Trim it in Edit before saving.`)
        out.warnings = out.warnings.filter(w => !/^Number not|^Term not/.test(w)).concat(findInventions(base, db.kvGet('resumeRaw', ''), out.resume, job, bank))
      } catch (e) { out.warnings.unshift(`LaTeX check failed: ${(e as Error).message.slice(0, 160)}`) }
      finally { for (const ext of ['.pdf', '.tex']) await rm(probe.replace(/\.pdf$/, ext), { force: true }).catch(() => {}) }
    }
    const prev = db.getTailored(jobId)
    const t: Tailored = { jobId, resume: out.resume, coverLetter: out.coverLetter || prev?.coverLetter || '', changes: out.changes, warnings: out.warnings,
      pdfPath: null, updatedAt: new Date().toISOString() }
    db.saveTailored(t)
    return t
}

function handlers(): void {
  // A handler given a label counts as work in progress: it lights the status dot and can be stopped.
  const h = (name: string, fn: (...args: any[]) => unknown, label = ''): void => {
    ipcMain.handle(name, (_e, ...args) => (label ? track(label, async () => fn(...args)) : fn(...args)))
  }
  h('getActivity', () => getActivity())
  h('stopAll', () => { stopWatching(); return stopAll() })

  h('getState', (): AppState => {
    const resume = db.kvGet('resume', emptyResume())
    return { resume, hasResume: hasResume(resume), profile: { ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) }, settings: settings(), cliFound: aiFound(),
      usage: db.kvGet('usage', NO_USAGE), workday: workdayLogin(), gmail: { email: db.kvGet('gmailEmail', '') }, documents: db.kvGet<DocFile[]>('documents', []), lastRefresh: db.kvGet<string | null>('lastRefresh', null), boards: allBoards(settings()), coverage: db.kvGet('coverage', []), resumePdf: resumePdf(), autoApply: db.kvGet<Record<string, AutoApplyResult>>('autoApply', {}) }
  })

  h('importResume', async (): Promise<Resume | null> => {
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose your resume', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (pick.canceled || !pick.filePaths[0]) return null
    const text = await pdfToText(pick.filePaths[0])
    if (text.length < 80) throw new Error('No text could be read from that PDF. If it is a scan or an image, export a text-based PDF and try again.')
    const resume = await structureResume(text, settings().writeModel)
    db.kvSet('resumeRaw', text); db.kvSet('resume', resume)
    keepResumePdf(pick.filePaths[0])
    // Seed the application profile from the resume the first time.
    const p = db.kvGet('profile', emptyProfile())
    if (!p.firstName && !p.email) {
      const parts = resume.name.trim().split(/\s+/)
      const edu = resume.education[0]
      db.kvSet('profile', { ...p, firstName: parts[0] || '', lastName: parts.slice(1).join(' '), email: resume.contact.email, phone: resume.contact.phone,
        city: resume.contact.location.split(',')[0]?.trim() || '', province: resume.contact.location.split(',')[1]?.trim() || '',
        linkedin: resume.contact.linkedin, website: resume.contact.website, school: edu?.school || '', degree: edu?.degree || '' } satisfies Profile)
    }
    return resume
  }, 'Reading your resume')
  h('chooseResumePdf', async (): Promise<{ name: string; path: string } | null> => {
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose the resume PDF to attach to applications', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (pick.canceled || !pick.filePaths[0]) return null
    return keepResumePdf(pick.filePaths[0])
  })
  // Additional documents: copied into the app's folder and classified; attached to matching upload boxes.
  const docsDir = join(app.getPath('userData'), 'documents')
  h('addDocuments', async (): Promise<DocFile[]> => {
    const pick = await dialog.showOpenDialog(win!, { title: 'Add documents (transcript, portfolio, reference letters, certificates...)', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg'] }] })
    if (pick.canceled || !pick.filePaths.length) return []
    const added = await addDocuments(pick.filePaths, docsDir, settings().scoreModel)
    db.kvSet('documents', [...db.kvGet<DocFile[]>('documents', []), ...added])
    return added
  }, 'Reading your documents')
  h('setDocumentKind', (id: string, kind: DocKind) => { db.kvSet('documents', db.kvGet<DocFile[]>('documents', []).map(d => d.id === id ? { ...d, kind, byUser: true } : d)) })
  h('removeDocument', (id: string) => {
    const all = db.kvGet<DocFile[]>('documents', [])
    const d = all.find(x => x.id === id); if (d) removeDocumentFile(d)
    db.kvSet('documents', all.filter(x => x.id !== id))
  })
  h('revealDocument', (id: string) => { const d = db.kvGet<DocFile[]>('documents', []).find(x => x.id === id); if (d) shell.showItemInFolder(d.path) })
  h('revealResumePdf', () => { const r = resumePdf(); if (r) shell.showItemInFolder(r.path) })
  h('saveResume', (r: Resume) => { db.kvSet('resume', normalizeResume(r)) })
  // A changed profile can change which postings pass (term length, sponsorship), so turned-down postings are read again.
  h('saveProfile', (p: Profile) => { db.kvSet('profile', { ...emptyProfile(), ...p }); db.kvSet('rejectedPostings', {}); db.kvSet('workdayReadAt', {}) })
  h('saveSettings', (s: Settings) => { db.kvSet('settings', { ...defaultSettings(), ...s }); setProvider(s.aiProvider) })

  h('listJobs', () => db.listJobs())
  h('getJob', (id: string) => { const job = db.getJob(id); return job ? { job, tailored: db.getTailored(id) } : null })
  h('updateJob', (id: string, patch: { status?: JobStatus; notes?: string }) => db.updateJob(id, patch))
  h('refresh', () => exclusive(() => refreshJobs(settings(), progress)), 'Getting jobs')
  h('score', () => exclusive(() => scorePending(settings(), progress)), 'Scoring jobs')
  h('rescore', () => exclusive(async () => { db.clearScores(); return scorePending(settings(), progress) }), 'Scoring jobs')

  h('addJob', async (input: { url: string; text: string }): Promise<Job> => {
    const url = (input.url || '').trim()
    let text = (input.text || '').trim()
    if (url && !/^https?:\/\//i.test(url)) throw new Error('The link must start with http:// or https://')
    if (!text) {
      if (!url) throw new Error('Paste a link or the posting text.')
      const r = await siteFetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) }).catch(() => null)
      text = r && r.ok ? htmlToText(await r.text()) : ''
      if (text.length < 300) throw new Error('That site would not show the posting to the app. Copy the posting text from your browser and paste it in the box.')
    }
    const info = await askJson<{ title?: string; company?: string; location?: string; description?: string }>(
      `Extract the job posting from this page text.\n\n<page>\n${text.slice(0, 14000)}\n</page>\n\n` +
      `Reply with JSON: {"title": "", "company": "", "location": "city, state/province, country as written", "description": "the full posting text: duties, requirements, qualifications. Copy it, do not summarise. Leave out navigation, cookie and footer text."}`,
      { model: settings().scoreModel })
    if (!info.title || !info.description) throw new Error(`${aiName()} could not find a job posting in that text.`)
    // A pasted posting meets the same rules as the ones the app finds.
    setRulesFromProfile({ ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) })
    const why = textProblem(info.title, info.description, regionOf(info.location || ''))
    if (why) throw new Error(`Not added: ${info.company || 'this posting'} – ${info.title} is a ${why.replace(/^U\.S\. persons only/, 'U.S.-persons-only role')}.`)
    const raw: RawJob = { id: `manual:manual:${Date.now()}`, source: 'manual', company: info.company || 'Unknown employer', title: info.title,
      location: info.location || '', url: url || '', applyUrl: url || '', description: info.description, postedAt: null, big: true }
    const region = regionOf(raw.location)
    if (!db.insertJob(raw, region === 'unknown' ? 'other' : region)) throw new Error('That job is already in your list.')
    db.updateJob(raw.id, { status: 'saved' })
    return needJob(raw.id)
  }, 'Adding a job')

  h('tailor', (jobId: string, withCover: boolean): Promise<Tailored> => tailorJob(jobId, withCover), 'Tailoring a resume')

  h('saveTailored', async (jobId: string, resume: Resume, coverLetter: string) => {
    const job = needJob(jobId)
    const base = db.kvGet('resume', emptyResume())
    const clean = normalizeResume(resume)
    const { path, pages } = await writePdfs(job, clean, coverLetter)
    const prev = db.getTailored(jobId)
    const t: Tailored = { jobId, resume: clean, coverLetter, changes: prev?.changes || [], warnings: findInventions(base, db.kvGet('resumeRaw', ''), clean, job, bankOf({ ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) })),
      pdfPath: path, updatedAt: new Date().toISOString() }
    db.saveTailored(t)
    if (['new', 'saved'].includes(job.status)) db.updateJob(jobId, { status: 'tailored' })
    return { ...t, pages }
  }, 'Saving the PDF')
  h('revealPdf', (jobId: string) => { const t = db.getTailored(jobId); if (t?.pdfPath && existsSync(t.pdfPath)) shell.showItemInFolder(t.pdfPath) })

  const applyArgs = async (jobId: string): Promise<[Job, Profile, Resume, Tailored | null, string]> => {
    const job = needJob(jobId)
    let t = db.getTailored(jobId)
    let coverPdfPath: string | null = null
    // A tailored resume is always what gets attached: its PDF (and the cover letter's) is made here if "Save PDF" was never pressed.
    if (t) {
      try {
        const made = await writePdfs(job, normalizeResume(t.resume), t.coverLetter)
        coverPdfPath = made.coverPath
        if (t.pdfPath !== made.path) { t = { ...t, pdfPath: made.path }; db.saveTailored(t); if (['new', 'saved'].includes(job.status)) db.updateJob(jobId, { status: 'tailored' }) }
      } catch { /* fall back to whatever PDF exists */ }
    }
    const own = resumePdf()?.path || null
    const tailored: Tailored | null = t && t.pdfPath && existsSync(t.pdfPath) ? { ...t, coverPdfPath }
      : t ? { ...t, pdfPath: own, coverPdfPath }
      : own ? { jobId, resume: db.kvGet('resume', emptyResume()), coverLetter: '', changes: [], warnings: [], pdfPath: own, updatedAt: '' } : null
    return [job, { ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) }, t?.resume || db.kvGet('resume', emptyResume()), tailored, settings().writeModel]
  }
  // Workday: the email lives in the app's settings, the password only in the Mac Keychain. Neither is sent to the window.
  const wdHooks = (jobId: string): WorkdayHooks => ({
    getLogin: async () => { const email = db.kvGet('workdayEmail', ''); const password = await keychain.getPassword(email); return email && password ? { email, password } : null },
    isKnown: tenant => db.kvGet<string[]>('workdayTenants', []).includes(tenant),
    markKnown: tenant => { const t = db.kvGet<string[]>('workdayTenants', []); if (!t.includes(tenant)) db.kvSet('workdayTenants', [...t, tenant]) },
    autoCreate: settings().workdayAutoCreate,
    autoContinue: settings().workdayAutoContinue !== false,
    onUpdate: (result: PrefillResult) => send('prefillUpdate', { jobId, result })
  })
  h('prefill', async (jobId: string) => {
    const a = await applyArgs(jobId)
    if (!a[0].applyUrl && !a[0].url) throw new Error('This job has no link to open.')
    return prefill(join(app.getPath('userData'), 'apply-browser'), a, wdHooks(jobId))
  }, 'Filling an application')
  h('getLiveRun', () => liveRun())
  h('skipAutoApply', (jobId: string) => skipCurrent(jobId))
  h('autoApply', (jobIds: string[]) => exclusive(() => { startLive(jobIds); return runAutoApply(jobIds, {
    profileDir: join(app.getPath('userData'), 'apply-browser'),
    shotDir: join(app.getPath('userData'), 'autoapply'),
    hidden: settings().autoApplyWindow !== 'minimized',
    prepare: async jobId => {
      // A LinkedIn-alert job is first found on the employer's own site (if it was not already), and then tailored
      // to that full posting rather than the alert's one-line summary.
      let found = false
      const j0 = db.getJob(jobId)
      if (j0?.source === 'linkedin' && /linkedin\.com/i.test(j0.applyUrl || j0.url)) {
        updateLive(jobId, { step: `Looking for this job on ${j0.company}'s own careers site` })
        found = await resolveStored(jobId, 86400_000).catch(e => { if (e instanceof StoppedError) throw e; return false })
      }
      const t = db.getTailored(jobId)
      const fresh = t && !found && Date.now() - new Date(t.updatedAt).getTime() < 7 * 24 * 3600_000
      // A failed tailoring (the AI timing out, say) does not cost the application: it goes ahead with the last
      // tailored resume for this job, or the user's own resume PDF.
      if (!fresh) {
        try { await tailorJob(jobId, true) }
        catch (e) {
          if (e instanceof StoppedError) throw e
          if (!t && !resumePdf()) throw e
          updateLive(jobId, { step: `Tailoring failed (${(e as Error).message.slice(0, 80)}), so your ${t ? 'last tailored' : 'own'} resume is attached` })
        }
      }
      return applyArgs(jobId)
    },
    hooks: jobId => ({ ...wdHooks(jobId), autoContinue: true, onUpdate: () => {} }),
    onResult: r => {
      const all = db.kvGet<Record<string, AutoApplyResult>>('autoApply', {})
      db.kvSet('autoApply', { ...all, [r.jobId]: r })
      if (r.outcome === 'applied') {
        const j = db.getJob(r.jobId)
        db.updateJob(r.jobId, { status: 'applied', notes: `${j?.notes ? j.notes + '\n' : ''}Auto-applied ${new Date().toLocaleDateString()}` })
      } else if (/posting has closed/i.test(r.reason)) {
        // A closed posting leaves the job list (it stays under Hidden, and a refresh never adds it back).
        const j = db.getJob(r.jobId)
        if (j && j.status !== 'applied') db.updateJob(r.jobId, { status: 'hidden', notes: `${j.notes ? j.notes + '\n' : ''}Posting closed ${new Date().toLocaleDateString()}` })
      }
      send('autoApply', r)
      updateLive(r.jobId, { state: r.outcome, reason: r.outcome === 'applied' ? '' : r.reason, page: r.page, end: true })
    },
    onProgress: (done, total, label) => progress({ stage: 'Auto-applying', detail: label, done, total }),
    onLive: (jobId, ev) => updateLive(jobId, ev)
  }).finally(endLive) }), 'Auto-applying')
  // Clears every auto-apply mark (flagged / dry run / failed) except real applications, so those jobs can be tried again.
  h('clearAllAutoApplyFlags', () => { const all = db.kvGet<Record<string, AutoApplyResult>>('autoApply', {}); for (const k of Object.keys(all)) if (all[k].outcome !== 'applied') delete all[k]; db.kvSet('autoApply', all) })
  // Answers the user typed for questions auto-apply could not answer: kept in the profile for every later form, and the
  // job's flag is cleared so the next run tries it again.
  h('saveAnswers', (jobId: string, list: SavedAnswer[]) => {
    const p = { ...emptyProfile(), ...db.kvGet<Profile>('profile', emptyProfile()) }
    const key = (q: string): string => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const add = (list || []).map(x => ({ q: String(x.q || '').trim().slice(0, 500), a: String(x.a || '').trim().slice(0, 2000), at: new Date().toISOString() })).filter(x => x.q && x.a)
    if (!add.length) return
    const keep = (p.answers || []).filter(x => !add.some(y => key(y.q) === key(x.q)))
    db.kvSet('profile', { ...p, answers: [...keep, ...add] })
    if (jobId) { const all = db.kvGet<Record<string, AutoApplyResult>>('autoApply', {}); if (all[jobId]?.outcome !== 'applied') { delete all[jobId]; db.kvSet('autoApply', all) } }
  })
  h('clearAutoApplyFlag', (jobId: string) => { const all = db.kvGet<Record<string, AutoApplyResult>>('autoApply', {}); delete all[jobId]; db.kvSet('autoApply', all) })
  h('showAutoApplyShot', (jobId: string) => { const r = db.kvGet<Record<string, AutoApplyResult>>('autoApply', {})[jobId]; if (r?.shot && existsSync(r.shot)) return shell.openPath(r.shot) })
  h('fillAgain', async (jobId: string) => fillAgain(await applyArgs(jobId), wdHooks(jobId)), 'Filling an application')
  h('setWorkdayLogin', async (email: string, password: string): Promise<WorkdayLogin> => {
    email = String(email || '').trim()
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.')
    const old = db.kvGet('workdayEmail', '')
    await keychain.setPassword(email, String(password || ''))
    if (old && old !== email) await keychain.deletePassword(old)
    db.kvSet('workdayEmail', email); db.kvSet('workdayHasPassword', true)
    return workdayLogin()
  })
  h('clearWorkdayLogin', async (): Promise<WorkdayLogin> => {
    await keychain.deletePassword(db.kvGet('workdayEmail', ''))
    db.kvSet('workdayEmail', ''); db.kvSet('workdayHasPassword', false); db.kvSet('workdayTenants', [])
    return workdayLogin()
  })
  h('connectGmail', async (clientId: string, clientSecret: string): Promise<{ email: string }> => {
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim()
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).')
    db.kvSet('settings', { ...settings(), gmailClientId: clientId, gmailClientSecret: clientSecret })
    return { email: await gmail.connect(gmailStore, url => shell.openExternal(url)) }
  }, 'Connecting Gmail')
  h('disconnectGmail', async (): Promise<{ email: string }> => { await gmail.disconnect(gmailStore); return { email: '' } })
  h('openExternal', (url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url) })
}

app.whenReady().then(() => {
  db.openDb(join(app.getPath('userData'), 'internship-hunter.db'))
  gmail.useStore(gmailStore)
  setProvider(settings().aiProvider)
  useDocuments(() => db.kvGet<DocFile[]>('documents', []))
  setDiscoveredBoards(db.kvGet('discoveredBoards', []))
  setUsageListener(u => { db.kvSet('usage', u); send('usage', u) }, { ...NO_USAGE, calls: db.kvGet('aiCalls', 0), ...db.kvGet<Partial<Usage>>('usage', {}) })
  setActivityListener(a => send('activity', a))
  handlers()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { closeBrowser().finally(() => app.quit()) })
