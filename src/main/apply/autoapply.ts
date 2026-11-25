// Auto-apply: for each job the user approved in the confirmation dialog, fill the application and press Submit.
// A job that takes too long, or shows anything unexpected (robot check, email verification, a required field the
// app cannot fill, an error, a page that will not move on), is skipped and flagged for the user, with a screenshot.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Locator, Page } from 'playwright-core'
import type { AutoApplyResult, Job, PrefillResult, Profile, Resume, Tailored, LiveJob } from '../../shared/types'
import { begin, checkStop, isStopping, StoppedError } from '../activity'
import { forAutoApply as A, type WorkdayHooks } from './prefill'
import * as gmail from '../mail/gmail'
import { missReason } from '../sources/linkedin-resolve'

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
  onLive?(jobId: string, ev: { state?: LiveJob['state']; page?: string; step?: string; reason?: string; end?: boolean }): void
}

/** Per-job limit. IH_AUTOAPPLY_LIMIT_MS shortens it for tests. */
const LIMIT_MS = Number(process.env.IH_AUTOAPPLY_LIMIT_MS) || 330_000
/** With IH_AUTOAPPLY_DRYRUN set, everything runs except the final Submit click (for testing on real sites). */
const DRY = !!process.env.IH_AUTOAPPLY_DRYRUN
const limitText = (): string => { const s = Math.round(LIMIT_MS / 1000); return s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} seconds` }

// Only ever checked after the app pressed Submit: job pages often say "thank you for your interest".
const CONFIRMED = /thank you for (applying|your (job )?application|submitting)|thanks for applying|application (has been |was )?(successfully )?(submitted|received|sent|complete)|successfully (submitted|applied)|we('ve| have) received your application|you('ve| have) (successfully )?applied|your application is (complete|on its way)/i
// A posting taken down. Workday shows its "doesn't exist" page only after loading, so this is checked on every look.
const CLOSED = /job (is )?no longer (available|open|accepting)|no longer accepting (applications|applicants|candidates)|position has been filled|this job (posting )?(has )?(closed|expired)|page (you|you're|you are) looking for (doesn't|does not|no longer|can't|cannot)|page (you|you're|you are) looking for/i
/** The button on a job page that opens its application form. */
const APPLY_TEXT = /^\s*(apply( now| online| here)?|apply (for|to) (this )?(job|position|role)|i'?m interested|start (your )?application|begin application|apply with (your )?(resume|cv|email))\s*$/i
const APPLY_STRICT = /^\s*(apply now|apply online|apply (for|to) (this )?(job|position|role)|i'?m interested|start (your )?application|begin application)\s*$/i
/** The site paused sign-in or code requests after too many tries: the flag's text, or ''. */
const lockedOut = (text: string): string => {
  if (!/too many (attempts|tries|verification|code requests)|maximum number of (sign-in |verification )?attempts/i.test(text)) return ''
  const wait = text.match(/try again in ([0-9]+ ?(minutes?|hours?|mins?))/i)
  return `the site paused sign-in after too many tries${wait ? ` (try again in ${wait[1].toLowerCase()})` : ''}: run it again later`
}
/** A screen asking for an emailed code or link: a few boxes, or only boxes for the code's digits. */
const isCodeScreen = (labels: string[]): boolean => labels.length <= 4 || labels.every(l => /code|digit|otp|passcode|pin\b/i.test(l))
const VERIFY_EMAIL = /verify your (email|account)|verification (code|link|email)|check your (email|inbox)|enter the (code|one-time)|we sent (you )?(a|an) (code|email)/i
// (Greenhouse's embedded form keeps its busy and done captions inside the button: "Submit your application Please wait... Done".)
const SUBMIT_TEXT = /^\s*(submit( (my |your )?application)?(\s+please\s+wait\W*(\s+done)?)?|send application|complete application|finish( application)?|apply)\s*$/i
const NEXT_TEXT = /^\s*(next|continue|save (and|&) continue|save and next|proceed)\s*$/i

class Skipped extends Error {}
// skipCurrent() rejects the running job's race; the token lets a drive() left running in the background see it was skipped.
let skipNow: (() => void) | null = null, skipJobId = '', jobToken = 0, skippedToken = -1
export function skipCurrent(jobId: string): boolean { if (!skipNow || jobId !== skipJobId) return false; skippedToken = jobToken; skipNow(); return true }
class Flag extends Error { questions: string[]; constructor(reason: string, questions: string[] = []) { super(reason); this.questions = questions } }

/** The page's text, followed by that of its embedded frames (Greenhouse forms on an employer's own site sit in an iframe). */
async function bodyText(p: Page): Promise<string> {
  const main = await p.locator('body').innerText({ timeout: 3000 }).catch(() => '')
  const inner: string[] = []
  for (const f of p.frames()) {
    if (f === p.mainFrame() || !/greenhouse|lever|ashby|job_app|embed/i.test(f.url())) continue
    inner.push(await f.locator('body').innerText({ timeout: 2000 }).catch(() => ''))
  }
  return [main, ...inner].join(' ').replace(/\s+/g, ' ')
}

/** A robot check the user has to do. Google's invisible reCAPTCHA badge (on many Greenhouse forms) does not count. */
async function robotCheck(p: Page): Promise<boolean> {
  for (const f of p.frames()) {
    const u = f.url()
    if (!/recaptcha\/api2\/(anchor|bframe)|hcaptcha\.com|challenges\.cloudflare\.com|captcha-delivery\.com|arkoselabs\.com|funcaptcha/.test(u)) continue
    const el = await f.frameElement().catch(() => null)
    if (!el) continue
    // Invisible challenges (Oracle's hCaptcha) sit hidden or parked off-screen at y = -9999 until a script triggers them.
    if (!(await el.isVisible().catch(() => false))) continue
    const box = await el.boundingBox().catch(() => null)
    const onScreen = !!box && box.x + box.width > 0 && box.y + box.height > 0 && box.x > -2000 && box.y > -2000
    const inBadge = await el.evaluate((e: Element) => !!e.closest('.grecaptcha-badge')).catch(() => false)
    if (box && onScreen && box.width > 60 && box.height > 40 && !inBadge) return true
  }
  return /confirm you are not a robot|i'?m not a robot|verify you are human|you have been blocked|press (&|and) hold|are you a robot/i.test(await bodyText(p))
}

const problems = (r: PrefillResult): string => {
  const empty = r.skipped.filter(s => /required, still empty|no choice matched|is not one of the choices|could not find/i.test(s) && /required|still empty/i.test(s))
  if (empty.length) return `required field left empty: ${empty.slice(0, 3).map(e => e.replace(/\s*\(.*$/, '')).join(', ')}`
  return ''
}
/** Throws the "required field left empty" flag, carrying the questions word for word so the user can answer them once. */
const flagProblems = (r: PrefillResult): void => { const why = problems(r); if (why) throw new Flag(why, r.missing || []) }
/** Sign-in and account notes that mean the app cannot carry on by itself. */
const blockingNote = (note: string): string => {
  if (/robot/i.test(note)) return 'robot check at sign-in'
  // Workday's own words come first: the app's advice after them mentions verification emails either way.
  const said = note.match(/Workday says: "(.*?)"\. /i)?.[1] || note.match(/Workday says: "([^"]*)"/i)?.[1] || ''
  if (said) return /verif|activate|confirm your/i.test(said) ? 'email verification needed' : 'sign-in not accepted'
  if (/(rejected|refused) the saved login here earlier/i.test(note)) return 'sign-in not accepted'
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
async function verifyByEmail(p: Page, since: number, hint: string, olderSince = 0, waitMs = 90_000): Promise<'code' | 'link' | ''> {
  if (!gmail.connected()) return ''
  // New mail first (waiting for it to arrive). Only a link (never a code) may come from an older email: Workday's
  // confirm-your-account link from a run that created the account earlier.
  let v = await gmail.findVerification({ since, hint, waitMs }).catch(() => null)
  if (!v && olderSince) { const old = await gmail.findVerification({ since: olderSince, hint, waitMs: 0 }).catch(() => null); if (old?.link) v = { ...old, code: undefined } }
  if (!v) return ''
  if (v.code) {
    // Some sites split the code into one box per character (marked maxlength=1, or just one box per digit: Oracle).
    let cells = p.locator('input[maxlength="1"]').locator('visible=true')
    let n = await cells.count().catch(() => 0)
    if (n !== v.code.length) {
      cells = p.locator('input[type="text"], input[type="tel"], input[type="number"], input:not([type])').locator('visible=true')
      n = await cells.count().catch(() => 0)
    }
    if (n >= 4 && n === v.code.length) {
      // Typed key by key: these boxes move to the next one by themselves, and some ignore a pasted value.
      for (let i = 0; i < n; i++) { await cells.nth(i).click({ timeout: 2000 }).catch(() => {}); await cells.nth(i).fill('').catch(() => {}); await cells.nth(i).pressSequentially(v.code[i], { delay: 40 }) }
    }
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

/** The Gmail lookups behind the security-code step after Submit; the offline tests swap in a stand-in. */
export const mailHooks = {
  connected: (): boolean => gmail.connected(),
  find: (o: Parameters<typeof gmail.findVerification>[0]): ReturnType<typeof gmail.findVerification> => gmail.findVerification(o)
}
const usedCodes = new Set<string>()
/** Greenhouse's "enter the 8-character code" boxes, shown after Submit when its invisible robot check is unsure; or null. */
async function securityCodeBoxes(p: Page): Promise<Locator | null> {
  for (const f of p.frames()) {
    const boxes = f.locator('input[id^="security-input-"], #email-verification input[maxlength="1"]').locator('visible=true')
    if ((await boxes.count().catch(() => 0)) >= 4) return boxes
  }
  return null
}
/** The site's complaint about the typed security code (wrong, expired, too many tries), or ''. */
async function securityCodeError(p: Page): Promise<string> {
  for (const f of p.frames()) {
    const t = (await f.locator('#email-verification-error').locator('visible=true').allInnerTexts().catch(() => [] as string[])).join(' ').replace(/\s+/g, ' ').trim()
    if (t) return t.slice(0, 160)
  }
  return ''
}
/** Reads the emailed security code (sent after `since`, never one already typed) from Gmail and types it, one box per character. */
async function enterSecurityCode(p: Page, boxes: Locator, since: number, deadline: number): Promise<string> {
  if (!mailHooks.connected()) return ''
  let code = ''
  for (const end = Date.now() + Math.min(120_000, Math.max(0, deadline - Date.now())); ;) {
    const v = await mailHooks.find({ since, hint: 'greenhouse', waitMs: 0 }).catch(() => null)
    if (v?.code && !usedCodes.has(v.code)) { code = v.code; break }
    if (Date.now() >= end) return ''
    await p.waitForTimeout(5000)
  }
  const n = await boxes.count().catch(() => 0)
  if (n !== code.length) return ''
  usedCodes.add(code)
  // Typed key by key: each box moves on to the next by itself.
  for (let i = 0; i < n; i++) { await boxes.nth(i).click({ timeout: 2000 }).catch(() => {}); await boxes.nth(i).fill('').catch(() => {}); await boxes.nth(i).pressSequentially(code[i], { delay: 40 }) }
  return code
}

/** Presses the last visible button whose text matches, on the page or (when the page has none) inside an embedded form. */
async function pressByText(p: Page, re: RegExp, links = false): Promise<boolean> {
  if (await pressByTextIn(p.mainFrame(), re, links)) return true
  for (const f of p.frames()) if (f !== p.mainFrame() && /greenhouse|lever|ashby|job_app|embed/i.test(f.url()) && (await pressByTextIn(f, re, links))) return true
  return false
}
async function pressByTextIn(p: Frame, re: RegExp, links = false): Promise<boolean> {
  // links: job pages often draw "Apply now" as a styled link (Amazon, SmartRecruiters, Apple).
  // (Not a slide show's arrows: Waymo's page has a hidden-text "Next" carousel button above the form.)
  const btn = p.locator(`button:not([data-bs-slide]):not([class*="carousel" i]), input[type="submit"], input[type="button"], a[role="button"]:not([data-bs-slide]), [role="button"]:not([data-bs-slide])${links ? ', a[href]' : ''}`).locator('visible=true').filter({ hasText: re })
  const input = p.locator('input[type="submit"], input[type="button"]').locator('visible=true')
  let target = btn.last()
  if (!(await target.count().catch(() => 0))) {
    const n = await input.count().catch(() => 0)
    for (let i = n - 1; i >= 0; i--) if (re.test(await input.nth(i).inputValue().catch(() => ''))) { target = input.nth(i); break }
  }
  if (!(await target.isVisible().catch(() => false))) return false
  if (await target.isDisabled().catch(() => false)) return false
  if (!links) {
    await target.scrollIntoViewIfNeeded().catch(() => {})
    await target.click({ timeout: 5000 })
    return true
  }
  // Job pages repeat their Apply link (top, bottom, a sticky bar) and banners can cover one: try each, last first.
  const n = Math.min(await btn.count().catch(() => 0), 5)
  for (let i = n - 1; i >= 0; i--) {
    const t = btn.nth(i)
    // A link that would open a new tab opens in this one, so the app keeps following the application.
    await t.evaluate((e: HTMLElement) => { if (e.tagName === 'A') e.removeAttribute('target') }).catch(() => {})
    await t.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
    if (await t.click({ timeout: 2500 }).then(() => true, () => false)) return true
  }
  // Every one covered: follow the link directly.
  return target.evaluate((e: HTMLElement) => { e.click(); return true }).catch(() => false)
}

/** Presses the final Submit (or Apply) button and waits for the site to confirm. Throws Flag when it does not. */
async function submitFinal(p: Page, workday: boolean, deadline: number, job: Job): Promise<void> {
  await A.guardSubmit(p, false)
  const before = p.url()
  const wdBtn = p.locator(`${A.wd('pageFooterNextButton')}, ${A.wd('bottom-navigation-next-button')}`).locator('visible=true').first()
  const wdText = workday ? (await wdBtn.innerText().catch(() => '')).trim() : ''
  if (DRY) {
    let found = workday && /submit/i.test(wdText)
    if (!workday) for (const f of p.frames()) if ((await f.locator('button, input[type="submit"], [role="button"]').locator('visible=true').filter({ hasText: SUBMIT_TEXT }).count().catch(() => 0)) > 0) found = true
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
        .map(e => {
          const why: string[] = []
          const cs = getComputedStyle(e); const r = e.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) why.push(`size ${r.width}x${r.height}`)
          if (cs.visibility === 'hidden' || cs.display === 'none') why.push('hidden style')
          if (e.tabIndex < 0) why.push('tabindex<0')
          if (e.getAttribute('aria-hidden') === 'true') why.push('aria-hidden self')
          if (Number(cs.opacity) === 0) why.push('opacity 0')
          const hdr = e.closest('header, nav, [role="search"], [role="banner"], [role="navigation"], form[action*="search" i]'); if (hdr) why.push(`inside ${hdr.tagName}#${hdr.id}[role=${hdr.getAttribute('role')}]`)
          for (let a: Element | null = e, k = 0; a && a !== document.body; a = a.parentElement, k++) {
            const c = getComputedStyle(a)
            if (c.opacity === '0') why.push(`anc${k} opacity0 ${a.tagName}#${a.id}`)
            if (a !== e && c.overflow !== 'visible' && a.getBoundingClientRect().height < 2) why.push(`anc${k} clipped ${a.tagName}#${a.id}.${String(a.className).slice(0, 30)}`)
            if (k < 4 && a.getAttribute('aria-hidden') === 'true') why.push(`anc${k} aria-hidden`)
          }
          return { name: e.name || e.id, value: e.value, tagged: e.getAttribute('data-ih-idx'), why, label: (e.labels?.[0]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) }
        })).catch(() => [])
      const skips = await p.evaluate(() => (window as unknown as { __ihSkips?: unknown }).__ihSkips || null).catch(() => null)
      writeFileSync(join(process.env.IH_SHOTS || '/tmp', `last-fields-${Date.now()}.json`), JSON.stringify({ skips, fields: fields.map(x => ({ kind: x.f.kind, label: x.f.label, section: x.f.section, required: x.f.required, value: x.f.value })), live }, null, 1))
    }
    throw new Flag((found ? 'dry run: stopped just before pressing Submit' : 'dry run: no Submit button found') + errs)
  }
  let pressed = false
  if (workday && /submit/i.test(wdText)) { await wdBtn.click({ timeout: 5000 }); pressed = true }
  else pressed = await pressByText(p, SUBMIT_TEXT)
  if (!pressed) throw new Flag('no Submit button found')
  const pressedAt = Date.now() - 5000
  let coded = ''
  // Oracle Recruiting Cloud lands on the candidate profile, whose applications list shows "<requisition> ... Applied on <date>" for this job.
  const req = job.id.startsWith('oracle:') ? job.id.split(':').pop()!.replace(/\W/g, '') : ''
  const oracleListed = req ? new RegExp(`\\b${req}\\b[\\s\\S]{0,30}?(applied on|under consideration)`, 'i') : null
  // Greenhouse sometimes answers a first Submit with this and takes the second: wait, press once more, flag if it repeats.
  const SITE_ERR = /error processing your application/i
  let retriedAt = 0
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(500)
    if (await robotCheck(p)) throw new Flag('robot check after pressing Submit')
    const text = await bodyText(p)
    if (CONFIRMED.test(text) || oracleListed?.test(text) || (p.url() !== before && /confirm|thank|success|submitted|complete/i.test(p.url()))) return
    if (SITE_ERR.test(text)) {
      // The first message can still be on screen just after the second press: give the site a few seconds to answer.
      if (retriedAt) { if (Date.now() - retriedAt > 15_000) throw new Flag('the site said: "There was an error processing your application. Please try again."'); continue }
      await p.waitForTimeout(4000)
      if (!(await pressByText(p, SUBMIT_TEXT))) throw new Flag('the site said: "There was an error processing your application. Please try again." and the Submit button was gone')
      retriedAt = Date.now()
      continue
    }
    // Greenhouse: "A verification code was sent to ... enter the 8-character code": read it from Gmail, type it, submit again.
    const boxes = /code/i.test(text) ? await securityCodeBoxes(p) : null
    if (!boxes) continue
    if (coded) { const bad = await securityCodeError(p); if (bad) throw new Flag(`the site did not accept the emailed security code: "${bad}"`); continue }
    coded = await enterSecurityCode(p, boxes, pressedAt, deadline)
    if (!coded) throw new Flag(mailHooks.connected() ? 'Greenhouse emailed a security code that didn\'t arrive in Gmail (it asks for one when its robot check is unsure)' : 'the site emailed a security code to type in: connect Gmail in Settings so the app can read it')
    await p.waitForTimeout(500)
    if (!(await pressByText(p, SUBMIT_TEXT))) throw new Flag('typed the emailed security code, but the Submit button stayed disabled')
    i = 0
  }
  if (coded) throw new Flag('no confirmation after typing the emailed security code and pressing Submit again')
  const err =(await A.wdError(p)) || (await p.locator('[role="alert"], .error, [class*="error" i], [aria-invalid="true"]').locator('visible=true').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 160)
  throw new Flag(err ? `site did not accept the application: "${err}"` : 'no confirmation after pressing Submit')
}

