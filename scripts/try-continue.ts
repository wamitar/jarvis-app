// Checks the Workday "Save and Continue" step on a stand-in page, with no Claude calls and no real site.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-continue.ts
import { chromium } from 'playwright-core'
import { _test } from '../src/main/apply/prefill.ts'
import type { PrefillResult } from '../src/shared/types.ts'

const html = (step: string, button: string, id = 'pageFooterNextButton', overlay = false): string => `
  <div data-automation-id="progressBar"><span data-automation-id="progressBarActiveStep">current step 2 of 5 ${step}</span></div>
  <div style="position:relative;display:inline-block">
    ${overlay ? `<div data-automation-id="click_filter" style="position:absolute;inset:0" onclick="go()"></div>` : ''}
    <button data-automation-id="${id}" onclick="go()">${button}</button></div>
  <script>window.pressed = 0; function go() { window.pressed++; document.querySelector('[data-automation-id=progressBarActiveStep]').textContent = 'current step 3 of 5 Next step' }</script>`
const res = (skipped: string[] = []): PrefillResult => ({ page: 'test', filled: [], skipped, note: '' } as unknown as PrefillResult)

const cases: [string, string, PrefillResult, boolean][] = [
  ['normal page', html('My Information', 'Save and Continue'), res(), true],
  ['older button id', html('My Experience', 'Save and Continue', 'bottom-navigation-next-button'), res(), true],
  ['click overlay', html('Application Questions', 'Save and Continue', 'pageFooterNextButton', true), res(), true],
  ['button says Next', html('Voluntary Disclosures', 'Next'), res(), true],
  ['button says Submit', html('Self Identify', 'Submit'), res(), false],
  ['Review step', html('Review', 'Save and Continue'), res(), false],
  ['Review step, Submit', html('Review', 'Submit'), res(), false],
  ['required field empty', html('My Information', 'Save and Continue'), res(['Phone (required, still empty)']), false]
]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
let bad = 0
for (const [name, body, r, expect] of cases) {
  await page.setContent(body)
  await _test.pressContinue(page, r)
  const pressed = (await page.evaluate(() => (window as unknown as { pressed: number }).pressed)) > 0
  if (pressed !== expect) bad++
  console.log(`${pressed === expect ? 'ok  ' : 'FAIL'} ${name}: ${pressed ? 'pressed' : 'not pressed'} — ${r.note}`)
}
await browser.close()
console.log(bad ? `${bad} FAILED` : 'all passed')
process.exit(bad ? 1 : 0)
