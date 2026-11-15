import type { Coverage, Job, RawJob, RefreshProgress, RefreshResult, Settings } from '../shared/types'
import { emptyProfile, emptyResume } from '../shared/types'
import * as db from './db'
import { checkJob, isInternTitle, regionOf, usAllowed } from './filter'
import { allBoards, fetchAll, fetchDetail } from './sources'
import { pool } from './sources/util'
import { scoreJobs } from './match'

export async function scorePending(settings: Settings, progress: (p: RefreshProgress) => void): Promise<number> {
  const resume = db.kvGet('resume', emptyResume())
  if (!resume.name && !resume.experience.length && !resume.projects.length) throw new Error('Add your resume first, on the Resume page.')
  const pending: Job[] = db.unscoredJobs()
  if (!pending.length) return 0
  progress({ stage: 'Scoring', detail: 'Asking Claude to score the matches', done: 0, total: pending.length })
  return scoreJobs(pending, resume, db.kvGet('profile', emptyProfile()), settings.scoreModel, (scored, done, total) => {
    for (const s of scored) db.setScore(s.id, s.score, s.reasons, s.missing)
    progress({ stage: 'Scoring', detail: 'Asking Claude to score the matches', done, total })
  })
}

export async function refreshJobs(settings: Settings, progress: (p: RefreshProgress) => void): Promise<RefreshResult> {
  const result: RefreshResult = { fetched: 0, passed: 0, added: 0, scored: 0, removed: 0, errors: [] }
  const { jobs, errors } = await fetchAll(settings, (done, total, label) => progress({ stage: 'Fetching', detail: label, done, total }))
  result.fetched = jobs.length
  result.errors = errors

  const fresh = jobs.filter(j => !db.hasJob(j))
  const direct: { j: RawJob; region: Job['region'] }[] = []
  const needDetail: RawJob[] = []
  for (const j of fresh) {
    const v = checkJob(j)
    if (!v.keep) continue
    if (v.needBody) needDetail.push(j); else direct.push({ j, region: v.region })
  }
  let done = 0
  await pool(needDetail, 4, async j => {
    try {
      const d = await fetchDetail(j)
      const full: RawJob = { ...j, description: d.description, location: d.location || j.location }
      const v = checkJob(full)
      // After the detail fetch there is nothing more to learn, so a still-vague location at a large employer is accepted.
      // A lesser-known employer whose location is still vague cannot be placed in one of the four US areas, so it is dropped.
      const stillVague = regionOf(full.location) === 'unknown'
      if (v.keep && full.description && !(stillVague && !usAllowed(full.company, full.location))) direct.push({ j: full, region: stillVague ? 'usa' : v.region })
    } catch (e) { if (result.errors.length < 30) result.errors.push(`${j.company} posting: ${(e as Error).message}`) }
    progress({ stage: 'Reading postings', detail: j.company, done: ++done, total: needDetail.length })
  })
  result.passed = direct.length
  for (const { j, region } of direct) if (db.insertJob(j, region)) result.added++

  result.removed = db.pruneUsJobs((company, location) => usAllowed(company, location))

  // Per-company record of this run, so the user can see a company was searched even when nothing matched.
  const stored = db.countByCompany()
  const cov = new Map<string, Coverage>(allBoards(settings).map(b => [b.company, { company: b.company, read: 0, interns: 0, matched: stored[b.company] || 0 }]))
  for (const j of jobs) { const c = cov.get(j.company); if (c) { c.read++; if (isInternTitle(j.title)) c.interns++ } }
  for (const e of errors) { const c = cov.get(e.split(': ')[0]); if (c) c.error = e.slice(e.indexOf(': ') + 2) }
  db.kvSet('coverage', [...cov.values()])
  db.kvSet('lastRefresh', new Date().toISOString())
  return result
}
