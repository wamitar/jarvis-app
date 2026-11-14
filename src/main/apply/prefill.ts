// Opens the application page in the user's Chrome (own profile folder) and fills it in.
// Every control on the page is read (text, dropdowns, radio groups, tick boxes, searchable pickers),
// Claude decides every answer it can infer from the profile, resume and posting, and the app types
// them in. It never clicks Submit and never solves CAPTCHAs: those stay with the user.
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core'
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

// ---------------------------------------------------------------------------------------------
// Reading the page

type Kind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'dropdown' | 'combobox' | 'file'
interface Field {
  idx: number           // data-ih-idx on the control (radio/checkbox groups: on every option)
  kind: Kind
  inputType: string     // e.g. email, tel, date, number
  label: string         // the control's own label (for a single tick box: the statement next to it)
  question: string      // the group's question for radios / tick boxes, when it differs from label
  section: string       // nearest heading above, e.g. "Work Experience 2"
  name: string
  required: boolean
  value: string         // current value / selected option text(s); '' when empty
  options: string[]
  maxLength: number
  multi: boolean        // combobox that takes several values (Workday skills)
}
interface Located { frame: Frame; f: Field; key: string }

/** Runs inside the page: tags each form control and describes it. Must stay self-contained. */
function collectFields(startIdx: number): Field[] {
  for (const el of Array.from(document.querySelectorAll('[data-ih-idx]'))) { el.removeAttribute('data-ih-idx'); el.removeAttribute('data-ih-opt') }
  const out: Field[] = []
  const clean = (s: string | null | undefined): string => (s || '').replace(/[*✱∗]/g, ' ').replace(/\s+/g, ' ').trim()
  const visible = (el: Element | null): boolean => {
    if (!el) return false
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const hasControl = (el: Element): boolean => !!el.querySelector('input:not([type=hidden]), select, textarea, button[aria-haspopup]')
  const ownLabel = (el: HTMLElement): { text: string; star: boolean } => {
    const raw = (t: string | null | undefined) => ({ text: clean(t), star: /[*✱∗]/.test(t || '') })
    const id = el.getAttribute('id')
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l && clean(l.textContent)) return raw(l.textContent) }
    const lb = el.getAttribute('aria-labelledby')
    if (lb) { const t = lb.split(/\s+/).map(i => document.getElementById(i)?.textContent || '').join(' '); if (clean(t)) return raw(t) }
    const wrap = el.closest('label'); if (wrap && clean(wrap.textContent)) return raw(wrap.textContent)
    if (clean(el.getAttribute('aria-label'))) return raw(el.getAttribute('aria-label'))
    return { text: '', star: false }
  }
  /** Text that sits before `el` inside an ancestor and is not itself a control or an option label. */
  const textBefore = (el: HTMLElement, skip: Set<Element>): { text: string; star: boolean } => {
    let p: HTMLElement | null = el.parentElement
    for (let depth = 0; depth < 7 && p && p !== document.body; depth++, p = p.parentElement) {
      const cands = Array.from(p.querySelectorAll<HTMLElement>('legend, label, h1, h2, h3, h4, h5, h6, p, span, div'))
        .filter(c => (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !c.contains(el) && !hasControl(c) &&
          !Array.from(skip).some(s => s.contains(c)) && clean(c.textContent).length >= 2 && clean(c.textContent).length < 500)
      if (cands.length) { const c = cands[cands.length - 1]; return { text: clean(c.textContent), star: /[*✱∗]/.test(c.textContent || '') } }
    }
    return { text: '', star: false }
  }
  const labelFor = (el: HTMLElement): { text: string; star: boolean } => {
    const own = ownLabel(el); if (own.text) return own
    const before = textBefore(el, new Set()); if (before.text) return before
    return { text: clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name')) || '', star: false }
  }
  const groupQuestion = (first: HTMLElement, optionEls: Element[]): { text: string; star: boolean } => {
    const fs = first.closest('fieldset'); const lg = fs?.querySelector('legend')
    if (lg && clean(lg.textContent)) return { text: clean(lg.textContent), star: /[*✱∗]/.test(lg.textContent || '') }
    const g = first.closest('[role="radiogroup"], [role="group"]') as HTMLElement | null
    if (g) { const o = ownLabel(g); if (o.text) return o }
    return textBefore(first, new Set(optionEls))
  }
  const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, [role="heading"]')).filter(h => visible(h) && clean(h.textContent))
  const sectionOf = (el: Element): string => {
    let last = ''
    for (const h of headings) { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = clean(h.textContent); else break }
    return last.slice(0, 80)
  }
  const optLabel = (el: HTMLInputElement): string => {
    const o = ownLabel(el).text
    if (o) return o
    const sib = el.nextElementSibling || el.parentElement?.nextElementSibling
    return clean(sib?.textContent || el.value)
  }
  const optVisible = (el: HTMLInputElement): boolean => {
    if (visible(el)) return true
    const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label') || el.parentElement
    return visible(l)
  }
  let idx = startIdx
  const push = (f: Omit<Field, 'idx'>, els: Element[]): void => {
    els.forEach((e, k) => { e.setAttribute('data-ih-idx', String(idx)); if (els.length > 1 || f.kind === 'radio' || f.kind === 'checkboxes') e.setAttribute('data-ih-opt', String(k)) })
    out.push({ idx, ...f }); idx++
  }
  const groupsDone = new Set<string>()
  const all = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select'))
  for (const el of all) {
    const input = el as HTMLInputElement
    const type = (el.tagName === 'INPUT' ? input.type || 'text' : el.tagName.toLowerCase()).toLowerCase()
    if (['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(type) || input.disabled) continue
    const section = sectionOf(el)
    if (type === 'radio' || type === 'checkbox') {
      if (!optVisible(input)) continue
      const container = input.closest('fieldset, [role="radiogroup"], [role="group"]')
      let group: HTMLInputElement[] = []
      if (input.name) group = all.filter(x => (x as HTMLInputElement).type === type && (x as HTMLInputElement).name === input.name && optVisible(x as HTMLInputElement)) as HTMLInputElement[]
      if (group.length <= 1 && container) group = Array.from(container.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)).filter(optVisible)
      if (group.length === 0) group = [input]
      const gkey = type + ':' + (input.name || '') + ':' + all.indexOf(group[0])
      if (groupsDone.has(gkey)) continue
      groupsDone.add(gkey)
      const labels = group.map(optLabel)
      const optionEls = group.map(g => (g.id && document.querySelector(`label[for="${CSS.escape(g.id)}"]`)) || g.closest('label') || g).filter(Boolean) as Element[]
      const q = groupQuestion(group[0], optionEls)
      const req = group.some(g => g.required || g.getAttribute('aria-required') === 'true') || q.star
      if (type === 'radio') {
        push({ kind: 'radio', inputType: type, label: q.text || labels.join(' / '), question: '', section, name: input.name, required: req,
          value: labels[group.findIndex(g => g.checked)] || '', options: labels, maxLength: 0, multi: false }, group)
      } else if (group.length > 1) {
        push({ kind: 'checkboxes', inputType: type, label: q.text, question: '', section, name: input.name, required: req,
          value: labels.filter((_, k) => group[k].checked).join('; '), options: labels, maxLength: 0, multi: true }, group)
      } else {
        push({ kind: 'checkbox', inputType: type, label: labels[0], question: q.text !== labels[0] ? q.text : '', section, name: input.name, required: req,
          value: input.checked ? 'checked' : '', options: [], maxLength: 0, multi: false }, group)
      }
      continue
    }
    if (type === 'file') {
      const l = labelFor(el)
      push({ kind: 'file', inputType: type, label: l.text, question: '', section, name: `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('data-automation-id') || ''}`,
        required: input.required, value: '', options: [], maxLength: 0, multi: false }, [el])
      continue
    }
    if (!visible(el) || input.readOnly) continue
    // Hidden stand-ins some forms keep beside custom dropdowns for their own validation (Greenhouse, react-select).
    if (el.getAttribute('aria-hidden') === 'true' || Number(getComputedStyle(el).opacity) === 0 || (el.tabIndex < 0 && el.getAttribute('role') !== 'combobox')) continue
    const l = labelFor(el)
    const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('data-automation-id') || ''}`.trim()
    const required = input.required || el.getAttribute('aria-required') === 'true' || l.star
    const isCombo = el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete') || el.getAttribute('data-uxi-widget-type') === 'selectinput'
    if (isCombo && el.tagName === 'INPUT') {
      // A searchable picker. Its chosen value usually shows in a sibling ("pill" or single-value element).
      let shown = ''
      let p: HTMLElement | null = el.parentElement
      for (let i = 0; i < 5 && p && !shown; i++, p = p.parentElement) {
        const picked = Array.from(p.querySelectorAll('[data-automation-id="selectedItem"], [class*="singleValue" i], [class*="multiValue" i], [class*="single-value" i]')).map(x => clean(x.textContent)).filter(Boolean)
        if (picked.length) shown = picked.join('; ')
      }
      const multi = !!el.closest('[data-automation-id="multiselectInputContainer"]') && /skill/i.test(l.text)
      push({ kind: 'combobox', inputType: 'combobox', label: l.text, question: '', section, name, required, value: shown, options: [], maxLength: 0, multi }, [el])
      continue
    }
    if (el.tagName === 'SELECT') {
      const s = el as HTMLSelectElement
      const opts = Array.from(s.options).map(o => o.text.trim())
      const cur = s.selectedIndex >= 0 ? opts[s.selectedIndex] : ''
      const placeholder = !cur || /^(select|choose|please|--|none selected)/i.test(cur) || s.value === ''
      push({ kind: 'select', inputType: 'select', label: l.text, question: '', section, name, required, value: placeholder ? '' : cur,
        options: opts.filter(o => o && !/^(select|choose|please select|--)/i.test(o)), maxLength: 0, multi: false }, [el])
      continue
    }
    push({ kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', inputType: type, label: l.text, question: '', section, name, required,
      value: input.value || '', options: [], maxLength: input.maxLength > 0 ? input.maxLength : 0, multi: false }, [el])
  }
  // Workday (and some others) draw dropdowns as buttons that open a list.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]'))) {
    if (!visible(el) || (el as HTMLButtonElement).disabled) continue
    const l = labelFor(el)
    const cur = clean(el.textContent)
    push({ kind: 'dropdown', inputType: 'dropdown', label: l.text, question: '', section: sectionOf(el), name: el.getAttribute('id') || '',
      required: el.getAttribute('aria-required') === 'true' || l.star, value: /^select one$|^select$|^choose/i.test(cur) ? '' : cur, options: [], maxLength: 0, multi: false }, [el])
  }
  return out
}

const visibleOptions = async (frame: Frame): Promise<string[]> =>
  frame.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    .map(o => (o.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 300)).catch(() => [])

/** Opens a custom dropdown or picker just long enough to read its choices. */
async function readOptions(frame: Frame, f: Field): Promise<void> {
  const loc = frame.locator(`[data-ih-idx="${f.idx}"]`).first()
  try {
    await loc.click({ timeout: 2500 })
    await frame.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
    f.options = await visibleOptions(frame)
  } catch { /* leave options empty; Claude still answers from the label */ }
  await frame.page().keyboard.press('Escape').catch(() => {})
  await frame.page().waitForTimeout(150)
}

// ---------------------------------------------------------------------------------------------
// Matching and typing

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()
function bestOption(options: string[], want: string): number {
  const w = norm(want)
  if (!w) return -1
  const n = options.map(norm)
  let i = n.indexOf(w); if (i >= 0) return i
  i = n.findIndex(o => o.startsWith(w + ' ') || w.startsWith(o + ' ')); if (i >= 0) return i
  i = n.findIndex(o => (` ${o} `).includes(` ${w} `)); if (i >= 0) return i
  if (w.length > 3) { i = n.findIndex(o => o.length > 3 && (` ${w} `).includes(` ${o} `)); if (i >= 0) return i }
  // Last resort: most shared words, if at least half of the wanted words match.
  const ww = new Set(w.split(' '))
  let best = -1, score = 0
  n.forEach((o, k) => { const s = o.split(' ').filter(t => ww.has(t)).length / Math.max(ww.size, 1); if (s > score) { score = s; best = k } })
  return score >= 0.5 ? best : -1
}

/** Types like a person (focus, select all, keystrokes, blur) so React-based forms such as Workday register it. */
async function typeInto(loc: Locator, value: string, keystrokes: boolean): Promise<void> {
  if (!keystrokes) {
    await loc.fill(value, { timeout: 8000 })
    if ((await loc.inputValue().catch(() => value)) === value) return
  }
  await loc.click({ timeout: 8000 })
  await loc.press('ControlOrMeta+a')
  await loc.press('Backspace')
  if (value.length <= 400) await loc.pressSequentially(value, { delay: 6 })
  else { await loc.fill(value); await loc.press('End'); await loc.pressSequentially(' '); await loc.press('Backspace') }
  await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
}

async function clickOption(frame: Frame, want: string): Promise<string | null> {
  const opts = await visibleOptions(frame)
  const i = bestOption(opts, want)
  if (i < 0) return null
  const loc = frame.locator('[role="option"]').filter({ hasText: opts[i] })
  const n = await loc.count()
  for (let k = 0; k < n; k++) {
    const o = loc.nth(k)
    if (await o.isVisible().catch(() => false)) {
      // Workday puts a radio/checkbox inside some options; clicking the option row picks it.
      await o.click({ timeout: 2500 })
      return opts[i]
    }
  }
  return null
}

async function pickInCombobox(frame: Frame, loc: Locator, value: string, workday: boolean): Promise<string | null> {
  await loc.click({ timeout: 2500 })
  await loc.press('ControlOrMeta+a').catch(() => {})
  await loc.pressSequentially(value, { delay: 25 })
  // Workday searches on Enter. Anywhere else Enter can submit the form, so it is never pressed there.
  if (workday) await loc.press('Enter').catch(() => {})
  await frame.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  await frame.page().waitForTimeout(300)
  let picked = await clickOption(frame, value)
  if (!picked) {
    // Search text did not match an option: clear it and pick from the full list instead.
    await loc.press('ControlOrMeta+a').catch(() => {}); await loc.press('Backspace').catch(() => {})
    await frame.page().keyboard.press('Escape').catch(() => {})
    await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
    await loc.click({ timeout: 2500 }).catch(() => {})   // reopen the full list
    await frame.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
    picked = await clickOption(frame, value)
  }
  if (picked) {
    // Two-level lists (Workday "How did you hear about us?"): a category opens a sub-list.
    await frame.page().waitForTimeout(500)
    const sub = await visibleOptions(frame)
    if (sub.length && !sub.includes(picked)) { const second = await clickOption(frame, value) || (sub.length ? (await frame.locator('[role="option"]:visible').first().click().then(() => sub[0]).catch(() => null)) : null); if (second) picked += ' › ' + second }
  }
  await frame.page().keyboard.press('Escape').catch(() => {})
  return picked
}

// ---------------------------------------------------------------------------------------------
// Deciding answers

type Rule = [RegExp, (p: Profile, job: Job) => string]
const usJob = (job: Job): boolean => job.region === 'usa'
/** Plain mapping, used when Claude is unavailable. */
const RULES: Rule[] = [
  [/first.?name|given.?name|prénom/i, p => p.firstName],
  [/last.?name|family.?name|surname/i, p => p.lastName],
  [/preferred.*name|nickname/i, p => p.firstName],
  [/full.?name|legal.?name|^name\b|your name|^\s*name\s*$/i, p => `${p.firstName} ${p.lastName}`.trim()],
  [/e-?mail/i, p => p.email],
  [/phone|mobile|tel\b/i, p => p.phone],
  [/linkedin/i, p => p.linkedin],
  [/github/i, p => p.github],
  [/website|portfolio|personal (site|url)/i, p => p.website],
  [/citizen/i, p => p.citizenship],
  [/sponsor/i, p => p.needsSponsorship],
  [/authori[sz]ed|legally (able|entitled|permitted)|eligible to work|right to work|work permit/i, (p, j) => (usJob(j) ? p.workAuthUsa : p.workAuthCanada)],
  [/relocat/i, p => p.willingToRelocate],
  [/gpa|grade point|cumulative average/i, p => p.gpa],
  [/graduat|completion date/i, p => p.graduation],
  [/school|university|college|institution/i, p => p.school],
  [/major|discipline|field of study|area of study|program of study/i, p => p.major],
  [/\bdegree\b/i, p => p.degree],
  [/start date|availab|when can you (start|begin)|earliest/i, p => p.availability],
  [/address( line)? ?1?$|street/i, p => p.address],
  [/postal|zip/i, p => p.postalCode],
  [/\bcity\b/i, p => p.city],
  [/province|\bstate\b/i, p => p.province],
  [/country/i, p => p.country]
]
const NEVER = /password|captcha|social (security|insurance)|\bssn\b|\bsin\b|passport|driver'?s? licen[cs]e number|bank|credit card/i

function ruleAnswer(f: Field, profile: Profile, job: Job): string {
  const text = `${f.question} ${f.label}`
  const r = RULES.find(([re]) => re.test(text)) || RULES.find(([re]) => re.test(f.name))
  return r ? r[1](profile, job) : ''
}

interface Answer { id: number; value: string | string[] | boolean }

async function decide(fields: Field[], job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string): Promise<Map<number, Answer['value']>> {
  const today = new Date().toISOString().slice(0, 10)
  const list = fields.map(f => ({
    id: f.idx, type: f.kind === 'combobox' ? (f.multi ? 'searchable multi-select' : 'searchable dropdown') : f.kind === 'dropdown' ? 'dropdown' : f.kind,
    ...(f.inputType && !['text', 'textarea', 'select', 'radio', 'checkbox', 'dropdown', 'combobox'].includes(f.inputType) ? { inputType: f.inputType } : {}),
    label: f.label.slice(0, 300), ...(f.question ? { question: f.question.slice(0, 300) } : {}), ...(f.section ? { section: f.section } : {}),
    required: f.required, ...(f.options.length ? { options: f.options.slice(0, 250) } : {}), ...(f.maxLength ? { maxLength: f.maxLength } : {})
  }))
  const { extra, ...facts } = profile
  const prompt = `You are filling in a job application form for the candidate. The candidate reviews the whole form before submitting it, so fill in everything you reasonably can. Read between the lines: use what a sensible person who knows the candidate well would answer.

Today is ${today}.

<candidate_facts>
${JSON.stringify(facts, null, 1)}
Other facts from the candidate: ${extra || '(none)'}
</candidate_facts>

<resume>
${resumeToText(resume)}
</resume>

<job>
${job.title} at ${job.company}, ${job.location}
${job.description.slice(0, 3000)}
</job>
${tailored?.coverLetter ? `\n<cover_letter>\n${tailored.coverLetter}\n</cover_letter>\n` : ''}
<fields>
${JSON.stringify(list)}
</fields>

How to answer:
- For dropdown, radio, select and searchable fields with "options", reply with the exact text of one option. For "checkboxes", reply with an array of the option texts to tick. For a single "checkbox", reply true to tick it or false to leave it.
- For a searchable field without options, reply with the text to search for (e.g. a school name, a skill, a country).
- Work authorization, sponsorship and citizenship come from candidate_facts. Answer them directly, including export-control or "U.S. person" (ITAR/EAR) questions: a U.S. citizen is a U.S. person.
- Gender, race, ethnicity, veteran, disability, sexual orientation and similar self-identification questions: choose the option that declines to answer ("I don't wish to answer", "Decline to self-identify", "I do not want to answer").
- Tick consent, acknowledgement, privacy, "I certify" and terms boxes. Do not tick marketing or newsletter boxes, and answer No to consenting to text (SMS) messages.
- "Have you worked for / been employed by this company before?", "Are you related to an employee?", non-compete or "Have you been convicted" style questions: answer No unless the facts say otherwise.
- "How did you hear about us?": pick the option closest to the company's careers website or a job board.
- Age questions ("Are you 18 or older?"): Yes, the candidate is a university student.
- Willing to relocate / travel / work on site: Yes for this internship unless the facts say otherwise.
- Phone country code or phone country: the country that matches the candidate's phone number. Phone device type: Mobile.
- Address fields: use the address in the facts; country is the candidate's country.
- Dates: match the format the label or inputType implies (MM, YYYY, MM/YYYY, YYYY-MM-DD). A "date" for a signature or self-identification form is today. Start date is the candidate's availability.
- Fields in sections like "Work Experience 1", "Work Experience 2", "Education 1" map to the resume entries in the order they appear on the resume. "Role Description" or similar: 2 to 4 plain sentences from that entry's bullets.
- Salary or compensation: if the job states a pay range, give its minimum; otherwise reply "Open to discussion" for text fields.
- Open questions ("Why do you want...", "Tell us about..."): 2 to 5 specific, first-person sentences built from the resume, facts and job. No clichés. Respect maxLength.
- Never invent experience, employers, credentials, grades or numbers. Reply "" only when the answer truly cannot be known (a government ID number, a date of birth, a password) or when a field should stay blank (address line 2, middle name, an optional link the candidate does not have).

Reply with JSON only: {"answers": [{"id": 0, "value": "..."}]} with one entry per field id.`
  const reply = await askJson<{ answers?: Answer[] } | Answer[]>(prompt, { model, timeoutMs: 180_000 })
  const arr = Array.isArray(reply) ? reply : reply?.answers || []
  const map = new Map<number, Answer['value']>()
  for (const a of arr) if (a && typeof a.id === 'number') map.set(a.id, a.value)
  return map
}

// ---------------------------------------------------------------------------------------------
// Filling

const blank = (page: string, note = ''): PrefillResult => ({ page, filled: [], skipped: [], drafted: [], note })
const short = (f: Field): string => (f.question || f.label || f.name || '(unlabelled field)').slice(0, 70)
const isEmpty = (f: Field): boolean => f.kind !== 'file' && !f.value.trim()

async function collectAll(p: Page): Promise<Located[]> {
  const out: Located[] = []
  let offset = 0
  for (const frame of p.frames()) {
    let fields: Field[] = []
    try { fields = await frame.evaluate(collectFields, offset) } catch { /* cross-origin or detached frame */ }
    const seen = new Map<string, number>()
    for (const f of fields) {
      const base = `${f.section}|${f.question}|${f.label}|${f.kind}`
      const n = (seen.get(base) || 0) + 1; seen.set(base, n)
      out.push({ frame, f, key: `${base}#${n}` })
    }
    offset += 1000
  }
  return out
}

