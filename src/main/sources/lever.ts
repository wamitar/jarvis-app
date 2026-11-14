import type { Board, RawJob } from '../../shared/types'
import { getJson, htmlToText } from './util'

interface LeverJob { id: string; text: string; hostedUrl: string; applyUrl: string; createdAt?: number; descriptionPlain?: string
  categories?: { location?: string; allLocations?: string[] }; lists?: { text: string; content: string }[]; additionalPlain?: string }

export async function fetchLever(b: Board): Promise<RawJob[]> {
  const data = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${b.id}?mode=json`)
  return (data || []).map(j => ({
    id: `lever:${b.id}:${j.id}`, source: 'lever' as const, company: b.company, title: j.text.trim(),
    location: (j.categories?.allLocations?.join(' / ') || j.categories?.location || ''), url: j.hostedUrl, applyUrl: j.applyUrl || j.hostedUrl + '/apply',
    description: [j.descriptionPlain || '', ...(j.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain || ''].join('\n\n').trim(),
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null, big: b.big
  }))
}
