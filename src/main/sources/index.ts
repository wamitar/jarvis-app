import type { Board, RawJob, Settings } from '../../shared/types'
import { BOARDS } from '../companies'
import { fetchGreenhouse } from './greenhouse'
import { fetchLever } from './lever'
import { fetchAshby } from './ashby'
import { fetchWorkday, fetchWorkdayDetail } from './workday'
import { fetchJobBank, fetchJobBankDetail } from './jobbank'
import { fetchAdzuna } from './adzuna'
import { isStopping, checkStop } from '../activity'
import { bambooHrDetail, fetchBambooHr, fetchSuccessFactors, fetchUkg, fetchWorkable, successFactorsDetail, workableDetail } from './canada'
import { eightfoldDetail, fetchAmazon, fetchApple, fetchEightfold, fetchGoogle, fetchJibe, fetchOracle, fetchSmartRecruiters, oracleDetail, smartRecruitersDetail } from './bigtech'
import { pool, RateLimited, withTimeout } from './util'

// Longest one company's job board may take before it is skipped for this refresh.
const BOARD_LIMIT_MS = 60_000
import { fetchSimplify, postingText, resetSimplifyCaches } from './simplify'

export interface FetchOutcome { jobs: RawJob[]; errors: string[] }

const FETCHERS: Record<Board['ats'], (b: Board) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workday: fetchWorkday,
  amazon: fetchAmazon, google: fetchGoogle, apple: fetchApple, eightfold: fetchEightfold, oracle: fetchOracle, smartrecruiters: fetchSmartRecruiters, jibe: fetchJibe,
  successfactors: fetchSuccessFactors, ukg: fetchUkg, bamboohr: fetchBambooHr, workable: fetchWorkable
}

export const FETCHERS_FOR_TEST = FETCHERS

// Boards found through the SimplifyJobs list (KNOWN employers only), kept in the database by refresh.ts.
let discovered: Board[] = []
export const setDiscoveredBoards = (b: Board[]): void => { discovered = b }

export function allBoards(settings: Settings): Board[] {
  const seen = new Set<string>()
  return [...BOARDS, ...settings.customBoards, ...discovered].filter(b => { const k = `${b.ats}:${b.id}`; if (seen.has(k)) return false; seen.add(k); return true })
}

/** Workday sites read successfully in the last this-many ms are not read again (they throttle, and change slowly). */
export const WORKDAY_REREAD_MS = 12 * 3600_000

