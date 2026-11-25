// Readers for the job systems most Canadian employers use: SAP SuccessFactors career sites,
// UKG (UltiPro) job boards, BambooHR and Workable. All read public pages or feeds; none needs a login.
import type { Board, RawJob } from '../../shared/types'
import { UA, getJson, htmlToText, decodeEntities } from './util'
import { regionOf } from '../filter'

const QUERIES = ['intern', 'co-op', 'student']
const BROWSER = { ...UA, 'user-agent': `Mozilla/5.0 (Macintosh) ${UA['user-agent']}` }

async function getHtml(url: string): Promise<string> {
  const r = await fetch(url, { headers: BROWSER, signal: AbortSignal.timeout(25_000) })
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`)
  return r.text()
}

/** SuccessFactors career site search pages. id = host, e.g. jobs.bombardier.com. */
export async function fetchSuccessFactors(b: Board): Promise<RawJob[]> {
  const seen = new Map<string, RawJob>()
  for (const q of b.queries ?? QUERIES) {
    for (let start = 0; start < 75; start += 25) {
      const html = await getHtml(`https://${b.id}/search/?q=${encodeURIComponent(q)}&startrow=${start}`)
      // Two layouts exist: a table (one <tr class="data-row"> per job) and tiles (one <li class="job-tile"> per job).
      let rows = html.split(/<tr[^>]*class="[^"]*data-row/).slice(1)
      if (!rows.length) rows = html.split(/<li[^>]*class="[^"]*job-tile/).slice(1)
      for (const row of rows) {
        const link = row.match(/<a[^>]*href="(\/job\/[^"]+)"[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/) || row.match(/<a[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*href="(\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
        if (!link) continue
        const path = link[1], postId = path.replace(/\/$/, '').split('/').pop() || path
        if (seen.has(postId)) continue
        let loc = htmlToText(row.match(/class="jobLocation"[^>]*>\s*([^<]+)</)?.[1] || row.match(/location-value[^>]*>\s*([^<]+)</)?.[1] || '')
        if (/^location:?$/i.test(loc)) loc = ''   // a tile's column label, not a place
        if (!loc) {
          // Tiles may not show a location; the link itself carries it: /job/Cambridge-Some-Title-ON-N3H-4R7/123/
          const slug = decodeURIComponent(path.split('/')[2] || '')
          const ca = slug.match(/-(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE)(?:-[A-Z]\d[A-Z]-\d[A-Z]\d)?$/), us = slug.match(/-([A-Z]{2})-\d{5}$/)
          if (ca) loc = `${slug.split('-')[0]}, ${ca[1]}, CA`; else if (us) loc = `${slug.split('-')[0]}, ${us[1]}, US`
        }
        // Ferrari leaves the location empty and puts the town in the title: "Accounting Internship (Maranello)".
        // Only a recognised place counts ("(Remote)" does not); otherwise the board's home town is used.
        if (!loc) { const paren = decodeEntities(htmlToText(link[2])).match(/\(([^()]+)\)\s*$/)?.[1] || ''; loc = regionOf(paren) !== 'unknown' ? paren : b.defaultLocation || '' }
        const date = new Date(htmlToText(row.match(/class="jobDate"[^>]*>\s*([^<]+)</)?.[1] || ''))
        const url = `https://${b.id}${decodeEntities(path)}`
        seen.set(postId, {
          id: `successfactors:${b.id}:${postId}`, source: 'successfactors', company: b.company, title: decodeEntities(htmlToText(link[2])),
          location: loc.replace(/,\s*CA$/, ', Canada').replace(/,\s*US$/, ', USA'), url, applyUrl: url, description: '',
          postedAt: isNaN(+date) ? null : date.toISOString(), big: b.big, detailUrl: url
        })
      }
      if (rows.length < 25) break
    }
  }
  return [...seen.values()]
}
export async function successFactorsDetail(url: string): Promise<string> {
  const html = await getHtml(url)
  const at = html.search(/class="[^"]*jobdescription/i)
  if (at < 0) return htmlToText(html.match(/<main[\s\S]*?<\/main>/i)?.[0] || '').slice(0, 9000)
  return htmlToText(html.slice(html.indexOf('>', at) + 1, at + 40000).split(/<div[^>]*class="[^"]*(?:applylink|job-page-footer|jobDisplayFooter)/i)[0]).slice(0, 9000)
}

