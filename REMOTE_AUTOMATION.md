# Remote automation: handoff for the iMac session

Written 2026-11-22 on the MacBook, for a new Claude Code session on the iMac that will run J.A.R.V.I.S unattended.
**Claude: read this whole file before doing anything, then work through "Setup" with the user in order.**

## Goal

The iMac stays on at home and runs the whole pipeline without anyone at the screen: get jobs, score them, tailor
resumes, and auto-apply to the approved ones, with Chrome minimized (later headless). Anything only a person can
do (a CAPTCHA, a question the app cannot answer) goes on a "needs you" list instead of blocking the run.

## Ground rules (from the user, keep to them)

- Never press Submit while testing. Use the dry run (below), which stops just before Submit.
- Never solve or bypass CAPTCHAs (no solver services, no tricks). Flag them for the user.
- Application answers must be truthful. Work eligibility (citizenship, authorization, sponsorship per country) comes
  from the Profile page, stored only in the local database; do not change it without asking the user.
- Only good, relevant internships at well-known companies: the employer-quality rules in `src/main/filter.ts`
  (KNOWN list, four key US areas for lesser-known employers, UK only for KNOWN) are intentional. Do not loosen them.
- Gmail access is read-only (`gmail.readonly`), used only to finish email verification during applications.
- Chrome must never come to the front; auto-apply minimizes it.
- Commit only when the user asks. Branch off `main` first.

## What was done on 2026-11-22 (MacBook session)

- Per-country work eligibility (Canada / USA / UK) in Profile; form answers follow the job's country.
- UK region (KNOWN employers only); UK placement years (about 12 months) and UK-national / SC-clearance roles filtered.
- Jobs that refuse visa sponsorship are hidden in countries where the profile says sponsorship is needed.
- Oracle: false robot-check fixed (off-screen hCaptcha), "honeypot" trap field ignored, privacy box + its Accept
  dialog handled, cookie banners closed. Oracle then shows a real hCaptcha, which is correctly flagged.
- Workday: the "Sign in with Apple / Google / LinkedIn / Sign in with email" menu now works (it always failed before).
  Workday cookie bar is declined. Insulet went all the way to Review in a dry run.
- Workday Field of Study: Workday's search lists neighbours first and renders long lists in batches (KLA shows
  "Mechanical Engineering" 13th of 26, after "Electro-Mechanical Engineering"). The picker now scrolls the list,
  accepts only the exact discipline first, clicks options by exact text, and removes a wrong autofilled value.
  Only if no exact option exists does it take the closest one, and the report says so. Verified live on KLA.
