import { existsSync, readFileSync } from 'node:fs'
// Opens the application page in the user's Chrome (own profile folder) and fills it in.
// Every control on the page is read (text, dropdowns, radio groups, tick boxes, searchable pickers),
// Claude decides every answer it can infer from the profile, resume and posting, and the app types
// them in. Pre-fill never clicks Submit (only auto-apply does, in autoapply.ts) and never solves CAPTCHAs.
import { begin, checkStop, isStopping, StoppedError } from '../activity'
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core'
import type { DocFile, Job, PrefillResult, Profile, Resume, Tailored } from '../../shared/types'
import { documentFor } from '../docs'
import { resumeToText } from '../../shared/types'
import { regionOf } from '../filter'
import { aiName, askJson } from '../ai/claude'

let context: BrowserContext | null = null
let page: Page | null = null

let contextHidden = false

/**
 * The user's own Chrome version, so a hidden (headless) browser can describe itself like a normal Chrome window.
 * Headless Chrome otherwise says "HeadlessChrome" in every request, which some job sites treat as a robot.
 */
function chromeUserAgent(): string | undefined {
  try {
    const plist = readFileSync('/Applications/Google Chrome.app/Contents/Info.plist', 'utf8')
    const major = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./)?.[1]
    return major ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : undefined
  } catch { return undefined }
}

/**
 * The application browser. hidden = no window at all (headless Chrome, same profile and sign-ins); used by
 * auto-apply. Not hidden = a normal window, for "Open application" where the user watches and finishes the form.
 * Switching between the two restarts Chrome (one profile can only be open once).
 */
async function getPage(profileDir: string, hidden = false): Promise<Page> {
  if (context) { try { context.pages() } catch { context = null } }
  if (context && contextHidden !== hidden) await closeBrowser()
  if (!context) {
    // Chrome pauses timers and drawing in a minimized window; these flags keep filling working while it stays out of the way.
    const args = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
    context = await chromium.launchPersistentContext(profileDir, hidden
      ? { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 }, userAgent: chromeUserAgent(), args }
      : { channel: 'chrome', headless: false, viewport: null, args })
    contextHidden = hidden
    context.on('close', () => { context = null; page = null })
  }
  if (!page || page.isClosed()) page = context.pages().find(p => !p.isClosed()) || await context.newPage()
  return page
}

/** Minimizes the application browser's window, so auto-apply never takes over the screen. */
export async function minimize(p: Page): Promise<void> {
  try {
    const s = await p.context().newCDPSession(p)
    const { windowId } = await s.send('Browser.getWindowForTarget') as { windowId: number }
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    await s.detach()
  } catch { /* window already gone */ }
}
export async function closeBrowser(): Promise<void> { try { await context?.close() } catch { /* already closed */ } context = null; page = null }

// ---------------------------------------------------------------------------------------------
// Reading the page

type Kind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'dropdown' | 'combobox' | 'file' | 'wddate'
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
  error?: string        // the site's own complaint shown at this field ("Invalid number.", "... is required")
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
  /** Transparent, or tucked inside a zero-height box that clips its contents (as Oracle hides its bot trap). */
  const hiddenByAncestor = (el: Element): boolean => {
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.opacity === '0') return true
      if (a !== el && cs.overflow !== 'visible' && a.getBoundingClientRect().height < 2) return true
    }
    return false
  }
  /**
   * Bot traps (Oracle's "honeypot" input): a field people never see, so only a robot fills it, and filling it
   * gets the application thrown out. Caught by name, or by being off-screen, transparent or hidden from screen readers.
   */
  const isTrap = (el: HTMLElement): boolean => {
    const id = `${el.getAttribute('name') || ''} ${el.id} ${el.className} ${el.getAttribute('aria-label') || ''}`
    if (/honey.?pot|bot.?trap|\bhp[_-]|leave (this )?(blank|empty)|do not fill/i.test(id)) return true
    // Custom radios, checkboxes, file pickers and dropdowns are often transparent on purpose; only text boxes are judged by layout.
    const t = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'INPUT' ? ((el as HTMLInputElement).type || 'text') : ''
    if (!['text', 'email', 'tel', 'url', 'number', 'search', 'textarea'].includes(t)) return false
    // Hidden from screen readers right at the box (a trap); a whole page hidden behind a busy layer or dialog is not.
    for (let a: Element | null = el, k = 0; a && k < 4; a = a.parentElement, k++) if (a.getAttribute('aria-hidden') === 'true') return true
    // Parked off the page itself (left: -9999px). Measured on the whole page, not the window: a field the page has
    // scrolled past sits above the window but is no trap.
    const r = el.getBoundingClientRect()
    const x = r.left + window.scrollX, y = r.top + window.scrollY
    if (x + r.width < -100 || y + r.height < -100 || x < -2000 || y < -2000) return true
    return hiddenByAncestor(el)
  }
  const hasControl = (el: Element): boolean => !!el.querySelector('input:not([type=hidden]), select, textarea, button[aria-haspopup]')
  /** A label styled as required by class alone, with the star drawn by CSS (Ashby: "_required_f7cvd_91"). */
  const reqClass = (e: Element | null | undefined): boolean => !!e && typeof e.className === 'string' && /(^|[\s_])required(?![a-z])/i.test(e.className)
  const ownLabel = (el: HTMLElement): { text: string; star: boolean } => {
    const raw = (t: string | null | undefined, from?: Element | null) => ({ text: clean(t), star: /[*✱∗]/.test(t || '') || reqClass(from) })
    const id = el.getAttribute('id')
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l && clean(l.textContent)) return raw(l.textContent, l) }
    const lb = el.getAttribute('aria-labelledby')
    if (lb) { const t = lb.split(/\s+/).map(i => document.getElementById(i)?.textContent || '').join(' '); if (clean(t)) return raw(t) }
    const wrap = el.closest('label'); if (wrap && clean(wrap.textContent)) return raw(wrap.textContent, wrap)
    if (clean(el.getAttribute('aria-label'))) return raw(el.getAttribute('aria-label'))
    return { text: '', star: false }
  }
  /** Text that sits before `el` inside an ancestor and is not itself a control or an option label. */
  const textBefore = (el: HTMLElement, skip: Set<Element>): { text: string; star: boolean } => {
    let p: HTMLElement | null = el.parentElement
    for (let depth = 0; depth < 7 && p && p !== document.body; depth++, p = p.parentElement) {
      const cands = Array.from(p.querySelectorAll<HTMLElement>('legend, label, h1, h2, h3, h4, h5, h6, p, span, div'))
        // Hidden text (the label of Oracle's invisible "honeypot" box) is never the question a visible field asks.
        .filter(c => (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !c.contains(el) && !hasControl(c) && visible(c) && !hiddenByAncestor(c) &&
          !Array.from(skip).some(s => s.contains(c)) && clean(c.textContent).length >= 2 && clean(c.textContent).length < 500)
      if (cands.length) { const c = cands[cands.length - 1]; return { text: clean(c.textContent), star: /[*✱∗]/.test(c.textContent || '') || (c.tagName === 'LABEL' && reqClass(c)) } }
    }
    return { text: '', star: false }
  }
  const placeholderOnly = (t: string): boolean => !t.replace(/\b(select one|select|choose one|choose|search|required|optional)\b/gi, '').replace(/[^\p{L}\p{N}]/gu, '')
  const labelFor = (el: HTMLElement): { text: string; star: boolean } => {
    const own = ownLabel(el); if (own.text && !placeholderOnly(own.text)) return own
    const before = textBefore(el, new Set()); if (before.text) return before
    return { text: clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name')) || '', star: false }
  }
  const groupQuestion = (first: HTMLElement, optionEls: Element[]): { text: string; star: boolean } => {
    // The group's own label first: a fieldset can be a whole section ("Additional Questions") holding many questions.
    const g = first.closest('[role="radiogroup"], [role="group"]') as HTMLElement | null
    if (g) { const o = ownLabel(g); if (o.text) return o }
    const fs = first.closest('fieldset'); const lg = fs?.querySelector('legend')
    const name = (first as HTMLInputElement).name
    const onlyThis = !!fs && Array.from(fs.querySelectorAll<HTMLInputElement>('input:not([type=hidden]), select, textarea')).every(x => (name && x.name === name) || x === first)
    if (lg && clean(lg.textContent) && onlyThis) return { text: clean(lg.textContent), star: /[*✱∗]/.test(lg.textContent || '') }
    const before = textBefore(first, new Set(optionEls))
    if (before.text) return before
    return lg && clean(lg.textContent) ? { text: clean(lg.textContent), star: /[*✱∗]/.test(lg.textContent || '') } : before
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
    const sib = clean((el.nextElementSibling || el.parentElement?.nextElementSibling)?.textContent)
    if (sib) return sib
    const ff = el.closest('[data-automation-id^="formField"]')
    if (ff && clean(ff.textContent)) return clean(ff.textContent)
    const v = el.value && el.value !== 'on' ? el.value : ''
    return v || clean(el.getAttribute('aria-label')) || (el.id || el.name || '').replace(/^.*--/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
  }
  const optVisible = (el: HTMLInputElement): boolean => {
    if (visible(el)) return true
    const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label') || el.parentElement
    return visible(l)
  }
  /** The site's error message shown at a field: by aria-errormessage / aria-describedby, or an error box in the field's own wrapper. */
  const errorAt = (el: Element): string => {
    const ids = `${el.getAttribute('aria-errormessage') || ''} ${el.getAttribute('aria-describedby') || ''}`.split(/\s+/).filter(Boolean)
    for (const id of ids) {
      const e = document.getElementById(id)
      if (e && visible(e) && (/error|invalid|alert/i.test(`${e.className} ${e.id} ${e.getAttribute('role') || ''}`) || el.getAttribute('aria-invalid') === 'true') && clean(e.textContent)) return clean(e.textContent).slice(0, 160)
    }
    let w: HTMLElement | null = el.parentElement
    for (let i = 0; i < 5 && w && w !== document.body; i++, w = w.parentElement) {
      // Stop at a wrapper that also holds another question's control (a radio's own group mates do not count).
      const nm = el.getAttribute('name')
      const others = Array.from(w.querySelectorAll('input:not([type=hidden]), select, textarea, button[aria-haspopup="listbox"], [role="radio"], [role="checkbox"]'))
        .filter(o => o !== el && !(nm && o.getAttribute('name') === nm) && !(el.closest('[role="radiogroup"]') && el.closest('[role="radiogroup"]') === o.closest('[role="radiogroup"]')))
      if (others.length) break
      const box = Array.from(w.querySelectorAll<HTMLElement>('[class*="error" i], [class*="invalid" i], [role="alert"]'))
        .find(b => b !== el && !b.contains(el) && visible(b) && !b.querySelector('input, select, textarea') && clean(b.textContent).length > 2 && clean(b.textContent).length < 200)
      if (box) return clean(box.textContent)
    }
    return ''
  }
  /** For a field labelled only "Make Selection Here" / "Select one": the question written above it. */
  const GENERIC = /^(make (a |your )?selection( here)?|select( one| an option)?|please (select|choose)( one| an option)?|choose( one| an option)?|answer|response|your (answer|response)|yes ?\/ ?no)$/i
  const askedAbove = (el: Element): string => {
    // Walk back from the field to the previous form control, gathering the text written in between.
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    w.currentNode = el
    const texts: string[] = []
    for (let n = w.previousNode(), k = 0; n && k < 400 && texts.length < 25; n = w.previousNode(), k++) {
      if (n.nodeType === 1) {
        const e = n as Element
        if (e.matches('input:not([type=hidden]), select, textarea, [role="radio"], [role="combobox"], button[aria-haspopup="listbox"]') && !e.contains(el)) break
        continue
      }
      const t = clean(n.textContent); if (t.length > 3 && n.parentElement && visible(n.parentElement) && !n.parentElement.closest('label')?.contains(el)) texts.unshift(t)
    }
    const own = clean(el.getAttribute('aria-label'))
    const kept = texts.filter(t => t !== own && !GENERIC.test(t))
    const qi = kept.map(t => /\?\s*$/.test(t)).lastIndexOf(true)
    // The question and the choices listed under it; or, with no "?", the text right above the field.
    return (qi >= 0 ? kept.slice(qi) : kept.slice(-3)).join(' • ').slice(0, 600)
  }
  let idx = startIdx
  const push = (f: Omit<Field, 'idx'>, els: Element[]): void => {
    const e0 = els[0]
    if (e0) {
      const err = errorAt(e0); if (err) f.error = err
      if (GENERIC.test(f.label.trim()) && !f.question) { const q = askedAbove(e0); if (q) f.question = q }
    }
    els.forEach((e, k) => { e.setAttribute('data-ih-idx', String(idx)); if (els.length > 1 || f.kind === 'radio' || f.kind === 'checkboxes') e.setAttribute('data-ih-opt', String(k)) })
    out.push({ idx, ...f }); idx++
  }
  const groupsDone = new Set<string>()
  // Debug aid: why each box was passed over (read with window.__ihSkips).
  const skips: Record<string, string> = {}
  const skip = (why: string, el: Element): void => { const k = (el.getAttribute('name') || el.id || el.tagName).slice(0, 40); skips[k] = why }
  ;(window as unknown as { __ihSkips: unknown }).__ihSkips = skips
  const all = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select'))
  for (const el of all) {
    const input = el as HTMLInputElement
    const type = (el.tagName === 'INPUT' ? input.type || 'text' : el.tagName.toLowerCase()).toLowerCase()
    // Sliders and colour pickers (a video player's seek and volume bars) are never application questions.
    if (['hidden', 'submit', 'button', 'image', 'reset', 'password', 'range', 'color'].includes(type) || input.disabled || el.closest('[data-plyr], .plyr, video, audio')) { skip('type/disabled', el); continue }
    if (isTrap(el)) { skip('trap', el); continue }
    // Cookie banners (OneTrust and the like) are not part of the application.
    if (el.closest('#onetrust-consent-sdk, #onetrust-pc-sdk, [id*="cookie" i][role="dialog"], [class*="cookie-consent" i], [id^="CybotCookiebot"], .truste_box_overlay')) { skip('cookie', el); continue }
    // The site's own job search (header search bar, "Search for jobs" / "Location" boxes) is not part of the application.
    if ((type === 'search' && el.getAttribute('role') !== 'combobox') || el.closest('header, nav, [role="search"], [role="banner"], [role="navigation"], form[action*="search" i]') ||
      /search (for )?jobs|job search|title or keyword|search by keyword/i.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`)) { skip('search', el); continue }
    const section = sectionOf(el)
    if (type === 'radio' || type === 'checkbox') {
      if (!optVisible(input)) continue
      // Ashby's Yes/No question keeps a hidden checkbox beside its two buttons; the buttons are read below instead.
      if (type === 'checkbox' && el.closest('div[class*="yesno" i]')?.querySelector('button')) { skip('yes/no buttons', el); continue }
      const container = input.closest('fieldset, [role="radiogroup"], [role="group"]')
      let group: HTMLInputElement[] = []
      // Same name = one question, but only inside one container: repeated blocks (Workday's "I currently work here"
      // in each Work Experience) reuse names and are separate questions.
      const sameBox = (x: Element): boolean => !container || container.contains(x)
      if (input.name) group = all.filter(x => (x as HTMLInputElement).type === type && (x as HTMLInputElement).name === input.name && sameBox(x) && optVisible(x as HTMLInputElement)) as HTMLInputElement[]
      if (group.length <= 1 && container) group = Array.from(container.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)).filter(optVisible)
      if (type === 'checkbox' && group.length > 1 && new Set(group.map(optLabel)).size === 1) group = [input]
      if (group.length === 0) group = [input]
      // Keyed by the group's first box: Ashby names each box of one question differently, which must not make each its own question.
      const gkey = type + ':' + (group[0].name || '') + ':' + all.indexOf(group[0])
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
        push({ kind: 'checkbox', inputType: type, label: labels[0], question: q.text !== labels[0] ? q.text : '', section, name: `${input.name} ${input.id}`.trim(), required: req,
          value: input.checked ? 'checked' : '', options: [], maxLength: 0, multi: false }, group)
      }
      continue
    }
    if (type === 'file') {
      // SuccessFactors' "Select a source for your file upload" dialog: its input belongs to whichever upload box
      // opened it, so it is handled by attachSuccessFactorsFiles, never as a field of its own.
      if (el.classList.contains('fileUpload') && document.querySelector('.attachmentField')) continue
      const l = labelFor(el)
      push({ kind: 'file', inputType: type, label: l.text, question: '', section, name: `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('data-automation-id') || ''}`,
        required: input.required, value: '', options: [], maxLength: 0, multi: false }, [el])
      continue
    }
    // Workday dates: month / day / year boxes that move to the next box as you type. Handled as one field.
    const auto0 = el.getAttribute('data-automation-id') || ''
    if (/^dateSection(Month|Day|Year)-input$/.test(auto0)) {
      const wrap = el.closest('[data-automation-id="dateInputWrapper"]') || el.parentElement?.parentElement?.parentElement
      const parts = Array.from(wrap?.querySelectorAll<HTMLInputElement>('input[data-automation-id^="dateSection"]') || [])
      if (parts[0] !== el) continue
      const fmt = parts.map(x => /Month/.test(x.getAttribute('data-automation-id') || '') ? 'MM' : /Day/.test(x.getAttribute('data-automation-id') || '') ? 'DD' : 'YYYY').join('/')
      const fs = el.closest('fieldset'); const lg = fs ? clean(fs.querySelector('legend')?.textContent) : ''
      const l = lg ? { text: lg, star: /[*✱∗]/.test(fs?.querySelector('legend')?.textContent || '') } : textBefore(el, new Set())
      const vals = parts.map(x => x.value || x.getAttribute('aria-valuenow') || '')
      push({ kind: 'wddate', inputType: 'date ' + fmt, label: l.text || 'Date', question: '', section, name: auto0,
        required: l.star || parts.some(x => x.getAttribute('aria-required') === 'true'), value: vals.every(Boolean) ? vals.join('/') : '', options: [], maxLength: 0, multi: false }, [el])
      continue
    }
    // A read-only box that opens a list (Oracle's select-style dropdowns: an empty box with a caret) is still a dropdown.
    const pickerOnly = input.readOnly && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox')
    if (!visible(el) || (input.readOnly && !pickerOnly)) { skip('invisible/readonly', el); continue }
    // Hidden stand-ins some forms keep beside custom dropdowns for their own validation (Greenhouse, react-select).
    if (el.getAttribute('aria-hidden') === 'true' || Number(getComputedStyle(el).opacity) === 0 || (el.tabIndex < 0 && !['combobox', 'spinbutton'].includes(el.getAttribute('role') || ''))) { skip('aria-hidden/opacity/tabindex', el); continue }
    const l = labelFor(el)
    const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('data-automation-id') || ''}`.trim()
    // Oracle Cloud marks some required rows (a month/year "Start Date *") only by its label's class.
    const required = input.required || el.getAttribute('aria-required') === 'true' || l.star || !!el.closest('.input-row')?.querySelector(':scope > form-element-label label.input-row__label--required, :scope > label.input-row__label--required')
    const isCombo = el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete') || el.getAttribute('data-uxi-widget-type') === 'selectinput'
    // A date box that opens a calendar (react-datepicker and similar, e.g. Eightfold): typed like a date.
    if (el.tagName === 'INPUT' && el.getAttribute('aria-haspopup') === 'dialog' && (/date/i.test(`${l.text} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${name}`))) {
      const ph = el.getAttribute('placeholder') || ''
      const fmt = /^(dd|DD)[/.-]/.test(ph) ? 'DD/MM/YYYY' : /^(yyyy|YYYY)-/.test(ph) ? 'YYYY-MM-DD' : 'MM/DD/YYYY'
      push({ kind: 'wddate', inputType: 'date ' + fmt, label: l.text || 'Date', question: '', section, name: 'pickdate ' + name, required,
        value: input.value || '', options: [], maxLength: 0, multi: false }, [el])
      continue
    }
    if (isCombo && el.tagName === 'INPUT') {
      // A searchable picker. Its chosen value usually shows in a sibling ("pill" or single-value element).
      let shown = ''
      let p: HTMLElement | null = el.parentElement
      for (let i = 0; i < 8 && p && !shown; i++, p = p.parentElement) {
        if (p.querySelectorAll('input:not([type=hidden]), textarea, select').length > 1) break   // reached another field
        // (Oracle Cloud's multi-select keeps its choices as pills, cx-multi-select-pill__value-text.)
        const picked = Array.from(p.querySelectorAll('[data-automation-id="selectedItem"], [class*="singleValue" i], [class*="multiValue" i], [class*="single-value" i], .cx-multi-select-pill__value-text')).map(x => clean(x.textContent)).filter(Boolean)
        if (picked.length) shown = picked.join('; ')
      }
      // Other pickers (SuccessFactors) keep the chosen text in the box itself; its placeholder entry counts as empty.
      // Not Oracle's multi-select: its box holds only search text, never a choice.
      if (!shown && input.value && !el.classList.contains('cx-multi-select-input') && !/^(no selection|none selected|select( one)?|please select.*)$/i.test(input.value.trim())) shown = clean(input.value)
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
    // A small group around this box (e.g. "From" around month + year) tells which value it is.
    let grp = el.closest('fieldset, [role="group"]') as HTMLElement | null
    if (grp && grp.querySelectorAll('input, select, textarea').length > 3) grp = null
    const gq = grp ? ((grp.tagName === 'FIELDSET' && clean(grp.querySelector('legend')?.textContent)) || ownLabel(grp).text) : ''
    push({ kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', inputType: type, label: l.text,
      question: gq && gq !== l.text && gq.length < 200 ? gq : '', section, name, required,
      value: input.value || '', options: [], maxLength: input.maxLength > 0 ? input.maxLength : 0, multi: false }, [el])
  }
  // Workday (and some others) draw dropdowns as buttons that open a list.
  // SAP UI5 date pickers (SuccessFactors): the typing box sits inside the component's shadow DOM, out of reach of
  // the input scan above. The component itself carries the label, the format and whether it is required.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('ui5-date-picker, ui5-date-picker-xweb-calendar-widget, ui5-daterange-picker'))) {
    if (!visible(el)) continue
    const pattern = el.getAttribute('format-pattern') || 'MM/dd/yyyy'
    // Only plain numeric patterns are typed; others (e.g. "MMM d, y") are left to the user.
    if (!/^(MM|dd|yyyy)([/.-](MM|dd|yyyy)){2}$/.test(pattern)) continue
    const fmt = pattern.replace(/yyyy/, 'YYYY').replace(/dd/, 'DD')
    const field = el.closest('.RCMFormField, .rcmFormElement, [class*="FormField"]')
    const lab = field?.querySelector('label')
    const text = clean(lab?.textContent) || el.getAttribute('accessible-name') || el.getAttribute('title') || 'Date'
    push({ kind: 'wddate', inputType: 'date ' + fmt, label: text.replace(/^\*\s*/, ''), question: '', section: sectionOf(el), name: 'ui5date',
      required: el.hasAttribute('required') || !!lab?.querySelector('.requiredField'), value: el.getAttribute('value') || '', options: [], maxLength: 0, multi: false }, [el])
  }
  // Radio buttons drawn without <input> (SuccessFactors' Yes/No questions): role="radiogroup" holding role="radio".
  for (const g of Array.from(document.querySelectorAll<HTMLElement>('[role="radiogroup"]'))) {
    if (!visible(g) || g.querySelector('input[type="radio"]')) continue
    const radios = Array.from(g.querySelectorAll<HTMLElement>('[role="radio"]')).filter(r => visible(r) || visible(r.parentElement))
    if (radios.length < 2) continue
    const names = radios.map(r => {
      const lb = r.getAttribute('aria-labelledby')
      const t = lb ? lb.split(/\s+/).map(i => document.getElementById(i)?.textContent || '').join(' ') : ''
      return clean(t) || clean(r.getAttribute('aria-label')) || clean(r.textContent) || clean(r.parentElement?.textContent)
    })
    const q = ownLabel(g).text ? ownLabel(g) : textBefore(radios[0], new Set(radios))
    const picked = radios.findIndex(r => r.getAttribute('aria-checked') === 'true')
    push({ kind: 'radio', inputType: 'radio', label: q.text || names.join(' / '), question: '', section: sectionOf(g), name: g.id || '',
      // Oracle Cloud's Yes/No pills: "required" is only the class of the row's label (its star is drawn by CSS).
      required: q.star || g.getAttribute('aria-required') === 'true' || !!g.closest('.input-row')?.querySelector('label.input-row__label--required'),
      value: picked >= 0 ? names[picked] : '', options: names, maxLength: 0, multi: false }, radios)
  }
  // Yes/No questions drawn as two toggle buttons (Ashby): the pressed one carries aria-pressed="true".
  for (const g of Array.from(document.querySelectorAll<HTMLElement>('div[class*="yesno" i]'))) {
    if (!visible(g) || g.parentElement?.closest('div[class*="yesno" i]')) continue
    const btns = Array.from(g.querySelectorAll<HTMLElement>('button')).filter(visible)
    if (btns.length < 2) continue
    const names = btns.map(b => clean(b.textContent))
    const q = textBefore(g, new Set(btns))
    const box = g.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const lab = g.closest('.ashby-application-form-field-entry, fieldset')?.querySelector('label')
    const picked = btns.findIndex(b => b.getAttribute('aria-pressed') === 'true')
    push({ kind: 'radio', inputType: 'radio', label: q.text || names.join(' / '), question: '', section: sectionOf(g), name: box?.name || '',
      required: q.star || reqClass(lab) || !!box?.required, value: picked >= 0 ? names[picked] : '', options: names, maxLength: 0, multi: false }, btns)
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]'))) {
    if (!visible(el) || (el as HTMLButtonElement).disabled) continue
    const cur = clean(el.textContent)
    const forLab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null
    const legend = el.closest('fieldset')?.querySelector('legend')
    const own = ownLabel(el)
    const l = forLab && clean(forLab.textContent) ? { text: clean(forLab.textContent), star: /[*✱∗]/.test(forLab.textContent || '') }
      : legend && clean(legend.textContent) ? { text: clean(legend.textContent), star: /[*✱∗]/.test(legend.textContent || '') }
      : own.text && !own.text.includes(cur) && !placeholderOnly(own.text) ? own : textBefore(el, new Set([el]))
    push({ kind: 'dropdown', inputType: 'dropdown', label: l.text, question: '', section: sectionOf(el), name: el.getAttribute('id') || '',
      required: el.getAttribute('aria-required') === 'true' || l.star, value: /^select one$|^select$|^choose/i.test(cur) ? '' : cur, options: [], maxLength: 0, multi: false }, [el])
  }
  return out
}

/** Options of an open list. Workday also marks the chips of already-chosen items as options; those are left out. */
const OPT = '[role="option"]:not([role="listbox"][aria-label*="selected" i] [role="option"]):not([data-automation-id="selectedItem"])'
const visibleOptions = async (frame: Frame): Promise<string[]> =>
  frame.evaluate((sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel))
    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    .map(o => (o.textContent || '').replace(/\s+/g, ' ').trim()).filter(t => t && !/^(select one|select|choose one|--+)$/i.test(t)).slice(0, 300), OPT).catch(() => [])