/** UKG / UltiPro job boards (MDA Space, Wajax). id = "host/tenant/JobBoard/board-guid". */
export async function fetchUkg(b: Board): Promise<RawJob[]> {
  interface Opp { Id: string; Title: string; PostedDate?: string; BriefDescription?: string
    Locations?: { LocalizedDescription?: string; Address?: { City?: string; State?: { Code?: string; Name?: string }; Country?: { Code?: string; Name?: string } } }[] }
  const seen = new Map<string, RawJob>()
  for (const q of QUERIES) {
    const d = await getJson<{ opportunities?: Opp[] }>(`https://${b.id}/JobBoardView/LoadSearchResults`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ opportunitySearch: { Top: 50, Skip: 0, QueryString: q, OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }], Filters: [] },
        matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] } })
    })
    for (const o of d.opportunities || []) {
      if (seen.has(o.Id)) continue
      const a = o.Locations?.[0]?.Address
      const loc = [a?.City || o.Locations?.[0]?.LocalizedDescription, a?.State?.Code || a?.State?.Name, a?.Country?.Name || a?.Country?.Code].filter(Boolean).join(', ')
      const url = `https://${b.id}/OpportunityDetail?opportunityId=${o.Id}`
      seen.set(o.Id, {
        id: `ukg:${b.id.split('/')[1]}:${o.Id}`, source: 'ukg', company: b.company, title: (o.Title || '').trim(), location: loc, url, applyUrl: url,
        description: htmlToText(o.BriefDescription || ''), postedAt: o.PostedDate || null, big: b.big
      })
    }
  }
  return [...seen.values()]
}

/** BambooHR careers lists. id = subdomain. */
export async function fetchBambooHr(b: Board): Promise<RawJob[]> {
  interface BJob { id: string; jobOpeningName: string; location?: { city?: string | null; state?: string | null }; atsLocation?: { country?: string | null } }
  const d = await getJson<{ result?: BJob[] }>(`https://${b.id}.bamboohr.com/careers/list`)
  return (d.result || []).map(j => {
    const url = `https://${b.id}.bamboohr.com/careers/${j.id}`
    return {
      id: `bamboohr:${b.id}:${j.id}`, source: 'bamboohr' as const, company: b.company, title: (j.jobOpeningName || '').trim(),
      location: [j.location?.city, j.location?.state, j.atsLocation?.country].filter(Boolean).join(', '), url, applyUrl: url, description: '', postedAt: null, big: b.big,
      detailUrl: `${url}/detail`
    }
  })
}
export async function bambooHrDetail(url: string): Promise<string> {
  const d = await getJson<{ result?: { jobOpening?: { description?: string } } }>(url)
  return htmlToText(d.result?.jobOpening?.description || '')
}

/** Workable job boards. id = account name. */
export async function fetchWorkable(b: Board): Promise<RawJob[]> {
  interface WJob { shortcode: string; title: string; published?: string; location?: { city?: string; region?: string; country?: string } }
  const d = await getJson<{ results?: WJob[] }>(`https://apply.workable.com/api/v3/accounts/${b.id}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] })
  })
  return (d.results || []).map(j => {
    const url = `https://apply.workable.com/${b.id}/j/${j.shortcode}/`
    return {
      id: `workable:${b.id}:${j.shortcode}`, source: 'workable' as const, company: b.company, title: (j.title || '').trim(),
      location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', '), url, applyUrl: url, description: '',
      postedAt: j.published || null, big: b.big, detailUrl: `https://apply.workable.com/api/v2/accounts/${b.id}/jobs/${j.shortcode}`
    }
  })
}
export async function workableDetail(url: string): Promise<string> {
  const d = await getJson<{ description?: string; requirements?: string }>(url)
  return htmlToText([d.description, d.requirements].filter(Boolean).join('<br/>'))
}
