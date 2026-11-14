import type { Board, RawJob } from '../../shared/types'
import { getJson, htmlToText } from './util'

interface GhJob { id: number; title: string; absolute_url: string; location?: { name?: string }; content?: string; updated_at?: string; first_published?: string }

export async function fetchGreenhouse(b: Board): Promise<RawJob[]> {
  const data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${b.id}/jobs?content=true`)
  return (data.jobs || []).map(j => ({
    id: `greenhouse:${b.id}:${j.id}`, source: 'greenhouse' as const, company: b.company, title: j.title.trim(),
    location: j.location?.name || '', url: j.absolute_url, applyUrl: j.absolute_url,
    description: htmlToText(j.content || ''), postedAt: j.first_published || j.updated_at || null, big: b.big
  }))
}