/** Opens a custom dropdown or picker just long enough to read its choices. */
async function closeLists(frame: Frame): Promise<void> {
  const open = async () => (await frame.locator(OPT + ':visible').count().catch(() => 0)) > 0
  if (!(await open())) return
  await frame.page().keyboard.press('Escape').catch(() => {})
  await frame.page().waitForTimeout(250)
  if (!(await open())) return
  // Workday's search lists ignore Escape: move focus away and click an empty spot at the page's edge.
  await frame.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {})
  await frame.page().mouse.click(4, 400).catch(() => {})
  await frame.page().waitForTimeout(300)
}

async function readOptions(frame: Frame, f: Field): Promise<void> {
  const loc = frame.locator(`[data-ih-idx="${f.idx}"]`).first()
  await closeLists(frame)
  try {
    await loc.click({ timeout: 2500 })
    // The list this box opens (aria-controls / aria-owns), so a list left open by another box is never read for it.
    const own = await loc.evaluate((e: Element) => (e.getAttribute('aria-controls') || e.getAttribute('aria-owns') || '').split(/\s+/)[0] || '').catch(() => '')
    const mine = own ? frame.locator(`[id="${own}"]`) : null
    if (mine) await mine.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
    else await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
    // Some pickers open their list only on the arrow key or typing, not on a click (Ashby's "Start typing..." boxes).
    if (f.kind === 'combobox' && !(await frame.locator(OPT + ':visible').count().catch(() => 0))) {
      await loc.press('ArrowDown').catch(() => {})
      await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
    }
    const scoped = mine ? await mine.locator('[role="option"]').evaluateAll(els => els.filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .map(o => (o.textContent || '').replace(/\s+/g, ' ').trim()).filter(t => t && !/^(select one|select|choose one|--+)$/i.test(t)).slice(0, 300)).catch(() => [] as string[]) : []
    f.options = scoped.length ? scoped : await visibleOptions(frame)
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
  // Placeholder entries ("No Selection", "Select one") are never a match: "No" must not pick "No Selection".
  const n = options.map(o => (PLACEHOLDER.test(o.trim()) ? '' : norm(o)))
  let i = n.indexOf(w); if (i >= 0) return i
  i = n.findIndex(o => o.startsWith(w + ' ') || w.startsWith(o + ' ')); if (i >= 0) return i
  // One word that differs only by its ending: "Citizenship" picks "Citizen".
  if (!w.includes(' ') && w.length >= 5) { i = n.findIndex(o => !o.includes(' ') && o.length >= 5 && (w.startsWith(o) || o.startsWith(w)) && Math.abs(o.length - w.length) <= 4); if (i >= 0) return i }
  i = n.findIndex(o => (` ${o} `).includes(` ${w} `)); if (i >= 0) return i
  if (w.length > 3) { i = n.findIndex(o => o.length > 3 && (` ${w} `).includes(` ${o} `)); if (i >= 0) return i }
  // Last resort: most shared words. Words that every option in a list tends to share ("engineering", "science")
  // do not count, so "Mechanical Engineering" can never settle for "Aerospace Engineering".
  const all = w.split(' ')
  const key = all.filter(t => !GENERIC.has(t))
  const ww = new Set(key.length ? key : all)
  let best = -1, score = 0
  n.forEach((o, k) => { const s = o.split(' ').filter(t => ww.has(t)).length / Math.max(ww.size, 1); if (s > score) { score = s; best = k } })
  return score >= (key.length ? 0.5 : 1) ? best : -1
}
const PLACEHOLDER = /^(no selection|none selected|select|select one|select an option|select\.\.\.|please select.*|choose( one| an option)?\.*|-+|—+)$/i
const GENERIC = new Set(['engineering', 'engineer', 'science', 'sciences', 'studies', 'technology', 'management', 'degree', 'of', 'in', 'and', 'the', 'a', 'for', 'to', 'or', 'general', 'other', 'applied'])

/** Types like a person (focus, select all, keystrokes, blur) so React-based forms such as Workday register it. */
async function typeInto(loc: Locator, value: string, keystrokes: boolean): Promise<void> {
  if (!keystrokes) {
    await loc.fill(value, { timeout: 8000 })
    // Leaving the box makes forms that check on blur (Eightfold) clear their "cannot be left blank" message.
    if ((await loc.inputValue().catch(() => value)) === value) { await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {}); return }
  }
  // Workday date boxes sit under a display layer that takes the click; focusing directly works there.
  await loc.click({ timeout: 3000 }).catch(() => loc.focus())
  await loc.press('ControlOrMeta+a')
  await loc.press('Backspace')
  if (value.length <= 400) await loc.pressSequentially(value, { delay: 6 })
  else { await loc.fill(value); await loc.press('End'); await loc.pressSequentially(' '); await loc.press('Backspace') }
  await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
}

type Chooser = (options: string[]) => number
async function clickOption(frame: Frame, want: string, choose?: Chooser): Promise<string | null> {
  const opts = await visibleOptions(frame)
  const i = choose ? choose(opts) : bestOption(opts, want)
  if (i < 0) return null
  // The whole text must match: "Electro-Mechanical Engineering" contains "Mechanical Engineering" too.
  const exact = new RegExp(`^\\s*${opts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\s*$`, 'i')
  let loc = frame.locator(OPT).filter({ hasText: exact })
  if (!(await loc.count().catch(() => 0))) loc = frame.locator(OPT).filter({ hasText: opts[i] })
  const n = await loc.count()
  for (let k = 0; k < n; k++) {
    const o = loc.nth(k)
    if (await o.isVisible().catch(() => false)) {
      // Already ticked (Workday's search selects a single match on Enter): clicking would untick it.
      if (await o.locator('[data-automation-id="checkbox"][data-automationcheckboxchecked="true"]').count().catch(() => 0)) return opts[i]
      // Workday puts a radio/checkbox inside some options; clicking the option row picks it.
      // A normal click first; if something covers the option (Workday's chosen-items list), send the press
      // straight to the option element, which Workday accepts, rather than clicking whatever is on top.
      const ok = await o.click({ timeout: 2000 }).then(() => true).catch(() => false) ||
        await o.evaluate((el: HTMLElement) => {
          const t = (el.querySelector('[data-automation-id="promptOption"]') as HTMLElement) || el
          const r = t.getBoundingClientRect(); const at = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, at) : new MouseEvent(type, at))
          return true
        }).catch(() => false)
      if (ok) return opts[i]
    }
  }
  return null
}

/** Empties a picker's search text. Never presses Backspace on an empty box: Workday deletes the last chosen item. */
async function clearSearch(loc: Locator): Promise<void> {
  if (!(await loc.inputValue().catch(() => ''))) return
  await loc.press('ControlOrMeta+a').catch(() => {})
  await loc.press('Backspace').catch(() => {})
}

