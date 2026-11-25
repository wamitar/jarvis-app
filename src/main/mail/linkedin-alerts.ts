// LinkedIn job alerts, read from the user's own email (read-only Gmail). LinkedIn itself is never opened or
// scraped: the alert emails LinkedIn sends already name each job's title, company and place.
//
// A job that the careers-site sources already found (same company and title) is left to that copy, which has the
// full posting and can be auto-applied. Others are added with their LinkedIn link, for the user to open and apply.
import type { RawJob } from '../../shared/types'
import { canonicalCompany, companyKey, isBigEmployer } from '../sources/simplify'
import { getMessage, searchAllIds } from './gmail'

// An out-of-range numeric entity (e.g. &#x110000;) is dropped instead of throwing.
const codePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : '')

const decodeEntities = (s: string): string => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))

/**
 * Job cards out of an email's HTML, for mails whose text part has none (e.g. "... are hiring" digests from
 * messages-noreply). A card's link wraps its title and "Company · Place" lines; a later "View" button repeats the id.
 */
export function parseAlertHtml(html: string): AlertJob[] {
  const flat = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a\b[^>]*?href=["'][^"']*?linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)[^"']*["'][^>]*>/gi, '\n@@JOB$1@@\n')
    .replace(/<\/?(?:p|div|tr|td|table|br|li|ul|h\d|span|a)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  const lines = decodeEntities(flat).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const out = new Map<string, AlertJob>()
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^@@JOB(\d+)@@$/)
    if (!m || out.has(m[1])) continue
    const card: string[] = []
    for (let k = i + 1; k < lines.length && !lines[k].startsWith('@@JOB') && card.length < 4; k++) {
      if (FOOTER.test(lines[k])) break // the last card must not swallow the email's footer
      if (!NOISE.test(lines[k])) card.push(lines[k])
    }
    if (card.length < 2) continue
    let [title, company, location] = card
    const dot = card[1].split(/\s+[·•]\s+/)
    if (dot.length >= 2) { company = dot[0]; location = dot.slice(1).join(', ') }
    if (!title || !company || title.length > 150 || company.length > 100) continue
    out.set(m[1], { linkedinId: m[1], title, company, location: location || '' })
  }
  return [...out.values()]
}

const FOOTER = /©|unsubscribe|LinkedIn Corporation|help center|this email was intended/i

export interface AlertJob { linkedinId: string; title: string; company: string; location: string }

// Lines in an alert that are not part of a job card's title / company / place.
const NOISE = /^(your job alert for|you may be a fit|jobs? you may|new jobs?|see all jobs|\d+\+? new jobs?|view job|unsubscribe|manage (job )?alerts|-{5,}|view$)/i

/** Reads the job cards out of one alert email's text part. */
export function parseAlert(text: string): AlertJob[] {
  const out: AlertJob[] = []
  const re = /View job:\s*https:\/\/www\.linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)\S*/g
  let last = 0
  for (const m of text.matchAll(re)) {
    // The card is the text between the previous card's link (or a separator line) and this link.
    const chunk = text.slice(last, m.index).split(/\n-{5,}\s*\n/).pop() || ''
    last = (m.index || 0) + m[0].length
    const lines = chunk.split('\n').map(l => l.trim()).filter(l => l && !NOISE.test(l))
    if (lines.length < 3) continue
    const [title, company, location] = lines
    if (title.length > 150 || company.length > 100) continue
    out.push({ linkedinId: m[1], title, company, location })
  }
  return out
}

const titleKey = (s: string): string => s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

const JOB_SENDERS = 'jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobs-listings@linkedin.com'
// messages-noreply / notifications-noreply mostly carry chat and social mail: only their job digests are read.
const DIGEST_SENDERS = 'messages-noreply@linkedin.com OR notifications-noreply@linkedin.com'

export interface AlertRead {
  jobs: RawJob[]
  /** Message ids fully read (remember them so an overlapping window does not fetch them again). */
  processed: string[]
  /** False when the time budget ran out or a stop was asked: the rest is read next time. */
  complete: boolean
  mails: number
  /** True when the search hit the id cap: older alert mails exist that were not read. */
  capped: boolean
  htmlCards: number
}
export interface AlertOptions { seen?: Set<string>; stop?: () => boolean; budgetMs?: number; pauseMs?: number; cap?: number; progress?: (done: number, total: number) => void }

/**
 * Jobs from LinkedIn alert emails received since `since` (ms; null = every mail there is). `have` = jobs already found
 * by the other sources in this refresh; an alert job matching one of them (same company, same title) is skipped.
 * Mails run newest first; ids in `opts.seen` are not fetched again.
 */
export async function fetchLinkedInAlerts(have: { company: string; title: string }[], since: number | null, opts: AlertOptions = {}): Promise<AlertRead> {
  const after = since == null ? '' : ` after:${Math.floor(since / 1000)}`
  const q = `(from:(${JOB_SENDERS}) OR (from:(${DIGEST_SENDERS}) (hiring OR "jobs/view" OR "new jobs")))${after}`
  const cap = opts.cap ?? 3000
  const all = await searchAllIds(q, cap + 1)
  const capped = all.length > cap
  const ids = all.slice(0, cap).filter(id => !opts.seen?.has(id))
  const known = new Set(have.map(j => `${companyKey(j.company)}|${titleKey(j.title)}`))
  const out = new Map<string, RawJob>()
  const res: AlertRead = { jobs: [], processed: [], complete: true, mails: 0, htmlCards: 0, capped }
  const deadline = Date.now() + (opts.budgetMs ?? 600_000)
  let failures = 0
  for (const id of ids) {
    if (opts.stop?.() || Date.now() > deadline) { res.complete = false; break }
    let mail
    try { mail = await getMessage(id) } catch (e) {
      if (++failures > 15) throw e
      continue
    }
    await new Promise(r => setTimeout(r, opts.pauseMs ?? 120))
    res.mails++; res.processed.push(id); opts.progress?.(res.processed.length, ids.length)
    let cards: AlertJob[] = []
    try { // one malformed mail is skipped (still counted as read), never fails the whole read
      cards = parseAlert(mail.text)
      if (!cards.length && /jobs\/view\/\d+/.test(mail.html)) { cards = parseAlertHtml(mail.html); res.htmlCards += cards.length }
    } catch { cards = [] }
    for (const a of cards) {
      if (out.has(a.linkedinId)) continue // a newer mail already had it
      const company = canonicalCompany(a.company)
      if (known.has(`${companyKey(company)}|${titleKey(a.title)}`)) continue
      const url = `https://www.linkedin.com/jobs/view/${a.linkedinId}/`
      out.set(a.linkedinId, {
        id: `linkedin:${companyKey(company).replace(/ /g, '-') || 'company'}:${a.linkedinId}`, source: 'linkedin', company, title: a.title, location: a.location, url, applyUrl: url,
        description: `${a.title}\n${a.company}\n${a.location}\n\nFrom your LinkedIn job alert email. The app does not open LinkedIn, so the full posting was not read: open the link to read it and apply.`,
        postedAt: new Date(mail.at).toISOString(), big: isBigEmployer(company)
      })
    }
  }
  res.jobs = [...out.values()]
  return res
}
