// Job Bank Canada (Government of Canada) public Atom search feed, limited to Ontario.
import type { RawJob } from '../../shared/types'
import { UA, htmlToText, decodeEntities } from './util'

const SEARCHES = ['mechanical engineering intern', 'mechanical engineering co-op', 'mechanical engineering student', 'engineering intern', 'engineering co-op student']

export async function fetchJobBank(): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>()
  for (const q of SEARCHES) {
    const url = `https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?searchstring=${encodeURIComponent(q)}&fprov=ON&sort=D`
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) })
    if (!r.ok) throw new Error(`${r.status} from jobbank.gc.ca`)
    const xml = await r.text()
    for (const entry of xml.split('<entry>').slice(1)) {
      const title = decodeEntities((entry.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] || '').trim())
      const link = entry.match(/<link[^>]*href="([^"]+)"/)?.[1] || ''
      const summary = entry.match(/<summary[^>]*><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] || ''
      const field = (name: string): string => htmlToText(summary.match(new RegExp(`${name}:</strong>([^<]*)`))?.[1] || '')
      const postId = link.split('/').pop() || ''
      if (!postId || seen.has(postId)) continue
      const loc = field('Location').replace(/\s*\((\w\w)\)/, ', $1').trim()
      seen.set(postId, {
        id: `jobbank:jobbank:${postId}`, source: 'jobbank', company: field('Employer') || 'Unknown employer', title,
        location: loc ? `${loc}, Canada` : 'Ontario, Canada', url: link, applyUrl: link, description: '',
        postedAt: entry.match(/<updated>([^<]+)</)?.[1] || null, big: false
      })
    }
  }
  return [...seen.values()]
}

export async function fetchJobBankDetail(j: RawJob): Promise<string> {
  const r = await fetch(j.url, { headers: UA, signal: AbortSignal.timeout(25_000) })
  if (!r.ok) throw new Error(`${r.status} from jobbank.gc.ca`)
  const html = await r.text()
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html
  return htmlToText(main).slice(0, 8000)
}
