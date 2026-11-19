import type { Job, Profile, Resume } from '../shared/types'
import { resumeToText } from '../shared/types'
import { askJson } from './ai/claude'
import { checkStop } from './activity'

interface Scored { id: string; score: number; reasons: string[]; missing: string[] }

const BATCH = 15

export async function scoreJobs(jobs: Job[], resume: Resume, profile: Profile, model: string,
  onBatch: (scored: Scored[], done: number, total: number) => void): Promise<number> {
  let done = 0
  for (let i = 0; i < jobs.length; i += BATCH) {
    checkStop()
    const batch = jobs.slice(i, i + BATCH)
    const listing = batch.map((j, n) =>
      `<job n="${n}">\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location}\n${j.description.slice(0, 1800)}\n</job>`).join('\n')
    const prompt = `Score how well this candidate fits each internship posting.

<resume>
${resumeToText(resume)}
</resume>

Candidate facts: studying ${profile.major || 'Mechanical Engineering'} at ${profile.school || 'university'}; graduates ${profile.graduation || 'unknown'}; available ${profile.availability || 'unknown'}; based in ${[profile.city, profile.province].filter(Boolean).join(', ') || 'Canada'}.

<jobs>
${listing}
</jobs>

For each job give a score from 0 to 100:
- 80-100: mechanical-engineering internship whose main requirements the resume clearly meets.
- 50-79: relevant internship with some gaps (missing tools, wrong year of study, adjacent discipline).
- under 50: weak fit, a different discipline, requires a graduate degree, or is not an internship or co-op.
Be strict and use the whole range.

Reply with a JSON array, one object per job, in the same order:
[{"n": 0, "score": 0, "reasons": ["up to 3 short reasons it fits"], "missing": ["up to 3 short gaps or requirements not met"]}]`
    const res = await askJson<{ n: number; score: number; reasons?: string[]; missing?: string[] }[]>(prompt, { model })
    const scored: Scored[] = []
    for (const r of Array.isArray(res) ? res : []) {
      const job = batch[r.n]
      if (!job || typeof r.score !== 'number') continue
      scored.push({ id: job.id, score: Math.max(0, Math.min(100, Math.round(r.score))),
        reasons: (r.reasons || []).slice(0, 3).map(String), missing: (r.missing || []).slice(0, 3).map(String) })
    }
    done += batch.length
    onBatch(scored, done, jobs.length)
  }
  return done
}
