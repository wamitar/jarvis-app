import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import type { Job, JobStatus, PrefillResult, Profile, RawJob, RefreshProgress, Resume, Settings, Tailored, Usage, WorkdayLogin } from '../shared/types'
import { defaultSettings, emptyProfile, emptyResume } from '../shared/types'
import type { AppState } from '../shared/api'
import * as db from './db'
import { askJson, findCli, setUsageListener } from './ai/claude'
import * as keychain from './keychain'
import { normalizeResume, pdfToText, structureResume } from './resume/parse'
import { tailorResume, shortenResume, findInventions } from './resume/tailor'
import { compileLatex, findTectonic, resumeLatex } from './resume/latex'
import { htmlToPdf, letterHtml, resumeHtml, safeName } from './resume/render'
import { refreshJobs, scorePending } from './refresh'
import { allBoards } from './sources'
import { UA, htmlToText } from './sources/util'
import { regionOf } from './filter'
import { closeBrowser, fillAgain, prefill, type WorkdayHooks } from './apply/prefill'

// The data folder keeps its original name so a rename of the app never loses data.
// Tests point IH_USER_DATA at a throwaway folder so they never touch real data.
app.setPath('userData', process.env.IH_USER_DATA || join(app.getPath('appData'), 'internship-hunter'))
app.setName('J.A.R.V.I.S.')
const NO_USAGE: Usage = { calls: 0, input: 0, output: 0 }

let win: BrowserWindow | null = null
const send = (channel: string, value: unknown): void => { if (win && !win.isDestroyed()) win.webContents.send(channel, value) }
const progress = (p: RefreshProgress | null): void => send('progress', p)
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

