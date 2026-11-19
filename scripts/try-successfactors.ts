// Walks a real SuccessFactors job page as far as its sign-in page: no Claude calls, nothing typed.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-successfactors.ts <job url>
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _test } from '../src/main/apply/prefill.ts'
import { stopAll } from '../src/main/activity.ts'
import { emptyProfile, emptyResume } from '../src/shared/types.ts'
import type { Job } from '../src/shared/types.ts'

const url = process.argv[2]
const job = { id: 't', source: 'successfactors', company: 'Test', title: 'Test', location: '', url, applyUrl: url, description: '', region: 'canada', status: 'new' } as unknown as Job
const updates: string[] = []
const hooks = { getLogin: async () => null, isKnown: () => false, markKnown: () => {}, autoCreate: false, onUpdate: (r: { page: string; note: string }) => { updates.push(`${r.page}: ${r.note}`) } }
const first = await _test.prefill(mkdtempSync(join(tmpdir(), 'ih-sf-')), [job, emptyProfile(), emptyResume(), null, 'haiku'], hooks)
console.log('first:', first.page, '|', first.filled.join(', '), '|', first.note)
await new Promise(r => setTimeout(r, 14000))
console.log('tabs:', _test.pages().map(u => u.slice(0, 90)).join(' , '))
console.log('updates:', updates.join(' || ') || '(none)')
stopAll(); _test.stopWatching()
await _test.closeBrowser()
process.exit(0)
