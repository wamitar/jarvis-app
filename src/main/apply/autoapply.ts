// Auto-apply: for each job the user approved in the confirmation dialog, fill the application and press Submit.
// A job that takes too long, or shows anything unexpected (robot check, email verification, a required field the
// app cannot fill, an error, a page that will not move on), is skipped and flagged for the user, with a screenshot.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { AutoApplyResult, Job, PrefillResult, Profile, Resume, Tailored, LiveJob } from '../../shared/types'
import { begin, checkStop, isStopping, StoppedError } from '../activity'
import { forAutoApply as A, type WorkdayHooks } from './prefill'
import * as gmail from '../mail/gmail'

type Args = [Job, Profile, Resume, Tailored | null, string]
export interface AutoApplyDeps {
  profileDir: string
  shotDir: string
  /** Run Chrome with no window at all (headless). Otherwise a minimized window. */
  hidden?: boolean
  /** Tailors the job's resume and cover letter (skipped when a recent one exists) and returns the apply arguments with PDFs. */
  prepare(jobId: string): Promise<Args>
  hooks(jobId: string): WorkdayHooks
  onResult(r: AutoApplyResult): void
  onProgress(done: number, total: number, label: string): void
  /** Live detail for the Status page: state changes, the page it is on, and each step taken. */
  onLive?(jobId: string, ev: { state?: LiveJob['state']; page?: string; step?: string; reason?: string }): void
}

/** Per-job limit. IH_AUTOAPPLY_LIMIT_MS shortens it for tests. */
const LIMIT_MS = Number(process.env.IH_AUTOAPPLY_LIMIT_MS) || 8 * 60_000
/** With IH_AUTOAPPLY_DRYRUN set, everything runs except the final Submit click (for testing on real sites). */
const DRY = !!process.env.IH_AUTOAPPLY_DRYRUN
const limitText = (): string => (LIMIT_MS >= 60_000 ? `${Math.round(LIMIT_MS / 60_000)} minutes` : `${Math.round(LIMIT_MS / 1000)} seconds`)

// Only ever checked after the app pressed Submit: job pages often say "thank you for your interest".
const CONFIRMED = /thank you for (applying|your application|submitting)|thanks for applying|application (has been |was )?(successfully )?(submitted|received|sent|complete)|successfully (submitted|applied)|we('ve| have) received your application|you('ve| have) (successfully )?applied|your application is (complete|on its way)/i
// A posting taken down. Workday shows its "doesn't exist" page only after loading, so this is checked on every look.
const CLOSED = /job (is )?no longer (available|open|accepting)|position has been filled|this job (posting )?(has )?(closed|expired)|page (you|you're|you are) looking for (doesn't|does not|no longer|can't|cannot)|page (you|you're|you are) looking for/i
const VERIFY_EMAIL = /verify your (email|account)|verification (code|link|email)|check your (email|inbox)|enter the (code|one-time)|we sent (you )?(a|an) (code|email)/i
const SUBMIT_TEXT = /^\s*(submit( (my |your )?application)?|send application|complete application|finish( application)?|apply)\s*$/i
const NEXT_TEXT = /^\s*(next|continue|save (and|&) continue|save and next|proceed)\s*$/i

class Flag extends Error { constructor(reason: string) { super(reason) } }

async function bodyText(p: Page): Promise<string> { return (await p.locator('body').innerText({ timeout: 3000 }).catch(() => '')).replace(/\s+/g, ' ') }

/** A robot check the user has to do. Google's invisible reCAPTCHA badge (on many Greenhouse forms) does not count. */
async function robotCheck(p: Page): Promise<boolean> {
  for (const f of p.frames()) {
    const u = f.url()
    if (!/recaptcha\/api2\/(anchor|bframe)|hcaptcha\.com|challenges\.cloudflare\.com/.test(u)) continue
    const el = await f.frameElement().catch(() => null)
    if (!el) continue
    // Invisible challenges (Oracle's hCaptcha) sit hidden or parked off-screen at y = -9999 until a script triggers them.
    if (!(await el.isVisible().catch(() => false))) continue
    const box = await el.boundingBox().catch(() => null)
    const onScreen = !!box && box.x + box.width > 0 && box.y + box.height > 0 && box.x > -2000 && box.y > -2000
    const inBadge = await el.evaluate((e: Element) => !!e.closest('.grecaptcha-badge')).catch(() => false)
    if (box && onScreen && box.width > 60 && box.height > 40 && !inBadge) return true
  }
  return /confirm you are not a robot|i'?m not a robot|verify you are human/i.test(await bodyText(p))
}