async function applyAnswer(x: Located, value: Answer['value'], workday: boolean, res: PrefillResult): Promise<void> {
  const { frame, f } = x
  const loc = frame.locator(`[data-ih-idx="${f.idx}"]`)
  const text = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? String(value) : String(value ?? '')
  const label = short(f)
  switch (f.kind) {
    case 'text': case 'textarea': {
      if (!text.trim()) return
      const v = f.maxLength && text.length > f.maxLength ? text.slice(0, f.maxLength) : text
      await typeInto(loc.first(), v, workday)
      if (f.kind === 'textarea' || v.length > 80) res.drafted.push({ question: (f.question || f.label).slice(0, 120), answer: v })
      else res.filled.push(`${label}: ${v}`)
      return
    }
    case 'select': {
      const i = bestOption(f.options, text)
      if (i < 0) { if (f.required) res.skipped.push(`${label} (no choice matched "${text.slice(0, 40)}")`); return }
      await loc.first().selectOption({ label: f.options[i] }).catch(async () => { await loc.first().selectOption(f.options[i]) })
      res.filled.push(`${label}: ${f.options[i]}`); return
    }
    case 'radio': {
      const i = bestOption(f.options, text)
      if (i < 0) { if (f.required) res.skipped.push(`${label} (no choice matched "${text.slice(0, 40)}")`); return }
      const opt = frame.locator(`[data-ih-idx="${f.idx}"][data-ih-opt="${i}"]`).first()
      await opt.check({ force: true, timeout: 2500 }).catch(async () => {
        const id = await opt.getAttribute('id')
        if (id) await frame.locator(`label[for="${id}"]`).first().click(); else await opt.click({ force: true })
      })
      res.filled.push(`${label}: ${f.options[i]}`); return
    }
    case 'checkbox': {
      const want = value === true || /^(true|yes|checked|tick)$/i.test(text)
      if (!want) return
      const box = loc.first()
      await box.check({ force: true, timeout: 2500 }).catch(async () => {
        const id = await box.getAttribute('id')
        if (id) await frame.locator(`label[for="${id}"]`).first().click(); else await box.click({ force: true })
      })
      res.filled.push(`Ticked: ${label}`); return
    }
    case 'checkboxes': {
      const wants = Array.isArray(value) ? value.map(String) : text.split(/;|\n/).map(s => s.trim()).filter(Boolean)
      const ticked: string[] = []
      for (const w of wants) {
        const i = bestOption(f.options, w); if (i < 0) continue
        const opt = frame.locator(`[data-ih-idx="${f.idx}"][data-ih-opt="${i}"]`).first()
        await opt.check({ force: true, timeout: 2500 }).catch(() => opt.click({ force: true }))
        ticked.push(f.options[i])
      }
      if (ticked.length) res.filled.push(`${label}: ${ticked.join(', ')}`); else if (f.required) res.skipped.push(`${label} (no choice matched)`)
      return
    }
    case 'dropdown': {
      if (!text.trim()) return
      await loc.first().click({ timeout: 2500 })
      await frame.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
      const picked = await clickOption(frame, text)
      if (picked) res.filled.push(`${label}: ${picked}`)
      else { await frame.page().keyboard.press('Escape').catch(() => {}); res.skipped.push(`${label} (dropdown: "${text.slice(0, 40)}" is not one of the choices)`) }
      return
    }
    case 'combobox': {
      const items = Array.isArray(value) ? value.map(String) : f.multi ? text.split(/,|;/).map(s => s.trim()).filter(Boolean) : [text]
      const picked: string[] = []
      for (const it of items.filter(i => i.trim()).slice(0, 15)) {
        const got = await pickInCombobox(frame, loc.first(), it, workday).catch(() => null)
        if (got) picked.push(got)
      }
      if (picked.length) res.filled.push(`${label}: ${picked.join(', ')}`)
      else if (items.some(i => i.trim())) res.skipped.push(`${label} (could not find "${items[0].slice(0, 40)}" in the list)`)
      return
    }
    default: return
  }
}

