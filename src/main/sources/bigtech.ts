// Large employers that run their own careers sites. Each reads a public search endpoint or page;
// none of them needs a login. Meta and Tesla are absent: their sites refuse automated readers.
import type { Board, RawJob } from '../../shared/types'
import { UA, getJson, htmlToText } from './util'

const QUERIES = ['mechanical engineer intern', 'hardware engineer intern', 'mechanical co-op']

export async function fetchAmazon(b: Board): Promise<RawJob[]> {
  interface AJob { id_icims: string; title: string; normalized_location?: string; location?: string; job_path: string; description?: string
    basic_qualifications?: string; preferred_qualifications?: string; posted_date?: string }
  const seen = new Map<string, RawJob>()
  for (const q of QUERIES) {
    const data = await getJson<{ jobs?: AJob[] }>(`https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}&result_limit=100&offset=0`)
    for (const j of data.jobs || []) {
      if (seen.has(j.id_icims)) continue
      const posted = j.posted_date ? new Date(j.posted_date) : null
      seen.set(j.id_icims, {
        id: `amazon:amazon:${j.id_icims}`, source: 'amazon', company: b.company, title: (j.title || '').trim(), location: j.normalized_location || j.location || '',
        url: `https://www.amazon.jobs${j.job_path}`, applyUrl: `https://www.amazon.jobs${j.job_path}`,
        description: htmlToText([j.description, 'Basic qualifications', j.basic_qualifications, 'Preferred qualifications', j.preferred_qualifications].filter(Boolean).join('<br/>')),
        postedAt: posted && !isNaN(+posted) ? posted.toISOString() : null, big: b.big
      })
    }
  }
  return [...seen.values()]
}

/** Google's careers page embeds its results as a data array; positions in that array are read defensively. */
export async function fetchGoogle(b: Board): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>()
  for (const q of ['mechanical engineer intern', 'hardware engineering intern', 'product design engineering intern']) {
    for (let page = 1; page <= 2; page++) {
      const r = await fetch(`https://www.google.com/about/careers/applications/jobs/results/?q=${encodeURIComponent(q)}&page=${page}`, { headers: UA, signal: AbortSignal.timeout(25_000) })
      if (!r.ok) throw new Error(`${r.status} from google.com careers`)
      const html = await r.text()
      const m = html.match(/AF_initDataCallback\(\{key: 'ds:1', hash: '\d+', data:([\s\S]*?), sideChannel: \{\}\}\);/)
      if (!m) throw new Error('Google careers page layout changed')
      const rows = (JSON.parse(m[1]) as unknown[])[0]
      if (!Array.isArray(rows) || !rows.length) break
      for (const e of rows as any[][]) {
        const id = String(e[0] || ''), title = String(e[1] || '')
        if (!id || !title || seen.has(id)) continue
        const part = (x: unknown): string => (Array.isArray(x) && typeof x[1] === 'string' ? x[1] : '')
        const locs = Array.isArray(e[9]) ? e[9].map((l: unknown[]) => String(l?.[0] || '')).filter(Boolean) : []
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const url = `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug}`
        seen.set(id, {
          id: `google:google:${id}`, source: 'google', company: b.company, title, location: locs.join(' / '), url, applyUrl: url,
          description: htmlToText([part(e[10]), '<p>Responsibilities</p>', part(e[3]), part(e[4])].join('')),
          postedAt: Array.isArray(e[12]) && typeof e[12][0] === 'number' ? new Date(e[12][0] * 1000).toISOString() : null, big: b.big
        })
      }
      if (rows.length < 20) break
    }
  }
  return [...seen.values()]
}

