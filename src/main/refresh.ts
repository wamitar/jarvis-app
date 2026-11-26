import type { Board, Coverage, Job, RawJob, RefreshProgress, RefreshResult, Settings } from '../shared/types'
import { emptyProfile, emptyResume } from '../shared/types'
import * as db from './db'
import { checkJob, isInternTitle, regionOf, setRulesFromProfile, textProblem, ukAllowed, usAllowed } from './filter'
import { allBoards, fetchAll, fetchDetail, setDiscoveredBoards } from './sources'
import { canonicalCompany, discoverBoards, isBigEmployer } from './sources/simplify'
import { classifyCompanies, loadCompanySizes } from './sources/company-size'
import { fetchLinkedInAlerts, MAX_ALERT_AGE_DAYS } from './mail/linkedin-alerts'
import { resolvePending } from './sources/linkedin-resolve'
import { recheckOpenJobs } from './sources/recheck'
import * as gmail from './mail/gmail'
import { pool, withTimeout } from './sources/util'
import { aiFound, aiName } from './ai/claude'
import { scoreJobs } from './match'
import { US_DEFENSE } from './companies'
import { isStopping, checkStop } from './activity'

export async function scorePending(settings: Settings, progress: (p: RefreshProgress) => void): Promise<number> {
  const resume = db.kvGet('resume', emptyResume())
  if (!resume.name && !resume.experience.length && !resume.projects.length) throw new Error('Add your resume first, on the Resume page.')
  const pending: Job[] = db.unscoredJobs()
  if (!pending.length) return 0
  progress({ stage: 'Scoring', detail: `Asking ${aiName()} to score the matches`, done: 0, total: pending.length })
  return scoreJobs(pending, resume, db.kvGet('profile', emptyProfile()), settings.scoreModel, (scored, done, total) => {
    for (const s of scored) db.setScore(s.id, s.score, s.reasons, s.missing)
    progress({ stage: 'Scoring', detail: `Asking ${aiName()} to score the matches`, done, total })
  })
}

