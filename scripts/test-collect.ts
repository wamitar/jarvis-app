// Checks how the app reads forms: which boxes count as application fields and what it learns about each one.
// Uses a hidden Chrome on small built-in pages. No network, no AI.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-collect.ts
import { chromium } from 'playwright-core'
import { _test } from '../src/main/apply/prefill.ts'

const html = `
<header><input placeholder="Search for jobs by title or keyword"><input placeholder="Location"></header>
<div id="onetrust-consent-sdk"><label><input type="checkbox" checked> Consent to all Advertising Cookies</label></div>
<style>[role=radio]{display:inline-block;width:14px;height:14px;border:1px solid #333;border-radius:50%}</style>
<div class="plyr"><input type="range" data-plyr="seek" aria-label="Seek"><input type="range" aria-label="Volume"></div>
<main><h2>Application</h2>
<fieldset><legend>Additional Questions</legend>
 <div><label for="rg1"><span>Are you enrolled in an Electrical Engineering program?</span></label>
  <div role="radiogroup" id="rg1" aria-labelledby="rg1_legend"><input type="radio" name="rg1" id="rg1a" aria-required="true"><label for="rg1a">Yes</label><input type="radio" name="rg1" id="rg1b"><label for="rg1b">No</label></div></div>
 <div><label for="rg2"><span>Do you hold a valid driver licence?</span></label>
  <div role="radiogroup" id="rg2"><input type="radio" name="rg2" id="rg2a"><label for="rg2a">Yes</label><input type="radio" name="rg2" id="rg2b"><label for="rg2b">No</label></div></div>
</fieldset>
<div><label id="sd_label" for="sd">Job Start Date</label><input role="combobox" aria-haspopup="dialog" aria-label="Select date" id="sd" placeholder="Select date" aria-labelledby="sd_label" aria-required="true"></div>
<fieldset><legend>Do you need sponsorship?</legend><input type="radio" name="sp" id="spa"><label for="spa">Yes</label><input type="radio" name="sp" id="spb"><label for="spb">No</label></fieldset>
<label for="em">* Email Address</label><input id="em" value="a@b.c" aria-invalid="true" aria-describedby="em-err"><div id="em-err" role="alert" class="errorMsg">Invalid email.</div>
<div class="field"><label for="sal">* What is your desired salary?</label><input id="sal" value="25 USD per hour"><div class="validation-error">Invalid number.</div></div>
<p><b>1. Are you one of the following?</b></p><ul><li>U.S. Citizen or National</li><li>U.S. Lawful Permanent Resident</li></ul>
<label for="ms">* Make Selection Here</label><select id="ms" required><option value="">No Selection</option><option>Yes</option><option>No</option></select>
<label id="q18">* Are you 18 years of age or older?</label>
<div role="radiogroup" aria-labelledby="q18"><span role="radio" aria-checked="false" aria-labelledby="y1" tabindex="0" onclick="this.setAttribute('aria-checked','true');this.nextElementSibling.nextElementSibling.setAttribute('aria-checked','false')"></span><label id="y1">Yes</label>
<span role="radio" aria-checked="false" aria-labelledby="n1" tabindex="0" onclick="this.setAttribute('aria-checked','true');this.previousElementSibling.previousElementSibling.setAttribute('aria-checked','false')"></span><label id="n1">No</label></div>
</main>`

let bad = 0
const check = (name: string, ok: boolean, info = ''): void => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + info}`) }
const b = await chromium.launch({ channel: 'chrome', headless: true })
const p = await b.newPage()
await p.setContent(html)
const fs = await _test.collectAll(p)
const by = (re: RegExp) => fs.find(x => re.test(x.f.label))
const show = JSON.stringify(fs.map(x => [x.f.kind, x.f.label, x.f.question, x.f.error]))
check('job-search boxes are not application fields', !fs.some(x => /search|location/i.test(x.f.label)), show)
check('radio in a section fieldset gets its own question', fs.some(x => x.f.kind === 'radio' && /Electrical Engineering program/.test(x.f.label)) && fs.some(x => x.f.kind === 'radio' && /driver licence/.test(x.f.label)), show)
check('fieldset legend still used for a one-question fieldset', fs.some(x => x.f.kind === 'radio' && /sponsorship/.test(x.f.label)), show)
check('calendar date box is a date, not a dropdown', fs.some(x => x.f.kind === 'wddate' && /Job Start Date/.test(x.f.label) && x.f.inputType === 'date MM/DD/YYYY'), show)
check('video player sliders are not application fields', !fs.some(x => /seek|volume/i.test(x.f.label)), show)
check('cookie banner is not an application field', !fs.some(x => /cookie/i.test(x.f.label)), show)
check('site error read at the field (aria-describedby)', by(/email/i)?.f.error === 'Invalid email.', show)
check('site error read at the field (error box beside it)', by(/salary/i)?.f.error === 'Invalid number.', show)
check('generic label gets the question above it', /Are you one of the following\?.*Citizen/.test(by(/make selection/i)?.f.question || ''), show)
const r = by(/18 years/i)
check('radio buttons drawn without <input> are read', !!r && r.f.kind === 'radio' && r.f.required && JSON.stringify(r.f.options) === '["Yes","No"]', show)
if (r) {
  const res = { filled: [] as string[], skipped: [] as string[], drafted: [], note: '', label: '' }
  await _test.applyAnswer(r, 'Yes', false, res as never)
  const now = (await _test.collectAll(p)).find(x => /18 years/i.test(x.f.label))
  check('choosing on such radio buttons sticks', now?.f.value === 'Yes', JSON.stringify(res))
}
// A page scrolled to the bottom (as before pressing Submit) still shows every field above; a box parked off the page does not count.
await p.setContent(`<input style="position:absolute;left:-9999px" name="trap1" aria-label="Phone extension"><label for="t">Top field</label><input id="t"><div style="height:5000px"></div><label for="b">Bottom field</label><input id="b">`)
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
const sc = await _test.collectAll(p)
check('fields scrolled past are still read', sc.some(x => x.f.label === 'Top field') && sc.some(x => x.f.label === 'Bottom field'), JSON.stringify(sc.map(x => x.f.label)))
check('box parked off the page is a trap', !sc.some(x => /extension/i.test(x.f.label)), JSON.stringify(sc.map(x => x.f.label)))
// Workday: completely empty extra experience blocks are deleted (last first); filled ones stay.
const block = (n: number, title: string) => `<div role="group" aria-labelledby="h${n}"><h4 id="h${n}">Work Experience ${n}</h4>
  <label for="t${n}">Job Title</label><input id="t${n}" value="${title}"><label for="c${n}">Company</label><input id="c${n}" value="${title ? 'Carleton' : ''}">
  <button aria-label="Delete Work Experience ${n}" onclick="this.parentNode.remove()">Delete</button></div>`
await p.setContent(block(1, 'Research Intern') + block(2, '') + block(3, ''))
const res2 = { filled: [] as string[], skipped: [] as string[], drafted: [], note: '', label: '' }
await _test.removeEmptyWorkdayBlocks(p, [], res2 as never)
const left = await p.locator('[role=group] h4').allInnerTexts()
check('empty Workday blocks removed, filled one kept', JSON.stringify(left) === '["Work Experience 1"]', JSON.stringify({ left, res2 }))
await b.close()
console.log(bad ? `${bad} FAILED` : 'all passed')
process.exit(bad ? 1 : 0)