function handlers(): void {
  const h = (name: string, fn: (...args: any[]) => unknown): void => { ipcMain.handle(name, (_e, ...args) => fn(...args)) }

  h('getState', (): AppState => {
    const resume = db.kvGet('resume', emptyResume())
    return { resume, hasResume: hasResume(resume), profile: { ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) }, settings: settings(), cliFound: !!findCli(),
      usage: db.kvGet('usage', NO_USAGE), workday: workdayLogin(), lastRefresh: db.kvGet<string | null>('lastRefresh', null), boards: allBoards(settings()), coverage: db.kvGet('coverage', []), resumePdf: resumePdf() }
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
  })
  h('chooseResumePdf', async (): Promise<{ name: string; path: string } | null> => {
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose the resume PDF to attach to applications', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (pick.canceled || !pick.filePaths[0]) return null
    return keepResumePdf(pick.filePaths[0])
  })
  h('revealResumePdf', () => { const r = resumePdf(); if (r) shell.showItemInFolder(r.path) })
  h('saveResume', (r: Resume) => { db.kvSet('resume', normalizeResume(r)) })
  h('saveProfile', (p: Profile) => { db.kvSet('profile', { ...emptyProfile(), ...p }) })
  h('saveSettings', (s: Settings) => { db.kvSet('settings', { ...defaultSettings(), ...s }) })

  h('listJobs', () => db.listJobs())
  h('getJob', (id: string) => { const job = db.getJob(id); return job ? { job, tailored: db.getTailored(id) } : null })
  h('updateJob', (id: string, patch: { status?: JobStatus; notes?: string }) => db.updateJob(id, patch))
  h('refresh', () => exclusive(() => refreshJobs(settings(), progress)))
  h('score', () => exclusive(() => scorePending(settings(), progress)))
  h('rescore', () => exclusive(async () => { db.clearScores(); return scorePending(settings(), progress) }))

  h('addJob', async (input: { url: string; text: string }): Promise<Job> => {
    const url = (input.url || '').trim()
    let text = (input.text || '').trim()
    if (url && !/^https?:\/\//i.test(url)) throw new Error('The link must start with http:// or https://')
    if (!text) {
      if (!url) throw new Error('Paste a link or the posting text.')
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) }).catch(() => null)
      text = r && r.ok ? htmlToText(await r.text()) : ''
      if (text.length < 300) throw new Error('That site would not show the posting to the app. Copy the posting text from your browser and paste it in the box.')
    }
    const info = await askJson<{ title?: string; company?: string; location?: string; description?: string }>(
      `Extract the job posting from this page text.\n\n<page>\n${text.slice(0, 14000)}\n</page>\n\n` +
      `Reply with JSON: {"title": "", "company": "", "location": "city, state/province, country as written", "description": "the full posting text: duties, requirements, qualifications. Copy it, do not summarise. Leave out navigation, cookie and footer text."}`,
      { model: settings().scoreModel })
    if (!info.title || !info.description) throw new Error('Claude could not find a job posting in that text.')
    const raw: RawJob = { id: `manual:manual:${Date.now()}`, source: 'manual', company: info.company || 'Unknown employer', title: info.title,
      location: info.location || '', url: url || '', applyUrl: url || '', description: info.description, postedAt: null, big: true }
    const region = regionOf(raw.location)
    if (!db.insertJob(raw, region === 'unknown' ? 'other' : region)) throw new Error('That job is already in your list.')
    db.updateJob(raw.id, { status: 'saved' })
    return needJob(raw.id)
  })

  h('tailor', async (jobId: string, withCover: boolean): Promise<Tailored> => {
    const job = needJob(jobId)
    const base = db.kvGet('resume', emptyResume())
    if (!hasResume(base)) throw new Error('Add your resume first, on the Resume page.')
    const profile = db.kvGet('profile', emptyProfile())
    const out = await tailorResume(base, db.kvGet('resumeRaw', ''), job, withCover, profile.extra, settings().writeModel)
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
        out.warnings = out.warnings.filter(w => !/^Number not|^Term not/.test(w)).concat(findInventions(base, db.kvGet('resumeRaw', ''), out.resume, job))
      } catch (e) { out.warnings.unshift(`LaTeX check failed: ${(e as Error).message.slice(0, 160)}`) }
      finally { for (const ext of ['.pdf', '.tex']) await rm(probe.replace(/\.pdf$/, ext), { force: true }).catch(() => {}) }
    }
    const prev = db.getTailored(jobId)
    const t: Tailored = { jobId, resume: out.resume, coverLetter: out.coverLetter || prev?.coverLetter || '', changes: out.changes, warnings: out.warnings,
      pdfPath: null, updatedAt: new Date().toISOString() }
    db.saveTailored(t)
    return t
  })

  h('saveTailored', async (jobId: string, resume: Resume, coverLetter: string) => {
    const job = needJob(jobId)
    const base = db.kvGet('resume', emptyResume())
    const clean = normalizeResume(resume)
    const root = process.env.IH_USER_DATA ? join(process.env.IH_USER_DATA, 'pdfs') : join(app.getPath('documents'), 'J.A.R.V.I.S')
    const dir = join(root, safeName(`${job.company} - ${job.title}`))
    const who = safeName(clean.name || 'Resume')
    // The resume is typeset with the user's LaTeX template (a .tex is saved beside the PDF). Without a LaTeX engine the plain layout is used.
    const pdfOut = join(dir, `${who} - Resume.pdf`)
    const { path, pages } = findTectonic(app.getPath('userData')) ? await compileLatex(resumeLatex(clean), pdfOut, app.getPath('userData')) : await htmlToPdf(resumeHtml(clean), pdfOut)
    if (coverLetter.trim()) {
      const c = clean.contact
      await htmlToPdf(letterHtml(clean.name, [c.email, c.phone, c.location].filter(Boolean).join(' | '), coverLetter), join(dir, `${who} - Cover Letter.pdf`))
    }
    const prev = db.getTailored(jobId)
    const t: Tailored = { jobId, resume: clean, coverLetter, changes: prev?.changes || [], warnings: findInventions(base, db.kvGet('resumeRaw', ''), clean, job),
      pdfPath: path, updatedAt: new Date().toISOString() }
    db.saveTailored(t)
    if (['new', 'saved'].includes(job.status)) db.updateJob(jobId, { status: 'tailored' })
    return { ...t, pages }
  })
  h('revealPdf', (jobId: string) => { const t = db.getTailored(jobId); if (t?.pdfPath && existsSync(t.pdfPath)) shell.showItemInFolder(t.pdfPath) })

  const applyArgs = (jobId: string): [Job, Profile, Resume, Tailored | null, string] => {
    const job = needJob(jobId)
    const t = db.getTailored(jobId)
    // Attach the tailored PDF; without one, the user's own resume PDF.
    const own = resumePdf()?.path || null
    const tailored: Tailored | null = t && t.pdfPath && existsSync(t.pdfPath) ? t
      : t ? { ...t, pdfPath: own }
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
  h('prefill', (jobId: string) => {
    const a = applyArgs(jobId)
    if (!a[0].applyUrl && !a[0].url) throw new Error('This job has no link to open.')
    return prefill(join(app.getPath('userData'), 'apply-browser'), a, wdHooks(jobId))
  })
  h('fillAgain', (jobId: string) => fillAgain(applyArgs(jobId), wdHooks(jobId)))
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
  h('openExternal', (url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url) })
}

app.whenReady().then(() => {
  db.openDb(join(app.getPath('userData'), 'internship-hunter.db'))
  setUsageListener(u => { db.kvSet('usage', u); send('usage', u) }, { ...NO_USAGE, calls: db.kvGet('aiCalls', 0), ...db.kvGet<Partial<Usage>>('usage', {}) })
  handlers()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { closeBrowser().finally(() => app.quit()) })
