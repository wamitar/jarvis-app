# J.A.R.V.I.S.

A Mac desktop app that finds mechanical engineering internships, tailors your resume to each one, and pre-fills the application for you to review and submit.

It uses the Claude Code sign-in on this Mac, so there is no API key and no extra bill: usage counts against your Claude plan.

## Run it

- Packaged app: open `release/mac-arm64/J.A.R.V.I.S.app`
- From source: `npm install`, then `npm run dev`
- Rebuild the packaged app: `npm run package`

## How it works

1. **Resume**: import your PDF once. Claude turns it into editable sections.
2. **Profile**: the answers typed into application forms (contact, school, work eligibility).
3. **Jobs → Get jobs**: reads about 160 company job boards (Greenhouse, Lever, Ashby, Workday, plus Amazon, Apple, Google, Microsoft, Netflix, Ford, Honeywell and Bosch) and Job Bank Canada. A strict filter keeps internships and co-ops with mechanical work: large employers and larger hardware startups in the USA and Canada, any company in Ontario. No Claude usage.
4. **Score with Claude**: a separate button scores the unscored jobs against your resume, 15 per call.
5. **Tailored resume**: Claude rewords and reorders your resume for one posting. It may not add anything, and the app flags any number or term that is not in your original. PDFs are saved in `Documents/J.A.R.V.I.S/`.
6. **Apply**: opens the application in Chrome and reads every field on the page: text boxes, dropdowns, Workday's list buttons and searchable pickers, radio buttons and tick boxes. Claude works out each answer from your profile, resume and the posting (work eligibility, citizenship, export control, relocation, how you heard, experience blocks, written answers), choosing "decline to answer" on demographic questions. Text is typed key by key so Workday registers it, a second pass catches follow-up questions, and anything required that is still empty is listed. It never presses Submit or solves CAPTCHAs.
7. **Common sense, not hard-coded answers**: the AI is told to answer the way a sensible person who knows you would (N/A for follow-ups that do not apply, "No" for history questions a student would say no to, LinkedIn for a required portfolio link, a realistic intern pay figure, education dates from your graduation date). Required fields still empty after the first pass get a second look, with what went wrong the first time. Only questions it truly cannot know (or self-identification you have not given) stop a job.
8. **Rejections from email**: Tracker › Check email for rejections reads your Gmail (read-only) for rejection emails, marks the matching tracked job Rejected with a note, and lists the ones it could not tie to a job (a role you are not tracking, or several roles at that company). Emails already checked are skipped next time.
9. **Answer once**: a flagged job lists the questions it could not answer on the Status page and in the job's detail. Type an answer there and it is kept in Profile › Saved answers and used on every later form that asks the same thing. Profile › Voluntary self-identification holds your gender / race / veteran / disability answers (blank = decline).
10. **Email (Gmail, read-only)**: Workday's "verify your account" links are opened automatically, including ones sent in an earlier run. Your password is the same everywhere, so a refused Workday sign-in is retried once on a fresh page (after checking the email and password were typed exactly); if it is still refused and no account exists there, the app creates one. It never uses "Forgot your password?", and it stops before an account could get locked.
11. **Resilience**: if the chosen AI (Claude or Codex) fails or times out, the other one answers instead; if tailoring fails, the job is applied with your last tailored or own resume instead of being skipped.
12. **Reads the site's own complaints**: a field the site marks wrong ("Invalid number.", "... is required") is answered again, with the site's message, before Submit is pressed. Fields labelled only "Make Selection Here" are given the question written above them.
13. **Job pages and sign-ins**: presses "Apply now" / "I'm interested" style links, handles email-first sign-in pages, and deletes empty extra Workday experience blocks. Required consent boxes (terms, privacy) are ticked; optional newsletters, job alerts and marketing boxes never are.
14. **LinkedIn alert jobs**: each job from a LinkedIn alert email is looked up on the employer's own careers site (the AI searches the web with only the job title, company and location). A link is kept only after the app loads it and sees the same title and company, never a job board or a re-post. The job then gets the full posting (for scoring and tailoring) and is auto-applied there. The first refresh reads every alert email you have; later refreshes read the new ones (alerts in other LinkedIn emails, such as "... are hiring", count too). A company missing from the app's employer list is judged once by the AI (large employer or larger hardware startup, or not). Up to 40 are looked up per refresh, newest first; scheduled runs auto-apply only the ones already found there. A miss is tried again after three days (after an hour when the site was only busy). LinkedIn itself is never opened.

## Scheduled runs (unattended)

`sh scripts/schedule.sh` installs a LaunchAgent (`local.jarvis.pipeline`) that starts the packaged app with `--scheduled-run` at 9:00 and 21:00. Each run gets jobs, scores them, then auto-applies to every open job that has no auto-apply mark yet (jobs flagged before are left for you; no daily limit). If the app is open, that copy does the run; otherwise it starts without a window and quits afterwards. The Stop switch stops it. The result shows on the Status page and in `scheduled-runs.log` in the data folder. `sh scripts/schedule.sh now` starts a run at once; `sh scripts/schedule.sh remove` uninstalls it.

## Limits

- LinkedIn and Indeed are not searched (they do not allow it). Jobs from LinkedIn alert emails are applied on the employer's own site when it is found there; jobs only on LinkedIn (Easy Apply) are flagged for you. Otherwise use **Add a job by link** and paste the posting.
- Workday: save one email and password in Settings › Workday account (the password goes in the Mac Keychain). The app presses Apply, fills the sign-in or create-account page, then fills each page as you move through it. Meta and Tesla block automated readers; use **Add a job by link**.
- Government ID numbers, dates of birth and passwords are never filled.
- Stops and flags (never works around): robot checks (SmartRecruiters often shows one), Apple Account sign-in (two-factor), a site asking to move your account to a new login (Amazon.jobs), a refused sign-in (no password resets, at most two tries), and a site that paused sign-in codes after too many tries (run it again later).
- Adzuna (wider Ontario coverage) is optional and needs a free key, entered in Settings.

## Tests

- `npm test` runs the offline checks: fixed rules, form reading on built-in pages, term and field-of-study rules, and auto-apply on stand-in sites (about 2 minutes, no AI, no network).
- `IH_AUTOAPPLY_DRYRUN=1 IH_PROFILE=<copy of the apply-browser folder> node --no-warnings --import ./scripts/resolve-ts.mjs scripts/try-autoapply-real.ts <job ids>` runs auto-apply on real postings and stops before Submit (add `IH_AUTOAPPLY_DEBUG=1` to keep each page's HTML).
- `npm run test:sources` checks the live job sources and the filter rules.
- `node scripts/e2e.mjs <folder>` drives the real app with a fictional resume in a throwaway data folder.
- `node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-prefill.ts` fills a mock Workday form with a fictional candidate (uses Claude).

Your data lives in `~/Library/Application Support/internship-hunter/`.
