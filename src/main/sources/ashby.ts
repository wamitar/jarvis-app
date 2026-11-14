import type { Board, RawJob } from '../../shared/types'
import { getJson, htmlToText } from './util'

interface AshbyJob { id: string; title: string; location?: string; secondaryLocations?: { location: string }[]; descriptionPlain?: string; descriptionHtml?: string
  jobUrl: string; applyUrl?: string; publishedAt?: string; isListed?: boolean; address?: { postalAddress?: { addressRegion?: string; addressCountry?: string } } }

export async function fetchAshby(b: Board): Promise<RawJob[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${b.id}`)
  return (data.jobs || []).filter(j => j.isListed !== false).map(j => {
    const addr = j.address?.postalAddress
    // Ashby's location text often already includes the region and country, so only add what is missing.
    const loc = [j.location, addr?.addressRegion, addr?.addressCountry].filter((p, i, a) => p && (i === 0 || !(a[0] || '').includes(p))).join(', ')
    return {
      id: `ashby:${b.id}:${j.id}`, source: 'ashby' as const, company: b.company, title: j.title.trim(), location: loc,
      url: j.jobUrl, applyUrl: j.applyUrl || j.jobUrl + '/application',
      description: j.descriptionPlain || htmlToText(j.descriptionHtml || ''), postedAt: j.publishedAt || null, big: b.big
    }
  })
}
