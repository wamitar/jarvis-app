// End-to-end run of the real app against a throwaway data folder and a fictional resume.
// Usage: node scripts/e2e.mjs <outDir> [steps]   steps: comma list of import,refresh,list,score,tailor,prefill,workday
import { _electron as electron, chromium } from 'playwright-core'
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startMockWorkday } from './mock-workday.mjs'

const out = resolve(process.argv[2] || './e2e-out')
const steps = (process.argv[3] || 'import,refresh,list,score,tailor,prefill').split(',')
mkdirSync(out, { recursive: true })
const pdf = join(out, 'sample-resume.pdf')
const log = (...a) => console.log('[e2e]', ...a)

if (!existsSync(pdf)) {
  const b = await chromium.launch({ channel: 'chrome' })
  const p = await b.newPage()
  await p.setContent(`<body style="font:11pt Helvetica;margin:40px"><h1 style="margin:0">Sam Rivera</h1>
  <p>sam.rivera@example.com | 555-010-0199 | Waterloo, ON | linkedin.com/in/samrivera-example</p>
  <h3>EDUCATION</h3><p><b>University of Waterloo</b> — BASc Mechanical Engineering, Sept 2024 – Apr 2029 (expected)</p><ul><li>GPA 3.7/4.0; Dean's Honours List</li></ul>
  <h3>EXPERIENCE</h3><p><b>Mechanical Design Co-op</b>, Northfield Fixtures Inc., Guelph, ON — May 2026 – Aug 2026</p>
  <ul><li>Designed 6 welding fixtures in SolidWorks for a bracket assembly line, cutting changeover time by 18%</li><li>Produced GD&T drawings and ran tolerance stack-ups for 3 sheet-metal assemblies</li><li>Ran FEA in ANSYS on a lifting bracket and reduced its mass by 12% while keeping a safety factor of 3</li></ul>
  <p><b>Chassis Team Member</b>, Waterloo Formula Electric — Sept 2024 – Present</p>
  <ul><li>Designed and machined aluminium suspension uprights on a 3-axis CNC mill</li><li>Built a MATLAB script to compare suspension geometries for camber gain</li></ul>
  <h3>PROJECTS</h3><p><b>Desktop CNC Router</b> — SolidWorks, Arduino, 2025</p><ul><li>Designed and built a 3-axis router with a 300 x 300 mm work area and 0.1 mm repeatability</li><li>3D printed motor mounts in PETG and iterated the gantry design twice to remove flex</li></ul>
  <h3>SKILLS</h3><p><b>CAD/CAE:</b> SolidWorks, ANSYS, AutoCAD</p><p><b>Fabrication:</b> CNC milling, lathe, 3D printing, MIG welding</p><p><b>Software:</b> MATLAB, Python, Excel</p></body>`)
  await p.pdf({ path: pdf, format: 'Letter' }); await b.close()
  log('sample resume PDF written')
}

