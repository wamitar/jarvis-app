// Runs the app's real Workday watcher on one job until it reaches the first form page. Never presses Save or Submit.
// Usage: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-signin.ts <jobId> <known: yes|no>
import { DatabaseSync } from 'node:sqlite'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { _test } from '../src/main/apply/prefill'
import * as keychain from '../src/main/keychain'
import { emptyProfile, type Job, type PrefillResult } from '../src/shared/types'
const [jobId, known] = process.argv.slice(2)
const db = new DatabaseSync(join(homedir(), 'Library/Application Support/internship-hunter/internship-hunter.db'), { readOnly: true })
const kv = (k: string): any => JSON.parse(String((db.prepare('select value from kv where key = ?').get(k) as any)?.value ?? 'null'))
const r = db.prepare('select * from jobs where id = ?').get(jobId) as any
const job = { id: r.id, source: r.source, company: r.company, title: r.title, location: r.location, url: r.url, applyUrl: r.apply_url || r.url, description: r.description || '', region: r.region } as Job
const t0 = Date.now()
const log = (r: PrefillResult) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${r.page} | ${r.filled.join(', ').slice(0, 160)} | ${r.note.slice(0, 160)}`)
let reached = false
const hooks = {
  getLogin: async () => { const email = kv('workdayEmail'); const password = await keychain.getPassword(email); return email && password ? { email, password } : null },
  isKnown: () => known === 'yes', markKnown: (tn: string) => console.log('  markKnown', tn), autoCreate: true,
  onUpdate: (r: PrefillResult) => { log(r); if (/My Information|My Experience|Application Questions/i.test(r.page)) reached = true }
}
const first = await _test.prefill(mkdtempSync(join(tmpdir(), 'wd-')), [job, { ...emptyProfile(), ...kv('profile') }, kv('resume'), null, 'sonnet'], hooks)
log(first)
while (!reached && Date.now() - t0 < 300_000) await new Promise(r => setTimeout(r, 2000))
console.log(reached ? 'REACHED THE FORM' : 'DID NOT REACH THE FORM in 5 minutes')
await _test.closeBrowser()
process.exit(0)
