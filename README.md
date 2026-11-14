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

## Limits

- LinkedIn and Indeed are not searched (they do not allow it). Use **Add a job by link** and paste the posting.
- Workday: save one email and password in Settings › Workday account (the password goes in the Mac Keychain). The app presses Apply, fills the sign-in or create-account page, then fills each page as you move through it. Meta and Tesla block automated readers; use **Add a job by link**.
- Government ID numbers, dates of birth and passwords are never filled.
- Adzuna (wider Ontario coverage) is optional and needs a free key, entered in Settings.

## Tests

- `npm run test:sources` checks the live job sources and the filter rules.
- `node scripts/e2e.mjs <folder>` drives the real app with a fictional resume in a throwaway data folder.
- `node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-prefill.ts` fills a mock Workday form with a fictional candidate (uses Claude).

Your data lives in `~/Library/Application Support/internship-hunter/`.