// E2E_APP = path to a packaged app's executable, to test the build instead of the source tree.
const app = await electron.launch({ ...(process.env.E2E_APP ? { executablePath: process.env.E2E_APP, args: [] } : { args: ['.'] }), env: { ...process.env, IH_USER_DATA: join(out, 'data'), IH_ONLY_BOARDS: process.env.IH_ONLY_BOARDS || 'zoox,skydio,magna', IH_WD_TEST_HOST: '127.0.0.1' } })
const w = await app.firstWindow()
w.on('console', m => { if (m.type() === 'error') log('renderer error:', m.text()) })
w.on('pageerror', e => log('page error:', e.message))
await w.waitForSelector('.brand')
log('window title:', await w.title(), '| brand:', await w.locator('.brand').textContent())
const pickJob = () => (process.env.E2E_JOB ? w.locator('.job', { hasText: process.env.E2E_JOB }).first() : w.locator('.job').first())
const shot = async n => { await w.screenshot({ path: join(out, n + '.png') }); log('screenshot', n) }
const toast = async () => (await w.locator('.toast').first().textContent({ timeout: 500 }).catch(() => null))
try {
  if (steps.includes('import')) {
    await shot('01-first-run')
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, pdf)
    await w.getByRole('button', { name: /Import PDF|Replace from PDF/ }).click()
    await w.waitForSelector('text=Contact', { timeout: 180000 })
    log('resume imported; name field =', await w.locator('.card input').first().inputValue())
    log('experience entries:', await w.locator('.card:has(h3:text-is("Experience")) .entry').count(), '| projects:', await w.locator('.card:has(h3:text-is("Projects")) .entry').count())
    await shot('02-resume')
    await w.getByRole('button', { name: 'Profile' }).click()
    log('profile first name =', await w.locator('label.f:has-text("First name") input').inputValue(), '| school =', await w.locator('label.f:has-text("School") input').first().inputValue())
    await w.locator('label.f:has-text("Authorized to work in Canada") select').selectOption('Yes')
    await w.locator('label.f:has-text("Authorized to work in the USA") select').selectOption('No')
    await w.locator('label.f:has-text("Need visa sponsorship") select').selectOption('Yes')
    await w.locator('label.f:has-text("Expected graduation") input').fill('April 2029')
    await w.locator('label.f:has-text("Available from") input').fill('May 2027')
    await w.getByRole('button', { name: 'Save changes' }).click()
    await shot('03-profile')
  }
  if (steps.includes('refresh')) {
    await w.getByRole('button', { name: 'Jobs' }).first().click()
    await w.getByRole('button', { name: 'Get jobs' }).click()
    await w.waitForSelector('.banner.good', { timeout: 900000 })
    log('refresh:', await w.locator('.banner.good span').textContent())
    log('source errors shown:', await w.locator('.banner.warn summary').textContent({ timeout: 500 }).catch(() => 'none'))
    log('jobs listed:', await w.locator('.job').count(), '| scored right after fetching:', await w.locator('.job .score:not(:text-is("–"))').count())
    log('token footer:', (await w.locator('.usage').innerText()).replace(/\n/g, ' | '))
  }
  if (steps.includes('list')) {
    await w.getByRole('button', { name: 'Jobs' }).first().click()
    const list = w.locator('.list')
    const m = await list.evaluate(e => ({ sh: e.scrollHeight, ch: e.clientHeight, win: innerHeight }))
    await list.hover(); await w.mouse.wheel(0, 600); await w.waitForTimeout(300)
    log('list scroll: content', m.sh, 'visible', m.ch, 'window', m.win, '| scrolled to', await list.evaluate(e => e.scrollTop))
    await shot('04a-scrolled')
    await list.evaluate(e => e.scrollTo(0, 0))
    const before = await w.locator('.job').count()
    const victim = (await w.locator('.job .t').nth(1).textContent())
    await w.locator('.job').nth(1).hover(); await w.locator('.job').nth(1).getByTitle('Not interested').click()
    await w.waitForTimeout(400)
    log('dismiss:', victim, '| list', before, '->', await w.locator('.job').count(), '| toast:', await toast())
    const applied = (await w.locator('.job .t').nth(1).textContent())
    await w.locator('.job').nth(1).getByTitle('I already applied').click()
    await w.waitForTimeout(400)
    log('applied:', applied, '| list now', await w.locator('.job').count())
    await w.locator('.filters select').first().selectOption('applied'); log('Applied filter shows:', await w.locator('.job .t').allTextContents())
    await w.locator('.filters select').first().selectOption('hidden'); log('Hidden filter shows:', await w.locator('.job .t').allTextContents())
    await w.locator('.job').first().getByTitle('Bring back').click(); await w.waitForTimeout(300)
    await w.locator('.filters select').first().selectOption('open')
    log('after bringing back:', await w.locator('.job').count())
    await w.getByRole('button', { name: 'Tracker' }).click(); log('tracker rows:', await w.locator('tbody tr').count()); await w.getByRole('button', { name: 'Jobs' }).first().click()
  }
  if (steps.includes('score')) {
    await w.getByRole('button', { name: 'Jobs' }).first().click()
    const btn = w.getByRole('button', { name: /Score \d+ unscored/ })
    log('score button:', await btn.textContent())
    await btn.click()
    await w.waitForSelector('.banner.good:has-text("Claude scored")', { timeout: 600000 })
    log('score:', await w.locator('.banner.good span').textContent())
    for (const j of await w.locator('.job').all().then(a => a.slice(0, 6))) log('  ', (await j.innerText()).replace(/\n+/g, ' | '))
    log('token footer:', (await w.locator('.usage').innerText()).replace(/\n/g, ' | '))
    await w.locator('.job').first().click()
    await shot('04-jobs')
  }
  if (steps.includes('tailor')) {
    await w.getByRole('button', { name: 'Jobs' }).first().click()
    await pickJob().click()
    await w.getByRole('button', { name: /Tailored resume/ }).click()
    await w.getByRole('button', { name: /Tailor my resume|Tailor again/ }).click()
    await w.waitForSelector('.diff', { timeout: 400000 })
    log('changes:', await w.locator('.card:has(h3:text-is("What Claude changed")) li').allTextContents())
    log('warnings:', await w.locator('.banner.warn li').allTextContents())
    await shot('05-tailored')
    await w.getByRole('button', { name: 'Save PDF' }).click()
    await w.waitForSelector('text=/PDF is \\d+ page/', { timeout: 60000 })
    log('pdf:', await w.locator('text=/PDF is \\d+ page/').textContent())
    const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [`${p} (${statSync(p).size} bytes)`] })
    log('files:', walk(join(out, 'data', 'pdfs')))
    await w.locator('.detail').evaluate(e => e.scrollTo(0, 0))
    await shot('06-saved')
  }
  if (steps.includes('prefill')) {
    await w.getByRole('button', { name: 'Jobs' }).first().click()
    await pickJob().click()
    await w.getByRole('button', { name: 'Apply', exact: true }).click()
    await w.getByRole('button', { name: 'Pre-fill application' }).click()
    await w.waitForSelector('text=/Filled \\(\\d+\\)/', { timeout: 240000 }).catch(async () => log('prefill did not finish; toast:', await toast()))
    log('filled:', await w.locator('.card:has(h3:text-matches("^Filled")) li').allTextContents())
    log('left:', await w.locator('.card:has(h3:text-matches("^Left for you")) li').allTextContents())
    log('drafted:', await w.locator('.card:has(h3:text-matches("^Answers")) b').allTextContents())
    log('note:', await w.locator('.banner.info').last().textContent())
    await shot('07-apply')
  }
  if (steps.includes('workday')) {
    const mock = await startMockWorkday()
    const secret = 'Tt1!' + randomBytes(6).toString('hex')   // throwaway test password, never printed
    try {
      await w.getByRole('button', { name: 'Settings' }).click()
      await w.locator('label.f:has-text("Workday email") input').fill('sam.rivera@example.com')
      await w.locator('.card:has(h3:text-is("Workday account")) input[type=password]').fill(secret)
      await w.getByRole('button', { name: 'Save to Keychain' }).click()
      await w.waitForSelector('.pill.good:has-text("Saved for")')
      log('settings:', await w.locator('.card:has(h3:text-is("Workday account")) .pill').textContent(), '| password box now empty:', (await w.locator('.card:has(h3:text-is("Workday account")) input[type=password]').inputValue()) === '')
      await shot('08-workday-settings')
      const dbText = await app.evaluate(async ({ app }) => { const fs = process.mainModule.require('node:fs'), path = process.mainModule.require('node:path'); const dir = app.getPath('userData'); return fs.readdirSync(dir).filter(f => f.startsWith('internship-hunter.db')).map(f => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('') })
      log('password found in app database files:', dbText.includes(secret))
      await w.getByRole('button', { name: 'Jobs' }).first().click()
      if (await w.locator('.job', { hasText: 'Mock' }).count()) await w.locator('.job', { hasText: 'Mock' }).first().click()   // reuse the job from an earlier run: no Claude call
      else {
        await w.getByRole('button', { name: 'Add a job by link' }).click()
        await w.locator('.card input[placeholder^="https"]').fill(mock.url + '/job')
        await w.locator('.card textarea').fill('Mechanical Engineering Intern at Mockwork Robotics, Toronto, Ontario, Canada. Summer 2027. Design fixtures in SolidWorks, run tolerance stack-ups, support CNC machining and testing. Requirements: enrolled in a mechanical engineering degree; CAD experience; GD&T.')
        await w.getByRole('button', { name: 'Add job', exact: true }).click()
        await w.waitForSelector('.detail h2:has-text("Mechanical")', { timeout: 120000 })
      }
      log('added job:', await w.locator('.detail h2').textContent(), '| score shown:', await w.locator('.detail .score').textContent())
      await w.getByRole('button', { name: 'Apply', exact: true }).click()
      await w.getByRole('button', { name: 'Pre-fill application' }).click()
      await w.waitForSelector('.detail h3:has-text("Workday")', { timeout: 60000 })
      await w.waitForSelector('.detail h3:has-text("create account")', { timeout: 30000 }).catch(() => {})
      log('page now:', await w.locator('.detail h3').first().textContent(), '| filled:', await w.locator('.card:has(h3:text-matches("^Filled")) li').allTextContents())
      await w.waitForTimeout(1500)
      const typed = mock.last(e => e.page === 'login' && e.event === 'typed')
      log('mock saw (auto-create OFF):', JSON.stringify({ ...typed, pwLenMatchesSecret: typed?.pwLen === secret.length }), '| create pressed:', mock.log.some(e => e.event === 'create'), '| apply clicked:', mock.log.some(e => e.event === 'apply-clicked'))
      await shot('09-workday-create')
      await w.getByRole('button', { name: 'Settings' }).click()
      await w.locator('label:has-text("press Create Account for me") input[type=checkbox]').check()
      await w.getByRole('button', { name: 'Jobs' }).first().click()
      await w.locator('.job', { hasText: 'Mock' }).first().click()
      await w.getByRole('button', { name: 'Apply', exact: true }).click()
      await w.getByRole('button', { name: 'Pre-fill application' }).click()
      await w.waitForSelector('.detail h3:has-text("My Experience")', { timeout: 90000 })
      await w.waitForTimeout(2500)
      log('create event:', JSON.stringify(mock.last(e => e.event === 'create')))
      log('step1:', JSON.stringify(mock.last(e => e.page === 'step1')))
      log('step2:', JSON.stringify(mock.last(e => e.page === 'step2')))
      log('app pressed Next/Submit:', mock.log.some(e => e.event === 'NEXT-PRESSED-BY-APP'))
      log('earlier pages:', await w.locator('.log > div').allTextContents())
      await shot('10-workday-flow')
    } finally {
      await w.getByRole('button', { name: 'Settings' }).click().catch(() => {})
      await w.getByRole('button', { name: 'Remove login' }).click().catch(() => {})
      await w.waitForTimeout(500)
      mock.close()
    }
  }
} catch (e) { log('FAILED:', e.message.split('\n').slice(0, 4).join(' / ')); log('toast:', await toast()); await shot('99-failure') }
log('usage:', (await w.locator('.usage').innerText()).replace(/\n/g, ' | '))
if (!process.env.E2E_KEEP_OPEN) await app.close()
