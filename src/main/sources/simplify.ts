// SimplifyJobs' public, community-maintained internship list (github.com/SimplifyJobs/Summer2027-Internships).
// Most internships people see on LinkedIn are copies of postings on the employer's own careers site; this list links
// to those careers-site postings directly, so it finds them without touching LinkedIn.
//
// Each listing is turned into the same job the employer's own board would give (same id, e.g.
// "greenhouse:spacex:123"), so a job already found through a curated board is not added twice, and auto-apply
// treats it exactly like any other Greenhouse / Lever / Ashby / Workday / SmartRecruiters job.
// Every listing still goes through the normal filter (good employers, mechanical relevance, term, sponsorship).
import type { Board, RawJob } from '../../shared/types'
import { BOARDS, KNOWN } from '../companies'
import { UA, getJson, htmlToText } from './util'

const LIST_URL = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json'
const MAX_AGE_DAYS = 120

interface Listing {
  id: string; company_name: string; title: string; url: string; locations?: string[]; category?: string
  active?: boolean; is_visible?: boolean; date_posted?: number
}

// Words that say nothing about which company it is ("KLA Corporation" is KLA).
const SUFFIX = /\b(international|north america|global|inc|incorporated|corp|corporation|company|co|llc|ltd|limited|plc|gmbh|ag|sa|technologies|technology|holdings|group|the|usa|us|canada)\b/g
export const companyKey = (s: string): string => s.toLowerCase().replace(/&/g, ' and ').replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim()

/** The app's own name for a company ("KLA Corporation" -> "KLA"), so the KNOWN list and the boards recognise it. */
const CANON = new Map<string, string>()
for (const name of [...KNOWN, ...BOARDS.map(b => b.company)]) {
  CANON.set(companyKey(name), name)
  // "RTX (Collins, Pratt & Whitney, Raytheon)": the part before the brackets names it too.
  const head = name.split('(')[0].trim()
  if (head !== name && !CANON.has(companyKey(head))) CANON.set(companyKey(head), name)
}
// Divisions and other spellings the list uses for an employer the app already knows.
const ALIAS: Record<string, string> = {
  'hewlett packard': 'HP', hp: 'HP', 'honeywell aerospace': 'Honeywell', 'honeywell aerospace technologies': 'Honeywell',
  'general dynamics mission systems': 'General Dynamics', 'general dynamics uk': 'General Dynamics', 'general dynamics land systems': 'General Dynamics',
  'general dynamics electric boat': 'General Dynamics', 'gd': 'General Dynamics', 'lockheed': 'Lockheed Martin',
  'collins aerospace': 'RTX (Collins, Pratt & Whitney, Raytheon)', 'pratt and whitney': 'RTX (Collins, Pratt & Whitney, Raytheon)',
  raytheon: 'RTX (Collins, Pratt & Whitney, Raytheon)', rtx: 'RTX (Collins, Pratt & Whitney, Raytheon)',
  'ge healthcare': 'GE HealthCare', 'leonardo drs': 'Leonardo DRS', 'p and g': 'Procter & Gamble', 'procter and gamble': 'Procter & Gamble',
  'westinghouse electric': 'Westinghouse', 'keysight': 'Keysight', 'on semiconductor': 'onsemi', 'amazon robotics': 'Amazon',
  'amazon web services': 'Amazon', aws: 'Amazon', 'google deepmind': 'Google', 'tesla motors': 'Tesla', 'blue origin': 'Blue Origin',
  // Formula 1 teams. "Red Bull Technology" is left out: its key is plain "red bull", the drinks company.
  'oracle red bull racing': 'Red Bull Racing', 'red bull powertrains': 'Red Bull Racing', 'mclaren racing': 'McLaren', 'mclaren f1': 'McLaren',
  'mercedes amg': 'Mercedes-AMG Petronas F1', 'mercedes amg f1': 'Mercedes-AMG Petronas F1', 'mercedes amg petronas': 'Mercedes-AMG Petronas F1',
  'mercedes amg petronas formula one team': 'Mercedes-AMG Petronas F1', 'williams f1': 'Williams Racing', 'atlassian williams racing': 'Williams Racing',
  'aston martin aramco': 'Aston Martin F1', 'aston martin aramco f1 team': 'Aston Martin F1', 'scuderia ferrari': 'Ferrari',
  'moneygram haas f1 team': 'Haas F1 Team', 'haas f1': 'Haas F1 Team', 'visa cash app rb': 'Racing Bulls', vcarb: 'Racing Bulls',
  'bwt alpine f1 team': 'Alpine F1', 'alpine racing': 'Alpine F1', sauber: 'Audi F1 (Sauber)', 'stake f1 team': 'Audi F1 (Sauber)',
  'audi f1 team': 'Audi F1 (Sauber)', 'sauber motorsport': 'Audi F1 (Sauber)', 'cadillac formula 1 team': 'Cadillac F1', 'cadillac f1 team': 'Cadillac F1',
  'twg motorsports': 'Cadillac F1'
}
export const canonicalCompany = (name: string): string => { const k = companyKey(name); return ALIAS[k] || CANON.get(k) || name.trim() }

