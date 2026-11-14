export const UA = { 'user-agent': 'internship-hunter/0.1 (personal job search tool)' }

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { accept: 'application/json', ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(25_000) })
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
