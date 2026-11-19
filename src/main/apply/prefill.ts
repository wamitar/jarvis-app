// Opens the application page in the user's Chrome (own profile folder) and fills it in.
// Every control on the page is read (text, dropdowns, radio groups, tick boxes, searchable pickers),
// Claude decides every answer it can infer from the profile, resume and posting, and the app types
// them in. It never clicks Submit and never solves CAPTCHAs: those stay with the user.
import { begin, checkStop, isStopping } from '../activity'
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
  const placeholderOnly = (t: string): boolean => !t.replace(/\b(select one|select|choose one|choose|search|required|optional)\b/gi, '').replace(/[^\p{L}\p{N}]/gu, '')
  const labelFor = (el: HTMLElement): { text: string; star: boolean } => {
    const own = ownLabel(el); if (own.text && !placeholderOnly(own.text)) return own
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
      // Same name = one question, but only inside one container: repeated blocks (Workday's "I currently work here"
      // in each Work Experience) reuse names and are separate questions.
      const sameBox = (x: Element): boolean => !container || container.contains(x)
      if (input.name) group = all.filter(x => (x as HTMLInputElement).type === type && (x as HTMLInputElement).name === input.name && sameBox(x) && optVisible(x as HTMLInputElement)) as HTMLInputElement[]
      if (group.length <= 1 && container) group = Array.from(container.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)).filter(optVisible)
      if (type === 'checkbox' && group.length > 1 && new Set(group.map(optLabel)).size === 1) group = [input]
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
        push({ kind: 'checkbox', inputType: type, label: labels[0], question: q.text !== labels[0] ? q.text : '', section, name: `${input.name} ${input.id}`.trim(), required: req,
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
    if (!visible(el) || input.readOnly) continue
    // Hidden stand-ins some forms keep beside custom dropdowns for their own validation (Greenhouse, react-select).
    if (el.getAttribute('aria-hidden') === 'true' || Number(getComputedStyle(el).opacity) === 0 || (el.tabIndex < 0 && !['combobox', 'spinbutton'].includes(el.getAttribute('role') || ''))) continue
    const l = labelFor(el)
    const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('data-automation-id') || ''}`.trim()
    const required = input.required || el.getAttribute('aria-required') === 'true' || l.star
    const isCombo = el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete') || el.getAttribute('data-uxi-widget-type') === 'selectinput'
    if (isCombo && el.tagName === 'INPUT') {
      // A searchable picker. Its chosen value usually shows in a sibling ("pill" or single-value element).
      let shown = ''
      let p: HTMLElement | null = el.parentElement
      for (let i = 0; i < 8 && p && !shown; i++, p = p.parentElement) {
        if (p.querySelectorAll('input:not([type=hidden]), textarea, select').length > 1) break   // reached another field
        const picked = Array.from(p.querySelectorAll('[data-automation-id="selectedItem"], [class*="singleValue" i], [class*="multiValue" i], [class*="single-value" i]')).map(x => clean(x.textContent)).filter(Boolean)
        if (picked.length) shown = picked.join('; ')
      }
      // Other pickers (SuccessFactors) keep the chosen text in the box itself; its placeholder entry counts as empty.
      if (!shown && input.value && !/^(no selection|none selected|select( one)?|please select.*)$/i.test(input.value.trim())) shown = clean(input.value)
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
    await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
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
  // Placeholder entries ("No Selection", "Select one") are never a match: "No" must not pick "No Selection".
  const n = options.map(o => (PLACEHOLDER.test(o.trim()) ? '' : norm(o)))
  let i = n.indexOf(w); if (i >= 0) return i
  i = n.findIndex(o => o.startsWith(w + ' ') || w.startsWith(o + ' ')); if (i >= 0) return i
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
    if ((await loc.inputValue().catch(() => value)) === value) return
  }
  // Workday date boxes sit under a display layer that takes the click; focusing directly works there.
  await loc.click({ timeout: 3000 }).catch(() => loc.focus())
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
  const loc = frame.locator(OPT).filter({ hasText: opts[i] })
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

async function pickInCombobox(frame: Frame, loc: Locator, value: string, workday: boolean): Promise<string | null> {
  await closeLists(frame)
  // With items already chosen, Workday's list of them covers the search box: focus it rather than click through.
  if ((await frame.locator('[data-automation-id="selectedItem"]').count().catch(() => 0)) > 0) await loc.focus()
  else await loc.click({ timeout: 2500 }).catch(() => loc.focus())
  await clearSearch(loc)
  await loc.pressSequentially(value, { delay: 25 })
  // Workday searches on Enter. Anywhere else Enter can submit the form, so it is never pressed there.
  if (workday) await loc.press('Enter').catch(() => {})
  await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  await frame.page().waitForTimeout(workday ? 900 : 300)
  let shown = await settledOptions(frame, value, workday)
  let picked = await clickOption(frame, value)
  // Workday's search can come back empty for a full phrase ("Mechanical Engineering") yet find it by its key word.
  const keyWords = norm(value).split(' ').filter(t => !GENERIC.has(t) && t.length > 2)
  if (!picked && workday && keyWords.length && keyWords.join(' ') !== norm(value)) {
    await clearSearch(loc)
    await loc.pressSequentially(keyWords[0], { delay: 25 })
    await loc.press('Enter').catch(() => {})
    await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    shown = await settledOptions(frame, value, true)
    picked = await clickOption(frame, value)
  }
  if (!picked) {
    // Search text did not match an option: clear it and pick from the full list instead.
    await clearSearch(loc)
    await frame.page().keyboard.press('Escape').catch(() => {})
    await loc.evaluate((e: HTMLElement) => e.blur()).catch(() => {})
    await loc.focus().catch(() => {}); await loc.press('ArrowDown').catch(() => {})   // reopen the full list
    await frame.locator(OPT).first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
    shown = await visibleOptions(frame)
    picked = await clickOption(frame, value)
  }
  if (picked) {
    // Two-level lists (Workday "How did you hear about us?"): a category opens a sub-list.
    await frame.page().waitForTimeout(500)
    const sub = await visibleOptions(frame)
    // Only a list that is entirely new counts as a sub-list. If the same results are still showing (a long
    // field-of-study list, say), nothing more is clicked: picking its first entry would choose the wrong thing.
    const isSubList = sub.length > 0 && !sub.includes(picked) && !sub.some(o => shown.includes(o))
    if (isSubList) { const second = await clickOption(frame, value) || (await frame.locator(OPT + ':visible').first().click().then(() => sub[0]).catch(() => null)); if (second) picked += ' › ' + second }
  }
  if (!picked) { lastSeen = shown.slice(0, 8); await clearSearch(loc) }
  await frame.page().keyboard.press('Escape').catch(() => {})
  return picked
}
/** The options on screen the last time a picker found no match, so the report can say what the list offered. */
let lastSeen: string[] = []

/** Waits for a picker's results to stop changing (Workday loads them after the search), up to about 6 seconds. */
async function settledOptions(frame: Frame, want: string, workday: boolean): Promise<string[]> {
  let prev = await visibleOptions(frame)
  if (!workday) return prev
  for (let i = 0; i < 14; i++) {
    if (bestOption(prev, want) >= 0) return prev
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
const STUDY = /field of study|\bmajor\b|discipline|area of study|program of study|specialization/i
const NEVER = /robots only|for robots|honeypot|leave (this|it) (field )?(blank|empty)|do not (fill|enter|complete)|password|captcha|social (security|insurance)|\bssn\b|\bsin\b|passport|driver'?s? licen[cs]e number|bank|credit card/i

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
    label: f.label.slice(0, 1500), ...(f.label.length < 4 && f.name ? { fieldName: f.name.slice(0, 80) } : {}), ...(f.question ? { question: f.question.slice(0, 1500) } : {}), ...(f.section ? { section: f.section } : {}),
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
- Be lenient: tick or say Yes to consent, acknowledgement, privacy, "I certify", terms, text (SMS) message, recruiting-communication and job-alert questions. When unsure whether to agree to something, agree.
- Preferred method of contact: Email.
- AI screening, AI interviews or automated/AI evaluation of the application: answer No (opt out) whenever the form offers the choice.
- "Have you worked for / been employed by this company before?", "Are you related to an employee?", non-compete or "Have you been convicted" style questions: answer No unless the facts say otherwise.
- "How did you hear about us?": always the company's careers website. Pick the option closest to that ("Careers Website", "Company Website", "Corporate Website", "Career Site"); for a free-text box write "Company careers website". Only if no such option exists, pick a job board.
- Field of study, major or discipline: always the major in candidate_facts. With options, pick that exact discipline or the option that names it (never a different engineering discipline such as aerospace); if none names it, leave the field out. Without options, search for the major's exact name.
- Never answer with a placeholder option such as "No Selection" or "Select one". If no real option fits an optional question, leave that field out.
- "Highest level of education completed": the candidate has NOT finished a degree yet; pick high school / secondary (or the closest "some college / currently enrolled" option). A question about the degree being pursued gets the bachelor's degree.
- Age questions ("Are you 18 or older?"): Yes, the candidate is a university student.
- Willing to relocate / travel / work on site: Yes for this internship unless the facts say otherwise.
- Phone country code or phone country: the country that matches the candidate's phone number. Phone device type: Mobile.
- Address fields: use the address in the facts; country is the candidate's country.
- Fields with type "wddate" are dates: reply in exactly the format in inputType (e.g. "09/2025" for "date MM/YYYY", "11/14/2026" for "date MM/DD/YYYY", "2025" for "date YYYY"). "From"/"To" in a Work Experience or Education section are that entry's start/end dates from the resume; if the resume only gives a year, use 09 for a fall start, 05 for a summer start, 01 otherwise. For a current role or a degree in progress, give the expected end date only if one is known, otherwise "". Whenever you leave a To date blank for a current role, also tick that entry's "I currently work here" box (same section).
- Searchable multi-select of skills: reply with an array of up to 8 skills from the resume.
- Dates: match the format the label or inputType implies (MM, YYYY, MM/YYYY, YYYY-MM-DD). A "date" for a signature or self-identification form is today. Start date is the candidate's availability.
- Fields in sections like "Work Experience 1", "Work Experience 2", "Education 1" map to the resume entries in the order they appear on the resume. "Role Description" or similar: 2 to 4 plain sentences from that entry's bullets.
- Notice period for a current employer: "2 weeks".
- Lists of countries in a question matter: answer from the candidate's actual citizenships (United States and Canada) against the exact list shown.
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

/** Ticks a box and confirms it stuck; styled boxes often ignore a direct check, so the label or the box is clicked instead. */
async function tick(frame: Frame, box: Locator): Promise<void> {
  if (await box.isChecked().catch(() => false)) return
  await box.check({ force: true, timeout: 2500 }).catch(() => {})
  if (await box.isChecked().catch(() => false)) return
  const id = await box.getAttribute('id').catch(() => null)
  const label = id ? frame.locator(`label[for="${id}"]`).first() : null
  if (label && (await label.isVisible().catch(() => false))) await label.click({ timeout: 2500 }).catch(() => {})
  if (!(await box.isChecked().catch(() => false))) await box.click({ force: true, timeout: 2500 }).catch(() => {})
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
      const fmt = f.inputType.replace(/^date /, '').split('/')
      const got = text.split(/[^0-9]+/).filter(Boolean)
      if (got.length !== fmt.length) { res.skipped.push(`${label} (date "${text}" does not fit ${fmt.join('/')})`); return }
      const digits = got.map((g, k) => fmt[k] === 'YYYY' ? g.padStart(4, '20') : g.padStart(2, '0')).join('')
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
        const id = await opt.getAttribute('id')
        if (id) await frame.locator(`label[for="${id}"]`).first().click(); else await opt.click({ force: true })
      })
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

async function attachFiles(fields: Located[], tailored: Tailored | null, res: PrefillResult): Promise<void> {
  // Already uploaded (Workday keeps the file from its "Autofill with Resume" step): never upload a second copy.
  const page0 = fields[0]?.frame.page()
  const already = page0 ? await page0.locator('[data-automation-id="file-upload-successful"], [data-automation-id="fileUploadSuccessMessage"]').count().catch(() => 0) +
    (/successfully uploaded/i.test(await page0.locator('body').innerText().catch(() => '')) ? 1 : 0) : 0
  let resumeDone = already > 0
  let coverDone = false
  for (const { frame, f } of fields.filter(x => x.f.kind === 'file')) {
    const key = `${f.label} ${f.name}`
    const isCover = /cover/i.test(key)
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
    } else if (f.required) res.skipped.push(`${short(f)} (file upload)`)
  }
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
  try { return await fillPage(p, job, profile, resume, tailored, model, label, redo) }
  finally { await guardSubmit(p, false) }
}

async function fillPage(p: Page, job: Job, profile: Profile, resume: Resume, tailored: Tailored | null, model: string, label: string, redo: boolean): Promise<PrefillResult> {
  const res = blank(label)
  const workday = isWorkdayUrl(p.url())
  const attempted = new Set<string>()
  // Some forms (SuccessFactors) open with every section folded shut, which hides all the fields.
  const expand = p.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^\s*expand all( sections)?\s*$/i }).first()
  if (await expand.isVisible().catch(() => false)) { await expand.click().catch(() => {}); await p.waitForTimeout(2500); res.filled.push('Opened all sections') }
  let fields = await collectAll(p)
  if (workday && /experience/i.test(label) && (await addWorkdayBlocks(p, fields, resume, res))) fields = await collectAll(p)
  // Workday's own resume reader sometimes fills the field of study with a different discipline. Where the chosen
  // value does not match the major in the profile, it is removed so the right one is picked below.
  if (workday && profile.major.trim()) {
    const key = norm(profile.major).split(' ').filter(t => !GENERIC.has(t))
    let cleared = false
    for (const x of fields) {
      if (x.f.kind !== 'combobox' || !STUDY.test(`${x.f.label} ${x.f.question}`) || !x.f.value.trim()) continue
      const v = ` ${norm(x.f.value)} `
      if (!key.length || key.every(k => v.includes(` ${k} `))) continue
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
  await attachFiles(fields, tailored, res)
  if (tailored?.pdfPath && fields.some(x => x.f.kind === 'file')) { await p.waitForTimeout(1500); fields = await collectAll(p) }   // uploads can autofill and re-render

  // Two passes: answering a question can reveal follow-up questions.
  for (let pass = 0; pass < 2; pass++) {
    const words = /[a-z]{3,}\s+[a-z]{2,}/i
    const meaningless = (f: Field): boolean => (f.kind === 'checkbox' && !f.question && !words.test(f.label)) ||
      (f.kind === 'checkboxes' && !words.test(f.label) && !f.options.some(o => words.test(o)))
    const todo = fields.filter(x => !meaningless(x.f) && (isEmpty(x.f) || (redo && pass === 0 && !['file', 'combobox'].includes(x.f.kind) && !(x.f.kind === 'dropdown' && !x.f.label))) && !attempted.has(x.key) && !NEVER.test(`${x.f.label} ${x.f.question} ${x.f.name}`))
    if (!todo.length) break
    for (const x of todo) if ((x.f.kind === 'dropdown' || x.f.kind === 'combobox') && !x.f.options.length) await readOptions(x.frame, x.f)
    let answers: Map<number, Answer['value']>
    try { answers = await decide(todo.map(x => x.f), job, profile, resume, tailored, model) }
    catch (e) {
      res.skipped.push(`Claude could not decide the answers (${(e as Error).message.slice(0, 80)}); filled the basics only`)
      answers = new Map(todo.map(x => [x.f.idx, ruleAnswer(x.f, profile, job)]))
    }
    for (const x of todo) {
      checkStop()
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
/** Employers where Workday rejected the saved login. The app stops trying there: repeated failures can lock the account. */
const loginRejected = new Set<string>()
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

async function signIn(p: Page, login: { email: string; password: string }, res: PrefillResult, tenant = ''): Promise<boolean> {
  if (tenant && loginRejected.has(tenant)) { res.note = 'Workday rejected the saved login here earlier. ' + VERIFY_HINT; return false }
  for (let attempt = 0; attempt < 2; attempt++) {
    await typeInto(p.locator(wd('email')).first(), login.email, true)
    await typeInto(p.locator(wd('password')).first(), login.password, true)
    await pressWd(p, 'signInSubmitButton')
    res.filled.push(attempt ? 'Pressed Sign In again' : 'Signed in with your saved login')
    const gone = await p.locator('input[type="password"]:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).then(() => true).catch(() => false)
    if (gone) return true
    const err = await wdError(p)
    if (/password|incorrect|invalid|locked|verif|code/i.test(err)) { if (tenant) loginRejected.add(tenant); res.note = `Workday says: "${err}". ${VERIFY_HINT}`; return false }
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
    if (await signIn(p, login, res, tenant)) { hooks.markKnown(tenant); res.note = 'Signed in. The next pages are filled as they appear.' }
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
  const authPage = /sign in|create account/i.test(stepNow) || (await seen(p, `${wd('signInContent')}, ${wd('signInFormo')}`))
  if (authPage) await p.locator('input[type="password"]:visible').first().waitFor({ timeout: 10_000 }).catch(() => {})
  if ((await p.locator('input[type="password"]:visible').count().catch(() => 0)) > 0) return authStep(p, tenant, hooks)
  if (authPage) return blank('Workday sign-in', 'The sign-in page is still loading. The app tries again when it appears; if it does not, press "Fill this page again".')
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
  if (inFlow) {
    res.note = 'Check this page, finish what is left for you, then press Save and Continue. The next page is filled when it appears. Submit is always yours.'
    if (hooks.autoContinue !== false) await pressContinue(p, res)
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
  for (let i = 0; i < 24; i++) {
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
  await p.locator('#fbclc_createAccountButton').first().click().catch(() => {})
  res.filled.push('Pressed Create Account')
  let moved = false
  for (let i = 0; i < 30 && !moved; i++) { await p.waitForTimeout(500); moved = p.url() !== before || !(await p.locator('#fbclc_pwdConf').first().isVisible().catch(() => false)) }
  if (moved) { res.note = 'Created your account with the saved email and password. The application is filled as it appears. If the site emails a verification link, open it and come back.'; return }
  const err = (await p.locator('[role="alert"], .rcmValidationMsgArea, .error, [class*="error" i]').locator('visible=true').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 200)
  res.note = `${err ? `The site says: "${err}". ` : 'The account page did not move on. '}Finish creating the account in the browser; the app carries on once you are in.`
}

async function siteSignIn(p: Page, hooks: WorkdayHooks, profile?: Profile): Promise<PrefillResult> {
  const res = blank('Sign in')
  const host = hostOf(p.url())
  const manual = 'Sign in or create the account yourself in the browser; the app fills the application as soon as you are in.'
  if (!p.url().startsWith('https://')) { res.note = `This sign-in page is not on a secure (https) address, so the app did not type your password. ${manual}`; return res }
  if (siteRejected.has(host)) { res.note = `${host} rejected the saved login earlier, so the app will not try it again here. ${manual}`; return res }
  const login = await hooks.getLogin()
  if (!login) { res.note = `This site needs an account. Save your email and password in Settings › Job site login, or ${manual.charAt(0).toLowerCase()}${manual.slice(1)}`; return res }
  const pws = p.locator('input[type="password"]:visible')
  const count = await pws.count().catch(() => 0)
  if (!count) return res
  const email = p.locator(EMAIL_BOX).locator('visible=true').first()
  if (await email.isVisible().catch(() => false)) { await typeInto(email, login.email, true); res.filled.push('Email') }
  for (let i = 0; i < Math.min(count, 2); i++) await typeInto(pws.nth(i), login.password, true)
  if (count > 1 && (await p.locator('#fbclc_pwdConf').first().isVisible().catch(() => false))) {
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
  if (siteTried.has(host)) { res.note = 'Filled your saved login. Press Sign In yourself; the app already tried once on this site.'; return res }
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
  if (gone) { res.note = 'Signed in with your saved login. The application is filled as it appears.'; return res }
  siteRejected.add(host)
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
      const again = await siteSignIn(p, hooks, profile)
      again.filled.unshift('Sign-in was not accepted, so the app opened the create-account page')
      return again
    }
  }
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
  await p.bringToFront().catch(() => {})
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
export const _test = { successFactorsApply, siteSignIn, pages: (): string[] => (context?.pages() || []).map(x => x.url()), stopWatching, pressContinue, prefill, closeBrowser,  collectAll, fillCurrentPage, bestOption, workdayStep, pickInCombobox, visibleOptions }
