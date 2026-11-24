// Checks sign-in with the saved login on stand-in pages. No real site, no real password, no Claude calls.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-signin-any.ts
import { chromium } from 'playwright-core'
import { _test } from '../src/main/apply/prefill.ts'

const login = { email: 'test.user@example.com', password: 'Stand-in-pass1' }
const hooks = { getLogin: async () => login, isKnown: () => false, markKnown: () => {}, autoCreate: false, onUpdate: () => {} }
const signIn = (ok: boolean): string => `<h1>Sign In</h1><form onsubmit="event.preventDefault(); window.sent = [u.value, pw.value]; ${ok ? "document.body.innerHTML = '<h1>Application</h1>'" : "err.textContent = 'Invalid email or password'"}">
  <input id="u" name="username"><input id="pw" type="password" name="password"><div id="err" class="error"></div><button type="submit">Sign In</button></form>`
const create = `<h1>Create account</h1><form onsubmit="event.preventDefault(); window.sent = 'CREATED'"><input type="email" name="email"><input type="password" name="p1"><input type="password" name="p2"><input type="checkbox" id="terms"><button type="submit">Create Account</button></form>`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
// Each case is served on its own made-up https host, so "once per site" and "never retry after a rejection" can be seen.
// A stand-in for SuccessFactors: sign-in rejects, "Create an account" leads to its account form, whose privacy
// statement only opens once a country is chosen and whose button only works once the statement is accepted.
const sfSignIn = `<h1>Sign In</h1><form onsubmit="event.preventDefault(); err.textContent = 'Invalid login'"><input name="username"><input type="password" name="password"><div id="err" class="error"></div><button type="submit">Sign In</button></form><a href="https://sf.test/create">Create an account to apply</a>`
const sfCreate = `<h1>Create an Account</h1><input id="fbclc_userName"><input id="fbclc_emailConf"><input type="password" id="fbclc_pwd"><input type="password" id="fbclc_pwdConf"><input id="fbclc_fName"><input id="fbclc_lName">
  <select id="fbclc_country"><option>- Select -</option><option>Canada</option><option>United States</option></select>
  <a id="dataPrivacyId" role="button" onclick="if (fbclc_country.value === 'Canada') dlg.style.display = 'block'">Read and accept the data privacy statement.</a>
  <div id="dlg" role="dialog" style="display:none"><button id="dlgButton_21:" onclick="window.accepted = true; dlg.style.display = 'none'">Accept</button><button id="dlgButton_22:">Decline</button></div>
  <button id="fbclc_createAccountButton" onclick="if (window.accepted) { window.made = [fbclc_userName.value, fbclc_emailConf.value, fbclc_pwd.value === fbclc_pwdConf.value, fbclc_fName.value, fbclc_lName.value, fbclc_country.value]; document.title = JSON.stringify(window.made); document.body.innerHTML = '<h1>Application</h1>' }">Create Account</button>`
const pages: Record<string, string> = { 'https://sf.test/': sfSignIn, 'https://sf.test/create': sfCreate, 'https://sf2.test/': sfSignIn.replace('https://sf.test', 'https://sf2.test'), 'https://sf2.test/create': sfCreate, 'https://good.test/': signIn(true), 'https://bad.test/': signIn(false), 'https://new.test/': create }
await ctx.route('**/*', route => { const body = pages[route.request().url()]; return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: '' }) })
const page = await ctx.newPage()
let bad = 0
const check = (name: string, ok: boolean, note: string): void => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${note.slice(0, 110)}`) }
const sent = (): Promise<unknown> => page.evaluate(() => (window as unknown as { sent?: unknown }).sent ?? null)

await page.goto('https://good.test/')
let r = await _test.siteSignIn(page, hooks)
check('signs in', (await page.locator('h1').innerText()) === 'Application', r.note)

await page.goto('https://bad.test/')
r = await _test.siteSignIn(page, hooks)
check('rejected login is reported', /Invalid email or password/.test(r.note) && Array.isArray(await sent()), r.note)
await page.goto('https://bad.test/')
r = await _test.siteSignIn(page, hooks)
check('does not retry after a rejection', (await sent()) === null && /will not try/.test(r.note), r.note)

await page.goto('https://new.test/')
r = await _test.siteSignIn(page, hooks)
const vals = await page.evaluate(() => [...document.querySelectorAll('input')].map(i => (i as HTMLInputElement).type === 'checkbox' ? String((i as HTMLInputElement).checked) : (i as HTMLInputElement).value))
check('create form: fields filled, button and terms left alone', vals[0] === login.email && vals[1] === login.password && vals[2] === login.password && vals[3] === 'false' && (await sent()) === null, r.note)

const profile = { firstName: 'Test', lastName: 'User', country: 'Canada' } as unknown as Parameters<typeof _test.siteSignIn>[2]
await page.goto('https://sf.test/')
r = await _test.siteSignIn(page, { ...hooks, autoCreate: true }, profile)
check('no account: signs up, accepts the statement, creates the account', (await page.title()) === JSON.stringify([login.email, login.email, true, 'Test', 'User', 'Canada']), r.filled.join(', '))
await page.goto('https://sf2.test/')
r = await _test.siteSignIn(page, hooks, profile)
check('with "create accounts for me" off: form filled, nothing accepted or pressed', (await page.locator('#fbclc_pwdConf').inputValue()) === login.password && (await page.evaluate(() => !(window as unknown as { accepted?: boolean }).accepted)) && (await page.locator('h1').innerText()) === 'Create an Account', r.note)

await ctx.unroute('**/*')
await page.goto('data:text/html,' + encodeURIComponent(signIn(true)))
r = await _test.siteSignIn(page, hooks)
check('no password typed off https', (await page.locator('#pw').inputValue()) === '' && /not on a secure/.test(r.note), r.note)

// Workable: the optional Photo box (image/*) sits before the Resume box; the PDF must go only into Resume.
await page.goto('data:text/html,' + encodeURIComponent(`<label for="ph">Photo</label><input type="file" id="ph" name="avatar" accept="image/*"><label for="rs">Resume</label><input type="file" id="rs" name="resume">`))
const up = await _test.collectAll(page)
const ar = { filled: [] as string[], skipped: [] as string[] }
await _test.attachFiles(up, { pdfPath: '/tmp/ih-resume.pdf', coverPdfPath: null } as never, ar as never)
const names = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')].map(i => (i as HTMLInputElement).files?.length || 0))
check('resume goes in Resume, never the Photo box', names[0] === 0 && names[1] === 1, ar.filled.concat(ar.skipped).join(', '))

await browser.close()
console.log(bad ? `${bad} FAILED` : 'all passed')
process.exit(bad ? 1 : 0)