/**
 * Employers treated like the curated large-employer boards (searched outside Ontario): the KNOWN list and every
 * curated board marked big. Anyone else from these open lists counts as a lesser-known employer, so only their
 * Ontario jobs are kept, the same rule the curated small boards follow.
 */
const BIG = new Set([...KNOWN, ...BOARDS.filter(b => b.big).map(b => b.company)])
export const isBigEmployer = (company: string): boolean => BIG.has(company)

// The list's shorthand for cities, written out so the region rules recognise them.
const CITY: [RegExp, string][] = [[/^South SF$/i, 'South San Francisco, CA'], [/^SF$/i, 'San Francisco, CA'], [/^LA$/i, 'Los Angeles, CA'], [/^NYC$/i, 'New York, NY'], [/^DC$/i, 'Washington, DC']]
const place = (l: string): string => { const t = l.trim(); for (const [re, full] of CITY) if (re.test(t)) return full; return t }

/** A posting on a careers system the app reads: which system, its board, and the posting id. */
export interface Placed { ats: Board['ats']; board: string; jobId: string; url: string; detailUrl?: string }

/** Reads a careers-site link: greenhouse, lever, ashby, workday or smartrecruiters, else null. */
export function placeUrl(raw: string): Placed | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)
  if (/^(job-boards|boards)\.greenhouse\.io$/.test(host) && parts[1] === 'jobs' && /^\d+$/.test(parts[2] || ''))
    return { ats: 'greenhouse', board: parts[0], jobId: parts[2], url: `https://job-boards.greenhouse.io/${parts[0]}/jobs/${parts[2]}` }
  if (host === 'jobs.lever.co' && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]))
    return { ats: 'lever', board: parts[0], jobId: parts[1], url: `https://jobs.lever.co/${parts[0]}/${parts[1]}` }
  if (host === 'jobs.ashbyhq.com' && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]))
    return { ats: 'ashby', board: parts[0], jobId: parts[1], url: `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}` }
  // tenant.wdN.myworkdayjobs.com/[en-US/]Site/job/Place/Title_R123, or wdN.myworkdaysite.com/recruiting/tenant/Site/job/...
  let m = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/)
  let tenant = '', dc = '', rest: string[] = []
  if (m) { tenant = m[1]; dc = m[2]; rest = parts }
  else if ((m = host.match(/^(wd\d+)\.myworkdaysite\.com$/)) && parts[0] === 'recruiting') { tenant = parts[1]; dc = m[1]; rest = parts.slice(2) }
  if (tenant) {
    if (/^[a-z]{2}-[A-Z]{2}$/.test(rest[0] || '')) rest = rest.slice(1)
    const site = rest[0], at = rest.indexOf('job')
    if (!site || at < 0 || rest.length < at + 2) return null
    const path = rest.slice(at)
    return { ats: 'workday', board: `${tenant}|${dc}|${site}`, jobId: path[path.length - 1], url: `https://${tenant}.${dc}.myworkdayjobs.com/${site}/${path.join('/')}` }
  }
  if (host === 'jobs.smartrecruiters.com' && parts.length >= 2) {
    const id = parts[1].match(/^(\d{6,})/)?.[1]
    if (id) return { ats: 'smartrecruiters', board: parts[0], jobId: id, url: `https://jobs.smartrecruiters.com/${parts[0]}/${id}`,
      detailUrl: `https://api.smartrecruiters.com/v1/companies/${parts[0]}/postings/${id}` }
  }
  return null
}

/** The id the employer's own board gives the same posting (see each source file). */
export const placedId = (p: Placed): string => `${p.ats}:${p.ats === 'workday' ? p.board.split('|')[0] : p.board}:${p.jobId}`

// Mechanical-type roles. Software-only categories are skipped here; the real relevance check is checkJob.
const RELEVANT = /mechanic|mechatron|manufactur|hardware|aerospace|aeronaut|robot|propulsion|thermal|structur|design eng|product design|test eng|process eng|quality eng|industrial eng|materials|energy|automotive|vehicle|engineering (intern|co-?op|student)/i