const problems = (r: PrefillResult): string => {
  const empty = r.skipped.filter(s => /required, still empty|no choice matched|is not one of the choices|could not find/i.test(s) && /required|still empty/i.test(s))
  if (empty.length) return `required field left empty: ${empty.slice(0, 2).map(e => e.replace(/\s*\(.*$/, '')).join(', ')}`
  return ''
}
/** Sign-in and account notes that mean the app cannot carry on by itself. */
const blockingNote = (note: string): string => {
  if (/robot/i.test(note)) return 'robot check at sign-in'
  if (/verification email|verify/i.test(note)) return 'email verification needed'
  const refused = note.match(/did not accept the page: "([^"]{1,160})/i)   // a form page refused, not the sign-in
  if (refused) return `the page was not accepted: ${refused[1]}`
  if (/rejected|did not accept|not accept the saved login|will not (try|retry)/i.test(note)) return 'sign-in not accepted'
  if (/needs a password of|does not fit/i.test(note)) return 'saved password does not meet this site’s rules'
  if (/not on a secure/i.test(note)) return 'sign-in page is not secure (https)'
  if (/save your (workday )?email and password/i.test(note)) return 'no saved login'
  if (/then press Create Account/i.test(note)) return 'creating an account here needs you (automatic account creation is off in Settings)'
  return ''
}

const CODE_INPUT = 'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[aria-label*="code" i], input[placeholder*="code" i], input[name*="pin" i], input[name*="otp" i], input[id*="otp" i]'
/**
 * Finishes an email-verification step from the connected Gmail (read-only): types the emailed code, or opens the
 * emailed link in a tab of the application browser. Only mail that arrived after this application started counts.
 * Returns what was done ('code' or 'link'), or '' when Gmail is not connected or nothing usable arrived.
 */
