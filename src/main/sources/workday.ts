import type { Board, RawJob } from '../../shared/types'
import { getJson, htmlToText } from './util'

interface WdPosting { title: string; externalPath: string; locationsText?: string; postedOn?: string; bulletFields?: string[] }
interface WdDetail { jobPostingInfo?: { jobDescription?: string; location?: string; additionalLocations?: string[]; country?: { descriptor?: string }; startDate?: string; externalUrl?: string } }

const base = (b: Board): { api: string; site: string } => {
  const [tenant, dc, site] = b.id.split('|')
  return { api: `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`, site: `https://${tenant}.${dc}.myworkdayjobs.com/${site}` }
}

// Workday has no "all jobs" feed, so we search for a few phrases and merge the results.
const SEARCHES = ['mechanical intern', 'mechanical co-op', 'engineering intern', 'engineering student']

export async function fetchWorkday(b: Board): Promise<RawJob[]> {
  const { api, site } = base(b)
  const seen = new Map<string, RawJob>()
  for (const searchText of SEARCHES) {
    for (let offset = 0; offset < 60; offset += 20) {
      const data = await getJson<{ total?: number; jobPostings?: WdPosting[] }>(`${api}/jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText })
      })
      const posts = data.jobPostings || []
      for (const p of posts) {
        if (!p.externalPath || seen.has(p.externalPath)) continue
        seen.set(p.externalPath, {
          id: `workday:${b.id.split('|')[0]}:${p.externalPath.split('/').pop()}`, source: 'workday', company: b.company, title: (p.title || '').trim(),
          location: p.locationsText || '', url: site + p.externalPath, applyUrl: site + p.externalPath, description: '', postedAt: null, big: b.big
        })
      }
      if (posts.length < 20) break
    }
  }
  return [...seen.values()]
}

/** Workday list results have no description and often a vague location ("3 Locations"); this fills both in. */
export async function fetchWorkdayDetail(j: RawJob): Promise<{ description: string; location: string }> {
  const u = new URL(j.url)
  const [, site, ...rest] = u.pathname.split('/')
  const tenant = u.host.split('.')[0]
  const d = await getJson<WdDetail>(`${u.origin}/wday/cxs/${tenant}/${site}/${rest.join('/')}`)
  const info = d.jobPostingInfo || {}
  const locs = [info.location, ...(info.additionalLocations || [])].filter(Boolean).join(' / ')
  const country = info.country?.descriptor || ''
  return { description: htmlToText(info.jobDescription || ''), location: [locs, country].filter(Boolean).join(', ') || j.location }
}
