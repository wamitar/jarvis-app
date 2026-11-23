export const UA = { 'user-agent': 'internship-hunter/0.1 (personal job search tool)' }

/** A site said "too many requests" (HTTP 429). */
export class RateLimited extends Error {}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let r: Response
  // "Too many requests": wait and try again, up to three times. Workday is not retried: it keeps refusing for a
  // while, so the refresh moves on and reads it another time (see fetchAll).
  const retries = /\.myworkday(jobs|site)\.com$/i.test(new URL(url).hostname) ? 0 : 3
  for (let attempt = 0; ; attempt++) {
    r = await fetch(url, { ...init, headers: { accept: 'application/json', ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(25_000) })
    if (r.status === 429 && attempt >= retries) throw new RateLimited(`429 from ${new URL(url).host} (the site is limiting requests; tried again on a later refresh)`)
    if (r.status !== 429) break
    const wait = Number(r.headers.get('retry-after')) * 1000 || [3000, 8000, 20000][attempt]
    await new Promise(res => setTimeout(res, Math.min(wait, 30_000)))
  }
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`)
  return (await r.json()) as T
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', bull: '•', eacute: 'é', hellip: '…' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Turns HTML (possibly entity-escaped, as Greenhouse sends it) into readable plain text. */
export function htmlToText(html: string): string {
  let s = html || ''
  if (!/<[a-z]/i.test(s) && /&lt;/.test(s)) s = decodeEntities(s)
  s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ').replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; out.push(await fn(it)) }
  }))
  return out
}

/**
 * Gives up on a step that takes longer than `ms` (a company's job board that hangs or keeps answering
 * "too many requests"), so one slow site never holds up the whole refresh. The step is simply abandoned.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`skipped: ${what} took over ${Math.round(ms / 1000)} s (tried again next refresh)`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