async function attachFiles(fields: Located[], tailored: Tailored | null, res: PrefillResult): Promise<void> {
  let resumeDone = false
  for (const { frame, f } of fields.filter(x => x.f.kind === 'file')) {
    const key = `${f.label} ${f.name}`
    const isCover = /cover/i.test(key)
    if (!isCover && !resumeDone && tailored?.pdfPath && (/resume|cv|curriculum|file-upload/i.test(key) || !/transcript|portfolio|other|additional/i.test(key))) {
      try {
        await frame.locator(`[data-ih-idx="${f.idx}"]`).first().setInputFiles(tailored.pdfPath)
        resumeDone = true; res.filled.push('Resume PDF attached')
      } catch (e) { res.skipped.push(`Resume upload (${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
    } else if (f.required) res.skipped.push(`${short(f)} (file upload)`)
  }
}

/** Workday "My Experience": add empty Work Experience / Education blocks when the page has none. */
async function addWorkdayBlocks(p: Page, fields: Located[], resume: Resume, res: PrefillResult): Promise<boolean> {
  const has = (re: RegExp, lab: RegExp): boolean => fields.some(x => re.test(x.f.section) && lab.test(x.f.label))
  const plan: [RegExp, RegExp, number, string][] = [
    [/work experience/i, /job title/i, Math.min(resume.experience.length, 4), 'Work Experience'],
    [/education/i, /school|university/i, Math.min(resume.education.length, 2), 'Education']
  ]
  let added = false
  for (const [section, lab, count, name] of plan) {
    if (!count || has(section, lab)) continue
    const btn = p.locator(`[role="group"][aria-labelledby*="${name.replace(' ', '-')}" i] button, button[aria-label^="Add ${name}" i], button[aria-label^="Add Another ${name}" i]`)
      .filter({ hasText: /^\s*Add/ }).first()
    let target = btn
    if (!(await target.isVisible().catch(() => false))) {
      // Fall back to the "Add" button that follows the section's heading.
      target = p.locator(`xpath=//*[self::h2 or self::h3 or self::h4][contains(normalize-space(.), "${name}")]/following::button[normalize-space(.)="Add" or normalize-space(.)="Add Another"][1]`).first()
    }
    for (let k = 0; k < count; k++) {
      if (!(await target.isVisible().catch(() => false))) break
      await target.click().catch(() => {})
      await p.waitForTimeout(700)
      added = true
      // After the first block Workday shows "Add Another" in the same place.
      target = p.locator(`xpath=//*[self::h2 or self::h3 or self::h4][contains(normalize-space(.), "${name}")]/following::button[normalize-space(.)="Add Another"][1]`).first()
    }
    if (added) res.filled.push(`Added ${name} entries`)
  }
  return added
}

/** While the app is filling, any form submission (an accidental Enter, a stray click) is cancelled. */
async function guardSubmit(p: Page, on: boolean): Promise<void> {
  for (const frame of p.frames()) {
    await frame.evaluate((enable: boolean) => {
      const w = window as unknown as { __ihGuard?: boolean; __ihGuardInstalled?: boolean }
      if (!w.__ihGuardInstalled) {
        w.__ihGuardInstalled = true
        document.addEventListener('submit', e => { if (w.__ihGuard) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
      }
      w.__ihGuard = enable
    }, on).catch(() => {})
  }
}

async function fillCurrentPage(p: Page, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, label = 'Application page'): Promise<PrefillResult> {
  await guardSubmit(p, true)
  try { return await fillPage(p, job, profile, resume, tailored, model, label) }
  finally { await guardSubmit(p, false) }
}

async function fillPage(p: Page, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, label: string): Promise<PrefillResult> {
  const res = blank(label)
  const workday = isWorkdayUrl(p.url())
  const attempted = new Set<string>()
  let fields = await collectAll(p)
  if (workday && /experience/i.test(label) && (await addWorkdayBlocks(p, fields, resume, res))) fields = await collectAll(p)
  await attachFiles(fields, tailored, res)
  if (tailored?.pdfPath && fields.some(x => x.f.kind === 'file')) { await p.waitForTimeout(1500); fields = await collectAll(p) }   // uploads can autofill and re-render

  // Two passes: answering a question can reveal follow-up questions.
  for (let pass = 0; pass < 2; pass++) {
    const todo = fields.filter(x => isEmpty(x.f) && !attempted.has(x.key) && !NEVER.test(`${x.f.label} ${x.f.question} ${x.f.name}`))
    if (!todo.length) break
    for (const x of todo) if ((x.f.kind === 'dropdown' || x.f.kind === 'combobox') && !x.f.options.length) await readOptions(x.frame, x.f)
    let answers: Map<number, Answer['value']>
    try { answers = await decide(todo.map(x => x.f), job, profile, resume, tailored, model) }
    catch (e) {
      res.skipped.push(`Claude could not decide the answers (${(e as Error).message.slice(0, 80)}); filled the basics only`)
      answers = new Map(todo.map(x => [x.f.idx, ruleAnswer(x.f, profile, job)]))
    }
    for (const x of todo) {
      attempted.add(x.key)
      const v = answers.get(x.f.idx)
      if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) continue
      try { await applyAnswer(x, v, workday, res) }
      catch (e) { res.skipped.push(`${short(x.f)} (could not fill: ${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
    }
    await p.waitForTimeout(600)
    fields = await collectAll(p)
  }

  // Final check: report anything required that is still empty.
  if (!fields.length) {
    res.note = 'No form fields found on this page yet. If there is an Apply button, a sign-in or a CAPTCHA, do that step in the browser, then press "Fill this page" again.'
  } else {
    for (const x of fields) if (x.f.required && isEmpty(x.f)) res.skipped.push(`${short(x.f)} (required, still empty)`)
    res.note = 'Check every field in the browser, finish anything listed as left for you, then press Submit yourself.'
  }
  if (!tailored?.pdfPath) res.note += ' No tailored resume PDF was saved for this job, so nothing was attached.'
  res.skipped = Array.from(new Set(res.skipped))
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
  await typeInto(p.locator(wd('email')).first(), login.email, true)
  await typeInto(p.locator(wd('password')).first(), login.password, true)
  if (creating) {
    triedCreate.add(tenant)
    await typeInto(p.locator(wd('verifyPassword')).first(), login.password, true)
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
    const timer = setTimeout(() => { if (first) { first = false; resolve(blank('Workday', 'Still working on this page. Results appear here when it is done; if nothing changes, press "Fill this page again".')) } }, 150_000)
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

/** For tests: fill whatever page is open, without the Workday walk. */
export const _test = { collectAll, fillCurrentPage, bestOption }