async function pickInCombobox(frame: Frame, loc: Locator, value: string, workday: boolean, choose?: Chooser): Promise<string | null> {
  await closeLists(frame)
  // With items already chosen, Workday's list of them covers the search box: focus it rather than click through.
  if ((await frame.locator('[data-automation-id="selectedItem"]').count().catch(() => 0)) > 0) await loc.focus()
  else await loc.click({ timeout: 2500 }).catch(() => loc.focus())
  await clearSearch(loc)
  // Oracle Cloud searches postal codes and cities by their first part: "L6B 1N3, Markham, ON" (an answer copied from
  // its own list) finds nothing, "L6B 1N3" finds it.
  const oracle = isOracleUrl(frame.page().url())
  await loc.pressSequentially(oracle && /^[^,]{2,}, /.test(value) && !choose ? value.split(',')[0] : value, { delay: 25 })
  // Workday searches on Enter. Anywhere else Enter can submit the form, so it is never pressed there.
  if (workday) await loc.press('Enter').catch(() => {})
  await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  // SuccessFactors fetches its list from the server as you type, like Workday: wait for the matching option
  // instead of choosing from whatever is on screen after a fixed pause.
  const slow = workday || /successfactors|sapsf/i.test(frame.page().url())
  // Oracle Cloud shows the matching postal code or city for about a second, then falls back to its full list: the
  // match is clicked the moment it appears.
  if (oracle) for (let i = 0, any = false; i < 40; i++) {
    const now = await visibleOptions(frame)
    any ||= now.length > 0
    if (!any && i >= 14) break   // no list at all after two seconds: this box offers nothing to pick
    if (process.env.IH_AUTOAPPLY_DEBUG && i % 5 === 0) console.log(`[oracle pick] ${value} @${i}: val=${await loc.inputValue().catch(() => '?')} opts=${now.slice(0, 3).join(' | ')} (${now.length})`)
    if ((choose ? choose(now) : bestOption(now, value)) >= 0) break
    await frame.page().waitForTimeout(150)
  }
  else await frame.page().waitForTimeout(slow ? 900 : 300)
  let shown = await settledOptions(frame, value, slow, choose)
  if (workday && choose && choose(shown) < 0) shown = await scrollForOption(frame, choose)
  let picked = await clickOption(frame, value, choose)
  // Workday's search can come back empty for a full phrase ("Mechanical Engineering") yet find it by its key word.
  const keyWords = norm(value).split(' ').filter(t => !GENERIC.has(t) && t.length > 2)
  if (!picked && workday && keyWords.length && keyWords.join(' ') !== norm(value)) {
    await clearSearch(loc)
    await loc.pressSequentially(keyWords[0], { delay: 25 })
    await loc.press('Enter').catch(() => {})
    await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    shown = await settledOptions(frame, value, true, choose)
    if (choose && choose(shown) < 0) shown = await scrollForOption(frame, choose)
    picked = await clickOption(frame, value, choose)
  }
  if (!picked) {
    // Search text did not match an option: clear it and pick from the full list instead.
    await clearSearch(loc)
    await frame.page().keyboard.press('Escape').catch(() => {})
    await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
    await loc.focus().catch(() => {}); await loc.press('ArrowDown').catch(() => {})   // reopen the full list
    await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
    shown = await visibleOptions(frame)
    picked = await clickOption(frame, value, choose)
  }
  if (picked) {
    // Two-level lists (Workday "How did you hear about us?"): a category opens a sub-list.
    await frame.page().waitForTimeout(500)
    const sub = await visibleOptions(frame)
    // Only a list that is entirely new counts as a sub-list. If the same results are still showing (a long
    // field-of-study list, say), nothing more is clicked: picking its first entry would choose the wrong thing.
    const isSubList = sub.length > 0 && !sub.includes(picked) && !sub.some(o => shown.includes(o))
    if (isSubList) { const second = await clickOption(frame, value, choose) || (await frame.locator(OPT + ':visible').first().click().then(() => sub[0]).catch(() => null)); if (second) picked += ' › ' + second }
  }
  if (!picked) { lastSeen = shown.slice(0, 8); await clearSearch(loc) }
  // Escape only closes a list still open. Oracle Cloud's pickers close on the pick, and an Escape after that
  // empties the box again (its Country stayed blank that way).
  if (!picked || (!isOracleUrl(frame.page().url()) && (await frame.locator(OPT + ':visible').count().catch(() => 0)) > 0)) await frame.page().keyboard.press('Escape').catch(() => {})
  // SuccessFactors pickers check their value only when the box is left: without a blur, a "... is required" message
  // from an earlier failed try stays up (and marks the field invalid) even though the pick took.
  if (picked && slow && !workday) {
    await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
    await frame.page().waitForTimeout(300)
    if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[sf pick] ${value} -> ${picked}: title=${await loc.getAttribute('title').catch(() => '?')} invalid=${await loc.getAttribute('aria-invalid').catch(() => '?')}`)
  }
  return picked
}
/**
 * Workday renders a long result list in batches as it is scrolled, so the wanted option can exist but not be on
 * screen yet (KLA lists "Mechanical Engineering" 13th of 26 for that search). Scrolls the open list until the
 * chooser finds it or the list stops growing. Returns the options seen last.
 */
async function scrollForOption(frame: Frame, choose: Chooser): Promise<string[]> {
  let opts = await visibleOptions(frame), still = 0
  for (let k = 0; k < 20 && choose(opts) < 0 && still < 2; k++) {
    await frame.locator('[role="listbox"]:visible').last().evaluate((e: HTMLElement) => {
      // The list itself or its nearest scrolling parent.
      let el: HTMLElement | null = e
      while (el && el.scrollHeight <= el.clientHeight + 2) el = el.parentElement
      if (el) el.scrollTop += Math.max(200, el.clientHeight - 40)
      else (e.querySelector('[role="option"]:last-child') as HTMLElement | null)?.scrollIntoView({ block: 'end' })
    }).catch(() => {})
    await frame.page().waitForTimeout(450)
    const now = await visibleOptions(frame)
    still = now.join('|') === opts.join('|') ? still + 1 : 0
    opts = now
  }
  return opts
}
/** The options on screen the last time a picker found no match, so the report can say what the list offered. */
let lastSeen: string[] = []

/** Waits for a picker's results to stop changing (Workday loads them after the search), up to about 6 seconds. */
async function settledOptions(frame: Frame, want: string, workday: boolean, choose?: Chooser): Promise<string[]> {
  let prev = await visibleOptions(frame)
  if (!workday) return prev
  for (let i = 0; i < 14; i++) {
    if ((choose ? choose(prev) : bestOption(prev, want)) >= 0) return prev
    await frame.page().waitForTimeout(400)
    const now = await visibleOptions(frame)
    if (i >= 4 && now.length && now.join('|') === prev.join('|')) return now
    prev = now
  }
  return prev
}

// ---------------------------------------------------------------------------------------------
// Deciding answers

type Rule = [RegExp, (p: Profile, job: Job) => string]
/** The job's country, and the candidate's work authorization and sponsorship answers for that country. */
export function eligibilityFor(job: Job, p: Profile): { country: string; authorized: string; sponsorship: string } {
  if (job.region === 'usa') return { country: 'United States', authorized: p.workAuthUsa, sponsorship: p.sponsorshipUsa }
  if (job.region === 'uk') return { country: 'United Kingdom', authorized: p.workAuthUk, sponsorship: p.sponsorshipUk }
  if (job.region === 'ontario' || job.region === 'canada') return { country: 'Canada', authorized: p.workAuthCanada, sponsorship: p.needsSponsorship }
  // Anywhere else the candidate holds no work right and needs a visa. A job whose place is unknown keeps the Canadian answers.
  const town = `${job.location} ${job.title}`
  const country = /italy|maranello|faenza/i.test(town) ? 'Italy' : /switzerland|hinwil/i.test(town) ? 'Switzerland' : /france|ch[aâ]tillon/i.test(town) ? 'France' : regionOf(job.location) === 'other' ? job.location : ''
  if (!country) return { country: 'Canada', authorized: p.workAuthCanada, sponsorship: p.needsSponsorship }
  return { country, authorized: 'No', sponsorship: 'Yes' }
}
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
  [/sponsor/i, (p, j) => eligibilityFor(j, p).sponsorship],
  [/authori[sz]ed|legally (able|entitled|permitted)|eligible to work|right to work|work permit/i, (p, j) => eligibilityFor(j, p).authorized],
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
/**
 * Picks the option naming the candidate's major: it must contain the major's key words ("mechanical"), and an exact
 * name beats "Engineering, Mechanical", which beats "... Technology" or "... Technician". Nothing else is ever chosen.
 */
// Degree words that may sit around a discipline's name without changing it ("Bachelor of Mechanical Engineering (BEng)").
const DEGREE_WORDS = new Set(['bachelor', 'bachelors', 's', 'b', 'ba', 'bs', 'bsc', 'basc', 'beng', 'bse', 'master', 'masters', 'ms', 'msc', 'meng', 'honours', 'honors', 'hons', 'major', 'program', 'programme', 'undergraduate'])
/** The words that name the discipline itself: "Electro-Mechanical Engineering" gives electro + mechanical. */
const disciplineWords = (s: string): string[] => norm(s).split(' ').filter(t => t && !GENERIC.has(t) && !DEGREE_WORDS.has(t))
/** True when an option names exactly the major, and not a neighbouring discipline that shares a word with it. */
const sameDiscipline = (option: string, major: string): boolean => {
  const a = disciplineWords(option), b = disciplineWords(major)
  // "Mechanical Engineering Technology" is a technician program, not the degree (unless that is the major).
  if (/technolog|technician/i.test(option) && !/technolog|technician/i.test(major)) return false
  return !!b.length && a.length === b.length && b.every(k => a.includes(k))
}
/**
 * Picks the major from a list. Strict: only the exact discipline ("Mechanical Engineering", "Engineering,
 * Mechanical"). Loose (the last resort): any option naming it, preferring the closest.
 */
function studyChooser(major: string, strict = false): Chooser {
  const want = norm(major)
  const key = want.split(' ').filter(t => !GENERIC.has(t))
  return options => {
    const n = options.map(o => (PLACEHOLDER.test(o.trim()) ? '' : norm(o)))
    if (!key.length) return bestOption(options, major)
    if (strict) {
      let best = -1
      n.forEach((o, i) => { if (o && sameDiscipline(o, major) && (best < 0 || o.length < n[best].length)) best = i })
      return best
    }
    const rank = (o: string): number => {
      if (o === want || o === `engineering ${key.join(' ')}`) return 0
      if (/technolog|technician/.test(o)) return 4
      // A neighbouring discipline that shares the word ("electro mechanical") is a worse fit than the plain one.
      const extra = disciplineWords(o).length - key.length
      return (/engineering/.test(o) ? 1 : 2) + (extra > 0 ? 1 : 0)
    }
    let best = -1
    n.forEach((o, i) => {
      if (!o || !key.every(k => ` ${o} `.includes(` ${k} `))) return
      if (best < 0 || rank(o) < rank(n[best]) || (rank(o) === rank(n[best]) && o.length < n[best].length)) best = i
    })
    return best
  }
}
/** The ways a major is searched for, in order: as written, "Engineering, Mechanical", then the key word alone. */
function studyTerms(major: string): string[] {
  const key = norm(major).split(' ').filter(t => !GENERIC.has(t))
  const m = major.trim().match(/^(.+?)\s+engineering$/i)
  return [...new Set([major.trim(), m ? `Engineering, ${m[1]}` : '', key.map(k => k[0].toUpperCase() + k.slice(1)).join(' ')].filter(Boolean))]
}
const isStudy = (f: Field): boolean => STUDY.test(`${f.label} ${f.question}`) && ['combobox', 'dropdown', 'select', 'radio', 'text'].includes(f.kind) && !/minor|other|if (other|not)|specify/i.test(f.label)
const showsMajor = (value: string, major: string): boolean => { const key = norm(major).split(' ').filter(t => !GENERIC.has(t)); const v = ` ${norm(value)} `; return !!value.trim() && key.every(k => v.includes(` ${k} `)) }

/** Fills a field-of-study field with the profile's major by rule (never by Claude), then reads it back to be sure. */
async function fillStudy(p: Page, x: Located, major: string, workday: boolean, res: PrefillResult): Promise<void> {
  const { frame, f } = x
  const label = short(f)
  const choose = studyChooser(major)
  const loc = frame.locator(`[data-ih-idx="${f.idx}"]`).first()
  if (f.kind === 'text') { await typeInto(loc, major, workday); res.filled.push(`${label}: ${major}`); return }
  if (f.kind === 'combobox') {
    let lastOffered: string[] = []
    // First every search term looking for the exact discipline; only then the closest option. Workday's search can
    // list a neighbour first ("Electro-Mechanical Engineering" for "Mechanical Engineering"), which is not the major.
    for (const strict of [true, false]) {
      for (const term of studyTerms(major)) {
        const got = await pickInCombobox(frame, loc, term, workday, strict ? studyChooser(major, true) : choose).catch(() => null)
        if (!got) { lastOffered = lastSeen; continue }
        await p.waitForTimeout(500)
        const now = (await collectAll(p)).find(y => y.f.idx === f.idx || (y.f.label === f.label && y.f.section === f.section))
        const shown = now?.f.value || got
        const fits = strict ? sameDiscipline(shown, major) || sameDiscipline(got, major) : showsMajor(shown, major) || showsMajor(got, major)
        if (!now || fits) { res.filled.push(`${label}: ${got}${strict ? '' : ` (closest option; this list has no plain "${major}")`}`); return }
        lastOffered = [shown]
        // A wrong pick stays chosen in Workday's picker: remove it before the next search.
        if (workday && now.f.value.trim()) { await loc.focus().catch(() => {}); await clearSearch(loc); await loc.press('Backspace').catch(() => {}); await closeLists(frame) }
      }
    }
    res.skipped.push(`${label} (could not find ${major}${lastOffered.length ? `; the list offered: ${lastOffered.map(o => o.slice(0, 30)).join(', ')}` : ''})`)
    return
  }
  if (f.kind === 'dropdown' && !f.options.length) await readOptions(frame, f)
  const exact = studyChooser(major, true)(f.options)
  const i = exact >= 0 ? exact : choose(f.options)
  if (i < 0) { res.skipped.push(`${label} (no ${major} option; it offered: ${f.options.slice(0, 8).map(o => o.slice(0, 30)).join(', ')})`); return }
  await applyAnswer(x, f.options[i], workday, res)
}

const STUDY = /field of study|\bmajor\b|discipline|area of study|program of study|specialization/i
/** A required tick box that only records agreement (terms, privacy, "I certify", "I have read"): always ticked. */
const CONSENT = /\b(i (have read|agree|accept|consent)|consent|agree|terms (and|&) conditions|terms of (use|service)|privacy (policy|notice|statement)|(information|answers|statements?) (provided |given |above )?(is|are) (true|accurate|correct|complete))/i
/** Statements of fact the AI must judge, even when worded as "I acknowledge / I certify ...". */
const FACTUAL = /\bnot\b|do not|don't|sponsor|visa|authori[sz]|citizen|licen[cs]|certification|degree|clearance|criminal|convict|relocat|age of|years? old|disab|veteran/i
const mustTick = (f: Field): boolean => f.kind === 'checkbox' && f.required && CONSENT.test(`${f.label} ${f.question}`) && !FACTUAL.test(`${f.label} ${f.question}`)
const TRAP = /robots only|for robots|honeypot|captcha/i
const SECRET = /leave (this|it) (field )?(blank|empty)|do not (fill|enter|complete) this|password|social (security|insurance)|\bssn\b|\bsin\b|passport|driver'?s? licen[cs]e number|bank|credit card/i
/**
 * Fields the app never fills: bot traps, and boxes for secrets (passwords, ID and bank numbers). A choice question
 * that only mentions such a thing ("Do you have the legal right to work? (New hires need an SSN)", a consent box
 * whose legal text mentions passwords) is still answered: only typed-in values are held back.
 */
/** Optional sign-ups (newsletters, job alerts, marketing, texts): never ticked for the person. */
const OPT_IN = /newsletter|job alerts?|talent (community|network)|marketing|promotional|news(,)? (and|&) articles|delivered to your inbox|subscribe|sign me up|keep me (informed|updated)|(text|sms) messages|future (job )?opportunit|(e-?mails?|messages|updates|notifications) (about|on|for|of) (new )?(job|jobs|job postings|openings|positions|opportunities)/i
const never = (f: Field): boolean => (['checkbox', 'checkboxes'].includes(f.kind) && !f.required && OPT_IN.test(`${f.label} ${f.question}`)) || TRAP.test(`${f.label} ${f.name}`) || (['text', 'textarea', 'combobox'].includes(f.kind) && SECRET.test(`${f.label} ${f.question} ${f.name}`))

function ruleAnswer(f: Field, profile: Profile, job: Job): string {
  const text = `${f.question} ${f.label}`
  const r = RULES.find(([re]) => re.test(text)) || RULES.find(([re]) => re.test(f.name))
  return r ? r[1](profile, job) : ''
}

interface Answer { id: number; value: string | string[] | boolean; guess?: string }

/** What the candidate chose for voluntary self-identification, for the prompt. Blank means decline. */
function eeoText(p: Profile): string {
  const rows: [string, string | undefined][] = [['Gender', p.eeoGender], ['Hispanic or Latino', p.eeoHispanic], ['Race', p.eeoRace], ['Veteran status', p.eeoVeteran], ['Disability', p.eeoDisability]]
  return rows.map(([k, v]) => `${k}: ${v?.trim() || 'decline to answer'}`).join('; ')
}
const EEO_Q = /\b(gender|sex|race|ethnic\w*|hispanic|latino|veteran|disabilit\w*|sexual orientation|pronouns?)\b/i
/** A required self-identification list the AI left blank: only an option that declines. Never an identity; none means the user is asked. */
const eeoFallback = (options: string[]): string =>
  options.find(o => /(decline|prefer not|do(n'?t| not) wish|choose not|not to (say|answer|disclose|self-identify))/i.test(o)) || ''
/** The candidate's saved answers, newest first, trimmed to keep the prompt small. */
function savedAnswersText(p: Profile): string {
  const list = (p.answers || []).filter(x => x.q?.trim() && x.a?.trim()).slice(-80).reverse()
  return list.length ? list.map(x => `- Q: ${x.q.trim().slice(0, 240)}\n  A: ${x.a.trim().slice(0, 500)}`).join('\n') : '(none yet)'
}

/**
 * Asks the AI for every field's answer. `retry` marks a second look at required fields that are still empty: each
 * id maps to what happened the first time, and the AI is told the form cannot be sent until they are answered.
 */
async function decide(fields: Field[], job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, retry?: Map<number, string>, whys?: Map<number, string>): Promise<Map<number, Answer['value']>> {
  whys?.clear()   // ids are renumbered on every pass
  const today = new Date().toISOString().slice(0, 10)
  const list = fields.map(f => ({
    id: f.idx, type: f.kind === 'combobox' ? (f.multi ? 'searchable multi-select' : 'searchable dropdown') : f.kind === 'dropdown' ? 'dropdown' : f.kind,
    ...(f.inputType && !['text', 'textarea', 'select', 'radio', 'checkbox', 'dropdown', 'combobox'].includes(f.inputType) ? { inputType: f.inputType } : {}),
    label: f.label.slice(0, 1500), ...(f.label.length < 4 && f.name ? { fieldName: f.name.slice(0, 80) } : {}), ...(f.question ? { question: f.question.slice(0, 1500) } : {}), ...(f.section ? { section: f.section } : {}),
    required: f.required, ...(f.options.length ? { options: f.options.slice(0, 250) } : {}), ...(f.maxLength ? { maxLength: f.maxLength } : {}),
    ...(retry?.get(f.idx) ? { firstAttempt: retry.get(f.idx) } : {})
  }))
  const { extra, workAuthCanada, workAuthUsa, workAuthUk, needsSponsorship, sponsorshipUsa, sponsorshipUk, answers: _saved, eeoGender, eeoHispanic, eeoRace, eeoVeteran, eeoDisability, ...facts } = profile
  const elig = eligibilityFor(job, profile)
  const yn = (v: string): string => v || 'not stated'
  const retryNote = retry ? `
IMPORTANT: this is a second look. Every field below is REQUIRED and still empty, so the application cannot be sent until each one has an answer. "firstAttempt" says what was tried before and why it did not stick (for example the value was not one of the options). Give each field the answer least likely to hurt the application, using the rules below. Pick options by their exact text. Leave a field out only if answering it would mean inventing a fact (a government ID, a date of birth, a password). Self-identification: decline, or pick the option that identifies no group.
` : ''
  const prompt = `You are filling in a job application form for the candidate, unattended: nobody is watching, and a required question you leave blank stops the whole application. Work things out from the facts, resume and posting; never stall because an answer is not written down.
${retryNote}
Today is ${today}.

<candidate_facts>
${JSON.stringify(facts, null, 1)}
Work eligibility, by country: Canada: authorized ${yn(workAuthCanada)}, needs sponsorship ${yn(needsSponsorship)}. United States: authorized ${yn(workAuthUsa)}, needs sponsorship ${yn(sponsorshipUsa)}. United Kingdom: authorized ${yn(workAuthUk)}, needs sponsorship ${yn(sponsorshipUk)}. Any other country: authorized No, needs sponsorship Yes.
This job is in ${elig.country}: authorized to work there: ${yn(elig.authorized)}; needs visa sponsorship there: ${yn(elig.sponsorship)}.
Voluntary self-identification chosen by the candidate: ${eeoText(profile)}.
Other facts from the candidate: ${extra || '(none)'}
</candidate_facts>

<saved_answers>
The candidate's own answers to questions from earlier applications. When a field asks the same thing (even in other words), use the saved answer, adapted to the field's options or format. These beat every rule below.
${savedAnswersText(profile)}
</saved_answers>

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
- Principle: when candidate_facts and saved_answers do not settle a question, pick the answer that does not jeopardize the application (what a strong, eligible candidate would answer, or the closest option); mistakes can be fixed with the recruiter later. Match questions by meaning, not wording. Given facts (citizenship, work authorization, sponsorship, self-identification, education) stay truthful and override this; never invent IDs, DOB or passwords.
- For dropdown, radio, select and searchable fields with "options", reply with the exact text of one option. For "checkboxes", reply with an array of the option texts to tick. For a single "checkbox", reply true to tick it or false to leave it.
- For a searchable field without options, reply with the text to search for (e.g. a school name, a skill, a country, a month name).
- Required fields: always answer them. Optional fields: answer when clear; leave out ones that do not apply.
- Work authorization, sponsorship and citizenship come from candidate_facts and must be truthful. Questions about work authorization or sponsorship mean the country the job is in, unless the question names another country. Export-control or "U.S. person" (ITAR/EAR) questions: only a U.S. citizen, U.S. permanent resident (green card holder), refugee or asylee is a U.S. person; answer from the candidate's citizenship.
- Authorized to work "on an indefinite basis", "permanently", or "without sponsorship (now or in the future)": a candidate who needs sponsorship for that country is NOT authorized indefinitely, so answer No, even though the plain "authorized to work" fact is Yes.
- A Canadian citizen's U.S. work authorization comes through citizenship (TN status under USMCA/NAFTA), which the employer still has to support. So for a U.S. job, when the candidate is a Canadian citizen and a question about visa type, sponsorship or work status offers a TN / USMCA / NAFTA / "Canadian citizen" option, pick that option over a generic "I require sponsorship" or "other visa" one.
- Permanent residency ("Do you hold permanent resident / green card / legal permanent resident status in ..."): a citizen of a country is not a permanent resident of it; answer from candidate_facts, and No for any country the candidate is not a citizen or permanent resident of.
- Follow-up and conditional questions ("If yes, ...", "If no, please explain", "If you are not authorized ..., what is your status?", "If other, specify"): read the question they depend on. If the condition does not apply to the candidate, write "N/A" in a text box, or pick the option meaning not applicable / none / No. If it does apply, answer it from the facts.
- History questions whose answer is not in the facts (held a J-1/J-2 or other U.S. visa before, applied or worked here before, relatives at the company or in government, government official, conflict of interest, non-compete, security clearance, convicted of a crime, terminated from a job): answer what is true for an ordinary second-year university student with this resume: No / None / Not applicable.
- Experience questions: use the resume. A research internship, co-op or engineering internship counts as internship / co-op experience; student design teams and projects count as hands-on engineering experience. Years of professional experience: less than 1 (or 0) unless the resume shows more.
- Every identification question (gender, gender identity, transgender, pronouns, sex, race, ethnicity, Hispanic/Latino, Indigenous/Aboriginal, visible minority, member of a designated or equity-seeking group, veteran or military status, disability, sexual orientation / LGBTQ+, religion, age range, marital status and anything similar): use the candidate's self-identification above, and by default do NOT identify. Choose the option that declines ("I don't wish to answer", "Decline to self-identify", "Prefer not to say", "I do not want to answer"). If there is no declining option and the field is optional, leave it out. If it is required and has no declining option, choose the option that does not identify the candidate with any group (e.g. "No" for "Do you identify as a member of a visible minority?"), never a specific identity. Never guess these from a name or anything else.
- Be lenient: tick or say Yes to consent, acknowledgement, privacy, "I certify", "I understand", terms and conditions, text (SMS) message, recruiting-communication and job-alert questions. When unsure whether to agree to something, agree.
- Preferred method of contact: Email.
- AI screening, AI interviews or automated/AI evaluation of the application: answer No (opt out) whenever the form offers the choice.
- "How did you hear about us?": always the company's careers website. Pick the option closest to that ("Careers Website", "Company Website", "Corporate Website", "Career Site"); for a free-text box or a "please specify" box write "Company careers website". Only if no such option exists, pick a job board, then "Other".
- Field of study, major or discipline: always the major in candidate_facts. With options, pick that exact discipline or the option that names it (never a different engineering discipline such as aerospace); if none names it, pick the closest general option (e.g. "Engineering", "Other"). Without options, search for the major's exact name.
- School: the school in candidate_facts. Degree being pursued: the bachelor's degree option ("Bachelor's", "Bachelor of Engineering", "BEng", "BS").
- Education dates: start = when the candidate started university (work it out from the expected graduation and a 4-year program if not given); end / graduation = the expected graduation in candidate_facts. A separate month field gets the month (e.g. "April"), a year field the year (e.g. "2029").
- "Highest level of education completed": the candidate has NOT finished a degree yet; pick high school / secondary (or the closest "some college / currently enrolled" option).
- Year of study / class standing: work it out from the expected graduation (e.g. graduating in 2029 from a 4-year program means second year in the 2026-27 school year: "Sophomore" or "2nd year").
- Never answer with a placeholder option such as "No Selection" or "Select one". If no real option fits an optional question, leave that field out; for a required one pick the closest real option.
- Age ("18 or older?"): Yes.
- Willing to relocate / travel / work on site / commute / work full-time during the internship / work the stated dates or hours: Yes unless the facts say otherwise.
- Which location or office, when the posting lists several: the job's location, else the first listed.
- Internship season, term or start date: from the candidate's availability and term length in candidate_facts and the job title (e.g. "Summer 2027" in the title means Summer 2027). Start date is the candidate's availability unless the posting's own dates are later.
- Phone country code or phone country: the country that matches the candidate's phone number. Phone device type: Mobile.
- Address fields: the address in the facts.
- Links: LinkedIn, GitHub and website come from the facts. A required website / portfolio / "other link" field with no such link in the facts gets the LinkedIn URL. Treat a field as required when its text says so, even without a required mark ("your application will not be considered without ...", "must include", "please provide").
- Fields with type "wddate" are dates: reply in exactly the format in inputType (e.g. "09/2025" for "date MM/YYYY", "11/14/2026" for "date MM/DD/YYYY", "2025" for "date YYYY"). "From"/"To" in a Work Experience or Education section are that entry's start/end dates from the resume; if the resume only gives a year, use 09 for a fall start, 05 for a summer start, 01 otherwise. For a degree in progress the To date is the expected graduation. For a current role give the expected end date only if one is known, otherwise "", and also tick that entry's "I currently work here" box (same section).
- Searchable multi-select of skills: reply with an array of up to 8 skills from the resume.
- Dates: match the format the label or inputType implies (MM, YYYY, MM/YYYY, YYYY-MM-DD). A "date" for a signature or self-identification form is today. A signature or "type your full name" box gets the candidate's full name.
- Fields in sections like "Work Experience 1", "Work Experience 2", "Education 1" map to the resume entries in the order they appear on the resume. "Role Description" or similar: 2 to 4 plain sentences from that entry's bullets.
- Notice period: "2 weeks".
- "Date obtained" next to a citizenship country (e.g. "Country 1 Name" / "Date Obtained 1"): the date for that country from citizenshipDates in candidate_facts (citizenship by birth = the birth date given there). Never guess it: if citizenshipDates does not give it, leave the field empty.
- Lists of countries in a question: check the candidate's actual citizenship against the exact list shown.
- Salary, pay or compensation expectations: if the job states a pay range, give its minimum. Otherwise give a realistic figure for an engineering intern in the job's location (about 25 USD an hour in the United States, about 24 CAD an hour in Canada); a field asking for an annual amount gets the hourly figure times 2080 (for example 52000). Give just the number (for example 25 or 52000), with no currency or words: forms often accept digits only. Only a large free-text box (textarea) may add words, e.g. "25 USD per hour, open to discussion".
- GPA: from the facts, in the scale the field implies (a 4.0-scale field gets "3.85").
- Open questions ("Why do you want...", "Tell us about...", "Describe a project..."): 2 to 5 specific, first-person sentences built from the resume, facts and job. No clichés. Respect maxLength.
- Never invent experience, employers, credentials, grades or numbers. Reply "" only when the answer truly cannot be known (a government ID number, a date of birth, a password) or when an optional field should stay blank (address line 2, middle name, an optional link the candidate does not have).

Reply with JSON only: {"answers": [{"id": 0, "value": "...", "guess": "..."}]} with one entry per field id. Add "guess": "<short reason>" only when you used the principle or inferred something not in the facts, resume or saved answers.`
  const reply = await askJson<{ answers?: Answer[] } | Answer[]>(prompt, { model, timeoutMs: 180_000 })
  if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[decide${retry ? ' retry' : ''}] ${JSON.stringify(list.map(f => ({ id: f.id, type: f.type, label: f.label.slice(0, 60), q: (f as { question?: string }).question?.slice(0, 60), opts: (f as { options?: string[] }).options?.slice(0, 6) })))}\n  => ${JSON.stringify(reply).slice(0, 1500)}`)
  const arr = Array.isArray(reply) ? reply : reply?.answers || []
  const map = new Map<number, Answer['value']>()
  for (const a of arr) if (a && typeof a.id === 'number') { map.set(a.id, a.value); if (whys && typeof a.guess === 'string' && a.guess.trim()) whys.set(a.id, a.guess.trim().slice(0, 200)) }
  return map
}