let cache: { etag: string; list: Listing[] } | null = null

/** Downloads the list (only when it changed since the last refresh) and returns the relevant listings as jobs. */
export async function fetchSimplify(): Promise<RawJob[]> {
  const r = await fetch(LIST_URL, { headers: { ...UA, ...(cache?.etag ? { 'if-none-match': cache.etag } : {}) }, signal: AbortSignal.timeout(60_000) })
  if (r.status !== 304) {
    if (!r.ok) throw new Error(`${r.status} from GitHub`)
    cache = { etag: r.headers.get('etag') || '', list: (await r.json()) as Listing[] }
  }
  const since = Date.now() / 1000 - MAX_AGE_DAYS * 86400
  const out = new Map<string, RawJob>()
  for (const x of cache?.list || []) {
    if (!x.active || x.is_visible === false || (x.date_posted || 0) < since) continue
    if (x.category !== 'Hardware' && !RELEVANT.test(x.title)) continue
    const placed = placeUrl(x.url)
    const company = canonicalCompany(x.company_name)
    const url = placed?.url || x.url.replace(/[?&](utm_source|ref)=Simplify\b/gi, '').replace(/[?&]$/, '')
    const id = placed ? placedId(placed) : `simplify:${companyKey(company).replace(/ /g, '-')}:${x.id}`
    out.set(id, {
      id, source: placed?.ats || 'simplify', company, title: x.title.trim(),
      location: (x.locations || []).map(place).join('; '), url, applyUrl: url,
      // No description in the list: it is read from the posting itself before the job is kept (see fetchDetail).
      description: '', postedAt: x.date_posted ? new Date(x.date_posted * 1000).toISOString() : null,
      big: isBigEmployer(company), detailUrl: placed?.detailUrl
    })
  }
  return [...out.values()]
}

/** New boards worth reading in full: KNOWN employers whose careers site the list revealed and the app lacks. */
export function discoverBoards(jobs: RawJob[], have: Board[], max: number): Board[] {
  const known = new Set(have.map(b => `${b.ats}:${b.id.toLowerCase()}`))
  const haveCompany = new Set(have.map(b => b.company))
  const out: Board[] = []
  for (const j of jobs) {
    if (out.length >= max) break
    if (!KNOWN.has(j.company) || haveCompany.has(j.company)) continue
    const p = placeUrl(j.url)
    if (!p) continue
    const k = `${p.ats}:${p.board.toLowerCase()}`
    if (known.has(k)) continue
    known.add(k); haveCompany.add(j.company)
    out.push({ company: j.company, ats: p.ats, id: p.board, big: true })
  }
  return out
}

// ---- Reading one posting's text (the list has none) ----

const ashbyBoards = new Map<string, Promise<{ id: string; descriptionPlain?: string; descriptionHtml?: string; location?: string }[]>>()

/** The description of one posting, from the careers system's public API, or the page itself as a last resort. */
export async function postingText(j: RawJob): Promise<string> {
  const [ats, board, id] = j.id.split(':')
  if (ats === 'greenhouse') {
    const d = await getJson<{ content?: string }>(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`)
    return htmlToText(d.content || '')
  }
  if (ats === 'lever') {
    const d = await getJson<{ descriptionPlain?: string; lists?: { text: string; content: string }[]; additionalPlain?: string }>(`https://api.lever.co/v0/postings/${board}/${id}`)
    return [d.descriptionPlain || '', ...(d.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`), d.additionalPlain || ''].join('\n\n').trim()
  }
  if (ats === 'ashby') {
    // Ashby has no public single-posting API; the board's list (read once per refresh) carries every description.
    if (!ashbyBoards.has(board)) ashbyBoards.set(board, getJson<{ jobs: any[] }>(`https://api.ashbyhq.com/posting-api/job-board/${board}`).then(d => d.jobs || []))
    const hit = (await ashbyBoards.get(board)!).find(x => x.id === id)
    if (!hit) throw new Error('posting no longer listed')
    return hit.descriptionPlain || htmlToText(hit.descriptionHtml || '')
  }
  // Any other careers site: the page's own text.
  const r = await fetch(j.url, { headers: { ...UA, accept: 'text/html' }, signal: AbortSignal.timeout(25_000) })
  if (!r.ok) throw new Error(`${r.status} from ${new URL(j.url).host}`)
  return htmlToText(await r.text()).slice(0, 20_000)
}

/** Clears the per-refresh Ashby cache. */
export const resetSimplifyCaches = (): void => { ashbyBoards.clear() }
