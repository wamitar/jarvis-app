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
import { pool } from './util'

export interface FetchOutcome { jobs: RawJob[]; errors: string[] }

const FETCHERS: Record<Board['ats'], (b: Board) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workday: fetchWorkday,
  amazon: fetchAmazon, google: fetchGoogle, apple: fetchApple, eightfold: fetchEightfold, oracle: fetchOracle, smartrecruiters: fetchSmartRecruiters, jibe: fetchJibe,
  successfactors: fetchSuccessFactors, ukg: fetchUkg, bamboohr: fetchBambooHr, workable: fetchWorkable
}

export const FETCHERS_FOR_TEST = FETCHERS

export function allBoards(settings: Settings): Board[] {
  const seen = new Set<string>()
  return [...BOARDS, ...settings.customBoards].filter(b => { const k = `${b.ats}:${b.id}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export async function fetchAll(settings: Settings, onProgress: (done: number, total: number, label: string) => void): Promise<FetchOutcome> {
  // IH_ONLY_BOARDS (comma-separated board ids) narrows a run to a few boards, for tests.
  const only = (process.env.IH_ONLY_BOARDS || '').split(',').filter(Boolean)
  const boards = allBoards(settings).filter(b => !only.length || only.some(o => b.id.startsWith(o)))
  const jobs: RawJob[] = []
  const errors: string[] = []
  const useAdzuna = !!(settings.adzunaAppId && settings.adzunaAppKey)
  const total = boards.length + 1 + (useAdzuna ? 1 : 0)
  let done = 0
  const tick = (label: string): void => { done++; onProgress(done, total, label) }

  await pool(boards, 6, async b => {
    if (isStopping()) return
    try { jobs.push(...await FETCHERS[b.ats](b)) } catch (e) { errors.push(`${b.company}: ${(e as Error).message}`) }
    tick(b.company)
  })
  checkStop()
  if (!only.length) try { jobs.push(...await fetchJobBank()) } catch (e) { errors.push(`Job Bank: ${(e as Error).message}`) }
  tick('Job Bank Canada')
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
  if (j.detailUrl) {
    const read = j.source === 'eightfold' ? eightfoldDetail : j.source === 'oracle' ? oracleDetail : j.source === 'successfactors' ? successFactorsDetail
      : j.source === 'bamboohr' ? bambooHrDetail : j.source === 'workable' ? workableDetail : smartRecruitersDetail
    return { description: await read(j.detailUrl), location: j.location }
  }
  return { description: j.description, location: j.location }
}
