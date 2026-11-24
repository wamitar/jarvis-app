// Checks the app's fixed rules: required consent boxes, fields never filled, how sign-in and page messages are
// classified, and reading codes and links out of emails. No browser, no network, no AI.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-rules.ts
import { _test } from '../src/main/apply/prefill.ts'
import { _rules } from '../src/main/apply/autoapply.ts'
import { extract } from '../src/main/mail/gmail.ts'
import { companyTokens, isCopySite, titleCover } from '../src/main/sources/linkedin-resolve.ts'

let bad = 0
const check = (name: string, got: unknown, want: unknown): void => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`) }
const f = (kind: string, label: string, question = '', required = true, name = '') => ({ kind, label, question, required, name, idx: 0, value: '', options: [] }) as never

// Required tick boxes that only record agreement are always ticked.
check('tick: terms and conditions', _test.mustTick(f('checkbox', 'Yes, I have read and consent to the terms and conditions', 'Terms and Conditions')), true)
check('tick: privacy notice', _test.mustTick(f('checkbox', 'I acknowledge the Privacy Notice')), true)
check('tick: answers are true', _test.mustTick(f('checkbox', 'I confirm the information provided is accurate and complete')), true)
check('no tick: acknowledges sponsorship (a fact)', _test.mustTick(f('checkbox', 'I acknowledge I will require visa sponsorship')), false)
check('no tick: certifies a licence (a fact)', _test.mustTick(f('checkbox', 'I certify I hold a PE certification')), false)
check('no tick: optional consent', _test.mustTick(f('checkbox', 'I agree to receive marketing texts', '', false)), false)
check('no tick: "do not" wording', _test.mustTick(f('checkbox', 'I do not consent to background checks')), false)
check('no tick: a factual question', _test.mustTick(f('checkbox', 'I have a valid driver licence')), false)
check('no tick: a dropdown', _test.mustTick(f('dropdown', 'I agree to the terms')), false)

// Never filled: bot traps and boxes for secrets. Choice questions that merely mention them are answered.
check('never: honeypot', _test.never(f('text', 'Leave this field blank', '', false, 'honeypot')), true)
check('never: password box', _test.never(f('text', 'Password')), true)
check('never: SIN box', _test.never(f('text', 'Social Insurance Number')), true)
check('never: passport number', _test.never(f('text', 'Passport number')), true)
check('answer: legal-right dropdown mentioning SSN', _test.never(f('dropdown', 'Do you have the legal right to work in the U.S.? (Note: New hires must have a valid SSN)')), false)
check('answer: consent box mentioning passwords', _test.never(f('checkbox', 'I agree to the terms (keep your password safe)')), false)
check('answer: do you hold a passport (radio)', _test.never(f('radio', 'Do you hold a valid passport?')), false)
check('never: optional newsletter', _test.never(f('checkbox', "Get the latest Cummins' Jobs, News and Articles delivered to your inbox", '', false)), true)
check('never: optional job alerts', _test.never(f('checkbox', 'Send me job alerts', '', false)), true)
check('never: optional SMS', _test.never(f('checkbox', 'I agree to receive text messages about my application', '', false)), true)
check('never: optional emails about new job postings', _test.never(f('checkbox', 'I agree to receive emails about new job postings. Consent is not a condition of employment.', '', false)), true)
check('answer: required SMS consent', _test.never(f('checkbox', 'I agree to receive text messages about my application', '', true)), false)
check('answer: first name', _test.never(f('text', 'First name')), false)

// Contact boxes corrected from the profile: only the real street address, never "Email Address".
const OWN: [RegExp, string][] = [[/postal|zip/i, 'P'], [/\bcity\b|\btown\b/i, 'C'], [/^((home|street|mailing|current|residential) )?address( line)? ?1?$|^street( address)?( line)? ?1?$/i, 'A']]
check('own: Address', _test.ownValue(OWN, 'Address'), 'A')
check('own: Address Line 1', _test.ownValue(OWN, 'Address Line 1'), 'A')
check('own: Street', _test.ownValue(OWN, 'Street'), 'A')
check('own: Email Address is not the street', _test.ownValue(OWN, 'Email Address'), '')
check('own: Address Line 2 untouched', _test.ownValue(OWN, 'Address Line 2'), '')
check('own: Street Address Line 2 untouched', _test.ownValue(OWN, 'Street Address Line 2'), '')
check('own: City', _test.ownValue(OWN, 'City'), 'C')

// Page notes: what blocks an application.
const n = _rules.blockingNote
check('wrong password', n('Workday says: "You may have entered the wrong email address or password or your account might be locked.". '), 'sign-in not accepted')
check('verify account', n('Workday says: "Please verify your account before signing in.". '), 'email verification needed')
check('message with inner quote', n('Workday says: "The "Email" you entered needs verification first.". '), 'email verification needed')
check('refused earlier', n('Workday refused the saved login here earlier in this run, so the app will not try again'), 'sign-in not accepted')
check('ordinary progress note', n('Signed in. The next pages are filled as they appear.'), '')

// Job-page buttons that open the application (and ones that must not count).
for (const t of ['Apply', 'Apply now', "I'm interested", 'Apply for this job', 'Start application', 'Apply to this position']) check(`apply button: ${t}`, _rules.APPLY_TEXT.test(t), true)
for (const t of ['Applying tips', 'Submit application', 'Refer a friend', 'Apply filters']) check(`not an apply button: ${t}`, _rules.APPLY_TEXT.test(t), false)

// LinkedIn alert jobs found on the employer's site: job boards are refused; title and company must match.
for (const u of ['https://www.ziprecruiter.com/c/x/Job/y', 'https://ca.indeed.com/viewjob?jk=1', 'https://www.linkedin.com/jobs/view/1/', 'https://www.workopolis.com/jobsearch/viewjob/x', 'https://ca.jooble.org/jdp/1', 'https://aecom.jobs/mississauga-on/engineering-intern-airport-projects/69169361F4434697BA06B11FF676506E/job/']) check(`job board refused: ${new URL(u).hostname}`, isCopySite(u), true)
for (const u of ['https://eaton.eightfold.ai/careers/job/1', 'https://jobs.smartrecruiters.com/AECOM2/1-x', 'https://ejia.fa.us6.oraclecloud.com/hcmUI/x', 'https://jobs.lincolnelectric.com/job/x/1/', 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/x']) check(`employer site kept: ${new URL(u).hostname}`, isCopySite(u), false)
check('title cover: same title', titleCover('Engineering Intern - Airport Projects', 'AECOM Engineering Intern Airport Projects Mississauga'), 1)
check('title cover: place in brackets ignored', titleCover('Engineering Spring 2027 Internship (Toronto, Canada)', 'Engineering Spring 2027 Internship Mississauga'), 1)
check('title cover: other job is low', titleCover('Mechanical Design Intern', 'Electrical Test Technician Co-op') < 0.5, true)
check('company tokens: S&C Electric', companyTokens('S&C Electric Company').includes('scelectric'), true)
check('company tokens: Mondelez accents', companyTokens('Mondelēz International')[0], 'mondelez')
check('company tokens: Veolia | North America', companyTokens('Veolia | North America')[0], 'veolia')

// Code screens: Oracle's six digit boxes count; a full form with a "Verify your Email" box does not.
check('code screen: six digit boxes', _rules.isCodeScreen([1, 2, 3, 4, 5, 6].map(i => `Enter verification code digit ${i} of six.`)), true)
check('code screen: one code box', _rules.isCodeScreen(['Verification code']), true)
check('not a code screen: full form', _rules.isCodeScreen(['First Name', 'Last Name', 'Email', 'Verify your Email', 'Phone', 'Country', 'City']), false)

check('locked out: Oracle', _rules.lockedOut('Too Many Attempts. Try Again Later. You reached the maximum number of attempts. Try again in 30 minutes.'), 'the site paused sign-in after too many tries (try again in 30 minutes): run it again later')
check('not locked out: normal page', _rules.lockedOut('Enter the code we sent to your email.'), '')

// Emails: codes and links.
check('code in text', extract('Your verification code', 'Your one-time code is 482913. It expires in 10 minutes.', []), { code: '482913' })
check('workday activate link', extract('Verify your candidate account', 'Click to verify', ['https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc123']).link, 'https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc123')
check('reset link is not a verify link', extract('Reset your password', 'Reset here', ['https://acme.wd5.myworkdayjobs.com/passwordreset/xyz']).link, undefined)
check('greenhouse security code (HTML-only email, one line)', extract('Security code for your application to Formlabs', 'Copy and paste this code into the security code field on your application: 01877316 After you enter the code, resubmit your application. © 2026 Greenhouse 18 West 18th Street, 11th Floor, New York, NY 10011, USA', []).code, '01877316')
check('no year taken as code', extract('Verify your email', 'Welcome to the 2027 internship program. Click the link to confirm.', ['https://x.com/confirm?t=1']).code, undefined)

// httpFetch (used for Workday, which refuses Node's fetch): redirects, gzip, POST bodies, on a local server.
{
  const http = await import('node:http'); const zlib = await import('node:zlib'); const { httpFetch } = await import('../src/main/sources/util.ts')
  const srv = http.createServer((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { location: '/gz' }); res.end(); return }
    if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' }); res.end(zlib.gzipSync(JSON.stringify({ ok: 1 }))); return }
    let body = ''; req.on('data', c => { body += c }); req.on('end', () => { res.writeHead(201); res.end(`${req.method} ${body}`) })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const a = await httpFetch(`${base}/hop`)
  check('httpFetch: follows a redirect and unzips', `${a.status} ${new URL(a.url).pathname} ${JSON.stringify(await a.json())}`, '200 /gz {"ok":1}')
  const b = await httpFetch(`${base}/post`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'text/plain' } })
  check('httpFetch: sends a POST body', `${b.status} ${await b.text()}`, '201 POST x=1')
  srv.close()
}

console.log(bad ? `${bad} FAILED` : 'all passed')
process.exit(bad ? 1 : 0)
