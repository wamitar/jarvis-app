// Opens the application page in the user's Chrome (own profile folder), fills what it can, and stops.
// It never clicks Submit, never solves CAPTCHAs and never signs in: those stay with the user.
import { chromium, type BrowserContext, type Frame, type Page } from 'playwright-core'
import type { Job, PrefillResult, Profile, Resume, Tailored } from '../../shared/types'
import { resumeToText } from '../../shared/types'
import { askJson } from '../ai/claude'

let context: BrowserContext | null = null
let page: Page | null = null

async function getPage(profileDir: string): Promise<Page> {
  if (context) { try { context.pages() } catch { context = null } }
  if (!context) {
    context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, viewport: null })
    context.on('close', () => { context = null; page = null })
  }
  if (!page || page.isClosed()) page = context.pages().find(p => !p.isClosed()) || await context.newPage()
  return page
}

export async function closeBrowser(): Promise<void> { try { await context?.close() } catch { /* already closed */ } context = null; page = null }

interface Field { idx: number; tag: string; type: string; label: string; name: string; required: boolean; value: string; options: string[] }

/** Runs inside the page: tags each visible form control and describes it. */
function collectFields(startIdx: number): Field[] {
  const out: Field[] = []
  const clean = (s: string | null | undefined): string => (s || '').replace(/[*✱∗]/g, ' ').replace(/\s+/g, ' ').trim()
  const labelFor = (el: HTMLElement): string => {
    const id = el.getAttribute('id')
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l && clean(l.textContent)) return clean(l.textContent) }
    const lb = el.getAttribute('aria-labelledby')
    if (lb) { const t = lb.split(/\s+/).map(i => clean(document.getElementById(i)?.textContent)).join(' ').trim(); if (t) return t }
    const wrap = el.closest('label'); if (wrap && clean(wrap.textContent)) return clean(wrap.textContent)
    if (clean(el.getAttribute('aria-label'))) return clean(el.getAttribute('aria-label'))
    let p: HTMLElement | null = el.parentElement
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const l = p.querySelector('label, legend, [class*="label" i], [class*="question" i]')
      if (l && !l.contains(el)) { const t = clean(l.textContent); if (t && t.length < 300) return t }
    }
    return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name')) || ''
  }
  let idx = startIdx
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select'))) {
    const input = el as HTMLInputElement
    const type = (el.tagName === 'INPUT' ? input.type || 'text' : el.tagName.toLowerCase()).toLowerCase()
    if (['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search'].includes(type)) continue
    const r = el.getBoundingClientRect()
    const visible = type === 'file' || (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
    if (!visible || input.disabled || input.readOnly) continue
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) {
      out.push({ idx: -1, tag: 'combobox', type: 'combobox', label: labelFor(el), name: '', required: false, value: '', options: [] }); continue
    }
    el.setAttribute('data-ih-idx', String(idx))
    out.push({
      idx, tag: el.tagName.toLowerCase(), type, label: labelFor(el), name: `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('autocomplete') || ''}`,
      required: input.required || el.getAttribute('aria-required') === 'true', value: type === 'file' ? '' : input.value || '',
      options: el.tagName === 'SELECT' ? Array.from((el as HTMLSelectElement).options).map(o => o.text.trim()).filter(Boolean) : []
    })
    idx++
  }
  // Workday draws its dropdowns as buttons that open a list.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]'))) {
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0) || (el as HTMLButtonElement).disabled) continue
    el.setAttribute('data-ih-idx', String(idx))
    out.push({ idx, tag: 'wdselect', type: 'wdselect', label: labelFor(el), name: el.getAttribute('id') || '', required: el.getAttribute('aria-required') === 'true', value: clean(el.textContent), options: [] })
    idx++
  }
  return out
}