// ---------------------------------------------------------------------------------------------
// Filling

const blank = (page: string, note = ''): PrefillResult => ({ page, filled: [], skipped: [], drafted: [], note })
const short = (f: Field): string => (f.question || f.label || f.name || '(unlabelled field)').slice(0, 70)
const isEmpty = (f: Field): boolean => f.kind !== 'file' && !f.value.trim()

/** Fields from the last full read of each page, to notice a read taken while the site was busy redrawing. */
const lastCount = new WeakMap<Page, { url: string; n: number }>()
async function collectAll(p: Page): Promise<Located[]> {
  let out = await collectOnce(p)
  const prev = lastCount.get(p)
  const before = prev && prev.url === p.url() ? prev.n : 0
  // Far fewer fields than a moment ago: the site is probably mid-redraw (SuccessFactors' busy layer). Look again.
  for (let k = 0; k < 3 && before >= 8 && out.length < before / 2; k++) { await p.waitForTimeout(1500); out = await collectOnce(p) }
  lastCount.set(p, { url: p.url(), n: out.length })
  return out
}
async function collectOnce(p: Page): Promise<Located[]> {
  const out: Located[] = []
  let offset = 0
  for (const frame of p.frames()) {
    let fields: Field[] = []
    try { fields = await frame.evaluate(collectFields, offset) } catch (e) { if (process.env.IH_AUTOAPPLY_DEBUG && frame === p.mainFrame()) console.log('[collect] main frame failed:', String(e).slice(0, 300)) /* cross-origin or detached frame */ }
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

/** Ticks a box and confirms it stuck; styled boxes often ignore a direct check, so the label or the box is clicked instead. */
async function tick(frame: Frame, box: Locator): Promise<void> {
  if (await box.isChecked().catch(() => false)) return
  await box.check({ force: true, timeout: 2500 }).catch(() => {})
  if (await box.isChecked().catch(() => false)) return
  const id = await box.getAttribute('id').catch(() => null)
  const label = id ? frame.locator(`label[for="${id}"]`).first() : null
  if (label && (await label.isVisible().catch(() => false))) await label.click({ timeout: 2500 }).catch(() => {})
  if (!(await box.isChecked().catch(() => false))) await box.click({ force: true, timeout: 2500 }).catch(() => {})
  if (!(await box.isChecked().catch(() => false))) await acceptConsentDialog(frame)
}
/**
 * Closes a cookie banner, which can sit on top of the form's Next and Submit buttons (Oracle's does). Rejects
 * optional cookies where the banner allows it, and accepts only when that is the sole way to close it.
 */
async function dismissCookies(p: Page): Promise<boolean> {
  // Workday's own cookie bar.
  const wdDecline = p.locator(wd('legalNoticeDeclineButton')).first()
  if (await wdDecline.isVisible().catch(() => false)) { await wdDecline.click({ timeout: 2500 }).catch(() => {}); await p.waitForTimeout(400); return true }
  const scope = ':is([class*="cookie" i], [id*="cookie" i], [id*="onetrust" i], [class*="consent" i], [id*="consent" i], [aria-label*="cookie" i])'
  const btns = p.locator(`${scope} :is(button, [role="button"], a), ${scope}:is(button, a)`).locator('visible=true')
  for (const re of [/^\s*(reject|decline|deny)( all| optional| non-essential)?( cookies)?\s*$/i, /^\s*(accept|allow)( all)?( cookies)?\s*$|^\s*(got it|i understand|ok)\s*$/i]) {
    const b = btns.filter({ hasText: re }).first()
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 2500 }).catch(() => {}); await p.waitForTimeout(500); return true }
  }
  return false
}
/**
 * Some consent boxes (Oracle's "I have read the Important Privacy Information") open the notice in a dialog when
 * ticked, and only become ticked once its Accept button is pressed.
 */
async function acceptConsentDialog(frame: Frame): Promise<void> {
  // A page can hold several dialogs (Oracle keeps four, mostly hidden), so look for a visible Accept inside any of them.
  const accept = frame.locator(':is([role="dialog"], [aria-modal="true"], dialog[open]) :is(button, [role="button"], input[type="button"], input[type="submit"])')
    .locator('visible=true').filter({ hasText: /^\s*(accept|i accept|agree|i agree|ok|confirm|i have read)\s*$/i }).first()
  // The dialog animates in, so give it a moment to appear.
  if (await accept.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await accept.click({ timeout: 2500 }).catch(() => {}); await frame.page().waitForTimeout(600)
  }
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
    case 'wddate': {
      const sep = f.inputType.match(/[/.-]/)?.[0] || '/'
      const fmt = f.inputType.replace(/^date /, '').split(/[/.-]/)
      const got = text.split(/[^0-9]+/).filter(Boolean)
      if (got.length !== fmt.length) { res.skipped.push(`${label} (date "${text}" does not fit ${fmt.join(sep)})`); return }
      const padded = got.map((g, k) => fmt[k] === 'YYYY' ? g.padStart(4, '20') : g.padStart(2, '0'))
      if (f.name.startsWith('pickdate')) {
        // A date box with a calendar pop-up: type the date, close the calendar, check the box kept it.
        const box = loc.first()
        await box.click({ timeout: 3000 }).catch(() => box.focus())
        await box.fill(padded.join(sep)).catch(async () => { await box.press('ControlOrMeta+a'); await frame.page().keyboard.type(padded.join(sep), { delay: 40 }) })
        await box.press('Enter').catch(() => {})
        await frame.page().keyboard.press('Escape').catch(() => {})
        await box.press('Tab').catch(() => {})
        const now = await box.inputValue().catch(() => '')
        if (now) res.filled.push(`${label}: ${now}`); else res.skipped.push(`${label} (the date picker did not take "${padded.join(sep)}")`)
        return
      }
      if (f.name === 'ui5date') {
        // SAP UI5 date picker: type the whole date into the box inside the component, then confirm with Enter.
        const box = loc.first().locator('input').first()
        await box.click({ timeout: 3000 }).catch(() => box.focus())
        await box.fill(padded.join(sep)).catch(async () => { await box.press('ControlOrMeta+a'); await frame.page().keyboard.type(padded.join(sep), { delay: 40 }) })
        await box.press('Enter').catch(() => {})
        await box.press('Tab').catch(() => {})
        const now = await loc.first().getAttribute('value').catch(() => '')
        if (now) res.filled.push(`${label}: ${now}`); else res.skipped.push(`${label} (the date picker did not take "${padded.join(sep)}")`)
        return
      }
      const digits = padded.join('')
      const first = loc.first()
      await first.locator('xpath=preceding-sibling::*[1]').click({ timeout: 2000 }).catch(() => first.focus())
      await first.focus().catch(() => {})
      await frame.page().keyboard.type(digits, { delay: 70 })
      await first.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
      res.filled.push(`${label}: ${got.join('/')}`); return
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
        const id = await opt.getAttribute('id').catch(() => null)
        if (id) await frame.locator(`label[for="${id}"]`).first().click({ timeout: 2500 }).catch(() => {}); else await opt.click({ force: true, timeout: 2500 }).catch(() => {})
      })
      // Styled radios can swallow the first click: check it took, and click the option's text if not.
      const on = async (): Promise<boolean> => opt.evaluate((e: HTMLElement) => (e as HTMLInputElement).checked === true || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-pressed') === 'true').catch(() => false)
      if (!(await on())) {
        const id = await opt.getAttribute('id').catch(() => null)
        const lab = id ? frame.locator(`label[for="${id}"]`).first() : opt.locator('xpath=..')
        await lab.click({ timeout: 2500 }).catch(() => opt.click({ force: true, timeout: 2500 }).catch(() => {}))
        // Last resort: the element's own click handler, for radios drawn too small or off to the side to click.
        if (!(await on())) await opt.evaluate((e: HTMLElement) => e.click()).catch(() => {})
      }
      if (!(await on())) { res.skipped.push(`${label} (clicked "${f.options[i]}" but it did not stay selected)`); return }
      res.filled.push(`${label}: ${f.options[i]}`); return
    }
    case 'checkbox': {
      const want = value === true || /^(true|yes|checked|tick)$/i.test(text)
      if (!want) return
      await tick(frame, loc.first())
      res.filled.push(`Ticked: ${label}`); return
    }
    case 'checkboxes': {
      const wants = Array.isArray(value) ? value.map(String) : text.split(/;|\n/).map(s => s.trim()).filter(Boolean)
      const ticked: string[] = []
      for (const w of wants) {
        const i = bestOption(f.options, w); if (i < 0) continue
        const opt = frame.locator(`[data-ih-idx="${f.idx}"][data-ih-opt="${i}"]`).first()
        await tick(frame, opt)
        ticked.push(f.options[i])
      }
      if (ticked.length) res.filled.push(`${label}: ${ticked.join(', ')}`); else if (f.required) res.skipped.push(`${label} (no choice matched)`)
      return
    }
    case 'dropdown': {
      if (!text.trim() || /^(select one|select|choose one)$/i.test(text.trim())) return
      await closeLists(frame)
      await loc.first().click({ timeout: 2500 })
      await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
      let picked = await clickOption(frame, text)
      const shows = async (): Promise<boolean> => !!picked && (await loc.first().innerText().catch(() => '')).replace(/\s+/g, ' ').includes(picked.slice(0, 40))
      if (picked && !(await frame.page().waitForTimeout(400).then(shows))) {
        await closeLists(frame); await loc.first().click({ timeout: 2500 }).catch(() => {})
        await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => {})
        picked = await clickOption(frame, text)
        if (picked && !(await frame.page().waitForTimeout(400).then(shows))) picked = null
      }
      if (picked) res.filled.push(`${label}: ${picked}`)
      else { await frame.page().keyboard.press('Escape').catch(() => {}); res.skipped.push(`${label} (dropdown: "${text.slice(0, 40)}" is not one of the choices)`) }
      return
    }
    case 'combobox': {
      if (PLACEHOLDER.test(text.trim())) return   // Claude chose to leave it unset
      const items = Array.isArray(value) ? value.map(String) : f.multi ? text.split(/,|;/).map(s => s.trim()).filter(Boolean) : [text]
      const picked: string[] = []
      for (const it of items.filter(i => i.trim()).slice(0, 15)) {
        const got = await pickInCombobox(frame, loc.first(), it, workday).catch(() => null)
        if (got) picked.push(got)
      }
      if (picked.length) res.filled.push(`${label}: ${picked.join(', ')}`)
      else if (items.some(i => i.trim())) res.skipped.push(`${label} (could not find "${items[0].slice(0, 40)}" in the list${lastSeen.length ? `; it offered: ${lastSeen.map(o => o.slice(0, 30)).join(', ')}` : ''})`)
      return
    }
    default: return
  }
}