/** Apple's search page ships its results as JSON inside the HTML. */
export async function fetchApple(b: Board): Promise<RawJob[]> {
  interface PJob { positionId?: string; id?: string; postingTitle?: string; transformedPostingTitle?: string; jobSummary?: string; postingDate?: string
    postDateInGMT?: string; locations?: { name?: string; countryName?: string }[]; team?: { teamName?: string } }
  const seen = new Map<string, RawJob>()
  for (const q of ['mechanical engineering internship', 'hardware engineering intern', 'undergrad engineering internships', 'product design intern']) {
    const r = await fetch(`https://jobs.apple.com/en-us/search?search=${encodeURIComponent(q)}&sort=relevance`, { headers: UA, signal: AbortSignal.timeout(25_000) })
    if (!r.ok) throw new Error(`${r.status} from jobs.apple.com`)
    const html = await r.text()
    const m = html.match(/__staticRouterHydrationData = JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)
    if (!m) throw new Error('Apple careers page layout changed')
    const data = JSON.parse(JSON.parse(m[1]) as string) as { loaderData?: Record<string, { searchResults?: PJob[] }> }
    const results = Object.values(data.loaderData || {}).flatMap(v => (v && Array.isArray(v.searchResults) ? v.searchResults : []))
    for (const j of results) {
      const id = String(j.positionId || j.id || '')
      if (!id || !j.postingTitle || seen.has(id)) continue
      const url = `https://jobs.apple.com/en-us/details/${id}/${j.transformedPostingTitle || ''}`
      seen.set(id, {
        id: `apple:apple:${id}`, source: 'apple', company: b.company, title: j.postingTitle.trim(),
        location: (j.locations || []).map(l => [l.name, l.countryName].filter(Boolean).join(', ')).join(' / '), url, applyUrl: url,
        description: [j.team?.teamName ? `Team: ${j.team.teamName}` : '', htmlToText(j.jobSummary || '')].filter(Boolean).join('\n'),
        postedAt: j.postDateInGMT || null, big: b.big
      })
    }
  }
  return [...seen.values()]
}

/** Eightfold-hosted careers sites. id = "host|domain|flavour" where flavour is pcsx (Microsoft) or v2 (Netflix). */
export async function fetchEightfold(b: Board): Promise<RawJob[]> {
  const [host, domain, flavour] = b.id.split('|')
  const seen = new Map<string, RawJob>()
  // These sites throttle quick repeat searches, so the queries are spaced out and a refusal is retried once.
  const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const polite = async <T>(url: string): Promise<T> => {
    try { return await getJson<T>(url) } catch (e) { if (!/^429/.test((e as Error).message)) throw e; await pause(8000); return getJson<T>(url) }
  }
  for (const [n, q] of QUERIES.entries()) {
    if (n) await pause(2500)
    interface Pos { id: number | string; name: string; locations?: string[]; location?: string; postedTs?: number; t_create?: number; job_description?: string
      positionUrl?: string; canonicalPositionUrl?: string }
    let positions: Pos[]
    if (flavour === 'pcsx') {
      const d = await polite<{ data?: { positions?: Pos[] } }>(`https://${host}/api/pcsx/search?domain=${domain}&query=${encodeURIComponent(q)}&start=0`)
      positions = d.data?.positions || []
    } else {
      const d = await polite<{ positions?: Pos[] }>(`https://${host}/api/apply/v2/jobs?domain=${domain}&query=${encodeURIComponent(q)}&start=0&num=50`)
      positions = d.positions || []
    }
    for (const p of positions) {
      const id = String(p.id)
      if (seen.has(id)) continue
      const url = p.canonicalPositionUrl || `https://${host}${p.positionUrl || '/careers/job/' + id}`
      const ts = p.postedTs || p.t_create
      seen.set(id, {
        id: `eightfold:${domain}:${id}`, source: 'eightfold', company: b.company, title: (p.name || '').trim(),
        location: (p.locations || [p.location || '']).join(' / ').replace(/,(?=\S)/g, ', '), url, applyUrl: url,
        description: htmlToText(p.job_description || ''), postedAt: ts ? new Date(ts * 1000).toISOString() : null, big: b.big,
        detailUrl: flavour === 'pcsx' ? `https://${host}/api/pcsx/position_details?position_id=${id}&domain=${domain}&hl=en` : `https://${host}/api/apply/v2/jobs/${id}?domain=${domain}`
      })
    }
  }
  return [...seen.values()]
}
export async function eightfoldDetail(url: string): Promise<string> {
  const d = await getJson<{ data?: { jobDescription?: string }; job_description?: string }>(url)
  return htmlToText(d.data?.jobDescription || d.job_description || '')
}

