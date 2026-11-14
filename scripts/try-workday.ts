// Walks one real Workday application with the app's own code: signs in or creates the account with the
// saved login, fills each page, presses Save and Continue (saves a draft), and stops at Review. Never submits.
// Usage: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-workday.ts <jobId> <outDir>
import { chromium } from 'playwright-core'
import { DatabaseSync } from 'node:sqlite'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, existsSync, mkdtempSync } from 'node:fs'
import { _test } from '../src/main/apply/prefill'
import * as keychain from '../src/main/keychain'
import { emptyProfile, type Job, type Tailored } from '../src/shared/types'

const [jobId, outDir = './try-workday-out'] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const db = new DatabaseSync(join(homedir(), 'Library/Application Support/internship-hunter/internship-hunter.db'), { readOnly: true })
const kv = (k: string): any => JSON.parse(String((db.prepare('select value from kv where key = ?').get(k) as any)?.value ?? 'null'))
const r = db.prepare('select * from jobs where id = ?').get(jobId) as any
const job = { id: r.id, source: r.source, company: r.company, title: r.title, location: r.location, url: r.url, applyUrl: r.apply_url || r.url,
  description: r.description || '', postedAt: r.posted_at, big: !!r.big, region: r.region, fetchedAt: r.fetched_at, score: r.score,
  reasons: [], missing: [], status: r.status, notes: '', appliedAt: null, hasTailored: false } as Job
const t = db.prepare('select * from tailored where job_id = ?').get(jobId) as any
const tailored: Tailored | null = t ? { jobId, resume: JSON.parse(t.resume), coverLetter: t.cover_letter || '', changes: [], warnings: [],
  pdfPath: t.pdf_path && existsSync(t.pdf_path) ? t.pdf_path : null, updatedAt: t.updated_at } : null
const profile = { ...emptyProfile(), ...kv('profile') }
const resume = tailored?.resume || kv('resume')
const known: string[] = [...(kv('workdayTenants') || []), ...(process.env.WD_KNOWN || '').split(',').filter(Boolean)]
const hooks = {
  getLogin: async () => { const email = kv('workdayEmail') || ''; const password = await keychain.getPassword(email); return email && password ? { email, password } : null },
  isKnown: (tn: string) => known.includes(tn), markKnown: (tn: string) => { if (!known.includes(tn)) known.push(tn) },
  autoCreate: !!kv('settings')?.workdayAutoCreate, onUpdate: () => {}
}
console.log(`Job: ${job.company} — ${job.title}\n${job.applyUrl}\nTailored PDF: ${tailored?.pdfPath || 'none'}`)

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wd-')), { channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 } })
const p = ctx.pages()[0] || await ctx.newPage()
await p.exposeFunction('__ihSubmitSeen', () => console.log('!! FORM SUBMIT EVENT FIRED'))
await p.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await p.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
const wd = (id: string) => `[data-automation-id="${id}"]`
const step = async () => (await p.locator(wd('progressBarActiveStep')).first().innerText({ timeout: 800 }).catch(() => '')).replace(/\s+/g, ' ').trim()
let lastSig = '', same = 0, wentBack = !process.env.BACK_TO
const clearDates = async () => {
  const n = await p.locator('input[data-automation-id^="dateSection"]').count()
  for (let k = 0; k < n; k++) { const d = p.locator('input[data-automation-id^="dateSection"]').nth(k); await d.focus().catch(() => {}); for (let j = 0; j < 4; j++) await p.keyboard.press('Backspace') }
  console.log(`  (cleared ${n} date boxes)`)
}
for (let i = 1; i <= 14; i++) {
  await p.waitForTimeout(2500)
  const st = await step()
  const err = await p.getByText(/^Something went wrong$/).first().isVisible().catch(() => false)
  const sig = p.url().split('?')[0] + '|' + st + (err ? '|err' : '')
  same = sig === lastSig ? same + 1 : 0; lastSig = sig
  if (same >= 2) { console.log('\nStuck on the same page three times; stopping.'); break }
  console.log(`\n===== ${i}. ${st || p.url().split('?')[0]}`)
  if (/review/i.test(st)) { console.log('Reached Review. Stopping here (Submit is yours).'); console.log((await p.locator('main, body').first().innerText()).replace(/\n{2,}/g, '\n').slice(0, 6000)); await p.screenshot({ path: join(outDir, `${i}-review.png`), fullPage: true }); break }
  if (!wentBack && st && !new RegExp(process.env.BACK_TO!, 'i').test(st)) {
    const back = p.getByRole('button', { name: /^back$/i }).first()
    if (await back.isVisible().catch(() => false)) { console.log('  going back'); await back.click(); await p.waitForTimeout(3500); lastSig = ''; continue }
  }
  if (!wentBack && st && new RegExp(process.env.BACK_TO!, 'i').test(st)) wentBack = true
  const t0 = Date.now()
  if (/experience/i.test(st) && process.env.DROP_SKILL) {
    // Test clean-up: remove a junk skill chip left by an earlier broken run.
    const chip = p.locator('[data-automation-id="selectedItem"]', { hasText: new RegExp('^\\s*' + process.env.DROP_SKILL + '\\s*$') }).first()
    if (await chip.isVisible().catch(() => false)) { await chip.locator('[data-automation-id="DELETE_charm"], [aria-label*="delete" i], [aria-label*="remove" i]').first().click({ timeout: 3000 }).then(() => console.log('  removed junk skill chip')).catch(e => console.log('  could not remove chip: ' + String(e).slice(0, 80))) }
  }
  const redo = !!process.env.REDO && !!st && new RegExp(process.env.REDO, 'i').test(st)
  if (redo) console.log('  (re-deciding every field on this page)')
  const res = await (redo ? _test.fillCurrentPage(p, job, profile, resume, tailored, 'sonnet', 'Workday: ' + st, true) : _test.workdayStep(p, [job, profile, resume, tailored, 'sonnet'], hooks)).catch(e => ({ page: 'error', filled: [], skipped: [String(e).slice(0, 200)], drafted: [], note: '' }))
  console.log(`[${res.page}] ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  res.filled.forEach(x => console.log('  ✓ ' + x.slice(0, 150)))
  res.drafted.forEach(d => console.log(`  ✎ ${d.question.slice(0, 80)} → ${d.answer.slice(0, 110)}…`))
  res.skipped.forEach(x => console.log('  • ' + x))
  if (res.note && !st) console.log('  note: ' + res.note)
  for (const x of await _test.collectAll(p)) if (/question|disclos|identify|experience/i.test(st)) console.log(`    [${x.f.kind}] ${(x.f.question ? x.f.question + ' / ' : '') + x.f.label}`.slice(0, 170) + ` = ${x.f.value.slice(0, 60) || '(empty)'}`)
  await p.screenshot({ path: join(outDir, `${i}.png`), fullPage: true })
  if (st && res.page !== 'Workday') {
    const next = p.locator(wd('pageFooterNextButton') + ',' + wd('bottom-navigation-next-button')).first()
    if (!(await next.isVisible().catch(() => false))) { console.log('  (no Save and Continue button found)'); continue }
    const label = (await next.innerText().catch(() => '')).trim()
    if (/submit/i.test(label)) { console.log('  Next button says Submit; stopping.'); break }
    await next.click()
    await p.waitForTimeout(3500)
    const errs = await p.locator(wd('errorMessage') + ',' + wd('inputAlert') + ', [role="alert"]').allInnerTexts().catch(() => [])
    const e = errs.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (e.length) console.log('  !! Workday errors after Save and Continue:\n     ' + e.slice(0, 12).join('\n     '))
  }
}
await ctx.close()