type Rule = [RegExp, (p: Profile, job: Job) => string]
const usJob = (job: Job): boolean => job.region === 'usa'
const RULES: Rule[] = [
  [/first.?name|given.?name|prénom/i, p => p.firstName],
  [/last.?name|family.?name|surname/i, p => p.lastName],
  [/preferred.*name|nickname/i, p => p.firstName],
  [/full.?name|legal.?name|^name\b|your name|^\s*name\s*$/i, p => `${p.firstName} ${p.lastName}`.trim()],
  [/e-?mail/i, p => p.email],
  [/phone|mobile|tel\b/i, p => p.phone],
  [/linkedin/i, p => p.linkedin],
  [/github/i, p => p.github],
  [/website|portfolio|personal (site|url)|other (link|url)/i, p => p.website],
  [/sponsor/i, p => p.needsSponsorship],
  [/authori[sz]ed|legally (able|entitled|permitted)|eligible to work|right to work|work permit/i, (p, j) => (usJob(j) ? p.workAuthUsa : p.workAuthCanada)],
  [/relocat/i, p => p.willingToRelocate],
  [/gpa|grade point|cumulative average/i, p => p.gpa],
  [/graduat|completion date|expected.*(degree|date)/i, p => p.graduation],
  [/school|university|college|institution/i, p => p.school],
  [/major|discipline|field of study|area of study|program of study/i, p => p.major],
  [/\bdegree\b/i, p => p.degree],
  [/start date|availab|when can you (start|begin)|earliest/i, p => p.availability],
  [/(length|duration).*(term|internship|co-?op)|how many months/i, p => p.termLength],
  [/\bcity\b|current location|where are you (based|located)|^location/i, p => [p.city, p.province].filter(Boolean).join(', ')],
  [/province|\bstate\b/i, p => p.province],
  [/country/i, p => p.country]
]
const SKIP = /how did you hear|referr|gender|race|ethnic|veteran|disab|pronoun|sexual|indigenous|salary|compensation|date of birth|sin\b|ssn|social (security|insurance)|password|captcha/i

function pickOption(options: string[], want: string): string | null {
  const w = want.toLowerCase().trim()
  if (!w) return null
  return options.find(o => o.toLowerCase() === w) || options.find(o => o.toLowerCase().startsWith(w)) ||
    options.find(o => o.toLowerCase().includes(w)) || null
}

