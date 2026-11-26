// Stored jobs that point at the employer's own posting are checked again every few days, and hidden once the posting
// says it is closed. Careers-site readers only add jobs; without this a job stays in the list after it closes.
// Plain page loads only (no AI): the same check used for LinkedIn-alert lookups (verifyPosting).
import * as db from '../db'
import { verifyPosting } from './linkedin-resolve'

const KEY = 'postingChecks'
const RECHECK_AFTER = 3 * 86400_000
const WAITING = ['new', 'saved', 'tailored']

/** Rechecks up to `max` waiting jobs (least recently checked first). Returns how many were hidden as closed. */
export async function recheckOpenJobs(max: number, stop: () => boolean, each?: (done: number, total: number) => void): Promise<number> {
  const now = Date.now()
  const jobs = db.listJobs()
  const checked = db.kvGet<Record<string, number>>(KEY, {})
  const live = new Set(jobs.map(j => j.id))
  for (const id of Object.keys(checked)) if (!live.has(id)) delete checked[id]
  const todo = jobs.filter(j => WAITING.includes(j.status) && /^https:\/\//i.test(j.applyUrl || '') && !/linkedin\.com/i.test(j.applyUrl) &&
    now - (checked[j.id] || 0) > RECHECK_AFTER).sort((a, b) => (checked[a.id] || 0) - (checked[b.id] || 0)).slice(0, max)
  let hidden = 0, done = 0
  const queue = [...todo]
  const worker = async (): Promise<void> => {
    for (let j = queue.shift(); j && !stop(); j = queue.shift()) {
      try {
        const r = await verifyPosting(j.applyUrl, j)
        checked[j.id] = Date.now()
        // Only a posting that says it is closed is hidden; a page that failed to load or changed shape is left alone.
        if (typeof r === 'string' && /says it is closed/.test(r) && db.hideClosed(j.id, r)) hidden++
      } catch { /* one failed check never stops the rest */ }
      each?.(++done, todo.length)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  db.kvSet(KEY, checked)
  return hidden
}
