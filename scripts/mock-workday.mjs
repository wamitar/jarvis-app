// A local stand-in for a Workday tenant, using the same data-automation-id hooks, for testing the apply flow.
// It records what was typed (never the password itself, only its length and whether both entries match).
import http from 'node:http'

export function startMockWorkday() {
  const log = []
  const page = body => `<!doctype html><meta charset="utf-8"><title>Mock Workday</title><body style="font:15px sans-serif;margin:30px;max-width:560px">${body}
  <script>const rec = o => fetch('/record', { method: 'POST', body: JSON.stringify(o) }); const v = id => document.querySelector('[data-automation-id="' + id + '"]')</script>`
  const pages = {
    '/job': page(`<h2>Mechanical Engineering Intern</h2><a href="#" data-automation-id="adventureButton" onclick="document.getElementById('m').hidden=false;rec({event:'apply-clicked'});return false">Apply</a>
      <div id="m" hidden><a data-automation-id="autofillWithResume" href="/login?start=resume">Autofill with Resume</a> <a data-automation-id="applyManually" href="/login?start=manual">Apply Manually</a></div>`),
    '/login': page(`<h2 id="h">Sign In</h2>
      <label for="e">Email Address</label><input id="e" data-automation-id="email"><br>
      <label for="p">Password</label><input id="p" type="password" data-automation-id="password"><br>
      <div id="c" hidden><label for="p2">Verify New Password</label><input id="p2" type="password" data-automation-id="verifyPassword"><br>
        <input type="checkbox" id="cb" data-automation-id="createAccountCheckbox"><label for="cb">I agree</label>
        <div style="position:relative;display:inline-block"><div data-automation-id="click_filter" role="button" aria-label="Create Account" style="position:absolute;inset:0" onclick="send('create')"></div><button data-automation-id="createAccountSubmitButton">Create Account</button></div></div>
      <div id="s"><div style="position:relative;display:inline-block"><div data-automation-id="click_filter" role="button" aria-label="Sign In" style="position:absolute;inset:0" onclick="send('signin')"></div><button data-automation-id="signInSubmitButton">Sign In</button></div>
        <button data-automation-id="createAccountLink" onclick="document.getElementById('c').hidden=false;document.getElementById('s').hidden=true;document.getElementById('h').textContent='Create Account'">Create Account</button></div>
      <script>
        const snap = extra => ({ page: 'login', start: new URLSearchParams(location.search).get('start'), email: v('email').value, pwLen: v('password').value.length, match: v('password').value === v('verifyPassword').value, agreed: v('createAccountCheckbox').checked, ...extra })
        setInterval(() => rec(snap({ event: 'typed' })), 700)
        async function send(kind) { await rec(snap({ event: kind })); location.href = '/en-US/site/job/apply/step1' }
      </script>`),
    '/en-US/site/job/apply/step1': page(`<div data-automation-id="progressBar"><span data-automation-id="progressBarActiveStep">current step 1 of 3 My Information</span></div>
      <label for="g">Given Name(s)</label><input id="g"><br><label for="f">Family Name</label><input id="f"><br><label for="ph">Phone Number</label><input id="ph"><br><label for="ci">City</label><input id="ci"><br>
      <label for="co">Country</label><button id="co" aria-haspopup="listbox" onclick="document.getElementById('opts').hidden=false">Select One</button>
      <ul id="opts" hidden>${['United States of America', 'Canada', 'Mexico'].map(o => `<li role="option" onclick="document.getElementById('co').textContent='${o}';this.parentNode.hidden=true">${o}</li>`).join('')}</ul>
      <label for="dt">Phone Device Type</label><button id="dt" aria-haspopup="listbox" onclick="document.getElementById('o2').hidden=false">Select One</button>
      <ul id="o2" hidden>${['Landline', 'Mobile'].map(o => `<li role="option" onclick="document.getElementById('dt').textContent='${o}';this.parentNode.hidden=true">${o}</li>`).join('')}</ul>
      <br><button data-automation-id="bottom-navigation-next-button" onclick="rec({event:'NEXT-PRESSED-BY-APP'})">Save and Continue</button>
      <script>let full = 0; setInterval(async () => { const s = { page: 'step1', event: 'typed', given: g.value, family: f.value, phone: ph.value, city: ci.value, country: co.textContent, device: dt.textContent }; await rec(s)
        if (s.given && s.country !== 'Select One' && ++full === 4) location.href = '/en-US/site/job/apply/step2' /* stands in for the user pressing Save and Continue */ }, 700)</script>`),
    '/en-US/site/job/apply/step2': page(`<div data-automation-id="progressBar"><span data-automation-id="progressBarActiveStep">current step 2 of 3 My Experience</span></div>
      <label for="r">Resume/CV</label><input id="r" type="file" data-automation-id="file-upload-input-ref"><br><label for="li">LinkedIn</label><input id="li"><br>
      <label for="sp">Will you now or in the future require sponsorship?</label><button id="sp" aria-haspopup="listbox" onclick="document.getElementById('o3').hidden=false">Select One</button>
      <ul id="o3" hidden>${['Yes', 'No'].map(o => `<li role="option" onclick="document.getElementById('sp').textContent='${o}';this.parentNode.hidden=true">${o}</li>`).join('')}</ul>
      <br><button data-automation-id="bottom-navigation-next-button" onclick="rec({event:'NEXT-PRESSED-BY-APP'})">Submit</button>
      <script>setInterval(() => rec({ page: 'step2', event: 'typed', file: r.files[0] ? r.files[0].name : '', linkedin: li.value, sponsorship: sp.textContent }), 700)</script>`)
  }
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/record') { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { log.push(JSON.parse(b)) } catch {} res.end('ok') }); return }
    if (pages[path]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[path]); return }
    res.writeHead(404); res.end('not found')
  })
  return new Promise(resolve => server.listen(47811, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close(), last: (pred) => [...log].reverse().find(pred) })))
}
