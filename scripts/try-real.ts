// Prefills one real posting from the app's database with the saved profile and resume. Never submits.
// Usage: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-real.ts <jobId> <screenshotDir>
import { chromium } from 'playwright-core'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { _test } from '../src/main/apply/prefill'
import { emptyProfile, type Job } from '../src/shared/types'

const [jobId, outDir = './try-real-out'] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const db = new DatabaseSync(join(homedir(), 'Library/Application Support/internship-hunter/internship-hunter.db'), { readOnly: true })
const kv = (k: string): any => JSON.parse(String((db.prepare('select value from kv where key = ?').get(k) as any)?.value ?? 'null'))
const r = db.prepare('select * from jobs where id = ?').get(jobId) as any
if (!r) throw new Error('job not found: ' + jobId)
const job = { id: r.id, source: r.source, company: r.company, title: r.title, location: r.location, url: r.url, applyUrl: r.apply_url,
  description: r.description || '', postedAt: r.posted_at, big: !!r.big, region: r.region, fetchedAt: r.fetched_at, score: r.score,
  reasons: [], missing: [], status: r.status, notes: '', appliedAt: null, hasTailored: false } as Job
const profile = { ...emptyProfile(), ...kv('profile') }
const resume = kv('resume')
console.log(`Job: ${job.company} — ${job.title} (${job.location})\n${job.applyUrl}`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const p = await browser.newPage({ viewport: { width: 1280, height: 900 } })
// Safety net: block anything that would send the application, and log any submit attempt.
await p.exposeFunction('__ihSubmitSeen', () => console.log('!! FORM SUBMIT EVENT FIRED'))
await p.addInitScript(() => document.addEventListener('submit', () => (window as any).__ihSubmitSeen(), true))
await p.route('**/*', route => {
  const req = route.request()
  if (req.method() === 'POST' && /submit|applications|apply/i.test(req.url()) && req.resourceType() !== 'image') { console.log('BLOCKED POST', req.url()); return route.abort() }
  return route.continue()
})
await p.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await p.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
// Greenhouse boards show the form below the description; some need an "Apply" click first.
const apply = p.getByRole('button', { name: /^apply( for this job| now)?$/i }).first()
if (await apply.isVisible().catch(() => false)) { await apply.click(); await p.waitForTimeout(1500) }

const t0 = Date.now()
const res = await _test.fillCurrentPage(p, job, profile, resume, null, 'sonnet', 'Application page')
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log('\nFILLED:'); res.filled.forEach(x => console.log('  ✓ ' + x))
console.log('\nWRITTEN ANSWERS:'); res.drafted.forEach(d => console.log(`  ✎ ${d.question}\n     ${d.answer}`))
console.log('\nLEFT FOR YOU:'); res.skipped.forEach(x => console.log('  • ' + x))
const errs = await p.evaluate(() => Array.from(document.querySelectorAll('[id$="-error"], .helper-text--error, [class*="error" i]'))
  .filter(e => (e as HTMLElement).offsetParent && /required/i.test(e.textContent || '')).length)
console.log(`\nVisible "required" errors on the page: ${errs}`)
await p.screenshot({ path: join(outDir, 'form-full.png'), fullPage: true })
console.log('\nScreenshot:', join(outDir, 'form-full.png'))
await browser.close()
