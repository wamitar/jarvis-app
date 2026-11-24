// Jobs from LinkedIn alert emails, found on the employer's own careers site so they can be auto-applied there.
//
// LinkedIn itself is never opened (signed in or not): its terms forbid automation and it hides the employer's link
// from signed-out visitors. Instead the app's AI searches the web (its one allowed tool) for the same posting on the
// employer's site (its only tools: web search and reading pages), and the answer is checked here before it is used: the page must load, must not be a job board or
// LinkedIn, must not say the job is closed, and must show this job's title and company. The AI never sees the user's
// details: only the job's title, company and place.
import { askJson, otherAiFound } from '../ai/claude'
import * as db from '../db'
import { siteFetch } from './util'

export interface EmployerPosting { url: string; title: string; description: string }

/** Job boards and other copies: never the place to apply. */
const COPY_SITE = /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|workopolis|jooble|talent|simplyhired|monster|careerbuilder|sorce|grabjobs|owlindex|opentalent|swejoblists|builtin|dice|wellfound|eluta|jobbank|adzuna|learn4good|jobrapido|neuvoo|careerjet|recruit|snagajob|bebee|whatjobs|jobilize|lensa|jobleads|simplify|joinhandshake|ripplematch|internships|google|bing|duckduckgo|facebook|reddit|youtube|wikipedia|levels|teal|jobright|hiring\.cafe|trueup|otta|welcometothejungle|jobs\.ca|workday\.com)\.(com|ca|net|org|io|jobs|co|fyi|ai)$/i
const CLOSED = /job (is )?no longer (available|open|accepting)|position has been filled|no longer accepting applications|this (job|position|posting|requisition) (posting )?(has )?(closed|expired|been filled)|job (has )?expired|page (you|you're|you are) looking for (doesn't|does not|no longer|can't|cannot)/i
const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'at', 'on', 'with', 'by', '-', '–', 'intern', 'internship', 'co', 'op', 'coop', 'student'])

/** The words of a job title that must appear on the employer's page (place names in brackets are dropped). */
export function titleWords(title: string): string[] {
  const t = title.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s[-–|]\s.*$/, ' ').replace(/[^a-z0-9]+/g, ' ')
  return [...new Set(t.split(' ').filter(w => w.length > 1 && !STOP.has(w)))]
}
/** Share of the title's words found in a text (0 to 1). */
export function titleCover(title: string, text: string): number {
  const words = titleWords(title)
  if (!words.length) return 0
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return words.filter(w => hay.includes(` ${w} `) || hay.includes(` ${w}s `) || (w.endsWith('s') && hay.includes(` ${w.slice(0, -1)} `))).length / words.length
}
/** The company's distinctive word ("Lincoln Electric" -> lincoln; "S&C Electric Company" -> s c / snc). */
export function companyTokens(company: string): string[] {
  const words = company.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\|.*$/, '').replace(/\([^)]*\)/g, ' ')
    .replace(/\b(inc|ltd|llc|corp|corporation|company|co|international|technologies|technology|north america|limited|group|the|by|of|plc|sa|ag|gmbh)\b/g, ' ')
    .replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(Boolean)
  const first = words[0] || ''
  const joined = words.join('').replace(/&/g, '')
  return [...new Set([first.replace(/&/g, ''), joined, first.replace(/&/g, 'and')].filter(w => w.length >= 2))]
}
// DirectEmployers' "<company>.jobs" network re-posts jobs (each with a 32-character id) and links on to the real one.
const DE_COPY = /\/[0-9A-F]{32}\/job\/?$/i
export const isCopySite = (url: string): boolean => {
  try { const u = new URL(url); return COPY_SITE.test(u.hostname) || (/\.jobs$/i.test(u.hostname) && DE_COPY.test(u.pathname)) } catch { return true }
}

