// Runs candidate employer boards through the app's real readers and reports what each returns.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/check-boards.ts <candidates.txt>
// Each line: Company;system;id;big(1|0)
import { readFileSync } from 'node:fs'
import { FETCHERS_FOR_TEST as FETCHERS } from '../src/main/sources/index.ts'
import { regionOf, isInternTitle, checkJob } from '../src/main/filter.ts'
import type { Board } from '../src/shared/types.ts'

const boards: Board[] = readFileSync(process.argv[2], 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => { const [company, ats, id, big = '1'] = l.split(';').map(x => x.trim()); return { company, ats: ats as Board['ats'], id, big: big === '1' } })
let i = 0
const lines: string[] = []
await Promise.all(Array.from({ length: 5 }, async () => {
  while (i < boards.length) {
    const b = boards[i++]
    try {
      const jobs = await FETCHERS[b.ats](b)
      const ca = jobs.filter(j => ['ontario', 'canada'].includes(regionOf(j.location)))
      const kept = jobs.filter(j => checkJob(j).keep)
      lines.push(`${jobs.length && ca.length ? 'GOOD' : jobs.length ? 'NOCA' : 'ZERO'} ${b.company};${b.ats};${b.id};${b.big ? 1 : 0}  # read ${jobs.length}, Canada ${ca.length}, interns ${jobs.filter(j => isInternTitle(j.title)).length}, pass ${kept.length} | ${(ca[0] || jobs[0])?.title?.slice(0, 40) || ''} @ ${(ca[0] || jobs[0])?.location?.slice(0, 40) || ''}`)
    } catch (e) { lines.push(`FAIL ${b.company};${b.ats};${b.id}  # ${(e as Error).message.slice(0, 80)}`) }
  }
}))
console.log(lines.sort().join('\n'))