export async function fetchAll(settings: Settings, onProgress: (done: number, total: number, label: string) => void,
  workdayReadAt: Record<string, number> = {}): Promise<FetchOutcome> {
  // IH_ONLY_BOARDS (comma-separated board ids) narrows a run to a few boards, for tests.
  const only = (process.env.IH_ONLY_BOARDS || '').split(',').filter(Boolean)
  const boards = allBoards(settings).filter(b => !only.length || only.some(o => b.id.startsWith(o)))
  const jobs: RawJob[] = []
  const errors: string[] = []
  const useAdzuna = !!(settings.adzunaAppId && settings.adzunaAppKey)
  const useSimplify = settings.useSimplify !== false && !only.length
  const total = boards.length + 1 + (useAdzuna ? 1 : 0) + (useSimplify ? 1 : 0)
  let done = 0
  const tick = (label: string): void => { done++; onProgress(done, total, label) }

  // Workday throttles bursts ("too many requests") and is the slow part of a refresh, so a Workday site read
  // successfully in the last 12 hours is skipped (workdayReadAt is updated here for the caller to keep).
  const now = Date.now()
  // When Workday refuses several sites in a row it is limiting this computer for a while: the rest of the
  // Workday sites are left for a later refresh instead of being asked (and refused) one by one.
  let workdayRefusals = 0
  const WORKDAY_BACK_OFF = 4
  const readBoard = async (b: Board): Promise<void> => {
    if (isStopping()) return
    const key = `${b.ats}:${b.id}`
    if (b.ats === 'workday' && now - (workdayReadAt[key] || 0) < WORKDAY_REREAD_MS) { tick(`${b.company} (read recently)`); return }
    if (b.ats === 'workday' && workdayRefusals >= WORKDAY_BACK_OFF) { tick(`${b.company} (Workday busy, next time)`); return }
    try {
      jobs.push(...await withTimeout(FETCHERS[b.ats](b), BOARD_LIMIT_MS, b.company))
      if (b.ats === 'workday') { workdayReadAt[key] = Date.now(); workdayRefusals = 0 }
    } catch (e) {
      if (b.ats === 'workday' && e instanceof RateLimited && ++workdayRefusals === WORKDAY_BACK_OFF)
        errors.push('Workday: limiting requests from this computer right now; the remaining Workday companies are read on a later refresh')
      if (!(e instanceof RateLimited && workdayRefusals > WORKDAY_BACK_OFF)) errors.push(`${b.company}: ${(e as Error).message}`)
    }
    tick(b.company)
  }
  await Promise.all([pool(boards.filter(b => b.ats === 'workday'), 6, readBoard), pool(boards.filter(b => b.ats !== 'workday'), 8, readBoard)])
  checkStop()
  if (!only.length) try { jobs.push(...await withTimeout(fetchJobBank(), 3 * BOARD_LIMIT_MS, 'Job Bank')) } catch (e) { errors.push(`Job Bank: ${(e as Error).message}`) }
  tick('Job Bank Canada')
  if (useSimplify) {
    resetSimplifyCaches()
    // The same posting found on a curated board has the same id: the board's copy (with its description) wins.
    const have = new Set(jobs.map(j => j.id))
    try { jobs.push(...(await withTimeout(fetchSimplify(), 2 * BOARD_LIMIT_MS, 'the SimplifyJobs list')).filter(j => !have.has(j.id))) } catch (e) { errors.push(`SimplifyJobs list: ${(e as Error).message}`) }
    tick('SimplifyJobs internship list')
  }
  if (useAdzuna) {
    const bigNames = new Set(boards.filter(b => b.big).map(b => b.company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))
    try { jobs.push(...await fetchAdzuna(settings.adzunaAppId, settings.adzunaAppKey, bigNames)) } catch (e) { errors.push(`Adzuna: ${(e as Error).message}`) }
    tick('Adzuna')
  }
  return { jobs, errors }
}

/** Fills in the description (and a precise location) for sources whose list results lack them. */
export async function fetchDetail(j: RawJob): Promise<{ description: string; location: string }> {
  if (j.source === 'workday') return fetchWorkdayDetail(j)
  if (j.source === 'jobbank') return { description: await fetchJobBankDetail(j), location: j.location }
  // Found through the SimplifyJobs list (no text in the list): read the posting itself.
  if (!j.description && (j.source === 'greenhouse' || j.source === 'lever' || j.source === 'ashby'))
    return { description: await postingText(j), location: j.location }
  // Some careers sites refuse automated reads (Tesla). The job is then judged on its title alone, and says so.
  if (j.source === 'simplify') {
    // A page that is only a script shell (a few words of text) counts as unreadable.
    const text = await postingText(j).then(t => (t.length > 400 ? t : '')).catch(() => '')
    return { description: text || `${j.title}\n\n(The app could not read this posting's text automatically. Open the link to see the full posting.)`, location: j.location }
  }
  if (j.source === 'linkedin') return { description: j.description, location: j.location }
  if (j.detailUrl) {
    const read = j.source === 'eightfold' ? eightfoldDetail : j.source === 'oracle' ? oracleDetail : j.source === 'successfactors' ? successFactorsDetail
      : j.source === 'bamboohr' ? bambooHrDetail : j.source === 'workable' ? workableDetail : smartRecruitersDetail
    return { description: await read(j.detailUrl), location: j.location }
  }
  return { description: j.description, location: j.location }
}
