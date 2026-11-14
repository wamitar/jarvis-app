// Drives the real prefill code against a mock Workday-style form, using the real Claude CLI.
// Usage: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-prefill.ts
import { chromium } from 'playwright-core'
import { _test } from '../src/main/apply/prefill'
import { emptyProfile, emptyResume, type Job, type Profile, type Resume } from '../src/shared/types'

const URL_ = 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/apply/applyManually'

const listbox = (id: string, label: string, opts: string[], req = true): string => `
  <div class="fld"><label for="${id}">${label}${req ? ' *' : ''}</label>
  <button id="${id}" aria-haspopup="listbox" ${req ? 'aria-required="true"' : ''} onclick="document.getElementById('${id}-l').hidden=false">Select One</button>
  <ul id="${id}-l" role="listbox" hidden>${opts.map(o => `<li role="option" onclick="document.getElementById('${id}').textContent=this.textContent;this.parentNode.hidden=true">${o}</li>`).join('')}</ul></div>`
const radios = (name: string, q: string, opts = ['Yes', 'No']): string => `
  <fieldset><legend>${q} *</legend>${opts.map((o, i) => `<input type="radio" name="${name}" id="${name}${i}" value="${i}" required><label for="${name}${i}">${o}</label>`).join(' ')}</fieldset>`
// Workday-like text input: its value only "counts" when real key presses arrive.
const keyInput = (id: string, label: string): string => `<div class="fld"><label for="${id}">${label} *</label><input id="${id}" aria-required="true" class="kb"></div>`

const html = `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:20px">
<div data-automation-id="progressBar"><span data-automation-id="progressBarActiveStep">current step 2 of 5 Application Questions</span></div>
<h2>My Information</h2>
${keyInput('given', 'Given Name(s)')}${keyInput('family', 'Family Name')}${keyInput('addr', 'Address Line 1')}${keyInput('postal', 'Postal Code')}
${listbox('dev', 'Phone Device Type', ['Landline', 'Mobile', 'Telephone'])}
${listbox('ctry', 'Country Phone Code', ['Canada (+1)', 'Mexico (+52)', 'United States of America (+1)'])}
<div class="fld"><label for="hear">How Did You Hear About Us? *</label>
  <input id="hear" data-uxi-widget-type="selectinput" aria-required="true" onfocus="showHear(false)" onkeydown="if(event.key==='Enter')showHear(true)">
  <ul id="hear-l" role="listbox" hidden></ul><span id="hear-v"></span></div>
<h2>Application Questions</h2>
${radios('auth', 'Are you legally authorized to work in the United States?')}
${radios('spon', 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?')}
${radios('itar', 'This position requires access to export-controlled information. Are you a U.S. Person as defined by ITAR (U.S. citizen, permanent resident, or protected individual)?')}
${listbox('prev', 'Have you previously been employed by Acme Aerospace or any of its subsidiaries?', ['No', 'Yes'])}
${listbox('reloc', 'Are you willing to relocate to Bohemia, NY for the duration of this internship?', ['Yes', 'No'])}
${listbox('age', 'Are you at least 18 years of age?', ['Yes', 'No'])}
<div class="fld"><label for="why">Why are you interested in this internship? *</label><textarea id="why" class="kb" aria-required="true" maxlength="600"></textarea></div>
<h2>Work Experience 1</h2>
${keyInput('jt', 'Job Title')}${keyInput('co', 'Company')}
<div class="fld"><label for="rd">Role Description *</label><textarea id="rd" class="kb" aria-required="true"></textarea></div>
<h2>Voluntary Disclosures</h2>
${listbox('gender', 'Gender', ['Male', 'Female', 'I do not wish to answer'])}
${listbox('vet', 'Veteran Status', ['I am a protected veteran', 'I am not a protected veteran', 'I do not wish to self-identify'])}
${radios('dis', 'Disability status', ['Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'])}
<div class="fld"><input type="checkbox" id="terms" required><label for="terms">I have read and consent to the terms and conditions *</label></div>
<div class="fld"><input type="checkbox" id="news"><label for="news">Send me marketing emails about future jobs</label></div>
<script>
  document.querySelectorAll('.kb').forEach(el => { el.dataset.typed = ''; el.addEventListener('keydown', e => { el.dataset.typed = 'yes' }) })
  const cats = { 'Job Board': ['LinkedIn', 'Indeed', 'Handshake'], 'Company Website': ['Acme Careers Site'], 'Referral': ['Employee Referral'] }
  function showHear(searched) {
    const l = document.getElementById('hear-l'), q = document.getElementById('hear').value.toLowerCase()
    const items = searched && q ? Object.values(cats).flat().filter(x => x.toLowerCase().includes(q)) : Object.keys(cats)
    l.innerHTML = items.map(x => '<li role="option">' + x + '</li>').join(''); l.hidden = false
    l.querySelectorAll('li').forEach(li => li.onclick = () => {
      if (cats[li.textContent]) { l.innerHTML = cats[li.textContent].map(x => '<li role="option">' + x + '</li>').join(''); l.querySelectorAll('li').forEach(s => s.onclick = () => pick(s.textContent)); return }
      pick(li.textContent)
    })
  }
  function pick(t) { document.getElementById('hear-v').innerHTML = '<span data-automation-id="selectedItem">' + t + '</span>'; document.getElementById('hear-l').hidden = true }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('[role=listbox]').forEach(l => l.hidden = true) })
</script>`

