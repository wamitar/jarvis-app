// Dry run of auto-apply on real job sites: everything runs (sign-in, filling with Claude, Continue) except the final
// Submit click. Uses the real data folder and application browser, so quit the app first. Marks nothing as applied.
// Run: IH_AUTOAPPLY_DRYRUN=1 node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-autoapply-real.ts <job id> [...]
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAutoApply } from '../src/main/apply/autoapply.ts'
import * as db from '../src/main/db.ts'
import { getPassword } from '../src/main/keychain.ts'
import { emptyProfile, emptyResume, defaultSettings } from '../src/shared/types.ts'
import type { Tailored } from '../src/shared/types.ts'

if (!process.env.IH_AUTOAPPLY_DRYRUN) { console.error('Set IH_AUTOAPPLY_DRYRUN=1: this script must never submit.'); process.exit(1) }
const data = join(homedir(), 'Library/Application Support/internship-hunter')
db.openDb(join(data, 'internship-hunter.db'))
const settings = { ...defaultSettings(), ...db.kvGet('settings', {}) }
const email = db.kvGet('workdayEmail', '')
const own = db.kvGet<string>('resumePdf', '')
const sum = await runAutoApply(process.argv.slice(2), {
  profileDir: process.env.IH_PROFILE || join(data, 'apply-browser'), shotDir: process.env.IH_SHOTS || join(data, 'autoapply-dryrun'),
  prepare: async id => {
    const job = db.getJob(id)!
    const t = db.getTailored(id)
    const pdf = t?.pdfPath && existsSync(t.pdfPath) ? t.pdfPath : own
    const tailored: Tailored = t ? { ...t, pdfPath: pdf } : { jobId: id, resume: db.kvGet('resume', emptyResume()), coverLetter: '', changes: [], warnings: [], pdfPath: pdf, updatedAt: '' }
    return [job, { ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) }, t?.resume || db.kvGet('resume', emptyResume()), tailored, settings.writeModel]
  },
  hooks: () => ({
    getLogin: async () => { const password = await getPassword(email); return email && password ? { email, password } : null },
    isKnown: t => db.kvGet<string[]>('workdayTenants', []).includes(t), markKnown: () => {}, autoCreate: false, autoContinue: true, onUpdate: () => {}
  }),
  onResult: r => console.log(`RESULT ${r.jobId.slice(0, 60)} | ${r.outcome} | ${r.reason} | on "${r.page}"${r.shot ? ' | ' + r.shot : ''}`),
  onProgress: (d, n, l) => console.log(`  ${d}/${n} ${l}`)
})
console.log('summary', JSON.stringify(sum))
process.exit(0)