/** Auto-apply's per-job deadline: filling stops starting new AI rounds once it has passed. */
let fillDeadline = Infinity
const setFillDeadline = (t: number): void => { fillDeadline = t }

// The user's additional documents (Profile › Additional documents), supplied by the app.
let documents: () => DocFile[] = () => []
export const useDocuments = (f: () => DocFile[]): void => { documents = f }

async function attachFiles(fields: Located[], tailored: Tailored | null, res: PrefillResult): Promise<void> {
  // Already uploaded (Workday keeps the file from its "Autofill with Resume" step): never upload a second copy.
  const page0 = fields[0]?.frame.page()
  const already = page0 ? await page0.locator('[data-automation-id="file-upload-successful"], [data-automation-id="fileUploadSuccessMessage"]').count().catch(() => 0) +
    (/successfully uploaded/i.test(await page0.locator('body').innerText().catch(() => '')) ? 1 : 0) : 0
  let resumeDone = already > 0
  let coverDone = false
  // A form that asks for a portfolio "linked here or attached below" but has no portfolio upload box of its own
  // (Formlabs: only Resume and Cover Letter) gets the portfolio PDF in a spare box (cover letter when there is no
  // cover letter, or an "additional file" box).
  const portfolio = documents().find(d => d.kind === 'portfolio' && existsSync(d.path))
  const asksPortfolio = !!portfolio && fields.some(x => /portfolio/i.test(`${x.f.question} ${x.f.label}`) && (x.f.kind === 'file' || /attach|upload/i.test(`${x.f.question} ${x.f.label}`)))
  let portfolioDone = false
  const spare: Located[] = []
  for (const { frame, f, key: k0 } of fields.filter(x => x.f.kind === 'file')) {
    const key = `${f.label} ${f.name}`
    // A photo / avatar box is never for a document: a PDF in it errors and blocks Submit (Workable's optional "Photo").
    const hint = await frame.locator(`[data-ih-idx="${f.idx}"]`).first().evaluate((e: Element) => `${e.getAttribute('id') || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('data-testid') || ''} ${/pdf|doc/i.test(e.getAttribute('accept') || '') ? '' : (e.getAttribute('accept') || '').replace(/image\/[^,]*/i, 'photo')}`).catch(() => '')
    if (/photo|avatar|picture|headshot|profile[\s_-]?(image|pic)/i.test(`${key} ${hint}`)) continue
    const isCover = /cover/i.test(key)
    // An upload box for a transcript, portfolio, reference letter... gets the matching additional document.
    let extra = /resume|\bcv\b|curriculum/i.test(key) ? null : documentFor(`${f.question} ${f.label}`, documents())
    // Oracle Cloud labels every upload box "Upload Attachment" and says what it wants in the block's instructions
    // ("Upload your transcript ..."). Only a transcript or portfolio is taken from there: a "Red Seal certificate"
    // box must not get an unrelated certificate.
    if (!extra && !isCover && !/resume|\bcv\b|curriculum/i.test(key) && isOracleUrl(frame.page().url())) {
      const help = await frame.locator(`[data-ih-idx="${f.idx}"]`).first().evaluate((e: Element) => e.closest('.apply-flow-block')?.querySelector('.apply-flow-block__instructions')?.textContent || '').catch(() => '')
      const d = documentFor(help, documents())
      if (d && (d.kind === 'transcript' || d.kind === 'portfolio')) extra = d
    }
    if (extra && !(isCover && tailored?.coverPdfPath)) {
      // Already on the page (Oracle keeps attachments from an earlier try): never a second copy.
      if ((await frame.locator('body').innerText().catch(() => '')).includes(extra.name)) { res.filled.push(`${short(f)}: ${extra.name} already attached`); continue }
      try {
        await frame.locator(`[data-ih-idx="${f.idx}"]`).first().setInputFiles(extra.path)
        res.filled.push(`${short(f)}: attached ${extra.name}`)
        if (isCover) coverDone = true
        if (extra.kind === 'portfolio') portfolioDone = true
      } catch (e) { res.skipped.push(`${short(f)} (upload of ${extra.name} failed: ${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
      continue
    }
    if (!isCover && !resumeDone && tailored?.pdfPath && (/resume|cv|curriculum|file-upload/i.test(key) || !/transcript|portfolio|other|additional/i.test(key))) {
      try {
        await frame.locator(`[data-ih-idx="${f.idx}"]`).first().setInputFiles(tailored.pdfPath)
        resumeDone = true; res.filled.push('Resume PDF attached')
      } catch (e) { res.skipped.push(`Resume upload (${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
    } else if (isCover && !coverDone && tailored?.coverPdfPath) {
      try {
        await frame.locator(`[data-ih-idx="${f.idx}"]`).first().setInputFiles(tailored.coverPdfPath)
        coverDone = true; res.filled.push('Cover letter PDF attached')
      } catch (e) { res.skipped.push(`Cover letter upload (${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
    } else if (isCover || /additional|other|attachment|supporting/i.test(key)) {
      spare.push({ frame, f, key: k0 })
      if (f.required && !asksPortfolio) res.skipped.push(`${short(f)} (file upload)`)
    } else if (f.required) res.skipped.push(`${short(f)} (file upload)`)
  }
  if (asksPortfolio && !portfolioDone && portfolio) {
    const box = spare.find(x => /cover/i.test(`${x.f.label} ${x.f.name}`) && !coverDone) || spare.find(x => !/cover/i.test(`${x.f.label} ${x.f.name}`))
    if (box) {
      if ((await box.frame.locator('body').innerText().catch(() => '')).includes(portfolio.name)) { res.filled.push(`${short(box.f)}: ${portfolio.name} already attached`); return }
      try {
        await box.frame.locator(`[data-ih-idx="${box.f.idx}"]`).first().setInputFiles(portfolio.path)
        res.filled.push(`${short(box.f)}: attached ${portfolio.name} (the form asks for a portfolio)`)
      } catch (e) { res.skipped.push(`${short(box.f)} (upload of ${portfolio.name} failed: ${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
    }
  }
}

// SuccessFactors upload boxes done for a job (job id + box label): each box holds one file and a new upload replaces
// it, so a box is uploaded to once per job, replacing a file left from an earlier application.
const sfUploaded = new Set<string>()

/**
 * SuccessFactors upload boxes (Resume, Cover Letter, Transcript...) have no file input on the page: the "+" (or the
 * pencil, when a file is already there) opens a "Select a source for your file upload" dialog whose "Upload from
 * Device" input takes the file. The file's name then shows in the box.
 */
async function attachSuccessFactorsFiles(p: Page, job: Job, tailored: Tailored | null, res: PrefillResult): Promise<void> {
  const boxes = p.locator('.attachmentField').locator('visible=true')
  const n = await boxes.count().catch(() => 0)
  let resumeDone = false
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i)
    const label = ((await box.locator('.rcmFormFieldLabel').first().innerText().catch(() => '')) || '').replace(/[*\s]+/g, ' ').trim()
    const required = await box.locator('.requiredField').count().catch(() => 0) > 0
    const isResume = /resume|\bcv\b|curriculum/i.test(label)
    const isCover = /cover/i.test(label)
    let file: { path: string; name: string } | null = null
    if (isResume && tailored?.pdfPath && !resumeDone) file = { path: tailored.pdfPath, name: 'Resume PDF' }
    else if (isCover && tailored?.coverPdfPath) file = { path: tailored.coverPdfPath, name: 'Cover letter PDF' }
    else if (!isResume && !isCover) { const d = documentFor(label, documents()); if (d) file = { path: d.path, name: d.name } }
    const current = (await box.locator('[id$="_attachDownloadLabel"]:not(.displayNone) [id$="_attachDownloadLabelLink"]').first().innerText().catch(() => '')).trim()
    if (!file) { if (required && !current) res.skipped.push(`${label || 'Attachment'} (file upload)`); continue }
    const key = `${job.id}|${label}`
    if (sfUploaded.has(key) && current) { if (isResume) resumeDone = true; continue }
    const fname = file.path.split('/').pop() || ''
    try {
      await box.locator('.addAttachments').first().click({ timeout: 5000 })
      const dialog = p.locator('[role="dialog"]').locator('visible=true').filter({ hasText: /upload from (device|computer)|select a source/i }).last()
      await dialog.waitFor({ state: 'visible', timeout: 8000 })
      await dialog.locator('input[type="file"]').first().setInputFiles(file.path)
      // The box shows the file's name once the upload has finished.
      const shown = box.locator('[id$="_attachDownloadLabel"]:not(.displayNone)').filter({ hasText: fname.slice(0, 40) })
      await shown.first().waitFor({ state: 'visible', timeout: 30000 })
      sfUploaded.add(key)
      if (isResume) resumeDone = true
      res.filled.push(current && current !== fname ? `${label}: ${file.name} attached (replaced ${current.slice(0, 40)})` : `${label}: ${file.name} attached`)
    } catch (e) {
      await p.keyboard.press('Escape').catch(() => {})
      res.skipped.push(`${label || 'Attachment'} (upload of ${file.name} failed: ${(e as Error).message.split('\n')[0].slice(0, 60)})`)
    }
  }
}

/** SuccessFactors: open an entry under "Formal Education" when the form has none, so school, degree and major get filled. */
async function addSuccessFactorsEducation(p: Page, fields: Located[], res: PrefillResult): Promise<boolean> {
  const heading = p.locator('h1, h2, h3, h4, [role="heading"], button, span, div').filter({ hasText: /^\s*Formal Education\s*$/i }).locator('visible=true').first()
  if (!(await heading.isVisible().catch(() => false))) return false
  if (fields.some(x => /^\s*(school|institution|university|college)( name)?\s*$/i.test(x.f.label))) return false
  const add = p.locator('xpath=//*[normalize-space(.)="Formal Education"]/following::*[self::button or @role="button" or self::a][contains(normalize-space(.), "Add")][1]').first()
  if (!(await add.isVisible().catch(() => false))) return false
  await add.click().catch(() => {})
  await p.waitForTimeout(2000)
  res.filled.push('Added a Formal Education entry')
  return true
}

/** Workday "My Experience": add empty Work Experience / Education blocks when the page has none. */
async function addWorkdayBlocks(p: Page, fields: Located[], resume: Resume, res: PrefillResult): Promise<boolean> {
  const have = (re: RegExp, lab: RegExp): number => fields.filter(x => re.test(x.f.section) && lab.test(x.f.label)).length
  const plan: [RegExp, RegExp, number, string][] = [
    [/work experience/i, /job title/i, Math.min(resume.experience.length, 4), 'Work Experience'],
    [/education/i, /school|university/i, Math.min(resume.education.length, 2), 'Education']
  ]
  let added = false
  for (const [section, lab, count, name] of plan) {
    const existing = have(section, lab)
    if (count <= existing) continue
    const btn = p.locator(`[role="group"][aria-labelledby*="${name.replace(' ', '-')}" i] button, button[aria-label^="Add ${name}" i], button[aria-label^="Add Another ${name}" i]`)
      .filter({ hasText: /^\s*Add/ }).first()
    let target = btn
    if (!(await target.isVisible().catch(() => false))) {
      // Fall back to the "Add" button that follows the section's heading.
      target = p.locator(`xpath=//*[self::h2 or self::h3 or self::h4][contains(normalize-space(.), "${name}")]/following::button[normalize-space(.)="Add" or normalize-space(.)="Add Another"][1]`).first()
    }
    if (existing) target = p.locator(`xpath=//*[self::h2 or self::h3 or self::h4][contains(normalize-space(.), "${name}")]/following::button[normalize-space(.)="Add Another"][1]`).first()
    for (let k = existing; k < count; k++) {
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

/**
 * Workday's resume reader can leave extra, completely empty blocks ("Work Experience 3" with nothing in it) whose
 * required dates would stop the page. A person would delete them; so does the app (the last one first).
 */
async function removeEmptyWorkdayBlocks(p: Page, _fields: Located[], res: PrefillResult): Promise<boolean> {
  // Each block is a group labelled "Work Experience 3" (by aria-labelledby or its first heading-like line).
  const empty = await p.evaluate(() => {
    const NAME = /^(work experience|education|websites?|languages?|certifications?) \d+$/i
    const out: { name: string; n: number }[] = []
    for (const g of Array.from(document.querySelectorAll<HTMLElement>('[role="group"], fieldset, [data-automation-id$="Section"] > div'))) {
      const lb = g.getAttribute('aria-labelledby')
      const name = ((lb ? lb.split(/\s+/).map(i => document.getElementById(i)?.textContent || '').join(' ') : '') || g.querySelector('h3, h4, h5, legend, [role="heading"]')?.textContent || '').replace(/\s+/g, ' ').trim()
      if (!NAME.test(name) || out.some(o => o.name === name)) continue
      const boxes = Array.from(g.querySelectorAll<HTMLInputElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea'))
      if (boxes.length < 2 || boxes.some(b => (b.value || '').trim())) continue
      out.push({ name, n: Number(name.match(/\d+$/)?.[0] || 0) })
    }
    return out.sort((a, b) => b.n - a.n).map(o => o.name)
  }).catch(() => [] as string[])
  let removed = false
  for (const sec of empty) {
    const btn = p.locator(`button[aria-label="Delete ${sec}" i], button[aria-label^="Delete ${sec} " i]`)
      .or(p.locator(`xpath=//*[normalize-space(.)="${sec}" and not(*[normalize-space(.)="${sec}"])]/following::button[normalize-space(.)="Delete" or starts-with(@aria-label, "Delete")][1]`)).first()
    if (!(await btn.isVisible().catch(() => false))) continue
    await btn.click({ timeout: 3000 }).catch(() => {})
    await p.waitForTimeout(800)
    res.filled.push(`Removed the empty ${sec} block`)
    removed = true
  }
  return removed
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

async function fillCurrentPage(p: Page, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, label = 'Application page', redo = false): Promise<PrefillResult> {
  await guardSubmit(p, true)
  try {
    if (!isOracleUrl(p.url())) return await fillPage(p, job, profile, resume, tailored, model, label, redo)
    // Oracle Cloud imports education and experience as summary tiles. One the site marks incomplete ("Unnamed Major,
    // Fields to fix: 1") is opened, filled like the rest of the page, and saved; then the next one.
    // The page itself first: while an entry's edit form is open, Oracle disables the rest of the form.
    const res = await fillPage(p, job, profile, resume, tailored, model, label, redo)
    for (let i = 0; i < 4; i++) {
      if ((await oracleTileOpen(p)) && !(await saveOracleTile(p))) break   // the site refused the entry: reported below
      if (!(await openOracleTile(p))) break
      const more = await fillPage(p, job, profile, resume, tailored, model, label, redo)
      res.filled = [...new Set([...res.filled, ...more.filled])]
      res.skipped = [...new Set([...res.skipped.filter(x => !/required, still empty/.test(x)), ...more.skipped])]
      res.missing = [...new Set([...(res.missing || []), ...(more.missing || [])])]
    }
    // A tile still marked incomplete (its edit form would not save) is a required field left empty.
    for (const t of await p.locator('[data-profile-item-invalid="true"]').locator('visible=true').evaluateAll(els => els.map(e => e.getAttribute('aria-label') || (e.textContent || '').replace(/\s+/g, ' ').trim() || 'an entry')).catch(() => [] as string[]))
      res.skipped.push(`${t.trim().slice(0, 60)} (required, still empty: the site marks this entry incomplete)`)
    return res
  }
  finally { await guardSubmit(p, false) }
}

const isOracleUrl = (u: string): boolean => /\.oraclecloud\.com$/i.test(hostOf(u))
/** Oracle Cloud: opens the first tile (education, experience) the site marks incomplete, unless one is open already. */
// Oracle draws imported entries two ways: tiles (Cummins: "Unnamed Major, Fields to fix: 1") and a timeline (CNRL),
// each with its own edit form and Save button.
const ORACLE_FORM_SAVE = '.profile-item-footer button, .timeline-form-footer button'
const ORACLE_BAD_ENTRY = 'li.apply-flow-profile-item-tile--invalid, .beautiful-timeline-item[data-profile-item-invalid="true"]'
const oracleTileOpen = async (p: Page): Promise<boolean> => (await p.locator(ORACLE_FORM_SAVE).locator('visible=true').count().catch(() => 0)) > 0
async function openOracleTile(p: Page): Promise<boolean> {
  if (await oracleTileOpen(p)) return true
  const tile = p.locator(ORACLE_BAD_ENTRY).first()
  if (!(await tile.count().catch(() => 0))) return false
  await tile.scrollIntoViewIfNeeded().catch(() => {})
  // The Edit button shows on hover (tiles), or is only drawn once the entry is selected by a click (timeline).
  if (await tile.evaluate((e: Element) => e.classList.contains('beautiful-timeline-item')).catch(() => false)) { await tile.click({ timeout: 3000 }).catch(() => {}); await p.waitForTimeout(600) }
  await tile.hover().catch(() => {})
  const edit = tile.locator('button.apply-flow-profile-item-tile__edit-item-icon, button.beautiful-timeline-item__edit-icon').first()
  const ok = (await edit.count().catch(() => 0)) > 0 &&
    await edit.click({ timeout: 4000 }).then(() => true, () => edit.evaluate((e: HTMLElement) => { e.click(); return true }).catch(() => false))
  await p.waitForTimeout(2000)
  const open = await oracleTileOpen(p)
  if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[oracle] opening an incomplete entry: edit pressed ${ok}, form open ${open}`)
  return ok && open
}
/** Oracle Cloud: presses Save under the open tile's form. False when no tile form is open. */
async function saveOracleTile(p: Page): Promise<boolean> {
  const save = p.locator(ORACLE_FORM_SAVE).locator('visible=true').filter({ hasText: /^\s*save\s*$/i }).first()
  if (!(await save.count().catch(() => 0))) return false
  await save.scrollIntoViewIfNeeded().catch(() => {})
  await save.click({ timeout: 4000 }).catch(() => {})
  await p.waitForTimeout(2000)
  // Still open: the site refused it (a field it wants is empty). Left open so the report names the field.
  return !(await save.isVisible().catch(() => false))
}

/** Which profile value a contact box should hold, by its label ('' when it is not one of them). */
const ownValue = (own: [RegExp, string][], label: string): string => own.find(([re]) => re.test(label))?.[1]?.trim() || ''

async function fillPage(p: Page, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, label: string, redo: boolean): Promise<PrefillResult> {
  const res = blank(label)
  const whys = new Map<number, string>()
  const workday = isWorkdayUrl(p.url())
  await dismissCookies(p)
  const attempted = new Set<string>()
  // Some forms (SuccessFactors) open with every section folded shut, which hides all the fields.
  const expand = p.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^\s*expand all( sections)?\s*$/i }).first()
  if (await expand.isVisible().catch(() => false)) { await expand.click().catch(() => {}); await p.waitForTimeout(2500); res.filled.push('Opened all sections') }
  let fields = await collectAll(p)
  if (workday && /experience/i.test(label) && (await addWorkdayBlocks(p, fields, resume, res))) fields = await collectAll(p)
  if (workday && /experience/i.test(label) && (await removeEmptyWorkdayBlocks(p, fields, res))) fields = await collectAll(p)
  if (!workday && (await addSuccessFactorsEducation(p, fields, res))) fields = await collectAll(p)
  // Workday's own resume reader sometimes fills the field of study with a different discipline. Where the chosen
  // value does not match the major in the profile, it is removed so the right one is picked below.
  if (workday && profile.major.trim()) {
    const key = norm(profile.major).split(' ').filter(t => !GENERIC.has(t))
    let cleared = false
    for (const x of fields) {
      if (x.f.kind !== 'combobox' || !STUDY.test(`${x.f.label} ${x.f.question}`) || !x.f.value.trim()) continue
      if (!key.length || sameDiscipline(x.f.value, profile.major)) continue
      const loc = x.frame.locator(`[data-ih-idx="${x.f.idx}"]`).first()
      await loc.focus().catch(() => {})
      await clearSearch(loc)
      await loc.press('Backspace').catch(() => {})   // on an empty Workday picker, Backspace removes the chosen item
      await closeLists(x.frame)
      res.filled.push(`${short(x.f)}: removed "${x.f.value.slice(0, 40)}" (your profile says ${profile.major})`)
      cleared = true
    }
    if (cleared) { await p.waitForTimeout(600); fields = await collectAll(p) }
  }
  // Contact details come from the profile, never from the site's resume reader (Workday's autofill has typed
  // "baseline" as the city and "PID" as the postal code). A text box holding something else gets the profile value.
  {
    const OWN: [RegExp, string][] = [[/postal|zip/i, profile.postalCode], [/\bcity\b|\btown\b/i, profile.city],
      [/^((home|street|mailing|current|residential) )?address( line)? ?1?$|^street( address)?( line)? ?1?$/i, profile.address]]
    let fixed = false
    for (const x of fields) {
      if (x.f.kind !== 'text' || !x.f.value.trim()) continue
      const name = `${x.f.label} ${x.f.question}`.trim()
      // "Email Address", "Web address", "IP address" are not the street address.
      if (/e-?mail|web|url|\bip\b|link/i.test(name) || ['email', 'url', 'tel'].includes(x.f.inputType)) continue
      const want = ownValue(OWN, x.f.label || name)
      if (!want || x.f.value.trim().toLowerCase() === want.toLowerCase()) continue
      try {
        await applyAnswer(x, want, workday, res)
        res.filled.push(`${short(x.f)}: replaced "${x.f.value.slice(0, 30)}" (from your profile)`); fixed = true
      } catch { /* left as it was */ }
    }
    if (fixed) { await p.waitForTimeout(400); fields = await collectAll(p) }
  }
  await attachFiles(fields, tailored, res)
  if (!workday && (await p.locator('.attachmentField').count().catch(() => 0))) await attachSuccessFactorsFiles(p, job, tailored, res)
  if (tailored?.pdfPath && fields.some(x => x.f.kind === 'file')) { await p.waitForTimeout(1500); fields = await collectAll(p) }   // uploads can autofill and re-render

  // What was answered so far, by field, and what went wrong: the second look at required fields is told this.
  const tried = new Map<string, string>()
  // Fields found again after the page re-drew itself while being filled. collectAll re-numbers every field, so once
  // it has run mid-way, the rest of a batch is looked up here by its place on the page instead of its old number.
  let fresh: Map<string, Located> | null = null
  const recollect = async (): Promise<void> => { fields = await collectAll(p); fresh = new Map(fields.map(y => [y.key, y])) }
  const exists = (x: Located): Promise<boolean> => x.frame.locator(`[data-ih-idx="${x.f.idx}"]`).count().then(n => n > 0).catch(() => false)
  /**
   * Applies one answer. Some forms re-draw a field the moment it is touched (Greenhouse re-renders its whole education
   * block on the first click), which leaves the app holding an element that is gone: the field is found again and the
   * answer applied once more.
   */
  const apply = async (x0: Located, v: Answer['value']): Promise<void> => {
    let x = fresh ? fresh.get(x0.key) : x0
    if (!x) return   // an earlier answer removed this field (it was a follow-up that no longer applies)
    if (!(await exists(x))) { await recollect(); x = fresh!.get(x0.key); if (!x) return }
    const shown = (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 80)
    const before = res.skipped.length
    let err = ''
    const t0 = Date.now()
    try { await applyAnswer(x, v, workday, res) } catch (e) { err = (e as Error).message.split('\n')[0].slice(0, 70) }
    if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[apply] ${x.f.kind} "${short(x.f)}" = ${shown.slice(0, 40)} (${Date.now() - t0} ms)${err ? ' error: ' + err : ''}`)
    // Retried only when the element itself went away under the app (or threw): a plain miss would miss again.
    if (err || !(await exists(x))) {
      await recollect()
      const now = fresh!.get(x0.key)
      if (now && isEmpty(now.f) && x.f.kind !== 'file') {
        res.skipped.splice(before)
        err = ''
        try { await applyAnswer(now, v, workday, res) } catch (e) { err = (e as Error).message.split('\n')[0].slice(0, 70) }
      } else if (now && !isEmpty(now.f)) { res.skipped.splice(before); err = '' }   // it took after all
      res.filled = [...new Set(res.filled)]
    }
    const guess = whys.get(x0.f.idx)
    if (guess && !err && res.skipped.length === before) (res.guesses ||= []).push({ q: (x0.f.question || x0.f.label).replace(/\s+/g, ' ').trim().slice(0, 200), a: (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 200), why: guess })
    if (err) res.skipped.push(`${short(x.f)} (could not fill: ${err})`)
    const problem = err || res.skipped.slice(before).join('; ')
    tried.set(x0.key, problem ? `answered "${shown}", but: ${problem.slice(0, 200)}` : `answered "${shown}"`)
  }
  const words = /[a-z]{3,}\s+[a-z]{2,}/i
  const meaningless = (f: Field): boolean => (f.kind === 'checkbox' && !f.question && !words.test(f.label)) ||
    (f.kind === 'checkboxes' && !words.test(f.label) && !f.options.some(o => words.test(o)))
  /** Reads the choices of custom dropdowns, then finds every field again in case reading them re-drew the form. */
  const withOptions = async (list: Located[]): Promise<Located[]> => {
    let opened = false
    for (const x of list) if ((x.f.kind === 'dropdown' || x.f.kind === 'combobox') && !x.f.options.length) { await readOptions(x.frame, x.f); opened = true }
    if (!opened) return list
    fields = await collectAll(p)
    const m = new Map(fields.map(y => [y.key, y]))
    // A field not found again is dropped: its old number may now belong to another field.
    return list.flatMap(x => { const y = m.get(x.key); if (!y) return []; if (!y.f.options.length) y.f.options = x.f.options; return [y] })
  }

  // Up to five passes (it stops as soon as nothing new is empty): answers reveal follow-ups, which reveal more (Analog Devices).
  for (let pass = 0; pass < 5 && Date.now() < fillDeadline; pass++) {
    fresh = null
    // Field of study is filled by rule from the profile, before Claude sees the rest of the page.
    if (profile.major.trim()) {
      let touched = false
      for (const x of fields.filter(y => isStudy(y.f) && !attempted.has(y.key))) {
        attempted.add(x.key)
        if (sameDiscipline(x.f.value, profile.major)) continue
        checkStop()
        try { await fillStudy(p, x, profile.major, workday, res); touched = true }
        catch (e) { res.skipped.push(`${short(x.f)} (could not fill: ${(e as Error).message.split('\n')[0].slice(0, 60)})`) }
      }
      if (touched) { await p.waitForTimeout(400); fields = await collectAll(p); for (const y of fields) if (isStudy(y.f)) attempted.add(y.key) }
    }
    let todo = fields.filter(x => !meaningless(x.f) && (isEmpty(x.f) || (redo && pass === 0 && !['file', 'combobox'].includes(x.f.kind) && !(x.f.kind === 'dropdown' && !x.f.label))) && !attempted.has(x.key) && !never(x.f))
    if (!todo.length) break
    todo = await withOptions(todo)
    let answers: Map<number, Answer['value']>
    try { answers = await decide(todo.map(x => x.f), job, profile, resume, tailored, model, undefined, whys) }
    catch (e) {
      if (e instanceof StoppedError) throw e
      res.skipped.push(`${aiName()} could not decide the answers (${(e as Error).message.slice(0, 80)}); filled the basics only`)
      answers = new Map(todo.map(x => [x.f.idx, ruleAnswer(x.f, profile, job)]))
    }
    // Oracle Cloud: the postal code's suggestion ("L6B 1N3, Markham, ON") also sets city and province, while a city
    // picked first narrows the postal list to that city's codes. So the postal code goes first, and a city or
    // province it has already set is left alone.
    const oracle = isOracleUrl(p.url())
    const geo = (x: Located): boolean => x.f.kind === 'combobox' && /\b(city|town|province|state|region|county)\b/i.test(x.f.label)
    if (oracle) todo.sort((a, b) => Number(/postal|zip/i.test(b.f.label)) - Number(/postal|zip/i.test(a.f.label)))
    for (const x of todo) {
      checkStop()
      attempted.add(x.key)
      if (oracle && geo(x) && (await x.frame.locator(`[data-ih-idx="${x.f.idx}"]`).first().inputValue().catch(() => ''))) continue
      // A city kept from an earlier application (Oracle saves the address) limits the postal search to that city's
      // codes: city and province are emptied first, and the postal code sets them again.
      if (oracle && x.f.kind === 'combobox' && /postal|zip/i.test(x.f.label))
        for (const r of await x.frame.locator('input[role="combobox"][name="city"], input[role="combobox"][name^="region"]').evaluateAll(els => els.filter(e => (e as HTMLInputElement).value).map(e => `${e.id}-reset-button`)).catch(() => [] as string[])) {
          if (process.env.IH_AUTOAPPLY_DEBUG) console.log(`[oracle] clearing ${r} before the postal code`)
          await x.frame.locator(`[id="${r}"]`).first().click({ timeout: 2000 }).catch(() => {})
          await p.waitForTimeout(600)
        }
      let v = mustTick(x.f) ? true : answers.get(x.f.idx)
      // A required postal code or city is the candidate's own (the AI has left Oracle's postal and city pickers blank).
      if ((v === undefined || v === '') && x.f.required && ['text', 'combobox'].includes(x.f.kind) && /postal|zip|\bcity\b/i.test(x.f.label)) v = ruleAnswer(x.f, profile, job) || v
      if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) { if (x.f.required) tried.set(x.key, 'left blank'); continue }
      await apply(x, v)
    }
    await p.waitForTimeout(600)
    fields = await collectAll(p)
  }

  // A second look at required fields that are still empty: the AI is told what was tried and that the form cannot be
  // sent without them, and answers with common sense (N/A for a follow-up that does not apply, the closest option, ...).
  const rescued = new Set<string>()
  for (let round = 0; round < 2 && fields.length && Date.now() < fillDeadline; round++) {
    fresh = null
    // Also fields the site has marked wrong ("Invalid number."): answered again, told what the site said.
    let left = fields.filter(x => ((x.f.required && isEmpty(x.f)) || (x.f.error && !isEmpty(x.f))) && x.f.kind !== 'file' && !rescued.has(x.key) && !never(x.f))
    if (!left.length) break
    checkStop()
    for (const x of left) rescued.add(x.key)
    left = await withOptions(left)
    let answers: Map<number, Answer['value']>
    const why = (x: Located): string => x.f.error && !isEmpty(x.f)
      ? `answered "${x.f.value.slice(0, 80)}", and the site rejected it: "${x.f.error}". Give a value in the form the site accepts (e.g. digits only for a number, a plain email address).`
      : [tried.get(x.key) || 'not answered yet', x.f.error ? `the site says: "${x.f.error}"` : ''].filter(Boolean).join('; ')
    try { answers = await decide(left.map(x => x.f), job, profile, resume, tailored, model, new Map(left.map(x => [x.f.idx, why(x)])), whys) }
    catch (e) { if (e instanceof StoppedError) throw e; break }
    for (const x of left) {
      checkStop()
      let v = mustTick(x.f) ? true : answers.get(x.f.idx)
      // A declining option the AI missed on a required self-identification list. With none, the field stays empty and is flagged.
      if ((v === undefined || v === '') && x.f.required && x.f.options.length && EEO_Q.test(`${x.f.question} ${x.f.label}`)) v = eeoFallback(x.f.options)
      if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) continue
      await apply(x, v)
    }
    await p.waitForTimeout(600)
    fields = await collectAll(p)
  }

  // Final check: report anything required that is still empty.
  if (!fields.length) {
    res.note = 'No form fields found on this page yet. If there is an Apply button, a sign-in or a CAPTCHA, do that step in the browser, then press "Fill this page" again.'
  } else {
    const empty = fields.filter(x => x.f.required && isEmpty(x.f))
    for (const x of empty) res.skipped.push(`${short(x.f)} (required, still empty)`)
    // IH_AUTOAPPLY_DEBUG: show how each still-empty dropdown draws its list, to teach the app new kinds.
    if (process.env.IH_AUTOAPPLY_DEBUG) for (const x of empty.filter(y => y.f.kind === 'combobox' || y.f.kind === 'dropdown').slice(0, 3)) {
      const loc = x.frame.locator(`[data-ih-idx="${x.f.idx}"]`).first()
      await loc.click({ timeout: 2000 }).catch(() => {}); await loc.press('ArrowDown').catch(() => {}); await p.waitForTimeout(1500)
      const html = await loc.evaluate((e: Element) => { const id = e.getAttribute('aria-controls') || e.getAttribute('aria-owns') || ''; const l = id ? document.getElementById(id) : null; return (l ? l.outerHTML : 'no list for ' + id).replace(/\s+/g, ' ').slice(0, 1500) }).catch(() => '')
      console.log(`[list] ${short(x.f)}: ${html}`)
      await p.keyboard.press('Escape').catch(() => {})
    }
    res.missing = [...new Set(empty.map(x => [x.f.question, x.f.label].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean))]
    res.note = 'Check every field in the browser, finish anything listed as left for you, then press Submit yourself.'
  }
  if (!tailored?.pdfPath) res.note += ' No resume PDF was available (no tailored one, and none saved on the Resume page), so nothing was attached.'
  res.skipped = Array.from(new Set(res.skipped))
  return res
}

// ---------------------------------------------------------------------------------------------
// Workday. Its applications sit behind Apply → a choice of how to start → sign in or create an
// account → several form pages. The app walks those steps and fills each page as it appears.
// Between pages it presses Save and Continue when nothing required is left empty. It never presses Submit:
// the button is only pressed when its own text says continue or next, and never on the Review step.

export interface WorkdayHooks {
  /** Email from Settings and password from the Mac Keychain; null when none is stored. */
  getLogin(): Promise<{ email: string; password: string } | null>
  isKnown(tenant: string): boolean          // an account already exists at this employer's Workday
  markKnown(tenant: string): void
  autoCreate: boolean                        // user opted in: tick the agreement box and press Create Account
  autoContinue?: boolean                     // press Save and Continue between pages; never Submit
  onUpdate(r: PrefillResult): void           // a later page was filled
}
type Args = [Job, Profile, Resume, Tailored | null, string]

// Workday's own domains. (The saved login is also used on other job sites' sign-in forms: see siteSignIn.)
const WD_HOST = /\.(myworkdayjobs|myworkdaysite)\.com$/i
const testHost = process.env.IH_USER_DATA ? process.env.IH_WD_TEST_HOST : undefined
const hostOf = (u: string): string => { try { return new URL(u).hostname } catch { return '' } }
export const isWorkdayUrl = (u: string): boolean => { const h = hostOf(u); return WD_HOST.test(h) || (!!testHost && h === testHost) }
const wd = (id: string): string => `[data-automation-id="${id}"]`
const triedCreate = new Set<string>()
/** Employers where a refused sign-in already led to one Create Account try in this run. */
const createAfterRefusal = new Set<string>()
/** Employers where Workday rejected the saved login. The app stops trying there: repeated failures can lock the account. */
const loginRejected = new Set<string>()
/** Password submissions per employer in this run (at most two, so a wrong login cannot lock the account). */
const pwSubmits = new Map<string, number>()
const REFUSED_AGAIN = 'Workday refused the saved login here earlier in this run, so the app will not try again (repeated tries can lock the account). Sign in yourself in the browser; the app carries on once you are in.'
/** After the account is verified from email, the saved login may be tried again on that employer's Workday. */
const forgetRejected = (tenant: string): void => { loginRejected.delete(tenant); pwSubmits.delete(tenant) }
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

const pwVisible = (p: Page): Promise<boolean> => p.locator('input[type="password"]:visible').first().isVisible().catch(() => false)
const wdError = async (p: Page): Promise<string> =>
  (await p.locator(`${wd('errorMessage')}, ${wd('inputAlert')}, [role="alert"]`).allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 200)

/** Switches Workday's account page from "Create Account" to "Sign In". */
async function toSignIn(p: Page): Promise<void> {
  const link = p.locator(`${wd('signInLink')}, button:has-text("Sign In"):below(${wd('createAccountSubmitButton')})`).first()
  if (!(await link.isVisible().catch(() => false))) return
  await link.click().catch(() => {})
  await p.locator(wd('verifyPassword')).first().waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {})
  await p.locator(wd('signInSubmitButton')).first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {})
  await p.waitForTimeout(500)   // the form re-renders after switching; typing too early is lost
}

/** Types the login and presses Sign In, then waits to see the password box go. Tries twice. */
const VERIFY_HINT = 'The app will not try this login again here, so the account cannot get locked. If the account is new, open the verification email from this employer\'s Workday and click the link first. Then sign in yourself in the browser (or use "Forgot your password?"); the app carries on once you are in.'

/**
 * Types the saved login and reads it back. Workday re-draws its sign-in form just after it appears and can drop
 * keystrokes, which once sent a mangled password (and a wrong password counts towards locking the account).
 * Sign In is never pressed unless both boxes hold exactly the saved email and password.
 */
async function typeLogin(p: Page, login: { email: string; password: string }): Promise<boolean> {
  const email = p.locator(wd('email')).first(), pass = p.locator(wd('password')).first()
  await pass.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  await p.waitForTimeout(700)
  for (let k = 0; k < 3; k++) {
    await typeInto(email, login.email, true)
    await typeInto(pass, login.password, true)
    await p.waitForTimeout(300)
    if ((await email.inputValue().catch(() => '')) === login.email && (await pass.inputValue().catch(() => '')) === login.password) return true
    await p.waitForTimeout(1000)
  }
  return false
}

/**
 * Signs in with the saved login. The password is always the same everywhere, so a refusal is taken as a glitch first:
 * one more try on a freshly loaded form. If Workday still refuses, the app stops (no reset, no further tries) so the
 * account cannot get locked, and authStep checks whether an account exists there at all.
 */
async function signIn(p: Page, login: { email: string; password: string }, res: PrefillResult, tenant = ''): Promise<boolean> {
  if (tenant && loginRejected.has(tenant)) { res.note = REFUSED_AGAIN; return false }
  let lastErr = ''
  const stop = (why: string): false => { if (tenant) loginRejected.add(tenant); res.note = `Workday says: "${(lastErr || 'the login was refused').replace(/"/g, "'")}". ${why}`; return false }
  for (let attempt = 0; attempt < 2; attempt++) {
    // Never more than two password submissions per employer in a run, whichever path got here.
    if (tenant && (pwSubmits.get(tenant) || 0) >= 2) return stop('The saved login was refused twice here, so the app will not try again (repeated tries can lock the account). Sign in yourself in the browser; the app carries on once you are in.')
    if (!(await typeLogin(p, login))) { res.note = 'Workday sign-in: the email and password did not stay in the boxes, so the app did not press Sign In. It tries again on the next look.'; return false }
    if (tenant) pwSubmits.set(tenant, (pwSubmits.get(tenant) || 0) + 1)
    await pressWd(p, 'signInSubmitButton')
    res.filled.push(attempt ? 'Pressed Sign In again (fresh page)' : 'Signed in with your saved login')
    const gone = await p.locator('input[type="password"]:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).then(() => true).catch(() => false)
    if (gone) { if (tenant) pwSubmits.delete(tenant); return true }
    const err = await wdError(p)
    if (err) lastErr = err
    if (/verif|activat|confirm your/i.test(err)) { if (tenant) loginRejected.add(tenant); res.note = `Workday says: "${err}". The account needs its email confirmed first; the app looks for that email in Gmail.`; return false }
    if (/password|incorrect|invalid|locked|wrong/i.test(err) && attempt === 0) {
      // One more try on a fresh page: a half-loaded form can drop what was typed. Some employers (Hitachi) reload onto
      // the social sign-in menu, so "Sign in with email" has to be chosen again first.
      await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      await p.locator(`input[type="password"]:visible, ${wd('SignInWithEmailButton')}, ${wd('CreateAccountWithEmailButton')}`)
        .or(p.getByText(/^\s*(sign in|create (an )?account) with email\s*$/i)).first().waitFor({ timeout: 25_000 }).catch(() => {})
      await openEmailSignIn(p)
      await toSignIn(p)
      if (!(await p.locator(wd('signInSubmitButton')).first().isVisible().catch(() => false))) return stop('The sign-in form did not come back after refreshing, so the app will not submit the login again (repeated tries can lock the account). Sign in yourself in the browser; the app carries on once you are in.')
      continue
    }
    if (/password|incorrect|invalid|locked|wrong/i.test(err)) return stop('')
  }
  res.note = 'Workday did not get past sign-in. Sign in yourself in the browser; the app carries on once you are in.'
  return false
}

async function authStep(p: Page, tenant: string, hooks: WorkdayHooks): Promise<PrefillResult> {
  const res = blank('Workday sign-in')
  const login = await hooks.getLogin()
  if (!login) {
    res.note = 'This employer uses Workday, which needs an account. Save your email and password in Settings › Job site login and press "Fill this page again", or sign in yourself in the browser.'
    return res
  }
  let creating = await seen(p, wd('verifyPassword'))
  // Workday often opens on "Create Account" even when the account exists: sign in for employers seen before.
  if (creating && (hooks.isKnown(tenant) || triedCreate.has(tenant))) { await toSignIn(p); creating = await seen(p, wd('verifyPassword')) }
  // Some employers label the link differently, so it is also found by its text under the sign-in form.
  const createLink = p.locator(`${wd('createAccountLink')}, button:text-is("Create Account"):below(${wd('signInSubmitButton')}), a:text-is("Create Account"):below(${wd('signInSubmitButton')})`).first()
  if (!creating && !hooks.isKnown(tenant) && !triedCreate.has(tenant) && (await createLink.isVisible().catch(() => false))) {
    triedCreate.add(tenant)
    await createLink.click()
    creating = await seen(p, wd('verifyPassword'), 6000)
  }
  if (!creating) {
    if (await signIn(p, login, res, tenant)) { hooks.markKnown(tenant); res.note = 'Signed in. The next pages are filled as they appear.'; return res }
    // Refused twice with the right password: often there is simply no account here yet (Workday says "wrong email or
    // password" either way). Create it with the saved login; if Workday says it already exists, the account is locked.
    if (/^Workday says/.test(res.note) && !/confirm|verif/i.test(res.note) && hooks.autoCreate && !createAfterRefusal.has(tenant)) {
      createAfterRefusal.add(tenant)
      const link = p.locator(`${wd('createAccountLink')}`).or(p.locator('button:visible, a:visible').filter({ hasText: /^\s*create account\s*$/i })).first()
      if (await link.isVisible().catch(() => false)) {
        await link.click().catch(() => {})
        if (await seen(p, wd('verifyPassword'), 8000)) {
          await typeInto(p.locator(wd('email')).first(), login.email, true)
          await typeInto(p.locator(wd('password')).first(), login.password, true)
          await typeInto(p.locator(wd('verifyPassword')).first(), login.password, true)
          const box = p.locator(wd('createAccountCheckbox')).first()
          if (await box.isVisible().catch(() => false)) await box.check({ force: true }).catch(() => box.click())
          await pressWd(p, 'createAccountSubmitButton')
          res.filled.push('Sign-in was refused, so the app pressed Create Account')
          const made = await p.locator(wd('verifyPassword')).first().waitFor({ state: 'hidden', timeout: 15_000 }).then(() => true).catch(() => false)
          const err = await wdError(p)
          if (made && !err) { forgetRejected(tenant); res.note = 'There was no account here yet, so the app created one with your saved login. If Workday emails a confirmation link, the app opens it from Gmail.'; return res }
          res.note = `Workday says: "${(err || 'the login was refused').replace(/"/g, "'")}". An account with this email already exists here and refused the saved password twice, so it is probably locked after earlier tries. The app stops here so it is not locked further: sign in yourself once in a browser (Workday unlocks after a while), and the app carries on next time.`
        }
      }
    }
    return res
  }
  triedCreate.add(tenant)
  res.page = 'Workday create account'
  await typeInto(p.locator(wd('email')).first(), login.email, true)
  await typeInto(p.locator(wd('password')).first(), login.password, true)
  await typeInto(p.locator(wd('verifyPassword')).first(), login.password, true)
  res.filled.push('Email', 'Password', 'Confirm password')
  if (!hooks.autoCreate) {
    res.note = 'Tick the agreement box if there is one, then press Create Account. The app carries on once you are in. To have it press Create Account too, turn that on in Settings › Job site login.'
    return res
  }
  const box = p.locator(wd('createAccountCheckbox')).first()
  if (await box.isVisible().catch(() => false)) { await box.check({ force: true }).catch(() => box.click()); res.filled.push('Agreement box ticked') }
  await pressWd(p, 'createAccountSubmitButton')
  res.filled.push('Pressed Create Account')
  const gone = await p.locator('input[type="password"]:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).then(() => true).catch(() => false)
  await p.waitForTimeout(1500)
  const pageText = (await p.locator('body').innerText().catch(() => '')).slice(0, 4000)
  if (/verify (your )?(email|account)|verification (email|link)|check your (email|inbox)|sent (you )?an email/i.test(pageText)) {
    hooks.markKnown(tenant); loginRejected.add(tenant)
    res.note = 'Account created. Workday sent a verification email: open it, click the link, then sign in here yourself. The app carries on once you are in.'
    return res
  }
  if (gone) { hooks.markKnown(tenant); res.note = 'Pressed Create Account. If Workday emails you a verification link, open it and come back. If the account already existed, the app signs in on the next page.'; return res }
  // The account already exists (Workday says so, or simply stays here): sign in instead.
  const err = await wdError(p)
  hooks.markKnown(tenant)
  await toSignIn(p)
  if (await signIn(p, login, res, tenant)) res.note = `${err ? `Workday said "${err}", so the app signed in instead. ` : 'An account already existed, so the app signed in. '}The next pages are filled as they appear.`
  return res
}

/** Presses "Sign in with email" (or "Create account with email") on Workday's social sign-in menu. True when pressed. */
async function openEmailSignIn(p: Page): Promise<boolean> {
  if (await pwVisible(p)) return false
  const btn = p.locator(`${wd('SignInWithEmailButton')}, ${wd('CreateAccountWithEmailButton')}`).or(
    p.locator('button:visible, [role="button"]:visible').filter({ hasText: /^\s*(sign in|create (an )?account|continue) with email\s*$/i })).or(
    p.getByText(/^\s*(sign in|create (an )?account|continue) with email\s*$/i)).first()
  if (!(await btn.isVisible().catch(() => false))) return false
  await btn.click().catch(() => {})
  await p.locator('input[type="password"]:visible').first().waitFor({ timeout: 8000 }).catch(() => {})
  await p.waitForTimeout(500)   // the form re-renders after switching; typing too early is lost
  return true
}

async function workdayStep(p: Page, args: Args, hooks: WorkdayHooks): Promise<PrefillResult> {
  const [job, profile, resume, tailored, model] = args
  const tenant = hostOf(p.url()).split('.')[0]
  // Workday's own "Something went wrong, please refresh" page: refresh once and let the watcher carry on.
  if (await p.getByText(/^Something went wrong$/).first().isVisible().catch(() => false)) {
    await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await p.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    return blank('Workday', 'Workday showed an error page, so the app refreshed it.')
  }
  // The "Create Account/Sign In" step can show its progress bar before its password boxes: wait for them,
  // and never treat that step as an application page (doing so marked employers as "has an account").
  const stepNow = await p.locator(wd('progressBarActiveStep')).first().innerText({ timeout: 400 }).catch(() => '')
  // Some employers' progress bars have no step names (Hitachi): then the page's own "Sign In" heading tells.
  const authPage = /sign in|create account/i.test(stepNow) || (await seen(p, `${wd('signInContent')}, ${wd('signInFormo')}`)) ||
    (await p.locator('h1:visible, h2:visible, h3:visible').filter({ hasText: /^\s*(sign in|create account)\s*$/i }).count().catch(() => 0)) > 0
  // Some employers open sign-in on a menu (Sign in with Apple / Google / LinkedIn, or "Sign in with email"): the
  // email and password boxes appear only after choosing email.
  // The menu loads after the progress bar, so wait for either it or the password boxes before deciding.
  if (authPage) await p.locator(`input[type="password"]:visible, ${wd('SignInWithEmailButton')}, ${wd('CreateAccountWithEmailButton')}`)
    .or(p.getByText(/^\s*(sign in|create (an )?account) with email\s*$/i)).first().waitFor({ timeout: 10_000 }).catch(() => {})
  if (authPage && loginRejected.has(tenant)) return blank('Workday sign-in', REFUSED_AGAIN)
  if (await openEmailSignIn(p)) return blank('Workday sign-in', 'Chose "Sign in with email". The app signs in on the next look.')
  if ((await p.locator('input[type="password"]:visible').count().catch(() => 0)) > 0) return authStep(p, tenant, hooks)
  if (authPage) return blank('Workday sign-in', 'The sign-in page is still loading. The app tries again when it appears; if it does not, press "Fill this page again".')
  if ((await seen(p, wd('applyManually'))) || (await seen(p, wd('autofillWithResume')))) {
    const res = blank('Workday: how to apply'); await chooseStart(p, tailored, res); return res
  }
  const inFlow = /\/apply(\/|$)/.test(p.url()) || (await seen(p, wd('progressBar')))
  // "Continue Application" replaces Apply when an application was started earlier.
  const resumeBtn = p.locator('a:visible, button:visible').filter({ hasText: /^\s*continue application\s*$/i }).first()
  if (!inFlow && !(await seen(p, wd('adventureButton'))) && (await resumeBtn.isVisible().catch(() => false))) {
    await resumeBtn.click().catch(() => {})
    return blank('Workday job page', 'Continuing the application started earlier. The next pages are filled as they appear.')
  }
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
  if (inFlow) {
    res.note = 'Check this page, finish what is left for you, then press Save and Continue. The next page is filled when it appears. Submit is always yours.'
    if (hooks.autoContinue !== false) {
      await pressContinue(p, res)
      // Workday sometimes drops a value it showed (an autofilled "How did you hear about us?") and refuses the page.
      // Once: fill what is empty now, then try again.
      // Also after Workday's own "Page Error" with only an error code, which a second press usually clears.
      if (/did not accept the page|did not move on/.test(res.note)) {
        const again = await fillCurrentPage(p, job, profile, resume, tailored, model, res.page)
        res.filled.push(...again.filled.map(f => `${f} (after Workday's error)`))
        res.skipped = again.skipped
        await pressContinue(p, res)
      }
    }
  }
  return res
}

const NEXT_BTN = `${wd('pageFooterNextButton')}, ${wd('bottom-navigation-next-button')}`
const CONTINUE_TEXT = /^(save\s*(and|&)\s*continue|continue|next)$/i

/**
 * Presses Workday's Save and Continue once a page is filled. It refuses on the Review step, when the button says
 * anything other than continue or next (the same button becomes Submit on the last page), and while a required
 * field is still empty. If Workday rejects the page, its message is passed on and the page is left for the user.
 */
async function pressContinue(p: Page, res: PrefillResult): Promise<void> {
  const step = (await p.locator(wd('progressBarActiveStep')).first().innerText({ timeout: 400 }).catch(() => '')).replace(/\s+/g, ' ')
  if (/review|submit/i.test(step)) { res.note = 'This is the Review page. Read it through, then press Submit yourself.'; return }
  const empty = res.skipped.filter(s => /required, still empty/.test(s))
  if (empty.length) { res.note = `Not pressing Save and Continue: ${empty.length} required ${empty.length === 1 ? 'field is' : 'fields are'} still empty. Fill ${empty.length === 1 ? 'it' : 'them'} in, then press Save and Continue yourself or "Fill this page again".`; return }
  const btn = p.locator(NEXT_BTN).first()
  if (!(await btn.isVisible().catch(() => false))) { res.note = 'Could not find the Save and Continue button on this page. Press it yourself; the next page is filled when it appears.'; return }
  const text = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  if (!CONTINUE_TEXT.test(text)) { res.note = /submit/i.test(text) ? 'This is the last page. Check it, then press Submit yourself.' : `The button here says "${text}", so the app left it for you.`; return }
  checkStop()
  const before = await signature(p)
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  const overlay = btn.locator('xpath=..').locator(wd('click_filter')).first()
  if (await overlay.isVisible().catch(() => false)) await overlay.click(); else await btn.click()
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(500)
    if ((await signature(p)) !== before) { res.filled.push('Pressed Save and Continue'); res.note = 'Pressed Save and Continue. The next page is filled when it appears. Submit is always yours.'; return }
  }
  const err = await wdError(p)
  res.note = err ? `Pressed Save and Continue, but Workday did not accept the page: "${err}". Fix what it points to, then press Save and Continue yourself.`
    : 'Pressed Save and Continue, but the page did not move on. Check it for anything marked in red, then press Save and Continue yourself.'
}

/** Fills each new Workday page as it appears, until the browser closes, another run starts, or 45 minutes pass. */
async function watchWorkday(p: Page, args: Args, hooks: WorkdayHooks): Promise<void> {
  const token = ++watchToken
  const end = begin('Watching the application for the next page')
  try {
  const done = new Set<string>()
  const authTries = new Map<string, number>()
  const until = Date.now() + 45 * 60_000
  while (token === watchToken && !p.isClosed() && Date.now() < until && !isStopping()) {
    try {
      const sig = isWorkdayUrl(p.url()) ? await signature(p) : ''
      // A sign-in page that is still showing after a try gets another go (up to three), so one slow login never stalls the run.
      if (sig && done.has(sig) && /\|pw[1-9]/.test(sig) && (authTries.get(sig) || 0) < 3 && !loginRejected.has(hostOf(p.url()).split('.')[0])) {
        await p.waitForTimeout(6000)
        if ((await signature(p)) === sig && (await pwVisible(p))) done.delete(sig)
      }
      if (sig && !done.has(sig)) {
        if (/\|pw[1-9]/.test(sig)) authTries.set(sig, (authTries.get(sig) || 0) + 1)
        await p.waitForTimeout(1300)
        if ((await signature(p)) !== sig) continue   // still loading or changing
        done.add(sig)
        try { hooks.onUpdate(await workdayStep(p, args, hooks)) }
        catch (e) { hooks.onUpdate(blank('Workday', `This page could not be filled: ${(e as Error).message.split('\n')[0].slice(0, 120)}`)) }
      }
      await p.waitForTimeout(1500)
    } catch { if (p.isClosed()) break; await new Promise(r => setTimeout(r, 1500)) }
  }
  } finally { end() }
}
/** Ends the Workday page watcher (the stop switch). The browser stays open. */
export function stopWatching(): void { watchToken++ }

// ---------------------------------------------------------------------------------------------
// SuccessFactors. The job page only has an "Apply now" control; the form sits behind it and behind
// that employer's own account. The app presses Apply, signs in with the saved login (see siteSignIn), then
// fills the application when it appears. It never presses Submit.

const SF_APPLY = 'a.dialogApply, a[href*="/talentcommunity/apply/"], button[href*="/talentcommunity/apply/"]'
/** The visible Apply control on a SuccessFactors job page (hidden copies exist for other screen sizes). */
const sfApply = (p: Page): Locator => p.locator(SF_APPLY).locator('visible=true').first()
const isSuccessFactorsJobPage = (p: Page): Promise<boolean> => sfApply(p).isVisible().catch(() => false)
/** SuccessFactors job links look like /job/<slug>/<number>/; the Apply control can take a moment to appear. */
const waitForSuccessFactorsJobPage = async (p: Page): Promise<boolean> =>
  /\/job\/[^?#]*\/\d{6,}\/?([?#]|$)/.test(p.url()) ? sfApply(p).waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false) : isSuccessFactorsJobPage(p)
const latestPage = (p: Page): Page => { const open = (context?.pages() || []).filter(x => !x.isClosed()); return open[open.length - 1] || p }

async function successFactorsApply(p: Page): Promise<PrefillResult> {
  const res = blank('Job page')
  if (await p.locator('#cookie-acknowledge').first().click({ timeout: 1500 }).then(() => true).catch(() => false)) await p.waitForTimeout(1200)
  const from = p.url()
  // The click can be lost while the page is still settling, so it is tried twice.
  for (let attempt = 0; attempt < 2; attempt++) {
    await sfApply(p).click({ timeout: 5000 }).catch(() => {})
    // Some employers open a small menu ("Apply Now" / "Start applying with LinkedIn").
    const item = p.locator('.dropdown-menu a:visible, ul[role="menu"] a:visible').filter({ hasText: /^\s*apply now\s*$/i }).first()
    if (await item.isVisible({ timeout: 1500 }).catch(() => false)) await item.click().catch(() => {})
    let moved = false
    for (let i = 0; i < 16 && !moved; i++) { await p.waitForTimeout(500); const now = latestPage(p); moved = now !== p || now.url() !== from }
    if (moved) break
  }
  res.filled.push('Pressed Apply now')
  res.note = 'Opening the application. This employer uses SuccessFactors, which needs an account: the app signs in with your saved login, then fills the form.'
  return res
}

// ---------------------------------------------------------------------------------------------
// Sign-in on any other job site. The user chose to use the one saved login everywhere, so when an
// application shows a sign-in form the app types the saved email and password and presses Sign In.
// It only does this over https, once per site, and never again on a site that rejected the login
// (repeated failures can lock an account). On a create-account form it fills the fields and leaves
// the button, and any terms box, to the user.

const siteRejected = new Set<string>()
const siteTried = new Set<string>()
/** When the saved login last worked on a site. A sign-in that worked is no lockout risk, so a later job there signs in again. */
const siteSignedIn = new Map<string, number>()
const EMAIL_BOX = 'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[name*="login" i]'

const siteCreateTried = new Set<string>()
const CREATE_LINK = /create an account|create account|register|sign up|new user/i

/**
 * SuccessFactors "Create an Account" page: email twice, password twice, name, country, the data privacy statement
 * and the Create Account button. Accepting the statement and pressing the button happen only when the user has
 * switched on "create accounts for me" in Settings, since that accepts the employer's terms on their behalf.
 */
async function successFactorsCreate(p: Page, login: { email: string; password: string }, profile: Profile | undefined, hooks: WorkdayHooks, res: PrefillResult): Promise<void> {
  res.page = 'Create account'
  const pw = login.password
  const fill = async (id: string, v: string): Promise<void> => { const l = p.locator(`#${id}`).first(); if (v && (await l.isVisible().catch(() => false))) await typeInto(l, v, true) }
  await fill('fbclc_userName', login.email); await fill('fbclc_emailConf', login.email)
  await fill('fbclc_pwd', pw); await fill('fbclc_pwdConf', pw)
  await fill('fbclc_fName', profile?.firstName || ''); await fill('fbclc_lName', profile?.lastName || '')
  res.filled.push('Email', 'Password', 'Name')
  // Some employers (Dana) also require a phone number with its country code on this form.
  const itu = p.locator('#fbclc_ituCode').first()
  if (await itu.isVisible().catch(() => false)) {
    const want = (profile?.country || 'Canada').toLowerCase()
    const opt = (await itu.locator('option').evaluateAll(os => os.map(o => ({ v: (o as HTMLOptionElement).value, t: (o.textContent || '').trim() }))).catch(() => [] as { v: string; t: string }[]))
      .find(o => o.v && o.t.toLowerCase().startsWith(`${want} (`))
    if (opt && (await itu.selectOption(opt.v).then(() => true).catch(() => false))) res.filled.push(`Phone country code: ${opt.t}`)
  }
  const phone = (profile?.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  await fill('fbclc_phoneNumber', phone)
  if (phone && (await p.locator('#fbclc_phoneNumber').first().isVisible().catch(() => false))) res.filled.push('Phone')
  const country = p.locator('#fbclc_country').first()
  if (await country.isVisible().catch(() => false)) {
    const ok = await country.selectOption({ label: profile?.country || 'Canada' }).then(() => true).catch(() => false)
    if (ok) res.filled.push(`Country: ${profile?.country || 'Canada'}`)
  }
  // SuccessFactors' own password rules; a password outside them would only be rejected.
  if (pw.length < 8 || pw.length > 18 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[^A-Za-z\s]/.test(pw) || /\s/.test(pw)) {
    res.note = 'This site needs a password of 8 to 18 characters with upper and lower case letters and a number or symbol, and your saved one does not fit. Type a password here yourself, accept the privacy statement and press Create Account. The app carries on once you are in.'
    return
  }
  if (!hooks.autoCreate) { res.note = 'Filled the account form. Open and accept the data privacy statement, then press Create Account. To have the app do that too, turn on "create accounts for me" in Settings › Job site login.'; return }
  if (await p.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha').first().count().catch(() => 0)) { res.note = 'Filled the account form. This site asks you to confirm you are not a robot: do that, accept the privacy statement and press Create Account yourself.'; return }
  const privacy = p.locator('#dataPrivacyId').first()
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.click().catch(() => {})
    const accept = p.locator('button[id^="dlgButton_"]:visible, [role="dialog"] button:visible').filter({ hasText: /^\s*(i )?accept\s*$/i }).first()
    if (await accept.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) { await accept.click().catch(() => {}); await p.waitForTimeout(1200); res.filled.push('Accepted the data privacy statement') }
    else { res.note = 'Filled the account form, but the privacy statement did not open. Accept it and press Create Account yourself.'; return }
  }
  const before = p.url()
  // No Create Account button: the account is made together with the application on this same page (Alstom), so
  // there is nothing separate to press here.
  if (!(await p.locator('#fbclc_createAccountButton').first().isVisible().catch(() => false))) {
    res.note = 'This site creates the account together with the application on one page, which the app does not fill yet. Sign in (if you have an account) or apply in the browser yourself.'
    return
  }
  await p.locator('#fbclc_createAccountButton').first().click().catch(() => {})
  res.filled.push('Pressed Create Account')
  let moved = false
  for (let i = 0; i < 30 && !moved; i++) { await p.waitForTimeout(500); moved = p.url() !== before || !(await p.locator('#fbclc_pwdConf').first().isVisible().catch(() => false)) }
  if (moved) { res.note = 'Created your account with the saved email and password. The application is filled as it appears. If the site emails a verification link, open it and come back.'; return }
  const err = (await p.locator('[role="alert"], .rcmValidationMsgArea, .error, [class*="error" i]').locator('visible=true').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 200)
  res.note = `${err ? `The site says: "${err}". ` : 'The account page did not move on. '}Finish creating the account in the browser; the app carries on once you are in.`
}

async function siteSignIn(p: Page, hooks: WorkdayHooks, profile?: Profile, site = ''): Promise<PrefillResult> {
  const res = blank('Sign in')
  // Sign-in hosts can be shared by many employers (career4.successfactors.com serves Westinghouse, Dana, Hatch...),
  // each with its own account, so tries and refusals are kept per employer: the job's own site, when known.
  const shown = hostOf(p.url())
  const host = site && site !== shown ? `${shown}|${site}` : shown
  const manual = 'Sign in or create the account yourself in the browser; the app fills the application as soon as you are in.'
  if (!p.url().startsWith('https://')) { res.note = `This sign-in page is not on a secure (https) address, so the app did not type your password. ${manual}`; return res }
  if (siteRejected.has(host)) { res.note = `${shown} rejected the saved login earlier, so the app will not try it again here. ${manual}`; return res }
  const login = await hooks.getLogin()
  if (!login) { res.note = `This site needs an account. Save your email and password in Settings › Job site login, or ${manual.charAt(0).toLowerCase()}${manual.slice(1)}`; return res }
  const pws = p.locator('input[type="password"]:visible')
  const count = await pws.count().catch(() => 0)
  if (!count) return res
  const email = p.locator(EMAIL_BOX).locator('visible=true').first()
  if (await email.isVisible().catch(() => false)) { await typeInto(email, login.email, true); res.filled.push('Email') }
  for (let i = 0; i < Math.min(count, 2); i++) await typeInto(pws.nth(i), login.password, true)
  if (count > 1 && (await p.locator('#fbclc_pwdConf').first().isVisible().catch(() => false))) {
    // A combined "create an account and apply" page (Alstom) also offers "Already a registered user? Please sign in".
    // The account may well exist already, so sign in there first; create one only when that sign-in is refused.
    const signInLink = p.locator('a[onclick*="openSignInModal"]').locator('visible=true').first()
    if (!siteTried.has(host) && (await signInLink.isVisible().catch(() => false))) {
      await signInLink.click().catch(() => {})
      const box = p.locator('input#password[type="password"]').locator('visible=true').first()
      if (await box.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
        siteTried.add(host)
        const user = p.locator('input#username').locator('visible=true').first()
        if (await user.isVisible().catch(() => false)) await typeInto(user, login.email, true)
        await typeInto(box, login.password, true)
        const btn = p.locator('#fbqa_signin').locator('visible=true').first()
        if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {}); else await box.press('Enter').catch(() => {})
        res.filled.push('Email', 'Password', 'Pressed Sign In')
        let gone = false
        for (let i = 0, clear = 0; i < 14 && !gone; i++) {
          await p.waitForTimeout(1000)
          await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
          clear = (await p.locator('input#password[type="password"]').locator('visible=true').count().catch(() => 1)) === 0 ? clear + 1 : 0
          gone = clear >= 3
        }
        if (gone) { siteSignedIn.set(host, Date.now()); res.filled.push('Signed in with your saved login'); res.note = 'Signed in with your saved login. The application is filled as it appears.'; return res }
        siteRejected.add(host)
        const err = (await p.locator('[role="alert"], .error, [class*="error" i]').locator('visible=true').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 160)
        res.note = `${err ? `The site says: "${err}". ` : 'The site did not accept the saved login. '}The app will not retry on this site, so the account cannot get locked. Sign in or create the account in the browser; the app carries on once you are in.`
        return res
      }
    }
    // Account creation is tried once per site: pressing it again on a page that did not move on only repeats the failure.
    if (siteCreateTried.has(host)) { res.page = 'Create account'; res.note = 'The app already tried to create an account on this site and the page did not move on. Finish the account yourself in the browser; the app carries on once you are in.'; return res }
    siteCreateTried.add(host)
    await successFactorsCreate(p, login, profile, hooks, res)
    return res
  }
  if (count > 1) {
    res.page = 'Create account'
    res.filled.push('Password', 'Confirm password')
    res.note = 'Filled the account form with your saved email and password. Complete anything else it asks, accept its terms if you agree, and press the create button yourself. The app carries on once you are in.'
    return res
  }
  res.filled.push('Password')
  // A "confirm you are not a robot" check is the user's to do; pressing Sign In without it only produces an error.
  if (await p.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha').first().count().catch(() => 0)) {
    res.note = 'Filled your saved login. This site asks you to confirm you are not a robot: tick that box and press Sign In yourself. The app fills the application as soon as you are in.'
    return res
  }
  // "Tried once" only counts a try that did not clearly work. After a sign-in that worked, the site's session can
  // run out (SuccessFactors logs out after a while and after each application), so a later job signs in again.
  // Only when the site asks again within two minutes of a sign-in that seemed to work is it left to the person.
  const okAt = siteSignedIn.get(host)
  if (siteTried.has(host) && (okAt === undefined || Date.now() - okAt < 120_000)) { res.note = 'Filled your saved login. Press Sign In yourself; the app already tried once on this site.'; return res }
  siteTried.add(host)
  const form = p.locator('form:has(input[type="password"])').first()
  const btn = form.locator('button[type="submit"]:visible, input[type="submit"]:visible, button:visible').filter({ hasText: /sign in|log ?in|continue|next/i }).first()
  const submit = (await btn.isVisible().catch(() => false)) ? btn : form.locator('button[type="submit"]:visible, input[type="submit"]:visible').first()
  if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {}); else await pws.first().press('Enter').catch(() => {})
  res.filled.push('Pressed Sign In')
  // A rejected sign-in often reloads the page, so the password box vanishing for a moment proves nothing:
  // the app waits for the page to settle and only counts it as signed in if the box stays gone.
  let gone = false
  for (let i = 0, clear = 0; i < 14 && !gone; i++) {
    await p.waitForTimeout(1000)
    await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
    clear = (await p.locator('input[type="password"]:visible').count().catch(() => 1)) === 0 ? clear + 1 : 0
    gone = clear >= 3
  }
  if (gone) { siteSignedIn.set(host, Date.now()); res.filled.push('Signed in with your saved login'); res.note = 'Signed in with your saved login. The application is filled as it appears.'; return res }
  // No account here yet: go to the site's create-account page and sign up with the same login.
  // The wording "create an account" is tried first, looser wording ("register", "sign up") only as a fallback.
  const links = p.locator('a, button').locator('visible=true')
  const exact = links.filter({ hasText: /create (an |your )?account/i }).first()
  const createLink = (await exact.isVisible().catch(() => false)) ? exact : links.filter({ hasText: CREATE_LINK }).first()
  if (!siteCreateTried.has(host) && (await createLink.isVisible().catch(() => false))) {
    siteCreateTried.add(host)
    const href = await createLink.getAttribute('href').catch(() => null)
    await createLink.click().catch(() => {})
    await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
    const twoBoxes = (): Promise<boolean> => p.locator('input[type="password"]:visible').nth(1).waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false)
    // After a rejected sign-in some sites ignore the click; the link's own address still works.
    if (!(await twoBoxes()) && href && !/^(#|javascript:)/i.test(href)) {
      await p.goto(new URL(href, p.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      await twoBoxes()
    }
    if (await p.locator('#fbclc_pwdConf').first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      res.filled.push('Sign-in was not accepted, so the app opened Create an Account')
      await successFactorsCreate(p, login, profile, hooks, res)
      return res
    }
    if ((await p.locator('input[type="password"]:visible').count().catch(() => 0)) > 1) {
      const again = await siteSignIn(p, hooks, profile, site)
      again.filled.unshift('Sign-in was not accepted, so the app opened the create-account page')
      return again
    }
  }
  // Marked only now: the create-account page above is filled by calling this function again, which would stop at the mark.
  siteRejected.add(host)
  const err = (await p.locator('[role="alert"], .error, .errorMessage, [class*="error" i]').locator('visible=true').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 160)
  res.note = `${err ? `The site says: "${err}". ` : 'The site did not accept the saved login. '}If you have no account here yet, create one in the browser with the same email and password. The app will not retry on this site, so the account cannot get locked. It carries on once you are in.`
  return res
}

/** After Apply: reports the sign-in step once, then fills each application page as it appears (six at most). */
async function watchApplication(start: Page, args: Args, hooks: WorkdayHooks): Promise<void> {
  const token = ++watchToken
  const end = begin('Watching the application for the next page')
  try {
    const done = new Set<string>()
    const until = Date.now() + 45 * 60_000
    let fills = 0
    while (token === watchToken && Date.now() < until && !isStopping() && fills < 6) {
      const p = latestPage(start)
      if (p.isClosed()) break
      page = p
      try {
        const heading = (await p.locator('h1:visible, h2:visible').first().innerText({ timeout: 400 }).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 60)
        const u = new URL(p.url())
        const sig = `${u.host}${u.pathname}|${heading}`
        if (await pwVisible(p)) {
          const pwSig = `${sig}|pw${await p.locator('input[type="password"]:visible').count().catch(() => 0)}`
          if (!done.has(pwSig)) { done.add(pwSig); await p.waitForTimeout(800); hooks.onUpdate(await siteSignIn(p, hooks, args[1])) }
        } else if (!done.has(sig) && !(await isSuccessFactorsJobPage(p))) {
          await p.waitForTimeout(1500)
          const again = latestPage(start)
          if (again === p && p.url().startsWith(`${u.origin}${u.pathname}`) && (await collectAll(p)).filter(x => x.f.kind !== 'file').length >= 3) {
            done.add(sig); fills++
            try { hooks.onUpdate(await fillCurrentPage(p, ...args, heading || 'Application page')) }
            catch (e) { hooks.onUpdate(blank('Application page', `This page could not be filled: ${(e as Error).message.split('\n')[0].slice(0, 120)}`)) }
          }
        }
      } catch { /* page navigating */ }
      await new Promise(r => setTimeout(r, 2000))
    }
  } finally { end() }
}

export async function prefill(profileDir: string, args: Args, hooks: WorkdayHooks): Promise<PrefillResult> {
  const [job] = args
  watchToken++   // stop any watcher from an earlier run
  const p = await getPage(profileDir)
  await p.goto(job.applyUrl || job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  if (!isWorkdayUrl(p.url()) && (await waitForSuccessFactorsJobPage(p))) {
    const res = await successFactorsApply(p)
    void watchApplication(p, args, hooks)
    return res
  }
  // Any other site that opens on a sign-in form: use the saved login, then fill what follows.
  if (!isWorkdayUrl(p.url()) && (await pwVisible(p))) {
    const res = await siteSignIn(p, hooks, args[1])
    void watchApplication(p, args, hooks)
    return res
  }
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
  if (!isWorkdayUrl(p.url()) && (await pwVisible(p))) return siteSignIn(p, hooks, args[1])
  return isWorkdayUrl(p.url()) ? workdayStep(p, args, hooks) : fillCurrentPage(p, ...args)
}

/** For tests: fill whatever page is open, without the Workday walk. */
export const _test = { removeEmptyWorkdayBlocks, attachSuccessFactorsFiles, applyAnswer, ownValue, mustTick, never, sameDiscipline, fillStudy, addSuccessFactorsEducation, studyChooser, studyTerms, successFactorsApply, siteSignIn, pages: (): string[] => (context?.pages() || []).map(x => x.url()), stopWatching, pressContinue, prefill, closeBrowser,  collectAll, attachFiles, fillCurrentPage, bestOption, workdayStep, pickInCombobox, visibleOptions }

/** A fresh tab in the application browser, for auto-apply. */
async function newTab(profileDir: string, hidden = false): Promise<Page> {
  const first = await getPage(profileDir, hidden)
  return first.context().newPage()
}
/** Every open tab in the application browser. */
const openPages = (): Page[] => (context?.pages() || []).filter(x => !x.isClosed())

/** The pieces auto-apply drives directly. */
export const forAutoApply = { setFillDeadline, dismissCookies, forgetRejected, minimize, newTab, openPages, workdayStep, successFactorsApply, waitForSuccessFactorsJobPage, siteSignIn, fillCurrentPage, guardSubmit,
  pwVisible, wdError, signature, isWorkdayUrl, collectAll, wd: (id: string): string => wd(id), stopWatching }
