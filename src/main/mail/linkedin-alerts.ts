// LinkedIn job alerts, read from the user's own email (read-only Gmail). LinkedIn itself is never opened or
// scraped: the alert emails LinkedIn sends already name each job's title, company and place.
//
// A job that the careers-site sources already found (same company and title) is left to that copy, which has the
// full posting and can be auto-applied. Others are added with their LinkedIn link, for the user to open and apply.
import type { RawJob } from '../../shared/types'
import { canonicalCompany, companyKey, isBigEmployer } from '../sources/simplify'
import { searchMessages } from './gmail'

export interface AlertJob { linkedinId: string; title: string; company: string; location: string }

// Lines in an alert that are not part of a job card's title / company / place.
const NOISE = /^(your job alert for|you may be a fit|jobs? you may|new jobs?|see all jobs|\d+\+? new jobs?|view job|unsubscribe|manage (job )?alerts|-{5,})/i

/** Reads the job cards out of one alert email's text part. */
export function parseAlert(text: string): AlertJob[] {
  const out: AlertJob[] = []
  const re = /View job:\s*https:\/\/www\.linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)\S*/g
  let last = 0
  for (const m of text.matchAll(re)) {
    // The card is the text between the previous card's link (or a separator line) and this link.
    const chunk = text.slice(last, m.index).split(/\n-{5,}\s*\n/).pop() || ''
    last = (m.index || 0) + m[0].length
    const lines = chunk.split('\n').map(l => l.trim()).filter(l => l && !NOISE.test(l))
    if (lines.length < 3) continue
    const [title, company, location] = lines
    if (title.length > 150 || company.length > 100) continue
    out.push({ linkedinId: m[1], title, company, location })
  }
  return out
}

const titleKey = (s: string): string => s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Jobs from LinkedIn alert emails received since `since` (ms). `have` = jobs already found by the other sources
 * in this refresh; an alert job matching one of them (same company, same title) is skipped.
 */
export async function fetchLinkedInAlerts(have: { company: string; title: string }[], since: number): Promise<RawJob[]> {
  const after = Math.floor(since / 1000)
  const mails = await searchMessages(`from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobs-listings@linkedin.com) after:${after}`, 60)
  const known = new Set(have.map(j => `${companyKey(j.company)}|${titleKey(j.title)}`))
  const out = new Map<string, RawJob>()
  for (const mail of mails) {
    for (const a of parseAlert(mail.text)) {
      const company = canonicalCompany(a.company)
      if (known.has(`${companyKey(company)}|${titleKey(a.title)}`)) continue
      const url = `https://www.linkedin.com/jobs/view/${a.linkedinId}/`
      const id = `linkedin:${companyKey(company).replace(/ /g, '-') || 'company'}:${a.linkedinId}`
      out.set(id, {
        id, source: 'linkedin', company, title: a.title, location: a.location, url, applyUrl: url,
        description: `${a.title}\n${a.company}\n${a.location}\n\nFrom your LinkedIn job alert email. The app does not open LinkedIn, so the full posting was not read: open the link to read it and apply.`,
        postedAt: new Date(mail.at).toISOString(), big: isBigEmployer(company)
      })
    }
  }
  return [...out.values()]
}
