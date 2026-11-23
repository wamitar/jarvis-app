// Opens a real application in the app's own browser profile, signs in with the saved login, and describes the
// form it finds. It fills nothing and makes no Claude calls. Quit the app first (they share the browser profile).
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/inspect-application.ts <job url>
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { _test } from '../src/main/apply/prefill.ts'
import * as db from '../src/main/db.ts'
import { getPassword } from '../src/main/keychain.ts'

const data = join(homedir(), 'Library/Application Support/internship-hunter')
db.openDb(join(data, 'internship-hunter.db'))
const email = db.kvGet('workdayEmail', '')
const hooks = { getLogin: async () => { const password = await getPassword(email); return email && password ? { email, password } : null }, isKnown: () => false, markKnown: () => {}, autoCreate: false, onUpdate: () => {} }
const ctx = await chromium.launchPersistentContext(join(data, 'apply-browser'), { channel: 'chrome', headless: false, viewport: null })
const p0 = ctx.pages()[0] || await ctx.newPage()
await p0.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 45000 })
await p0.waitForTimeout(2500)
const first = await _test.successFactorsApply(p0).catch(e => ({ filled: [], note: 'apply failed: ' + (e as Error).message.slice(0, 100) }))
console.log('apply:', first.filled.join(', '), '|', first.note.slice(0, 80))
const cur = () => { const open = ctx.pages().filter(x => !x.isClosed()); return open[open.length - 1] }
await cur().waitForTimeout(3000)
if (await cur().locator('input[type="password"]:visible').count()) { const r = await _test.siteSignIn(cur(), hooks); console.log('sign-in:', r.filled.join(', '), '|', r.note.slice(0, 200)) }
await cur().waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
await cur().waitForTimeout(5000)
const p = cur()
console.log('URL:', p.url().slice(0, 200), '\nTITLE:', await p.title())
console.log('FRAMES:', p.frames().map(f => f.url().slice(0, 90)).join(' , '))
console.log('TEXT:', (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 900))
if (process.argv[3] === 'education') {
  const expand = p.locator('button:visible, a:visible, [role="button"]:visible').filter({ hasText: /^\s*expand all sections\s*$/i }).first()
  if (await expand.count()) { await expand.click().catch(() => {}); await p.waitForTimeout(3000) }
  const res = { page: '', filled: [] as string[], skipped: [] as string[], drafted: [], note: '' }
  const added = await _test.addSuccessFactorsEducation(p, await _test.collectAll(p), res as never)
  console.log('added education entry:', added, res.filled.join(', '))
  const again = await _test.addSuccessFactorsEducation(p, await _test.collectAll(p), res as never)
  console.log('adds a second entry on refill:', again)
  const major = (await _test.collectAll(p)).find(y => y.f.label === 'Major')
  if (major) { await _test.fillStudy(p, major, 'Mechanical Engineering', false, res as never); console.log('major result:', res.filled.slice(-1).join(''), '| skipped:', res.skipped.join('; ')) }
  for (const x of (await _test.collectAll(p)).filter(y => /education|school|degree|major|study|institution|graduat/i.test(`${y.f.section} ${y.f.label}`))) console.log(`  [${x.f.kind}] "${x.f.label.slice(0, 50)}" value="${x.f.value.slice(0, 40)}" section="${x.f.section.slice(0, 30)}" req=${x.f.required}`)
} else {
const job = db.listJobs().find(x => x.url === process.argv[2])!
const tailored = db.getTailored(job.id)
const { emptyProfile, emptyResume } = await import('../src/shared/types.ts')
const profile = { ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) }
const res = await _test.fillCurrentPage(p, job, profile, tailored?.resume || db.kvGet('resume', emptyResume()), tailored, 'sonnet')
console.log('\nFILLED (' + res.filled.length + '):\n  ' + res.filled.join('\n  '))
console.log('DRAFTED:', (res.drafted || []).map((d: unknown) => JSON.stringify(d).slice(0, 80)).join(' | '))
console.log('LEFT FOR YOU (' + res.skipped.length + '):\n  ' + res.skipped.join('\n  '))
console.log('NOTE:', res.note)
await p.waitForTimeout(2000)
}
await ctx.close()
process.exit(0)