async function verifyByEmail(p: Page, since: number, hint: string): Promise<'code' | 'link' | ''> {
  if (!gmail.connected()) return ''
  const v = await gmail.findVerification({ since, hint, waitMs: 90_000 }).catch(() => null)
  if (!v) return ''
  if (v.code) {
    // Some sites split the code into one box per character.
    const cells = p.locator('input[maxlength="1"]').locator('visible=true')
    const n = await cells.count().catch(() => 0)
    if (n >= 4 && n === v.code.length) { for (let i = 0; i < n; i++) await cells.nth(i).fill(v.code[i]) }
    else {
      let box = p.locator(CODE_INPUT).locator('visible=true').first()
      if (!(await box.isVisible().catch(() => false))) {
        const texts = p.locator('input[type="text"], input[type="tel"], input[type="number"], input:not([type])').locator('visible=true')
        if ((await texts.count().catch(() => 0)) !== 1) return ''
        box = texts.first()
      }
      await box.fill(v.code)
    }
    await pressByText(p, /^\s*(verify|submit|continue|next|confirm|sign in|done)\s*$/i).catch(() => false)
    await p.waitForTimeout(3000)
    return 'code'
  }
  if (v.link) {
    const tab = await p.context().newPage()
    await tab.goto(v.link, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await tab.waitForTimeout(4000)
    await tab.close().catch(() => {})
    await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await p.waitForTimeout(2000)
    return 'link'
  }
  return ''
}

async function pressByText(p: Page, re: RegExp): Promise<boolean> {
  const btn = p.locator('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]').locator('visible=true').filter({ hasText: re })
  const input = p.locator('input[type="submit"], input[type="button"]').locator('visible=true')
  let target = btn.last()
  if (!(await target.count().catch(() => 0))) {
    const n = await input.count().catch(() => 0)
    for (let i = n - 1; i >= 0; i--) if (re.test(await input.nth(i).inputValue().catch(() => ''))) { target = input.nth(i); break }
  }
  if (!(await target.isVisible().catch(() => false))) return false
  if (await target.isDisabled().catch(() => false)) return false
  await target.scrollIntoViewIfNeeded().catch(() => {})
  await target.click({ timeout: 5000 })
  return true
}

/** Presses the final Submit (or Apply) button and waits for the site to confirm. Throws Flag when it does not. */
async function submitFinal(p: Page, workday: boolean): Promise<void> {
  await A.guardSubmit(p, false)
  const before = p.url()
  const wdBtn = p.locator(`${A.wd('pageFooterNextButton')}, ${A.wd('bottom-navigation-next-button')}`).locator('visible=true').first()
  const wdText = workday ? (await wdBtn.innerText().catch(() => '')).trim() : ''
  if (DRY) {
    const found = workday ? /submit/i.test(wdText) : (await p.locator('button, input[type="submit"], [role="button"]').locator('visible=true').filter({ hasText: SUBMIT_TEXT }).count().catch(() => 0)) > 0
    const invalid = await p.locator('[aria-invalid="true"], [role="alert"]').locator('visible=true').evaluateAll(els => els.map(e => {
      const lab = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent : ''
      return (lab || e.getAttribute('aria-label') || (e as HTMLElement).innerText || e.getAttribute('name') || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 60)
    })).catch(() => [] as string[])
    const emptyReq = (await A.collectAll(p).catch(() => [])).filter(x => x.f.required && x.f.kind !== 'file' && !x.f.value.trim()).map(x => `empty: ${(x.f.question || x.f.label).slice(0, 50)}`)
    const fieldErrs = await p.locator('[class*="error" i]:not([role="alert"])').locator('visible=true').allInnerTexts().catch(() => [] as string[])
    const all = [...new Set([...invalid, ...emptyReq, ...fieldErrs.map(t => t.replace(/\s+/g, ' ').trim().slice(0, 60))].filter(Boolean))]
    const errs = all.length ? ` (page shows problems: ${all.slice(0, 8).join('; ')})` : ''
    // IH_AUTOAPPLY_DEBUG: keep the final page's HTML next to the screenshots, to see how a missed field is built.
    if (process.env.IH_AUTOAPPLY_DEBUG) await p.content().then(h => writeFileSync(join(process.env.IH_SHOTS || '/tmp', `last-page-${Date.now()}.html`), h)).catch(() => {})
    if (process.env.IH_AUTOAPPLY_DEBUG) {
      const fields = await A.collectAll(p).catch(() => [])
      const live = await p.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-required="true"], select[aria-required="true"], textarea[aria-required="true"], input[required]'))
        .map(e => ({ name: e.name || e.id, value: e.value, tagged: e.getAttribute('data-ih-idx'), shown: !!(e.offsetWidth || e.offsetHeight), ro: e.readOnly, label: (e.labels?.[0]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) }))).catch(() => [])
      writeFileSync(join(process.env.IH_SHOTS || '/tmp', `last-fields-${Date.now()}.json`), JSON.stringify({ fields: fields.map(x => ({ kind: x.f.kind, label: x.f.label, section: x.f.section, required: x.f.required, value: x.f.value })), live }, null, 1))
    }
    throw new Flag((found ? 'dry run: stopped just before pressing Submit' : 'dry run: no Submit button found') + errs)
  }
  let pressed = false
  if (workday && /submit/i.test(wdText)) { await wdBtn.click({ timeout: 5000 }); pressed = true }
  else pressed = await pressByText(p, SUBMIT_TEXT)
  if (!pressed) throw new Flag('no Submit button found')
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(500)
    if (await robotCheck(p)) throw new Flag('robot check after pressing Submit')
    const text = await bodyText(p)
    if (CONFIRMED.test(text) || (p.url() !== before && /confirm|thank|success|submitted|complete/i.test(p.url()))) return
  }
  const err = (await A.wdError(p)) || (await p.locator('[role="alert"], .error, [class*="error" i], [aria-invalid="true"]').locator('visible=true').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 160)
  throw new Flag(err ? `site did not accept the application: "${err}"` : 'no confirmation after pressing Submit')
}