const pageText = (html: string): string => html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const meta = (html: string): string => [html.match(/<title[^>]*>([^<]*)/i)?.[1], ...[...html.matchAll(/<meta[^>]+(?:og:title|og:description|twitter:title|name="description")[^>]+content="([^"]*)"/gi)].map(m => m[1])].filter(Boolean).join(' ')

/**
 * Checks a candidate link: loads it and confirms it is this job on the employer's site. Returns the posting, or the
 * reason it was turned down.
 */
export async function verifyPosting(url: string, job: { title: string; company: string }): Promise<EmployerPosting | string> {
  // The English page when the link is to another language's copy (".../global/de/job/...").
  const en = url.replace(/\/(de|fr|es|it|pt|nl|pl|ja|zh|ko|de-de|fr-fr|fr-ca|es-es|pt-br)(\/|$)/i, '/en$2')
  if (en !== url) { const r = await verifyOne(en, job); if (typeof r !== 'string' || /closed/.test(r)) return r }
  return verifyOne(url, job)
}
async function verifyOne(url: string, job: { title: string; company: string }): Promise<EmployerPosting | string> {
  if (!/^https:\/\//i.test(url)) return 'not an https link'
  if (isCopySite(url)) return 'a job board or LinkedIn, not the employer'
  if (/\.myworkdayjobs\.com$/i.test(new URL(url).hostname)) { const w = await verifyWorkday(url, job); if (w !== null) return w }
  const r = await siteFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' } }).catch(() => null)
  if (!r) return 'the page did not load'
  if (r.status === 429) return 'the site is limiting requests right now (rate limited)'
  if (r.status >= 400 && r.status !== 403) return `the page answered ${r.status}`
  const final = r.url || url
  if (isCopySite(final)) return 'it redirects to a job board'
  const html = r.status === 403 ? '' : await r.text().catch(() => '')
  const text = pageText(html)
  if (CLOSED.test(text.slice(0, 20000))) return 'the posting says it is closed'
  let path = final; try { path = decodeURIComponent(final) } catch { /* keep */ }
  const seen = `${meta(html)} ${path.replace(/[-_/+.%?=&]+/g, ' ')} ${text.slice(0, 60000)}`
  const cover = titleCover(job.title, seen)
  const host = new URL(final).hostname.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const co = companyTokens(job.company)
  // Short tokens ("sc" for S&C) only count in the site's own address; on the page the fuller name must appear.
  const flat = seen.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, '').replace(/[^a-z0-9]+/g, '')
  const flatPath = path.toLowerCase().replace(/[^a-z0-9]/g, '')
  const companyOk = co.some(t => (t.length >= 3 && (host.includes(t) || flatPath.includes(t) || flat.includes(t))) || (t.length < 3 && host.startsWith(t)))
  // Script-built pages (Workday, Eightfold) show little text to a plain fetch: their link and title must carry the match.
  const need = text.length < 600 ? 0.75 : 0.8
  if (cover < need) return `the page does not show this job's title (${Math.round(cover * 100)}% of its words)`
  if (!companyOk) return `the page does not look like ${job.company}'s`
  const title = (html.match(/<meta[^>]+og:title[^>]+content="([^"]*)"/i)?.[1] || html.match(/<title[^>]*>([^<]*)/i)?.[1] || job.title).replace(/\s+/g, ' ').trim()
  return { url: final, title, description: text.length >= 600 ? text.slice(0, 20000) : '' }
}

/**
 * Workday pages are built by script and answer plain fetches with little text (or 429): read the posting from
 * Workday's own data API instead. Returns null when that API cannot be reached (the page check then runs as usual).
 */
async function verifyWorkday(url: string, job: { title: string; company: string }): Promise<EmployerPosting | string | null> {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter(Boolean)
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '')) parts.shift()   // "/en-US/External/job/..." → "External/job/..."
  const [site, ...rest] = parts
  if (!site || !rest.length) return null
  const tenant = u.hostname.split('.')[0]
  const r = await siteFetch(`${u.origin}/wday/cxs/${tenant}/${site}/${rest.join('/')}`, { headers: { accept: 'application/json', 'accept-language': 'en-US' }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (!r) return null
  // Workday answers 404 for an unknown posting and 403 "permission denied" (S22) for one taken down.
  if (r.status === 404) return 'the posting says it is closed'
  if (r.status === 403 && /"S22"|permission denied/.test(await r.text().catch(() => ''))) return 'the posting says it is closed'
  if (!r.ok) return null
  const d = await r.json().catch(() => null) as { jobPostingInfo?: { title?: string; jobDescription?: string; canApply?: boolean; externalUrl?: string } } | null
  const info = d?.jobPostingInfo
  if (!info?.title) return null
  if (info.canApply === false) return 'the posting says it is closed'
  const cover = titleCover(job.title, `${info.title} ${decodeURIComponent(u.pathname).replace(/[-_/]+/g, ' ')}`)
  if (cover < 0.75) return `the page does not show this job's title (${Math.round(cover * 100)}% of its words)`
  const text = pageText(info.jobDescription || '')
  const host = u.hostname.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const flat = `${host} ${text}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '')
  if (!companyTokens(job.company).some(t => t.length >= 3 ? flat.includes(t) : host.startsWith(t))) return `the page does not look like ${job.company}'s`
  return { url: info.externalUrl || url, title: info.title, description: text.length >= 300 ? text.slice(0, 20000) : '' }
}

/**
 * Finds a LinkedIn-alert job on the employer's own site. Returns the checked posting, or why it was not found
 * (Easy Apply only, closed, nothing trustworthy).
 */
export async function findEmployerPosting(job: { title: string; company: string; location: string }, model = 'sonnet'): Promise<EmployerPosting | string> {
  // The chosen AI first; if it finds nothing usable (not "closed"), the other AI's search often turns it up.
  const first = await searchOnce(job, model)
  if (typeof first !== 'string' || /closed|easy apply/i.test(first) || !otherAiFound()) return first
  const second = await searchOnce(job, model, true)
  return typeof second === 'string' ? first : second
}

async function searchOnce(job: { title: string; company: string; location: string }, model: string, other = false): Promise<EmployerPosting | string> {
  const prompt = `Find where to apply for this job directly on the employer's own careers site, using web search.

<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
</job>

The answer must be the posting's page on the employer's careers site or on the application system it uses (Workday "myworkdayjobs.com", Greenhouse, Lever, Ashby, iCIMS, SuccessFactors, Oracle "oraclecloud.com", SmartRecruiters, Eightfold, Taleo, Jobvite, Workable, UKG, Phenom, Avature, or the company's own jobs domain such as jobs.<company>.com). Never LinkedIn, Indeed, Glassdoor, ZipRecruiter, Workopolis, Jooble, a "<company>.jobs" re-post (DirectEmployers), or any other job board or aggregator: if you find one of those, follow its Apply link to the real posting.
It must be this exact job (same title; if the company posts the same title in several places, the one in ${job.location}). Do not guess or build a link: give only a link you saw in search results or on a page you opened.

How to look (stop as soon as you have it):
1. Search the exact title in quotes with the company name, and with site: filters for the common systems, e.g. site:myworkdayjobs.com, site:greenhouse.io, site:lever.co, site:smartrecruiters.com, site:eightfold.ai, site:oraclecloud.com, site:icims.com.
2. Find the company's careers site (search "<company> careers"), open it and look for the posting there or in its job search.
3. A job-board copy (Indeed, ZipRecruiter, ...) often names or links the employer's own page: follow that to the employer's site.
If the job is only on LinkedIn (Easy Apply) or you cannot find it on the employer's site, say so.

Reply with JSON only: {"url": "<link or null>", "foundTitle": "<the title as the employer's page shows it>", "why": "<if no link: easy apply only / closed / not found>"}`
  let reply: { url?: string | null; foundTitle?: string; why?: string }
  try { reply = await askJson(prompt, { model, timeoutMs: 300_000, web: true, other }) } catch (e) { return `the search failed (${(e as Error).message.slice(0, 120)})` }
  if (!reply?.url) return reply?.why ? `not found on the employer's site (${reply.why.slice(0, 120)})` : "not found on the employer's site"
  return verifyPosting(String(reply.url).trim(), job)
}

export interface LookupRecord { url: string | null; why: string; at: number }
const KEY = 'linkedinEmployer'
export const lookups = (): Record<string, LookupRecord> => db.kvGet<Record<string, LookupRecord>>(KEY, {})
const stillOnLinkedIn = (j: { applyUrl: string; url: string }): boolean => /linkedin\.com/i.test(j.applyUrl || j.url)

/**
 * Looks up one stored LinkedIn-alert job on the employer's site and, when found, stores the employer's link (and the
 * full posting text) on the job. Not looked up again within `retryAfter` of a miss. Returns true when the job now has
 * the employer's link.
 */
export async function resolveStored(jobId: string, retryAfter = 3 * 86400_000): Promise<boolean> {
  const job = db.getJob(jobId)
  if (!job || job.source !== 'linkedin') return false
  if (!stillOnLinkedIn(job)) return true
  const prev = lookups()[jobId]
  // A site that was only busy (rate limited) is tried again after an hour, not days.
  const wait = prev && /rate limited|search failed|answered 429/.test(prev.why) ? 3600_000 : retryAfter
  if (prev && !prev.url && Date.now() - prev.at < wait) return false
  const r = await findEmployerPosting({ title: job.title, company: job.company, location: job.location })
  const rec: LookupRecord = typeof r === 'string' ? { url: null, why: r, at: Date.now() } : { url: r.url, why: '', at: Date.now() }
  db.kvSet(KEY, { ...lookups(), [jobId]: rec })
  if (typeof r === 'string') return false
  db.setApplyUrl(jobId, r.url)
  if (r.description) db.setDescription(jobId, `${r.description}\n\n(Found on ${job.company}'s own site from your LinkedIn alert: ${r.url})`)
  return true
}

/** Why a LinkedIn-alert job has no employer link (for its flag), or '' when it has one or was never looked up. */
export const missReason = (jobId: string): string => lookups()[jobId]?.why || ''

/** Looks up stored LinkedIn-alert jobs that still point at LinkedIn (newest first, at most `max`), two at a time. */
export async function resolvePending(max: number, each: (done: number, total: number) => void, stop: () => boolean): Promise<number> {
  const seen = lookups()
  const todo = db.listJobs().filter(j => j.source === 'linkedin' && stillOnLinkedIn(j) && !['applied', 'hidden'].includes(j.status) &&
    !(seen[j.id] && !seen[j.id].url && Date.now() - seen[j.id].at < (/rate limited|search failed|answered 429/.test(seen[j.id].why) ? 3600_000 : 3 * 86400_000))).slice(0, max)
  let done = 0, found = 0
  const queue = [...todo]
  const worker = async (): Promise<void> => {
    for (let j = queue.shift(); j && !stop(); j = queue.shift()) {
      try { if (await resolveStored(j.id)) found++ } catch { /* one lookup failing never stops the rest */ }
      each(++done, todo.length)
    }
  }
  await Promise.all([worker(), worker()])
  return found
}
