// A Workday-style tenant whose sign-in opens on a "Sign in with email" menu (Hitachi), refuses the login, and
// reloads back onto the menu. The app must submit the password at most twice, then stop with Workday's own words.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-workday-signin.ts
process.env.IH_USER_DATA = '/tmp/ih-test'; process.env.IH_WD_TEST_HOST = 'hitachi.test'
import { chromium } from 'playwright-core'
const { _test } = await import('../src/main/apply/prefill.ts')

const login = { email: 'test.user@example.com', password: 'Stand-in-pass1' }
const hooks = { getLogin: async () => login, isKnown: () => true, markKnown: () => {}, autoCreate: false, onUpdate: () => {} }
const menu = `<h1>Sign In</h1><div id="root"><button data-automation-id="SignInWithEmailButton" onclick="show()">Sign in with email</button></div>
<script>function show() { root.innerHTML = '<form onsubmit="event.preventDefault(); fetch(\\'/submit\\', { method: \\'POST\\' }).then(() => err.textContent = \\'The username or password you entered is incorrect.\\')"><input data-automation-id="email"><input data-automation-id="password" type="password"><div id="err" data-automation-id="errorMessage"></div><button type="submit" data-automation-id="signInSubmitButton">Sign In</button></form>' }</script>`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
let submits = 0
await ctx.route('**/*', route => {
  const u = route.request().url()
  if (u === 'https://hitachi.test/submit') { submits++; return route.fulfill({ body: 'no' }) }
  return u === 'https://hitachi.test/' ? route.fulfill({ contentType: 'text/html', body: menu }) : route.fulfill({ status: 404, body: '' })
})
const page = await ctx.newPage()
let bad = 0
const check = (name: string, ok: boolean, note: string): void => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${note.slice(0, 150)}`) }

await page.goto('https://hitachi.test/')
const notes: string[] = []
for (let i = 0; i < 6; i++) {   // what the watcher does on each look
  const r = await _test.workdayStep(page, [] as never, hooks)
  notes.push(r.note)
  if (/will not try|Workday says/.test(r.note) && i > 0) break
}
check('password submitted at most twice', submits <= 2 && submits >= 1, `${submits} submissions`)
const last = notes[notes.length - 1]
check('stops with a note blockingNote reads as "sign-in not accepted"', /refused the saved login here earlier|Workday says: "[^"]+"\. /.test(last), last)
const before = submits
for (let i = 0; i < 2; i++) await _test.workdayStep(page, [] as never, hooks)
check('later looks submit nothing more', submits === before, `${submits} submissions`)

await browser.close()
console.log(bad ? `${bad} FAILED` : 'all passed')
process.exit(bad ? 1 : 0)
