import type { Board, Coverage, Job, RawJob, RefreshProgress, RefreshResult, Settings } from '../shared/types'
import { emptyProfile, emptyResume } from '../shared/types'
import * as db from './db'
import { checkJob, isInternTitle, regionOf, setRulesFromProfile, textProblem, ukAllowed, usAllowed } from './filter'
import { allBoards, fetchAll, fetchDetail, setDiscoveredBoards } from './sources'
import { discoverBoards } from './sources/simplify'
import { fetchLinkedInAlerts } from './mail/linkedin-alerts'
import * as gmail from './mail/gmail'
import { pool, withTimeout } from './sources/util'
import { aiName } from './ai/claude'
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

export async function refreshJobs(settings: Settings, progress: (p: RefreshProgress) => void): Promise<RefreshResult> {
  const result: RefreshResult = { fetched: 0, passed: 0, added: 0, scored: 0, removed: 0, errors: [] }
  setRulesFromProfile({ ...emptyProfile(), ...db.kvGet('profile', emptyProfile()) })
  setDiscoveredBoards(db.kvGet<Board[]>('discoveredBoards', []))
  const workdayReadAt = db.kvGet<Record<string, number>>('workdayReadAt', {})
  const { jobs, errors } = await fetchAll(settings, (done, total, label) => progress({ stage: 'Fetching', detail: label, done, total }), workdayReadAt)
  db.kvSet('workdayReadAt', workdayReadAt)
  // Careers sites of KNOWN employers that the SimplifyJobs list revealed: read in full from the next refresh on.
  const found = discoverBoards(jobs, allBoards(settings), 40)
  if (found.length) db.kvSet('discoveredBoards', [...db.kvGet<Board[]>('discoveredBoards', []), ...found])
  // LinkedIn job alerts the user receives by email (read-only Gmail). LinkedIn itself is never opened.
  if (settings.useLinkedInAlerts !== false && gmail.connected()) {
    progress({ stage: 'Fetching', detail: 'LinkedIn job alerts (Gmail)', done: 0, total: 1 })
    try {
      // First time: the last 14 days of alerts. After that: since the last read, with a day of overlap.
      const since = db.kvGet<string | null>('linkedinAlertsRead', null)
      const startedAt = new Date().toISOString()
      jobs.push(...await withTimeout(fetchLinkedInAlerts([...jobs, ...db.listJobs()], since ? Date.parse(since) - 86400_000 : Date.now() - 14 * 86400_000), 120_000, 'LinkedIn alerts'))
      db.kvSet('linkedinAlertsRead', startedAt)
    } catch (e) { errors.push(`LinkedIn alerts: ${(e as Error).message}`) }
  }
  result.fetched = jobs.length
  result.errors = errors

  // Postings read and turned down in the last two weeks are not read again (most of a refresh's time otherwise).
  const REREAD_AFTER = 14 * 86400_000
  const now = Date.now()
  const rejected = Object.fromEntries(Object.entries(db.kvGet<Record<string, number>>('rejectedPostings', {})).filter(([, at]) => now - at < REREAD_AFTER))
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

  result.removed = db.pruneJobs(r => (r.region !== 'usa' || (usAllowed(r.company, r.location) && !US_DEFENSE.has(r.company))) && (r.region !== 'uk' || ukAllowed(r.company)) && !(r.description && textProblem(r.title, r.description, r.region)))

  // Per-company record of this run, so the user can see a company was searched even when nothing matched.
  const stored = db.countByCompany()
  const cov = new Map<string, Coverage>(allBoards(settings).map(b => [b.company, { company: b.company, read: 0, interns: 0, matched: stored[b.company] || 0 }]))
  for (const j of jobs) { const c = cov.get(j.company); if (c) { c.read++; if (isInternTitle(j.title)) c.interns++ } }
  for (const e of errors) { const c = cov.get(e.split(': ')[0]); if (c) c.error = e.slice(e.indexOf(': ') + 2) }
  db.kvSet('coverage', [...cov.values()])
  db.kvSet('lastRefresh', new Date().toISOString())
  return result
}