/** Drives one job's application to a confirmed submission. Resolves on success, throws Flag otherwise. */
async function drive(start: Page, args: Args, hooks: WorkdayHooks, deadline: number, setPage: (s: string) => void, say: (s: string) => void = () => {}): Promise<void> {
  const [job] = args
  if (job.source === 'linkedin') throw new Flag('found through a LinkedIn alert: open it on LinkedIn and apply there (the app does not use LinkedIn)')
  if (await postingClosed(job)) throw new Flag('the posting has closed')
  await start.goto(applyLink(job), { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await start.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  if (/[?&]error=true|\/jobs\/?$|job.?not.?found|404/i.test(start.url()) || CLOSED.test(await bodyText(start)))
    throw new Flag('the posting has closed')
  let lastSig = '', same = 0, filledHere = '', mailTries = 0
  const started = Date.now()
  const opened = new Set(A.openPages())
  const current = (): Page => { const mine = A.openPages().filter(x => x === start || !opened.has(x)); return mine[mine.length - 1] || start }
  while (Date.now() < deadline) {
    checkStop()
    const p = current()
    if (p.isClosed()) throw new Flag('the application tab closed')
    const text = await bodyText(p)
    if (/you('ve| have) already applied|already (submitted|applied)/i.test(text)) throw new Flag('the site says you already applied')
    if (CLOSED.test(text.slice(0, 3000))) throw new Flag('the posting has closed')
    if (await robotCheck(p)) throw new Flag('robot check (CAPTCHA)')
    await A.dismissCookies(p)
    if (VERIFY_EMAIL.test(text) && !(await A.pwVisible(p))) {
      if (mailTries < 2) { mailTries++; setPage('Email verification (checking Gmail)'); if (await verifyByEmail(p, started, A.isWorkdayUrl(p.url()) ? new URL(p.url()).hostname.split('.')[0] : '')) { same = 0; lastSig = ''; continue } }
      throw new Flag(gmail.connected() ? 'email verification needed (no usable email arrived in Gmail)' : 'email verification needed')
    }
    const workday = A.isWorkdayUrl(p.url())
    const sig = workday ? await A.signature(p) : `${p.url().split('#')[0]}|${(await A.collectAll(p).catch(() => [])).length}`
    same = sig === lastSig ? same + 1 : 0
    lastSig = sig
    if (same >= 4 && process.env.IH_AUTOAPPLY_DEBUG) await p.content().then(h => writeFileSync(join(process.env.IH_SHOTS || '/tmp', `stuck-page-${Date.now()}.html`), h)).catch(() => {})
    if (same >= 4) throw new Flag(`stuck: the page did not change (${setPageName(p, text)})`)

    if (workday) {
      const step = (await p.locator(A.wd('progressBarActiveStep')).first().innerText({ timeout: 400 }).catch(() => '')).replace(/\s+/g, ' ')
      setPage(step ? `Workday: ${step.replace(/^current step \d+ of \d+/i, '').trim()}` : 'Workday')
      if (/review/i.test(step)) { await submitFinal(p, true); return }
      if (filledHere === sig) { await p.waitForTimeout(2500); continue }
      // An application page first shows an empty placeholder: wait for its form and buttons before filling.
      // (Not on the sign-in step: its social menu, "Sign in with email", has no form buttons at all.)
      // Some progress bars have no step names (Hitachi), so Workday's sign-in panel is checked for as well.
      const signInShown = (await p.locator(`${A.wd('signInContent')}, ${A.wd('SignInWithEmailButton')}, ${A.wd('CreateAccountWithEmailButton')}`).count().catch(() => 0)) > 0
      if (/\/apply(\/|$)/.test(p.url()) && !/sign in|create account/i.test(step) && !signInShown && !(await A.pwVisible(p))) {
        const ready = await p.locator(`${A.wd('pageFooterNextButton')}, ${A.wd('bottom-navigation-next-button')}`).first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
        if (!ready) continue
        await p.waitForTimeout(800)
        if ((await A.signature(p)) !== sig) continue
      }
      const r = await A.workdayStep(p, args, { ...hooks, autoContinue: true })
      if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[auto-apply] ${step || 'Workday'} | ${r.page} | filled ${r.filled.join(', ').slice(0, 600)} | ${r.note.slice(0, 160)}${r.skipped.length ? ` | skipped ${r.skipped.join('; ').slice(0, 800)}` : ''}`)
      filledHere = sig
      say(stepText(r))
      const why = problems(r) || blockingNote(r.note)
      // Workday sends a link to confirm a new account (or refuses sign-in until it is confirmed): open it from Gmail.
      if ((why === 'email verification needed' || (why === 'sign-in not accepted' && /verif/i.test(r.note))) && mailTries < 2) {
        mailTries++
        const tenant = new URL(p.url()).hostname.split('.')[0]
        setPage('Email verification (checking Gmail)')
        if (await verifyByEmail(p, started - 10 * 60_000, tenant)) { A.forgetRejected(tenant); filledHere = ''; same = 0; continue }
      }
      if (why) throw new Flag(why)
      if (/did not move on/i.test(r.note)) {
        // Workday can be slow to save a page: give it more time and one more press before giving up.
        let moved = false
        for (let i = 0; i < 10 && !moved; i++) { await p.waitForTimeout(1000); moved = (await A.signature(p)) !== sig }
        if (!moved) {
          await p.locator(`${A.wd('pageFooterNextButton')}, ${A.wd('bottom-navigation-next-button')}`).locator('visible=true').first().click({ timeout: 5000 }).catch(() => {})
          for (let i = 0; i < 20 && !moved; i++) { await p.waitForTimeout(1000); moved = (await A.signature(p)) !== sig }
        }
        if (!moved) { const err = await A.wdError(p); throw new Flag(err ? `Workday did not accept the page: "${err}"` : 'Workday did not move past this page') }
        continue
      }
      // A missing button usually means the page was still loading: try this page again (the stuck check ends it if not).
      if (/could not find the save and continue|still loading|signs in on the next look/i.test(r.note)) { filledHere = ''; await p.waitForTimeout(2000); continue }
      if (/button here says|did not accept the page/i.test(r.note)) throw new Flag(r.note.replace(/\. .*$/, ''))
      await p.waitForTimeout(1500)
      continue
    }
    if (await A.waitForSuccessFactorsJobPage(p)) { setPage('Job page'); await A.successFactorsApply(p); await p.waitForTimeout(2500); continue }
    if (await A.pwVisible(p)) {
      setPage('Sign in')
      const r = await A.siteSignIn(p, hooks, args[1])
      const why = blockingNote(r.note) || (/yourself/i.test(r.note) ? 'account step needs you' : '')
      if (why) throw new Flag(why)
      await p.waitForTimeout(2500)
      continue
    }
    const fields = await A.collectAll(p)
    if (fields.filter(x => x.f.kind !== 'file').length < 2) {
      // Some job pages need an Apply click first.
      if (await pressByText(p, /^\s*apply( now| for this (job|position))?\s*$/i).catch(() => false)) { setPage('Job page'); await p.waitForTimeout(3000); continue }
      if (same >= 2) throw new Flag('no application form found')
      await p.waitForTimeout(2500)
      continue
    }
    if (filledHere !== sig) {
      setPage(setPageName(p, text))
      const r = await A.fillCurrentPage(p, ...args)
      filledHere = sig
      say(stepText(r))
      const why = problems(r)
      if (why) throw new Flag(why)
    }
    // Multi-page forms move on with Next; single-page forms end with Submit.
    if (await pressByText(p, NEXT_TEXT).catch(() => false)) { await p.waitForTimeout(3000); continue }
    await submitFinal(p, false)
    return
  }
  throw new Flag(`took longer than ${limitText()}`)
}
/**
 * The hosted application form for job boards whose links can point at the employer's own site (which may redirect
 * to a home page once a posting moves): Greenhouse, Lever and Ashby all have a stable form address.
 */
function applyLink(job: Job): string {
  const [, board, id] = job.id.split(':')
  if (job.source === 'greenhouse' && board && id) return `https://job-boards.greenhouse.io/${board}/jobs/${id}`
  if (job.source === 'lever' && board && id) return `https://jobs.lever.co/${board}/${id}/apply`
  if (job.source === 'ashby' && board && id) return `https://jobs.ashbyhq.com/${board}/${id}/application`
  return job.applyUrl || job.url
}
/** Greenhouse and Lever say directly when a posting is gone (their links otherwise redirect to a home page). */
async function postingClosed(job: Job): Promise<boolean> {
  const [, board, id] = job.id.split(':')
  const api = job.source === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` : job.source === 'lever' ? `https://api.lever.co/v0/postings/${board}/${id}` : ''
  if (!api || !board || !id) return false
  const r = await fetch(api, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
  return r?.status === 404
}
/** One line for the Status page: the page, how much was filled, the actions taken, and the app's note. */
const stepText = (r: PrefillResult): string => {
  const acts = r.filled.filter(f => /^(pressed|chose|signed|opened|ticked)/i.test(f) || /replaced|removed/i.test(f))
  const answers = r.filled.length - acts.length
  const parts = [answers ? `filled ${answers} ${answers === 1 ? 'field' : 'fields'}` : '', ...acts.map(a => a.replace(/\s*\(.*?\)\s*$/, ''))].filter(Boolean)
  const empty = r.skipped.filter(x => /still empty/.test(x)).length
  return `${r.page}: ${parts.join(', ') || 'nothing to fill'}${empty ? ` · ${empty} required left empty` : ''}`.slice(0, 300)
}
const setPageName = (p: Page, text: string): string => (text.match(/^.{0,200}?\b(apply for [^.|]{3,60}|application[^.|]{0,40})/i)?.[1] || new URL(p.url()).hostname).slice(0, 60)

export async function runAutoApply(jobIds: string[], deps: AutoApplyDeps): Promise<{ applied: number; flagged: number; left: number }> {
  const end = begin(`Auto-applying to ${jobIds.length} jobs`)
  mkdirSync(deps.shotDir, { recursive: true })
  A.stopWatching()
  let applied = 0, flagged = 0, done = 0
  try {
    for (const jobId of jobIds) {
      if (isStopping()) break
      let page: Page | null = null
      const before = new Set(A.openPages())
      let where = 'Starting'
      const result = (outcome: AutoApplyResult['outcome'], reason: string, shot = ''): AutoApplyResult => ({ jobId, outcome, reason, page: where, at: new Date().toISOString(), shot })
      const stepEnd = begin(`Auto-apply ${done + 1} of ${jobIds.length}`)
      try {
        deps.onProgress(done, jobIds.length, 'Tailoring the resume')
        deps.onLive?.(jobId, { state: 'tailoring', page: 'Tailoring the resume' })
        const args = await deps.prepare(jobId)
        deps.onLive?.(jobId, { state: 'working', page: 'Opening the application' })
        deps.onProgress(done, jobIds.length, `${args[0].company}: ${args[0].title}`)
        page = await A.newTab(deps.profileDir, deps.hidden !== false)
        if (deps.hidden === false) await A.minimize(page)
        const deadline = Date.now() + LIMIT_MS
        await Promise.race([
          drive(page, args, deps.hooks(jobId), deadline, s => { where = s; deps.onLive?.(jobId, { page: s }) }, step => deps.onLive?.(jobId, { step })),
          new Promise((_, reject) => setTimeout(() => reject(new Flag(`took longer than ${limitText()}`)), LIMIT_MS + 15_000))
        ])
        applied++
        deps.onResult(result('applied', 'Submitted and confirmed'))
      } catch (e) {
        if (e instanceof StoppedError) { deps.onResult(result('flagged', 'stopped by you before it finished')); break }
        flagged++
        let shot = ''
        const visible = page && !page.isClosed() ? A.openPages().filter(x => x === page || x.url() !== 'about:blank').pop() || page : null
        if (visible) { shot = join(deps.shotDir, `${jobId.replace(/[^a-z0-9]+/gi, '_')}.png`); await visible.screenshot({ path: shot, fullPage: DRY }).catch(() => { shot = '' }) }
        const reason = e instanceof Flag ? e.message : `error: ${(e as Error).message.split('\n')[0].slice(0, 140)}`
        deps.onResult(result(/^dry run/.test(reason) ? 'dryrun' : 'flagged', reason, shot))
      } finally {
        stepEnd()
        done++
        // Close this job's tabs so the next one starts clean.
        for (const t of A.openPages()) if (!before.has(t)) await t.close().catch(() => {})
        deps.onProgress(done, jobIds.length, 'Next job')
      }
      checkStop()
    }
  } catch (e) { if (!(e instanceof StoppedError)) throw e }
  finally { end() }
  return { applied, flagged, left: jobIds.length - done }
}
