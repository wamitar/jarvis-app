// Judges whether a company outside the hand-made lists is a large employer or a larger hardware startup, so LinkedIn
// alert jobs at e.g. MAHLE or Trane are not dropped as "not a large employer". Verdicts are cached in the database
// and read by the filter through setAiLarge.
import { askJson } from '../ai/claude'
import { checkStop } from '../activity'
import * as db from '../db'
import { isAiLarge, setAiLarge } from '../filter'
import { canonicalCompany, isBigEmployer } from './simplify'

interface Entry { large: boolean; why: string; at: number }
const KEY = 'companySize'
const BATCH = 25
const MAX_AGE_MS = 90 * 86400_000

const read = (): Record<string, Entry> => db.kvGet<Record<string, Entry>>(KEY, {})

/** Loads the cached verdicts into the filter. Call once at startup and after classifyCompanies (which also does it). */
export function loadCompanySizes(): void {
  setAiLarge(Object.entries(read()).filter(([, e]) => e && e.large).map(([n]) => n))
}

const PROMPT = (names: string[]): string => `You are classifying employers for a mechanical-engineering student's internship search in the USA and Canada.
For each company name decide "large": true ONLY if it is
 (a) a large employer (roughly 1000+ employees worldwide, or a well-known public or major company), OR
 (b) a well-funded, larger hardware / deep-tech / aerospace / manufacturing startup (roughly 200+ employees or major funding),
and it operates in North America.
Answer false when unsure, when the name is ambiguous or you do not recognise it, when it is a small or local shop, and always for staffing agencies, recruiters, job boards and consultancies that hire on behalf of others (for example "Tech World Networking" style recruiters).
Reply with ONLY a JSON array, one object per company, in the same order: [{"name": "<exact name given>", "large": true|false, "why": "<max 12 words>"}]

Companies:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`

/** Asks the AI about companies not in the hand lists and not cached (or cached over 90 days). Returns how many were newly judged large, and the names that could not be judged (batch failed / no verdict). */
export async function classifyCompanies(names: string[], model: string): Promise<{ large: number; failed: string[] }> {
  const cache = read()
  const now = Date.now()
  const todo = new Map<string, string>() // canonical -> name as asked
  for (const raw of names) {
    const name = canonicalCompany(raw || '')
    if (!name || isHand(name)) continue
    const c = cache[name]
    if (c && now - c.at < MAX_AGE_MS) continue
    todo.set(name, name)
  }
  const list = [...todo.keys()]
  let newlyLarge = 0
  for (let i = 0; i < list.length; i += BATCH) {
    checkStop()
    const batch = list.slice(i, i + BATCH)
    try {
      const res = await askJson<{ name: string; large: boolean; why?: string }[]>(PROMPT(batch), { model, web: false, timeoutMs: 120_000 })
      if (!Array.isArray(res)) continue
      const fresh = read()
      for (const r of res) {
        const name = batch.find(n => n.toLowerCase() === String(r?.name || '').trim().toLowerCase())
        if (!name || typeof r.large !== 'boolean') continue
        if (r.large && !fresh[name]?.large) newlyLarge++
        fresh[name] = { large: r.large, why: String(r.why || '').slice(0, 160), at: Date.now() }
      }
      db.kvSet(KEY, fresh)
    } catch (e) {
      if (e instanceof Error && e.name === 'StoppedError') throw e
      if (e instanceof Error && e.message === 'Stopped.') throw e
      // One failed batch is skipped; those names are tried again next refresh.
    }
  }
  loadCompanySizes()
  const after = read()
  const failed = list.filter(n => !after[n] || Date.now() - after[n].at >= MAX_AGE_MS)
  return { large: newlyLarge, failed }
}

// Hand-curated employers (KNOWN and big boards) need no judgement. isBigEmployer also consults the AI set, so check the cache first.
function isHand(name: string): boolean { return !isAiLarge(name) && isBigEmployer(name) }
