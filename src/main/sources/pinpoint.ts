import type { Board, RawJob } from '../../shared/types'
import { getJson, htmlToText } from './util'

interface PpJob {
  id: string; title: string; url: string; description?: string; key_responsibilities?: string; skills_knowledge_expertise?: string
  location?: { city?: string; name?: string; province?: string }; deadline_at?: string | null
}

/** Pinpoint career sites. id = the subdomain, e.g. astonmartinf1. The list already carries the full text. */
export async function fetchPinpoint(b: Board): Promise<RawJob[]> {
  const data = await getJson<{ data?: PpJob[] }>(`https://${b.id}.pinpointhq.com/postings.json`)
  return (data.data || []).map(j => ({
    id: `pinpoint:${b.id}:${j.id}`, source: 'pinpoint' as const, company: b.company, title: (j.title || '').trim(),
    location: [j.location?.city || j.location?.name, j.location?.province].filter(Boolean).join(', '), url: j.url, applyUrl: j.url,
    description: htmlToText([j.description, j.key_responsibilities, j.skills_knowledge_expertise].filter(Boolean).join('<br/>')), postedAt: null, big: b.big
  }))
}