/** Jibe-hosted careers sites (AMD). id = host. */
export async function fetchJibe(b: Board): Promise<RawJob[]> {
  interface JJob { data: { slug: string; req_id?: string; title: string; description?: string; full_location?: string; country?: string; apply_url?: string; posted_date?: string } }
  const seen = new Map<string, RawJob>()
  for (const q of ['intern', 'co-op']) {
    for (let page = 1; page <= 3; page++) {
      const d = await getJson<{ jobs?: JJob[] }>(`https://${b.id}/api/jobs?keywords=${encodeURIComponent(q)}&page=${page}&limit=100`)
      const jobs = d.jobs || []
      for (const { data: j } of jobs) {
        if (!j?.slug || seen.has(j.slug)) continue
        const url = `https://${b.id}/careers-home/jobs/${j.slug}`
        seen.set(j.slug, {
          id: `jibe:${b.id.split('.')[1] || b.id}:${j.slug}`, source: 'jibe', company: b.company, title: (j.title || '').trim(),
          location: [j.full_location, j.country].filter(Boolean).join(', '), url, applyUrl: j.apply_url || url,
          description: htmlToText(j.description || ''), postedAt: j.posted_date || null, big: b.big
        })
      }
      if (jobs.length < 100) break
    }
  }
  return [...seen.values()]
}

/** Oracle Recruiting Cloud sites (Ford, Honeywell). id = "host|siteNumber". */
export async function fetchOracle(b: Board): Promise<RawJob[]> {
  const [host, site] = b.id.split('|')
  interface Req { Id: string; Title: string; PostedDate?: string; PrimaryLocation?: string; secondaryLocations?: { Name?: string }[] }
  const seen = new Map<string, RawJob>()
  for (const q of ['mechanical intern', 'engineering intern', 'engineering co-op']) {
    for (let offset = 0; offset < 100; offset += 50) {
      const d = await getJson<{ items?: { requisitionList?: Req[] }[] }>(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${site},keyword=%22${encodeURIComponent(q)}%22,limit=50,offset=${offset}`)
      const reqs = d.items?.[0]?.requisitionList || []
      for (const r of reqs) {
        if (seen.has(r.Id)) continue
        const url = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`
        seen.set(r.Id, {
          id: `oracle:${host.split('.')[0]}:${r.Id}`, source: 'oracle', company: b.company, title: (r.Title || '').trim(),
          location: [r.PrimaryLocation, ...(r.secondaryLocations || []).map(s => s.Name)].filter(Boolean).join(' / '), url, applyUrl: url, description: '',
          postedAt: r.PostedDate || null, big: b.big,
          detailUrl: `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${r.Id}%22,siteNumber=${site}`
        })
      }
      if (reqs.length < 50) break
    }
  }
  return [...seen.values()]
}
export async function oracleDetail(url: string): Promise<string> {
  const d = await getJson<{ items?: Record<string, string>[] }>(url)
  const it = d.items?.[0] || {}
  return htmlToText([it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr].filter(Boolean).join('<br/>'))
}

/** SmartRecruiters company boards (Bosch). id = company identifier. */
export async function fetchSmartRecruiters(b: Board): Promise<RawJob[]> {
  interface Post { id: string; name: string; releasedDate?: string; ref: string; location?: { city?: string; region?: string; country?: string } }
  const seen = new Map<string, RawJob>()
  for (const country of ['us', 'ca', 'gb']) {
    for (let offset = 0; offset < 300; offset += 100) {
      const d = await getJson<{ content?: Post[] }>(`https://api.smartrecruiters.com/v1/companies/${b.id}/postings?q=intern&country=${country}&limit=100&offset=${offset}`)
      const posts = d.content || []
      for (const p of posts) {
        if (seen.has(p.id)) continue
        const l = p.location || {}
        const url = `https://jobs.smartrecruiters.com/${b.id}/${p.id}`
        seen.set(p.id, {
          id: `smartrecruiters:${b.id}:${p.id}`, source: 'smartrecruiters', company: b.company, title: (p.name || '').trim(),
          location: [l.city, l.region, l.country === 'ca' ? 'Canada' : l.country === 'us' ? 'USA' : l.country === 'gb' ? 'United Kingdom' : l.country].filter(Boolean).join(', '),
          url, applyUrl: url, description: '', postedAt: p.releasedDate || null, big: b.big, detailUrl: p.ref
        })
      }
      if (posts.length < 100) break
    }
  }
  return [...seen.values()]
}
export async function smartRecruitersDetail(url: string): Promise<string> {
  const d = await getJson<{ jobAd?: { sections?: Record<string, { title?: string; text?: string }> } }>(url)
  const s = d.jobAd?.sections || {}
  return htmlToText(['jobDescription', 'qualifications', 'additionalInformation'].map(k => s[k]?.text || '').join('<br/>'))
}