const profile: Profile = { ...emptyProfile(), firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com', phone: '4165550199', address: '12 Example St',
  city: 'Ottawa', province: 'Ontario', postalCode: 'K1A 0B1', country: 'Canada', school: 'Carleton University', degree: 'Bachelor of Engineering',
  major: 'Mechanical Engineering', graduation: 'April 2029', citizenship: 'United States and Canada', workAuthCanada: 'Yes', workAuthUsa: 'Yes',
  needsSponsorship: 'No', availability: 'May 2027', termLength: '4 months', willingToRelocate: 'Yes' }
const resume: Resume = { ...emptyResume(), name: 'Sam Rivera',
  education: [{ school: 'Carleton University', degree: 'Bachelor of Mechanical Engineering', dates: '2024 - 2029', details: [] }],
  experience: [{ company: 'Ravens Formula SAE', title: 'Powertrain Team Member', location: 'Ottawa, ON', dates: 'Sept 2024 - Present',
    bullets: ['Ran CFD in ANSYS Fluent on the intake plenum', 'Built a flow bench test rig and compared results with simulation', 'Modelled cooling system parts in SolidWorks'] }],
  skills: [{ category: 'Tools', items: ['SolidWorks', 'ANSYS', 'MATLAB'] }] }
const job = { id: 't', source: 'manual', company: 'Acme Aerospace', title: 'Design Engineering Intern', location: 'Bohemia, NY', url: URL_, applyUrl: URL_,
  description: 'Summer internship designing aircraft components. Pay: $25 - $32 per hour. U.S. Person required (ITAR).', postedAt: null, big: true,
  region: 'usa', fetchedAt: '', score: null, reasons: [], missing: [], status: 'saved', notes: '', appliedAt: null, hasTailored: false } as Job

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const p = await browser.newPage()
await p.route('**/*', r => r.fulfill({ contentType: 'text/html', body: html }))
await p.goto(URL_)
const t0 = Date.now()
const res = await _test.fillCurrentPage(p, job, profile, resume, null, process.env.MODEL || 'sonnet', 'Workday: Application Questions')
console.log(`\nfilled in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log('FILLED:', res.filled)
console.log('DRAFTED:', res.drafted.map(d => `${d.question} => ${d.answer.slice(0, 90)}...`))
console.log('SKIPPED:', res.skipped)

const state = await p.evaluate(() => {
  const o: Record<string, string> = {}
  document.querySelectorAll('.kb').forEach(el => { o[el.id] = `${(el as HTMLInputElement).value.slice(0, 40)}${(el as HTMLElement).dataset.typed ? '' : '  <-- NOT TYPED'}` })
  document.querySelectorAll('button[aria-haspopup]').forEach(b => { o[b.id] = b.textContent || '' })
  document.querySelectorAll('fieldset').forEach(f => { const c = f.querySelector('input:checked'); o[(f.querySelector('input') as HTMLInputElement).name] = c ? (document.querySelector(`label[for="${c.id}"]`)?.textContent || '') : '(none)' })
  o.hear = document.getElementById('hear-v')?.textContent || '(none)'
  o.terms = String((document.getElementById('terms') as HTMLInputElement).checked)
  o.news = String((document.getElementById('news') as HTMLInputElement).checked)
  return o
})
console.log('\nPAGE STATE:'); for (const [k, v] of Object.entries(state)) console.log(`  ${k.padEnd(7)} ${v}`)
await browser.close()