export async function refreshJobs(settings: Settings, progress: (p: RefreshProgress) => void, recheckRejected = false): Promise<RefreshResult> {
  const result: RefreshResult = { fetched: 0, passed: 0, added: 0, scored: 0, removed: 0, closed: 0, errors: [] }
  setRulesFromProfile({ ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) })
  loadCompanySizes()
  setDiscoveredBoards(db.kvGet<Board[]>('discoveredBoards', []))
  const workdayReadAt = db.kvGet<Record<string, number>>('workdayReadAt', {})
  const { jobs, errors } = await fetchAll(settings, (done, total, label) => progress({ stage: 'Fetching', detail: label, done, total }), workdayReadAt)
  db.kvSet('workdayReadAt', workdayReadAt)
  // Careers sites of KNOWN employers that the SimplifyJobs list revealed: read in full from the next refresh on.
  const found = discoverBoards(jobs, allBoards(settings), 40)
  if (found.length) db.kvSet('discoveredBoards', [...db.kvGet<Board[]>('discoveredBoards', []), ...found])
  let commitLinkedIn: (() => void) | null = null
  // LinkedIn job alerts the user receives by email (read-only Gmail). LinkedIn itself is never opened.
  if (settings.useLinkedInAlerts !== false && gmail.connected()) {
    progress({ stage: 'Fetching', detail: 'LinkedIn job alerts (Gmail)', done: 0, total: 1 })
    try {
      // Once (until it completes): every alert mail there is. After that: since the last read, with a day of overlap.
      // Message ids already read are remembered, so overlapping or resumed reads do not fetch them again.
      const backfill = !db.kvGet<boolean>('linkedinBackfill', false)
      const since = db.kvGet<string | null>('linkedinAlertsRead', null)
      const startedAt = new Date().toISOString()
      const seenList = db.kvGet<string[]>('linkedinSeenMsgs', [])
      const r = await withTimeout(fetchLinkedInAlerts([...jobs, ...db.listJobs()], backfill || !since ? null : Date.parse(since) - 86400_000, {
        seen: new Set(seenList), stop: isStopping, budgetMs: backfill ? 600_000 : 180_000,
        progress: (d, n) => progress({ stage: 'Fetching', detail: `LinkedIn job alerts (Gmail) ${d}/${n}`, done: d, total: n })
      }), (backfill ? 600_000 : 180_000) + 60_000, 'LinkedIn alerts')
      // Alert jobs at companies missing from the hand-made employer list: the AI judges once whether each is a large
      // employer or a larger hardware startup (cached 90 days), before the filter runs. Jobs whose company could not be
      // judged (no AI, failed batch) wait in 'linkedinUnjudged' and are retried next refresh.
      const queued = db.kvGet<RawJob[]>('linkedinUnjudged', [])
      const have = new Set(r.jobs.map(j => j.id))
      const all = [...r.jobs, ...queued.filter(j => !have.has(j.id))]
      let failed = new Set<string>()
      if (aiFound()) {
        try {
          const c = await classifyCompanies([...new Set(all.filter(j => !j.big).map(j => j.company))], settings.scoreModel)
          failed = new Set(c.failed.map(n => n.toLowerCase()))
        } catch (e) {
          if (isStopping()) throw e
          errors.push(`LinkedIn employers: ${(e as Error).message.slice(0, 160)}`)
          failed = new Set(all.map(j => canonicalCompany(j.company).toLowerCase()))
        }
        for (const j of all) j.big = isBigEmployer(j.company)
      } else failed = new Set(all.map(j => canonicalCompany(j.company).toLowerCase()))
      const unjudged = all.filter(j => !j.big && failed.has(canonicalCompany(j.company).toLowerCase()))
      const unjudgedIds = new Set(unjudged.map(j => j.id))
      jobs.push(...all.filter(j => !unjudgedIds.has(j.id)))
      if (r.capped) errors.push('LinkedIn alerts: more than 3000 alert emails; the oldest were not read')
      // Committed only after the jobs below were inserted, so a stop or crash in between loses nothing.
      commitLinkedIn = () => {
        db.kvSet('linkedinSeenMsgs', [...seenList, ...r.processed].slice(-20000))
        db.kvSet('linkedinUnjudged', unjudged.slice(-2000))
        // A read that ran out of time keeps what it found and carries on from there next refresh.
        if (r.complete) { db.kvSet('linkedinAlertsRead', startedAt); if (backfill) db.kvSet('linkedinBackfill', true) }
        else errors.push(`LinkedIn alerts: read ${r.mails} mails so far, the rest is read next refresh`)
      }
    } catch (e) { errors.push(`LinkedIn alerts: ${(e as Error).message}`) }
  }
  result.fetched = jobs.length
  result.errors = errors

  // Postings read and turned down in the last two weeks are not read again (most of a refresh's time otherwise),
  // unless the user asked to recheck them (Jobs › Recheck rejected, after changing what they want).
  const REREAD_AFTER = 14 * 86400_000
  const now = Date.now()
  const rejected = Object.fromEntries(Object.entries(recheckRejected ? {} : db.kvGet<Record<string, number>>('rejectedPostings', {})).filter(([, at]) => now - at < REREAD_AFTER))
  const fresh = jobs.filter(j => !rejected[j.id] && !db.hasJob(j))
  const direct: { j: RawJob; region: Job['region'] }[] = []
  const needDetail: RawJob[] = []
  for (const j of fresh) {
    const v = checkJob(j)
    if (!v.keep) continue
    if (v.needBody) needDetail.push(j); else direct.push({ j, region: v.region })
  }
  let done = 0
  await pool(needDetail, 4, async j => {
    if (isStopping()) return
    try {
      const d = await withTimeout(fetchDetail(j), 30_000, 'reading the posting')
      const full: RawJob = { ...j, description: d.description, location: d.location || j.location }
      const v = checkJob(full)
      // After the detail fetch there is nothing more to learn, so a still-vague location at a large employer is accepted.
      // A lesser-known employer whose location is still vague cannot be placed in one of the four US areas, so it is dropped.
      const stillVague = regionOf(full.location) === 'unknown'
      if (v.keep && full.description && !(stillVague && !usAllowed(full.company, full.location))) direct.push({ j: full, region: stillVague ? 'usa' : v.region })
      else rejected[j.id] = now
    } catch (e) { if (result.errors.length < 30) result.errors.push(`${j.company} posting: ${(e as Error).message}`) }
    progress({ stage: 'Reading postings', detail: j.company, done: ++done, total: needDetail.length })
  })
  db.kvSet('rejectedPostings', rejected)
  checkStop()
  result.passed = direct.length
  for (const { j, region } of direct) if (db.insertJob(j, region)) result.added++
  commitLinkedIn?.()

  // LinkedIn-alert jobs: found on the employer's own site (the AI searches the web), so they carry the full posting
  // and can be auto-applied there. At most 40 per refresh; a miss is tried again after three days.
  if (settings.useLinkedInAlerts !== false && aiFound()) {
    try {
      await resolvePending(40, (d, n) => progress({ stage: 'Fetching', detail: 'LinkedIn jobs on employer sites', done: d, total: n }), isStopping)
    } catch (e) { result.errors.push(`LinkedIn jobs on employer sites: ${(e as Error).message.slice(0, 160)}`) }
  }

  // Closed postings leave the list: LinkedIn alerts too old to still be open, and stored jobs whose posting now says closed.
  result.closed = db.hideStaleLinkedIn(new Date(Date.now() - MAX_ALERT_AGE_DAYS * 86400_000).toISOString())
  try {
    result.closed += await recheckOpenJobs(80, isStopping, (d, n) => progress({ stage: 'Fetching', detail: 'Checking saved jobs are still open', done: d, total: n }))
  } catch (e) { result.errors.push(`Checking jobs are still open: ${(e as Error).message.slice(0, 160)}`) }

  result.removed = db.pruneJobs(r => (r.region !== 'usa' || (usAllowed(r.company, r.location) && !US_DEFENSE.has(r.company))) && (r.region !== 'uk' || ukAllowed(r.company)) && !(r.description && textProblem(r.title, r.description, r.region, r.company)))

  // Per-company record of this run, so the user can see a company was searched even when nothing matched.
  const stored = db.countByCompany()
  const cov = new Map<string, Coverage>(allBoards(settings).map(b => [b.company, { company: b.company, read: 0, interns: 0, matched: stored[b.company] || 0 }]))
  for (const j of jobs) { const c = cov.get(j.company); if (c) { c.read++; if (isInternTitle(j.title)) c.interns++ } }
  for (const e of errors) { const c = cov.get(e.split(': ')[0]); if (c) c.error = e.slice(e.indexOf(': ') + 2) }
  db.kvSet('coverage', [...cov.values()])
  db.kvSet('lastRefresh', new Date().toISOString())
  return result
}
