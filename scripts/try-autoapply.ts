// Runs auto-apply on stand-in pages (made-up https hosts served locally). Every field is pre-filled or one Claude
// never answers, so no Claude calls are made. Run: IH_AUTOAPPLY_LIMIT_MS=20000 node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-autoapply.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAutoApply } from '../src/main/apply/autoapply.ts'
import { forAutoApply } from '../src/main/apply/prefill.ts'
import { stopAll } from '../src/main/activity.ts'
import { emptyProfile, emptyResume } from '../src/shared/types.ts'
import type { AutoApplyResult, Job } from '../src/shared/types.ts'

const form = (extra: string, onSubmit: string): string => `<h1>Apply</h1><form onsubmit="event.preventDefault(); ${onSubmit}">
  <label for="a">First name</label><input id="a" name="first" value="Test"><label for="b">Last name</label><input id="b" name="last" value="User">${extra}
  <button type="submit">Submit application</button></form><div id="msg" class="error"></div>`
const pages: Record<string, (u: URL) => string> = {
  'good.test': () => form('', "document.body.innerHTML = '<h1>Thank you for applying!</h1>'"),
  'robot.test': () => form('<p>Confirm you are not a robot</p>', ''),
  'required.test': () => form('<label for="c">Social Insurance Number *</label><input id="c" name="sin" required aria-required="true">', ''),
  'error.test': () => form('', "msg.textContent = 'Something went wrong. Please try again.'"),
  'noform.test': () => '<h1>About us</h1><p>Nothing to apply to here.</p>',
  'endless.test': u => { const n = Number(u.searchParams.get('n') || 1); return `<h1>Step ${n}</h1>${Array.from({ length: n + 1 }, (_, i) => `<label for="f${i}">Field ${i}</label><input id="f${i}" value="x">`).join('')}<button onclick="location.href='https://endless.test/?n=${n + 1}'">Next</button>` }
}
const profileDir = mkdtempSync(join(tmpdir(), 'ih-auto-'))
const first = await forAutoApply.newTab(profileDir)
await first.context().route('**/*', route => { const u = new URL(route.request().url()); const make = pages[u.hostname]; return make ? route.fulfill({ contentType: 'text/html', body: make(u) }) : route.fulfill({ status: 404, body: '' }) })
const job = (host: string): Job => ({ id: host, source: 'greenhouse', company: host, title: 'Test', location: '', url: `https://${host}/`, applyUrl: `https://${host}/`, description: '', region: 'usa', status: 'new' } as unknown as Job)
const results: AutoApplyResult[] = []
const deps = {
  profileDir, shotDir: join(profileDir, 'shots'),
  prepare: async (id: string) => [job(id), emptyProfile(), emptyResume(), null, 'haiku'] as never,
  hooks: () => ({ getLogin: async () => null, isKnown: () => false, markKnown: () => {}, autoCreate: false, autoContinue: true, onUpdate: () => {} }),
  onResult: (r: AutoApplyResult) => { results.push(r) }, onProgress: () => {}
}
const t0 = Date.now()
const sum = await runAutoApply(Object.keys(pages), deps)
const expect: Record<string, RegExp> = { 'good.test': /^applied:/, 'robot.test': /robot/, 'required.test': /required field left empty/, 'error.test': /did not accept|no confirmation/, 'noform.test': /no application form/, 'endless.test': /longer than/ }
let bad = 0
for (const r of results) { const line = `${r.outcome}: ${r.reason}`; const ok = expect[r.jobId].test(line); if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.jobId.padEnd(14)} ${line}${r.shot ? ' [screenshot]' : ''}`) }
console.log(`summary ${JSON.stringify(sum)} in ${Math.round((Date.now() - t0) / 1000)}s`)
// The stop switch ends a run part-way.
const stopped: AutoApplyResult[] = []
setTimeout(() => stopAll(), 6000)
const s2 = await runAutoApply(['endless.test', 'good.test'], { ...deps, onResult: r => { stopped.push(r) } })
const okStop = s2.left >= 1 && stopped.some(r => /stopped by you/.test(r.reason))
if (!okStop) bad++
console.log(`${okStop ? 'ok  ' : 'FAIL'} stop switch: ${JSON.stringify(s2)} ${stopped.map(r => r.reason).join(' | ')}`)
await first.context().close()
console.log(bad ? `${bad} FAILED` : 'all passed'); process.exit(bad ? 1 : 0)