- Postings taken down ("The page you are looking for doesn't exist") are flagged as closed, not "stuck".
- New job sources (LinkedIn is never scraped or opened; its terms forbid it and it would risk the user's account):
  - SimplifyJobs public internship list (`src/main/sources/simplify.ts`): listings are turned into the employer's own
    careers-site job ids (greenhouse/lever/ashby/workday/smartrecruiters), so they dedupe with boards and auto-apply
    normally. KNOWN employers whose careers site it reveals are saved as boards (kv `discoveredBoards`, 40 per refresh).
  - LinkedIn job-alert emails via read-only Gmail (`src/main/mail/linkedin-alerts.ts`): parses the cards (title,
    company, place). Jobs not found on a careers site are stored with source `linkedin`; auto-apply flags them
    ("apply on LinkedIn"). The user already receives these alerts (about 25 emails a week).
  - Both follow the good-company rule: outside Ontario only KNOWN employers or big curated boards (`isBigEmployer`).
- Region fix: a US state code after the city wins ("Burlington, MA" is USA, not Ontario); multi-place listings are
  judged by their most wanted place. Workday/other "429 too many requests" now retried with backoff (`getJson`).
- Auto-apply Chrome is headless by default (Settings › "Auto-apply's Chrome": hidden / minimized). Headless uses
  the same profile; "Open application" still shows a window.
- Refresh speed: a board taking over 60 s is skipped; postings read and rejected are remembered 14 days (kv
  `rejectedPostings`); Workday sites read OK are not re-read for 12 h (kv `workdayReadAt`); profile save clears both.
  Workday's API answers 429 to this computer's Node requests often (curl at the same moment gets 200). Do NOT spoof
  browser headers to get around it. The app stops at Workday's first refusal and backs off after 4 in a row.
- SuccessFactors: SAP UI5 date pickers (shadow DOM) are now read and typed (kind wddate, name ui5date); list
  options are awaited like Workday's. Westinghouse also asks the date each citizenship was obtained (not in profile).
- Additional documents (Profile page): files copied to `documents/`, classified (`src/main/docs.ts`, name/heading
  rules then Claude), attached to matching upload boxes (transcript, portfolio, reference, certificate...).
- KNOWN list gained well-known engineering employers (Texas Instruments, Rockwell Automation, Garmin, Keysight, Bose,
  ASML, Formlabs, Intuitive Surgical, Westinghouse, P&G and others); Lockheed Martin, General Dynamics and BAE
  Systems are also in US_DEFENSE.
- Chrome is minimized during auto-apply and never brought to the front.
- Gmail (read-only) connection in Settings; auto-apply uses it to type emailed codes or open emailed links.
- Dry-run report lists the problems the page shows; `IH_AUTOAPPLY_DEBUG=1` logs each Workday step.

Added 2026-11-23:
- AI provider switch (Settings › AI): Claude Code or Codex (ChatGPT sign-in), with matched model tiers
  (haiku/sonnet/opus = GPT Luna/Sol/Astra). Codex runs with every tool disabled; the app prefers ~/.local/bin/codex.
- Status page: live auto-apply run (job, page, steps), last run (kv `lastRun`), needs-you list, applied list.
- Jobs page: Clear filters, and Clear all auto-apply marks. Tailoring keeps running when you leave the tab.
- Form filling: profile address/city/postal code replace a site's resume-autofill guesses; up to 5 passes for chained
  follow-up questions; JSON replies read up to the first complete value; Workday "Page Error" / refused page gets
  one refill and retry; Workday sign-in pages with unnamed steps (Hitachi) are recognised.
- UK: Rolls-Royce Intern_Graduate site, Unilever early careers, GSK, AstraZeneca boards; 28 UK engineering employers
  added to KNOWN. Open question for the user: accept 10-week UK summers and 12-month placements (term rule 4-8 months)?

Known open issues:
- SuccessFactors (Aecon): all fields filled, but the page keeps "Please correct the errors below" and a warning on
  "Job-Specific Information". Probably a stale warning that clears on Apply; unconfirmed. If a real run is refused,
  the flag now quotes the page's error.
- PCL (SuccessFactors) and Oracle (Honeywell and others) use real CAPTCHAs: these will always need the user.
- Workday rate-limits fast bursts (429). Keep board fetches at 6 or fewer at once; dry runs one at a time.

## Setup

### 1. Code (on the MacBook, before leaving)
The work above is uncommitted. Ask the user to commit and push it (or let Claude do it when asked), then on the iMac:

```sh
git clone https://github.com/wamitar/jarvis-app.git ~/Documents/J.A.R.V.I.S/app   # or git pull if it exists
cd ~/Documents/J.A.R.V.I.S/app && npm install && npm run typecheck && npm run package
```

Needs: Node 24 (MacBook has v24.22.0), Google Chrome (the app drives the real Chrome), Claude Code CLI signed in
(`claude` in PATH; the app uses it for scoring, tailoring and answers). Tectonic is optional (LaTeX resumes).

### 2. Data (copy from the MacBook with the app quit on both Macs)
Copy the whole folder `~/Library/Application Support/internship-hunter/` from the MacBook to the same path on the
iMac (AirDrop a zip, or `rsync -a` over the network). It holds the database (jobs, profile, resume, settings), the
application browser profile `apply-browser/` (site cookies, so fewer sign-ins), and the resume PDF.
Do not copy `Singleton*` files inside `apply-browser/` if they exist.

Passwords are in the MacBook's Keychain and do not travel: on the iMac open Settings and enter the job-site login
again (Settings › Job site login), then connect Gmail (step 3).

### 3. Gmail, read-only (one-time, about 10 minutes, in a browser)
1. Go to https://console.cloud.google.com/ signed in as the Gmail account that receives job-site email.
2. Create a project, e.g. "JARVIS mail".
3. APIs & Services › Library › "Gmail API" › Enable.
4. APIs & Services › OAuth consent screen (Google Auth Platform): User type **External**; app name "JARVIS";
   support and developer email = your address. Under Data access / Scopes add `.../auth/gmail.readonly` only.
   Under Audience / Test users add your own Gmail address.
5. Credentials › Create credentials › OAuth client ID › Application type **Desktop app** › Create.
   Copy the client ID (ends in `.apps.googleusercontent.com`) and the client secret.
6. In J.A.R.V.I.S: Settings › Gmail for verification emails › paste both › Connect Gmail. Your browser opens
   Google's consent page; it warns the app is unverified (it is your own app): Continue, allow read access.
   The pill should say "Connected read-only: you@gmail.com".

Important: while the consent screen is in **Testing**, Google expires the sign-in after **7 days**. To avoid
reconnecting every week, set Publishing status to **In production** (Audience page). For your own account this
works without Google's review; you will see the "unverified app" warning once when connecting.
To revoke at any time: Settings › Disconnect (revokes at Google), or https://myaccount.google.com/permissions.

### 4. Keep the iMac able to run unattended
- System Settings › Energy (or Battery › Options): prevent automatic sleeping; allow wake for network access.
- Stay logged in to the macOS account (the Keychain must be unlocked for the saved passwords and Gmail token).
- Turn off "Close windows when quitting an app" only if Chrome restores old tabs badly; otherwise leave defaults.

### 5. Check it works (dry run, never submits)
Quit the app first (the dry run uses the same Chrome profile), then:

```sh
IH_AUTOAPPLY_DRYRUN=1 IH_AUTOAPPLY_DEBUG=1 node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-autoapply-real.ts "<job id>"
```
Job ids come from the database: `sqlite3 ~/Library/Application\ Support/internship-hunter/internship-hunter.db "select id from jobs where status='new' limit 5"`.
Good result: `dryrun | dry run: stopped just before pressing Submit`. Screenshots go to `autoapply-dryrun/`.

## Next work for the iMac session (planned, not started)

Do these in order; each ends with a dry-run check.

1. **Engine without Electron.** Move refresh, scoring, tailoring and auto-apply orchestration out of
   `src/main/index.ts` into `src/engine/` (no `electron` imports; `scripts/try-autoapply-real.ts` already shows how
   to call it). Add a CLI: `node --import ./scripts/resolve-ts.mjs scripts/jarvis.ts refresh|score|tailor|apply [--dry]`.
   The Electron app keeps working and just reads the same database.
2. **Browser mode setting: visible / minimized / headless.** Headless = `headless: true` with `channel: 'chrome'`
   (Chrome's new headless) and the same `apply-browser` profile. Dry-run about 10 jobs per system (Workday,
   Greenhouse, Lever, Ashby, SuccessFactors, Oracle) in minimized and headless, compare how far each gets, and keep
   minimized for any system where headless draws more CAPTCHAs. Record Playwright traces for flagged jobs.
3. **"Needs you" list.** CAPTCHA / unfillable required field / account step: keep the job in a "needs you" state
   with the screenshot and reason, send a macOS notification, and add a "Finish in browser" button that opens a
   visible window on that page (same profile, so the session is kept).
4. **Schedule with launchd.** A LaunchAgent (`~/Library/LaunchAgents/local.jarvis.pipeline.plist`) running the CLI
   every 4 hours from 8:00 to 22:00: refresh → score → tailor the best new matches → auto-apply the approved ones.
   Approval rules (ask the user for the numbers): minimum score, KNOWN employers only, at most N applications per day.
   Write a short daily summary (applied / flagged / needs you) the app shows on open.
5. **Reliability.** Retry Workday 429s with backoff; one application at a time per employer; before Submit, check
   the database and the page for "already applied"; the Stop switch in the app must stop the scheduled run too.

## Useful facts
- Data: `~/Library/Application Support/internship-hunter/internship-hunter.db` (SQLite; `kv` table holds profile,
  settings, resume, autoApply results). Back it up before changing anything by hand (`sqlite3 db ".backup file"`).
- Filter rules: `src/main/filter.ts`. Employer list: `src/main/companies.ts`. Form filling: `src/main/apply/prefill.ts`.
  Auto-apply loop: `src/main/apply/autoapply.ts`. Gmail: `src/main/mail/gmail.ts`.
- Tests: `npm run typecheck`, `node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-term-rules.ts`.
