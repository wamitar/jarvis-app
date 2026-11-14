// Adzuna search API. Optional: needs a free app id and key from developer.adzuna.com, entered in Settings.
import type { RawJob } from '../../shared/types'
import { getJson, htmlToText } from './util'

interface AdzJob { id: string; title: string; description?: string; redirect_url: string; created?: string
  company?: { display_name?: string }; location?: { display_name?: string; area?: string[] } }

export async function fetchAdzuna(appId: string, appKey: string, bigNames: Set<string>): Promise<RawJob[]> {
  const out = new Map<string, RawJob>()
  const runs: { country: 'ca' | 'us'; what: string; where?: string }[] = [
    { country: 'ca', what: 'mechanical engineering intern', where: 'Ontario' },
    { country: 'ca', what: 'mechanical engineering co-op', where: 'Ontario' },
    { country: 'ca', what: 'mechanical engineering intern' },
    { country: 'us', what: 'mechanical engineering intern' }
  ]
  for (const run of runs) {
    for (let page = 1; page <= 2; page++) {
      const q = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: '50', what: run.what, max_days_old: '45' })
      if (run.where) q.set('where', run.where)
      const data = await getJson<{ results?: AdzJob[] }>(`https://api.adzuna.com/v1/api/jobs/${run.country}/search/${page}?${q}`)
      const results = data.results || []
      for (const j of results) {
        const company = j.company?.display_name || 'Unknown employer'
        const area = (j.location?.area || []).slice().reverse().join(', ')
        out.set(String(j.id), {
          id: `adzuna:${run.country}:${j.id}`, source: 'adzuna', company, title: htmlToText(j.title),
          location: `${j.location?.display_name || ''}, ${area}`.replace(/^, /, ''), url: j.redirect_url, applyUrl: j.redirect_url,
          description: htmlToText(j.description || ''), postedAt: j.created || null,
          big: bigNames.has(company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
        })
      }
      if (results.length < 50) break
    }
  }
  return [...out.values()]
}