async function fillFrame(frame: Frame, offset: number, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null,
  res: PrefillResult, open: { frame: Frame; f: Field }[]): Promise<number> {
  let fields: Field[]
  try { fields = await frame.evaluate(collectFields, offset) } catch { return 0 }
  let resumeDone = false, choices = 0
  for (const f of fields) {
    const label = f.label || f.name
    const short = label.slice(0, 70) || '(unlabelled field)'
    if (f.tag === 'combobox') { if (label) res.skipped.push(`${short} (custom dropdown: pick it yourself)`); continue }
    const loc = frame.locator(`[data-ih-idx="${f.idx}"]`)
    const key = `${label} ${f.name}`
    try {
      if (f.tag === 'wdselect') {
        if (f.value && !/^select one$/i.test(f.value)) continue
        if (SKIP.test(key)) { if (f.required) res.skipped.push(`${short} (left for you)`); continue }
        const rule = RULES.find(([re]) => re.test(label))
        const value = /device type/i.test(label) ? 'Mobile' : /phone code|country/i.test(label) ? profile.country : rule ? rule[1](profile, job) : ''
        if (!value) { if (f.required) res.skipped.push(`${short} (dropdown)`); continue }
        await loc.click()
        const opt = frame.locator('[role="option"]').filter({ hasText: new RegExp('^\\s*' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first()
        if (await opt.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) { await opt.click(); res.filled.push(`${short}: ${value}`) }
        else { await frame.page().keyboard.press('Escape').catch(() => {}); res.skipped.push(`${short} (dropdown: "${value}" is not one of the choices)`) }
        continue
      }
      if (f.type === 'file') {
        const isCover = /cover/i.test(key)
        if (!isCover && !resumeDone && tailored?.pdfPath && (/resume|cv|curriculum/i.test(key) || !/transcript|portfolio|other|additional/i.test(key))) {
          await loc.setInputFiles(tailored.pdfPath); resumeDone = true; res.filled.push('Resume PDF attached')
        } else res.skipped.push(`${short} (file upload)`)
        continue
      }
      if (f.type === 'checkbox' || f.type === 'radio') { choices++; continue }
      if (f.value && f.tag !== 'select') continue
      if (SKIP.test(key)) { if (f.required) res.skipped.push(`${short} (left for you)`); continue }
      if (/cover letter/i.test(key) && f.tag === 'textarea') {
        if (tailored?.coverLetter) { await loc.fill(tailored.coverLetter); res.filled.push('Cover letter') } else res.skipped.push('Cover letter (none written yet)')
        continue
      }
      const rule = RULES.find(([re]) => re.test(label)) || RULES.find(([re]) => re.test(f.name))
      const value = rule ? rule[1](profile, job) : ''
      if (f.tag === 'select') {
        if (f.value && !/^(select|choose|please|--)/i.test(f.options[0] || '')) continue
        const opt = value ? pickOption(f.options, value) : null
        if (opt) { await loc.selectOption({ label: opt }); res.filled.push(`${short}: ${opt}`) } else if (f.required || rule) res.skipped.push(`${short} (dropdown)`)
        continue
      }
      if (value) { await loc.fill(value); res.filled.push(short); continue }
      if (rule) { res.skipped.push(`${short} (not in your profile)`); continue }
      if (label.length > 18 && (f.tag === 'textarea' || /\?|why|describe|tell us|explain|what|which/i.test(label))) open.push({ frame, f })
      else if (f.required) res.skipped.push(short)
    } catch (e) { res.skipped.push(`${short} (could not fill: ${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
  }
  if (choices) res.skipped.push(`${choices} tick boxes and multiple-choice options (yours to choose)`)
  return fields.length
}

async function fillOpenQuestions(open: { frame: Frame; f: Field }[], job: Job, profile: Profile, resume: Resume, model: string, res: PrefillResult): Promise<void> {
  if (!open.length) return
  const qs = open.slice(0, 10)
  const prompt = `Draft answers to screening questions on an internship application. The candidate will review every answer before submitting.

<resume>
${resumeToText(resume)}
</resume>

Candidate facts: ${JSON.stringify({ ...profile, extra: undefined })}
Other facts the candidate gave: ${profile.extra || '(none)'}

<job>
${job.title} at ${job.company}, ${job.location}
${job.description.slice(0, 3500)}
</job>

<questions>
${qs.map((q, n) => `${n}. ${q.f.label} ${q.f.tag === 'textarea' ? '(long answer)' : '(short answer)'}`).join('\n')}
</questions>

Rules:
- Use only facts given above. Never invent experience, numbers, dates or personal details.
- If the facts above do not answer a question, return "" for it so the candidate writes it themselves.
- Short answers: a few words. Long answers: 2 to 5 plain sentences, first person, specific, no clichés.

Reply with JSON: [{"n": 0, "answer": ""}]`
  const answers = await askJson<{ n: number; answer: string }[]>(prompt, { model })
  for (const a of Array.isArray(answers) ? answers : []) {
    const q = qs[a.n]
    if (!q) continue
    const label = q.f.label.slice(0, 120)
    if (!a.answer || typeof a.answer !== 'string') { res.skipped.push(`${label.slice(0, 70)} (needs your answer)`); continue }
    try { await q.frame.locator(`[data-ih-idx="${q.f.idx}"]`).fill(a.answer); res.drafted.push({ question: label, answer: a.answer }) }
    catch { res.skipped.push(`${label.slice(0, 70)} (could not fill)`) }
  }
}

const blank = (page: string, note = ''): PrefillResult => ({ page, filled: [], skipped: [], drafted: [], note })

async function fillCurrentPage(p: Page, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, label = 'Application page'): Promise<PrefillResult> {
  const res = blank(label)
  const open: { frame: Frame; f: Field }[] = []
  let total = 0, offset = 0
  for (const frame of p.frames()) {
    const n = await fillFrame(frame, offset, job, profile, resume, tailored, res, open)
    total += n; offset += 1000
  }
  try { await fillOpenQuestions(open, job, profile, resume, model, res) }
  catch (e) { res.skipped.push(`Screening questions (Claude could not draft them: ${(e as Error).message.slice(0, 80)})`) }
  if (!total) res.note = 'No form fields found on this page yet. If there is an Apply button, a sign-in or a CAPTCHA, do that step in the browser, then press "Fill this page" again.'
  else res.note = 'Check every field in the browser, finish anything listed as left for you, then press Submit yourself.'
  if (!tailored?.pdfPath) res.note += ' No tailored resume PDF was saved for this job, so nothing was attached.'
  return res
}

// ---------------------------------------------------------------------------------------------
// Workday. Its applications sit behind Apply → a choice of how to start → sign in or create an
// account → several form pages. The app walks those steps and fills each page as it appears.
// It still never presses Next or Submit on the application itself.

export interface WorkdayHooks {
  /** Email from Settings and password from the Mac Keychain; null when none is stored. */
  getLogin(): Promise<{ email: string; password: string } | null>
  isKnown(tenant: string): boolean          // an account already exists at this employer's Workday
  markKnown(tenant: string): void
  autoCreate: boolean                        // user opted in: tick the agreement box and press Create Account
  onUpdate(r: PrefillResult): void           // a later page was filled
}
type Args = [Job, Profile, Resume, Tailored | null, string]

// The stored password is only ever typed on Workday's own domains.
const WD_HOST = /\.(myworkdayjobs|myworkdaysite)\.com$/i
const testHost = process.env.IH_USER_DATA ? process.env.IH_WD_TEST_HOST : undefined
const hostOf = (u: string): string => { try { return new URL(u).hostname } catch { return '' } }
export const isWorkdayUrl = (u: string): boolean => { const h = hostOf(u); return WD_HOST.test(h) || (!!testHost && h === testHost) }
const wd = (id: string): string => `[data-automation-id="${id}"]`
const triedCreate = new Set<string>()
let watchToken = 0

const seen = (p: Page, sel: string, timeout = 0): Promise<boolean> => {
  const l = p.locator(sel).first()
  return timeout ? l.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false) : l.isVisible().catch(() => false)
}
/** Workday lays an invisible "click_filter" over some buttons; the click has to go to that overlay. */
async function pressWd(p: Page, id: string): Promise<void> {
  const btn = p.locator(wd(id)).first()
  const overlay = btn.locator('xpath=..').locator(wd('click_filter')).first()
  if (await overlay.isVisible().catch(() => false)) await overlay.click(); else await btn.click()
}

async function signature(p: Page): Promise<string> {
  const step = await p.locator(wd('progressBarActiveStep')).first().innerText({ timeout: 400 }).catch(() => '')
  const pw = await p.locator('input[type="password"]:visible').count().catch(() => 0)
  const start = (await seen(p, wd('applyManually'))) || (await seen(p, wd('autofillWithResume')))
  return `${p.url().split('?')[0]}|${step.replace(/\s+/g, ' ').trim()}|pw${pw}|${start ? 'start' : ''}`
}

async function chooseStart(p: Page, tailored: Tailored | null, res: PrefillResult): Promise<void> {
  const useResume = !!tailored?.pdfPath && (await seen(p, wd('autofillWithResume')))
  const id = useResume ? 'autofillWithResume' : 'applyManually'
  if (!(await seen(p, wd(id)))) return
  await p.locator(wd(id)).first().click()
  res.filled.push(useResume ? 'Chose "Autofill with Resume"' : 'Chose "Apply Manually"')
}

async function authStep(p: Page, tenant: string, hooks: WorkdayHooks): Promise<PrefillResult> {
  const res = blank('Workday sign-in')
  const login = await hooks.getLogin()
  if (!login) {
    res.note = 'This employer uses Workday, which needs an account. Save your Workday email and password in Settings › Workday account and press "Fill this page again", or sign in yourself in the browser.'
    return res
  }
  let creating = await seen(p, wd('verifyPassword'))
  if (!creating && !hooks.isKnown(tenant) && !triedCreate.has(tenant) && (await seen(p, wd('createAccountLink')))) {
    triedCreate.add(tenant)
    await p.locator(wd('createAccountLink')).first().click()
    creating = await seen(p, wd('verifyPassword'), 6000)
  }
  await p.locator(wd('email')).first().fill(login.email)
  await p.locator(wd('password')).first().fill(login.password)
  if (creating) {
    triedCreate.add(tenant)
    await p.locator(wd('verifyPassword')).first().fill(login.password)
    res.page = 'Workday create account'
    res.filled.push('Email', 'Password', 'Confirm password')
    if (hooks.autoCreate) {
      const box = p.locator(wd('createAccountCheckbox')).first()
      if (await box.isVisible().catch(() => false)) { await box.check({ force: true }).catch(() => box.click()); res.filled.push('Agreement box ticked') }
      await pressWd(p, 'createAccountSubmitButton')
      res.filled.push('Pressed Create Account')
      res.note = 'If Workday emails you a verification link, open it and come back. If it says an account already exists, press Sign In on that page and the app signs you in.'
    } else {
      res.note = 'Tick the agreement box if there is one, then press Create Account. The app carries on once you are in. To have it press Create Account too, turn that on in Settings › Workday account.'
    }
  } else {
    await pressWd(p, 'signInSubmitButton')
    res.filled.push('Email', 'Password', 'Pressed Sign In')
    res.note = 'Signing in. If Workday rejects the password or asks for a code, finish that step in the browser.'
  }
  return res
}

async function workdayStep(p: Page, args: Args, hooks: WorkdayHooks): Promise<PrefillResult> {
  const [job, profile, resume, tailored, model] = args
  const tenant = hostOf(p.url()).split('.')[0]
  if ((await p.locator('input[type="password"]:visible').count().catch(() => 0)) > 0) return authStep(p, tenant, hooks)
  if ((await seen(p, wd('applyManually'))) || (await seen(p, wd('autofillWithResume')))) {
    const res = blank('Workday: how to apply'); await chooseStart(p, tailored, res); return res
  }
  const inFlow = /\/apply(\/|$)/.test(p.url()) || (await seen(p, wd('progressBar')))
  if (!inFlow && (await seen(p, wd('adventureButton')))) {
    const res = blank('Workday job page')
    await p.locator(wd('adventureButton')).first().click()
    res.filled.push('Pressed Apply')
    if ((await seen(p, wd('applyManually'), 6000)) || (await seen(p, wd('autofillWithResume')))) await chooseStart(p, tailored, res)
    res.note = 'Opening the application. The next pages are filled as they appear.'
    return res
  }
  if (inFlow) hooks.markKnown(tenant)
  const step = await p.locator(wd('progressBarActiveStep')).first().innerText({ timeout: 400 }).catch(() => '')
  const res = await fillCurrentPage(p, job, profile, resume, tailored, model, step ? `Workday: ${step.replace(/\s+/g, ' ').replace(/^current step \d+ of \d+/i, '').trim()}` : 'Workday page')
  if (inFlow) res.note = 'Check this page, finish what is left for you, then press Save and Continue. The next page is filled when it appears. Submit is always yours.'
  return res
}

/** Fills each new Workday page as it appears, until the browser closes, another run starts, or 45 minutes pass. */
async function watchWorkday(p: Page, args: Args, hooks: WorkdayHooks): Promise<void> {
  const token = ++watchToken
  const done = new Set<string>()
  const until = Date.now() + 45 * 60_000
  while (token === watchToken && !p.isClosed() && Date.now() < until) {
    try {
      const sig = isWorkdayUrl(p.url()) ? await signature(p) : ''
      if (sig && !done.has(sig)) {
        await p.waitForTimeout(1300)
        if ((await signature(p)) !== sig) continue   // still loading or changing
        done.add(sig)
        try { hooks.onUpdate(await workdayStep(p, args, hooks)) }
        catch (e) { hooks.onUpdate(blank('Workday', `This page could not be filled: ${(e as Error).message.split('\n')[0].slice(0, 120)}`)) }
      }
      await p.waitForTimeout(1500)
    } catch { if (p.isClosed()) break; await new Promise(r => setTimeout(r, 1500)) }
  }
}

export async function prefill(profileDir: string, args: Args, hooks: WorkdayHooks): Promise<PrefillResult> {
  const [job] = args
  watchToken++   // stop any watcher from an earlier run
  const p = await getPage(profileDir)
  await p.bringToFront().catch(() => {})
  await p.goto(job.applyUrl || job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  if (!isWorkdayUrl(p.url())) return fillCurrentPage(p, ...args)
  // The first page's result is returned; later pages arrive through hooks.onUpdate.
  return new Promise<PrefillResult>(resolve => {
    let first = true
    const timer = setTimeout(() => { if (first) { first = false; resolve(blank('Workday', 'The page is still loading. Press "Fill this page again" once it is ready.')) } }, 40_000)
    void watchWorkday(p, args, { ...hooks, onUpdate: r => { if (first) { first = false; clearTimeout(timer); resolve(r) } else hooks.onUpdate(r) } })
  })
}

export async function fillAgain(args: Args, hooks: WorkdayHooks): Promise<PrefillResult> {
  if (!context) throw new Error('The application browser is not open. Press "Pre-fill application" first.')
  const pages = context.pages().filter(x => !x.isClosed())
  const p = pages[pages.length - 1]
  if (!p) throw new Error('The application browser has no open page.')
  page = p
  return isWorkdayUrl(p.url()) ? workdayStep(p, args, hooks) : fillCurrentPage(p, ...args)
}