/** Drives one job's application to a confirmed submission. Resolves on success, throws Flag otherwise. */
async function drive(start: Page, args: Args, hooks: WorkdayHooks, deadline: number, setPage: (s: string) => void, say: (s: string) => void = () => {}, keep: (r: PrefillResult) => void = () => {}): Promise<void> {
  const [job] = args
  if (job.source === 'linkedin' && /linkedin\.com/i.test(applyLink(job)) && /closed/i.test(missReason(job.id))) throw new Flag('the posting has closed (on the employer\'s own site)')
  if (job.source === 'linkedin' && /linkedin\.com/i.test(applyLink(job))) throw new Flag(`from a LinkedIn alert, and not found on ${job.company}'s own careers site${missReason(job.id) ? ` (${missReason(job.id)})` : ''}: apply on LinkedIn (the app never uses LinkedIn itself)`)
  if (await postingClosed(job)) throw new Flag('the posting has closed')
  // A slow site (Alstom's jobsearch.alstom.com) can draw the whole job page yet not finish loading in time: carry on
  // when the page is there, give up only when nothing arrived.
  await start.goto(applyLink(job), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(async e => {
    if (start.url() === 'about:blank' || (await bodyText(start).catch(() => '')).trim().length < 200) throw e
  })
  await start.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  // Some companies switch off Ashby's hosted job page (Saronic) while the posting stays live on their own site, which
  // shows Ashby's embedded form: that form opens directly with ?embed=js.
  if (job.source === 'ashby' && /^jobs\.ashbyhq\.com$/.test(new URL(start.url()).hostname) && /page not found|page you requested was not found/i.test((await bodyText(start)).slice(0, 2000))) {
    await start.goto(applyLink(job) + '?embed=js', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await start.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    if (/page not found|page you requested was not found/i.test((await bodyText(start)).slice(0, 2000))) throw new Flag('the posting has closed')
  }
  if (/[?&]error=true|\/jobs\/?$|job.?not.?found|404/i.test(start.url()) || CLOSED.test(await bodyText(start)))
    throw new Flag('the posting has closed')
  let lastSig = '', same = 0, filledHere = '', mailTries = 0, glitches = 0, emailSteps = 0, sfReset = false, pagesFilled = 0
  const started = Date.now()
  const opened = new Set(A.openPages())
  const myToken = jobToken
  // Past the deadline the run has already been flagged and its tabs closed: stop here rather than touch the next job's tab.
  const current = (): Page => { if (skippedToken === myToken) throw new Skipped('skipped by you'); if (Date.now() >= deadline) throw new Flag(`took longer than ${limitText()}`); const mine = A.openPages().filter(x => x === start || !opened.has(x)); return mine[mine.length - 1] || start }
  while (Date.now() < deadline) {
    checkStop()
    const p = current()
    if (p.isClosed()) throw new Flag('the application tab closed')
    const text = await bodyText(p)
    if (/you('ve| have) already applied|already (submitted|applied)/i.test(text)) throw new Flag('the site says you already applied')
    // SuccessFactors' bare error page after Apply: hosts like career4.successfactors.com serve many employers, and a
    // session left over from another employer there spoils the hand-over. Drop that host's cookies and open the
    // posting again, once.
    if (/successfactors\./i.test(p.url()) && /an error occurred while processing your request/i.test(text.slice(0, 600)) && !sfReset) {
      sfReset = true
      const host = new URL(p.url()).hostname
      await p.context().clearCookies({ domain: host }).catch(() => {})
      say(`${host} showed its error page: cleared its old session and opened the posting again`)
      await p.goto(applyLink(job), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
      await p.waitForTimeout(2500); same = 0; lastSig = ''; continue
    }
    if (CLOSED.test(text.slice(0, 3000))) throw new Flag('the posting has closed')
    if (await robotCheck(p)) throw new Flag('robot check (CAPTCHA)')
    await A.dismissCookies(p)
    // A one-time move of an existing account to the site's new login (Amazon.jobs): the person's own account change.
    if (/transition your account|upgraded to a more secure login|migrate your account/i.test(text)) throw new Flag('the site wants to move your existing account to its new login (a one-time step that changes your account): do it once yourself, then the app carries on')
    // The site paused sign-in codes after too many requests: waiting here would only use up the time limit.
    if (lockedOut(text)) throw new Flag(lockedOut(text))
    // An idle warning ("Are you still with us?"): keep the session.
    if (/are you still with us|session (will )?(expire|end)s? (soon|automatically|in)/i.test(text)) await pressByText(p, /^\s*(continue working|stay signed in|continue session|keep (me )?(signed|logged) in|i'?m still here)\s*$/i).catch(() => false)
    // A code or link screen is small: a full form that merely has a "Verify your Email" (retype it) box is not one.
    if (VERIFY_EMAIL.test(text) && !(await A.pwVisible(p)) && isCodeScreen((await A.collectAll(p).catch(() => [])).filter(x => x.f.kind !== 'file').map(x => `${x.f.label} ${x.f.question} ${x.f.name}`))) {
      if (mailTries < 2) { mailTries++; setPage('Email verification (checking Gmail)'); const wdTenant = A.isWorkdayUrl(p.url()) ? new URL(p.url()).hostname.split('.')[0] : ''
        // Workday's confirm-your-account email may be from an earlier run, so for Workday two weeks of mail count.
        const room = (ms: number): number => Math.max(0, Math.min(ms, deadline - Date.now() - 60_000))
        if (mailTries === 1 && (await verifyByEmail(p, started, wdTenant, wdTenant ? Date.now() - 14 * 24 * 3600_000 : 0, room(90_000)))) { same = 0; lastSig = ''; continue }
        // Nothing after 90 seconds: ask for a new code and wait up to 5 minutes (Oracle's first code often never comes;
        // the new one arrives within about 3 minutes). Ask for a new one and wait longer, reading
        // only mail sent after the new request so an expired or wrong code is never typed again.
        {
          const asked = Date.now() - 5000
          await pressByText(p, /^\s*(send (a )?new code|resend( (the )?code)?|send code again|get a new code)\s*$/i).catch(() => false)
          if (room(300_000) > 0 && (await verifyByEmail(p, asked, wdTenant, 0, room(300_000)))) { same = 0; lastSig = ''; continue }
        } }
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
      if (/review/i.test(step)) { await submitFinal(p, true, deadline, job); return }
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
      let r: PrefillResult
      try { r = await A.workdayStep(p, args, { ...hooks, autoContinue: true }) }
      catch (e) {
        // The page moved on in the middle of a step (a sign-in that finished while the app was still typing, a page
        // that re-drew itself): look again rather than give up, unless it keeps happening.
        if (e instanceof StoppedError || e instanceof Flag || ++glitches > 3) throw e
        filledHere = ''; await p.waitForTimeout(2500); continue
      }
      if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[auto-apply] ${step || 'Workday'} | ${r.page} | filled ${r.filled.join(', ').slice(0, 600)} | ${r.note.slice(0, 160)}${r.skipped.length ? ` | skipped ${r.skipped.join('; ').slice(0, 800)}` : ''}`)
      filledHere = sig
      if (r.filled.length) pagesFilled++
      say(stepText(r)); keep(r)
      const why = problems(r) || blockingNote(r.note)
      const tenant = new URL(p.url()).hostname.split('.')[0]
      // Workday sends a link to confirm a new account (or refuses sign-in until it is confirmed): open it from Gmail.
      // The email can be from an earlier run (the account was created then), so mail from the last two weeks counts.
      if (why === 'email verification needed' && mailTries < 2) {
        mailTries++
        setPage('Email verification (checking Gmail)')
        if (await verifyByEmail(p, started - 10 * 60_000, tenant, mailTries === 1 ? Date.now() - 14 * 24 * 3600_000 : 0, Math.max(0, Math.min(90_000, deadline - Date.now())))) { A.forgetRejected(tenant); filledHere = ''; same = 0; continue }
      }
      if (why === 'sign-in not accepted') throw new Flag(`sign-in refused: ${(r.note.match(/Workday says: "(.*?)"\. /)?.[1] || r.note).slice(0, 220)}`)
      if (why) throw new Flag(why, problems(r) ? r.missing || [] : [])
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
      if (/could not find the save and continue|still loading|on the next look/i.test(r.note)) { filledHere = ''; await p.waitForTimeout(2000); continue }
      if (/button here says|did not accept the page/i.test(r.note)) throw new Flag(r.note.replace(/\. .*$/, ''))
      await p.waitForTimeout(1500)
      continue
    }
    // Apple: "Submit Resume" on the job page opens the form; Apple Account sign-in (two-factor) is always the person's own.
    const host = new URL(p.url()).hostname
    if (/(^|\.)(idmsa|appleid|account)\.apple\.com$/.test(host)) throw new Flag('Apple asks for your Apple Account sign-in (with a two-factor code): sign in once at jobs.apple.com in the app\'s browser ("Open application"), and the app carries on from then on')
    if (host === 'jobs.apple.com' && /\/details\//.test(p.url()) && (await pressByText(p, /^\s*submit (a |your )?resume\s*$/i, true).catch(() => false))) { setPage('Job page'); await p.waitForTimeout(4000); continue }
    if (await A.waitForSuccessFactorsJobPage(p)) { setPage('Job page'); await A.successFactorsApply(p); await p.waitForTimeout(2500); continue }
    if (await A.pwVisible(p)) {
      setPage('Sign in')
      const r = await A.siteSignIn(p, hooks, args[1], (() => { try { return new URL(applyLink(job)).hostname } catch { return '' } })())
      if (r.filled.length) say(stepText(r))
      if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[auto-apply] sign-in ${p.url().slice(0, 120)} | ${r.page} | ${r.filled.join(', ')} | ${r.note.slice(0, 200)}`)
      const why = blockingNote(r.note) || (/yourself/i.test(r.note) ? `account step needs you (${r.note.replace(/\s+/g, ' ').slice(0, 140)})` : '')
      if (why) throw new Flag(why)
      await p.waitForTimeout(2500)
      continue
    }
    const fields = await A.collectAll(p)
    if (fields.filter(x => x.f.kind !== 'file').length < 2) {
      // Email-first sign-in (Amazon and others): one box for the email and Continue; the password comes on the next page.
      const one = fields.find(x => x.f.kind === 'text')
      // Only on a page that is about signing in, and only with a button inside the email box's own form (never Submit).
      if (one && !one.f.value.trim() && (one.f.inputType === 'email' || /e-?mail/i.test(`${one.f.label} ${one.f.name}`)) && emailSteps < 2 && args[1].email &&
        // Oracle Cloud's start page says "You don't need to have an account ... simply using your email".
        /\b(sign in|log ?in|create (an |your )?account|sign up)\b|don.?t need to have an account/i.test(text) && !/job alerts?|newsletter|subscribe/i.test(`${one.f.label} ${one.f.question}`)) {
        const box = one.frame.locator(`[data-ih-idx="${one.f.idx}"]`).first()
        const GO = /^\s*(continue|next|sign in|log ?in)\s*$/i
        let btn = box.locator('xpath=ancestor::form[1]').locator('button, input[type="submit"], [role="button"]').locator('visible=true').filter({ hasText: GO }).first()
        // Oracle Cloud draws that page without a <form>: its Next button sits beside the email box.
        if (!(await btn.count().catch(() => 0)) && /oraclecloud\.com/i.test(p.url())) btn = one.frame.locator('button, [role="button"]').locator('visible=true').filter({ hasText: GO }).last()
        if (await btn.count().catch(() => 0)) {
          emailSteps++
          setPage('Sign in (email first)')
          await box.fill(args[1].email).catch(() => {})
          await btn.click({ timeout: 5000 }).catch(() => {})
          await p.waitForTimeout(3500); continue
        }
      }
      // A review step (Amazon.jobs' "Review & submit"): no boxes left, only the Submit button. A bare "Apply" button does not count.
      // Only with real review wording, after this job already had a page filled, and once the same page was seen twice
      // (never a first or resume-only page: "we will review your application" is everywhere).
      if (/review\s*(&|and)\s*submit|review your (application|answers|information|details)|please review/i.test(text) && pagesFilled > 0 && same >= 1 && fields.every(x => !x.f.required || x.f.kind === 'file' || x.f.value.trim())) {
        const REVIEW_SUBMIT = /^\s*(submit( (my |your )?application)?|send application|complete application|finish( application)?)\s*$/i
        let sub = 0
        for (const f of p.frames()) sub += await f.locator('button, input[type="submit"], [role="button"]').locator('visible=true').filter({ hasText: REVIEW_SUBMIT }).count().catch(() => 0)
        if (sub > 0) { setPage('Review & submit'); await submitFinal(p, false, deadline, job); return }
      }
      // Some job pages need an Apply click first.
      // Never on a page that is itself a form (a resume-only form ends with an "Apply" button that sends it): there,
      // only the unmistakable job-page wordings ("Apply now", "I'm interested") count.
      const formHere = fields.length > 0
      if (await pressByText(p, formHere ? APPLY_STRICT : APPLY_TEXT, true).catch(() => false)) { setPage('Job page'); await p.waitForTimeout(3000); continue }
      if (same >= 2) throw new Flag('no application form found')
      await p.waitForTimeout(2500)
      continue
    }
    if (filledHere !== sig) {
      setPage(setPageName(p, text))
      const r = await A.fillCurrentPage(p, ...args)
      filledHere = sig
      say(stepText(r)); keep(r)
      flagProblems(r)
    }
    // Multi-page forms move on with Next; single-page forms end with Submit.
    if (await pressByText(p, NEXT_TEXT).catch(() => false)) { await p.waitForTimeout(3000); continue }
    await submitFinal(p, false, deadline, job)
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
  const api = job.source === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` : job.source === 'lever' ? `https://api.lever.co/v0/postings/${board}/${id}`
    : job.source === 'smartrecruiters' ? `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}` : ''
  if (!api || !board || !id) return false
  const r = await fetch(api, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (r?.status === 404) return true
  // SmartRecruiters keeps an expired posting in its API with "active": false. Checking here means the job page
  // (which often shows a robot check) is never opened for a closed job.
  if (job.source === 'smartrecruiters' && r?.ok) return (await r.json().catch(() => null) as { active?: boolean } | null)?.active === false
  return false
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
      // Per job: a drive() that timed out can still be running, and must not add to the next job's notes.
      const guesses: NonNullable<AutoApplyResult['notes']> = []
      let closed = false
      const keep = (r: PrefillResult): void => { if (!closed) for (const g of r.guesses || []) if (!guesses.some(x => x.q === g.q)) guesses.push(g) }
      const result = (outcome: AutoApplyResult['outcome'], reason: string, shot = '', questions: string[] = []): AutoApplyResult => ({ jobId, outcome, reason, page: where, at: new Date().toISOString(), shot, ...(questions.length ? { questions } : {}), ...(guesses.length ? { notes: [...guesses] } : {}) })
      jobToken++
      const skipP = new Promise<never>((_, rej) => { skipNow = () => rej(new Skipped('skipped by you')) })
      skipP.catch(() => {})
      skipJobId = jobId
      const stepEnd = begin(`Auto-apply ${done + 1} of ${jobIds.length}`)
      try {
        deps.onProgress(done, jobIds.length, 'Tailoring the resume')
        deps.onLive?.(jobId, { state: 'tailoring', page: 'Tailoring the resume' })
        const args = await Promise.race([deps.prepare(jobId), skipP])
        deps.onLive?.(jobId, { state: 'working', page: 'Opening the application' })
        deps.onProgress(done, jobIds.length, `${args[0].company}: ${args[0].title}`)
        page = await A.newTab(deps.profileDir, deps.hidden !== false)
        if (deps.hidden === false) await A.minimize(page)
        const deadline = Date.now() + LIMIT_MS
        A.setFillDeadline(deadline)
        await Promise.race([
          drive(page, args, deps.hooks(jobId), deadline, s => { where = s; deps.onLive?.(jobId, { page: s }) }, step => deps.onLive?.(jobId, { step }), keep),
          new Promise((_, reject) => setTimeout(() => reject(new Flag(`took longer than ${limitText()}`)), LIMIT_MS)),
          skipP
        ])
        skipNow = null   // submitted: too late to skip
        applied++
        deps.onResult(result('applied', 'Submitted and confirmed'))
      } catch (e) {
        if (e instanceof StoppedError) { deps.onResult(result('flagged', 'stopped by you before it finished')); break }
        if (e instanceof Skipped) { deps.onLive?.(jobId, { state: 'skipped', reason: 'Skipped by you', end: true }); continue }
        flagged++
        let shot = ''
        const visible = page && !page.isClosed() ? A.openPages().filter(x => x === page || x.url() !== 'about:blank').pop() || page : null
        if (visible) { shot = join(deps.shotDir, `${jobId.replace(/[^a-z0-9]+/gi, '_')}.png`); await visible.screenshot({ path: shot, fullPage: DRY }).catch(() => { shot = '' }); if (process.env.IH_AUTOAPPLY_DEBUG && shot) { const html: string[] = []; for (const f of visible.frames()) html.push(await f.content().catch(() => '')); try { writeFileSync(shot.replace(/\.png$/, '.html'), html.join('\n<!-- frame -->\n')) } catch { /* debug only */ } } }
        // Any page call made after the tab was closed (waitForTimeout and the rest) throws this raw Playwright error.
        const reason = e instanceof Flag ? e.message : /Target page, context or browser has been closed/i.test((e as Error).message) ? 'the application tab closed' : `error: ${(e as Error).message.split('\n')[0].slice(0, 140)}`
        deps.onResult(result(/^dry run/.test(reason) ? 'dryrun' : 'flagged', reason, shot, e instanceof Flag ? e.questions : []))
      } finally {
        skipNow = null
        closed = true
        A.setFillDeadline(Infinity)   // manual "Pre-fill" afterwards has no deadline
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
export const _rules = { blockingNote, APPLY_TEXT, isCodeScreen, lockedOut }
