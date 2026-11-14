// Live check of the job sources and the filter. Run: npm run test:sources
import { BOARDS } from '../src/main/companies.ts'
import { fetchGreenhouse } from '../src/main/sources/greenhouse.ts'
import { fetchLever } from '../src/main/sources/lever.ts'
import { fetchAshby } from '../src/main/sources/ashby.ts'
import { fetchWorkday, fetchWorkdayDetail } from '../src/main/sources/workday.ts'
import { fetchJobBank, fetchJobBankDetail } from '../src/main/sources/jobbank.ts'
import { checkJob, regionOf } from '../src/main/filter.ts'
import type { RawJob } from '../src/shared/types.ts'

const pick = (ats: string, id: string) => BOARDS.find(b => b.ats === ats && b.id.startsWith(id))!
const runs: [string, () => Promise<RawJob[]>][] = [
  ['greenhouse spacex', () => fetchGreenhouse(pick('greenhouse', 'spacex'))],
  ['lever zoox', () => fetchLever(pick('lever', 'zoox'))],
  ['ashby skydio', () => fetchAshby(pick('ashby', 'skydio'))],
  ['workday boeing', () => fetchWorkday(pick('workday', 'boeing'))],
  ['workday magna', () => fetchWorkday(pick('workday', 'magna'))],
  ['jobbank', () => fetchJobBank()]
]
for (const [name, fn] of runs) {
  const jobs = await fn()
  const bad = jobs.filter(j => !j.id || !j.title || !j.url)
  const kept = jobs.map(j => ({ j, v: checkJob(j) })).filter(x => x.v.keep)
  console.log(`\n${name}: ${jobs.length} jobs, ${bad.length} malformed, ${kept.length} pass the filter`)
  for (const { j, v } of kept.slice(0, 6)) console.log(`  [${v.region}${v.needBody ? ', needs body' : ''}] ${j.title} — ${j.location}`)
  const nb = kept.find(x => x.v.needBody) || kept[0]
  if (nb && j_detail(nb.j)) {
    const d = nb.j.source === 'workday' ? await fetchWorkdayDetail(nb.j) : { description: await fetchJobBankDetail(nb.j), location: nb.j.location }
    console.log(`  detail: ${d.description.length} chars, location "${d.location}" -> ${regionOf(d.location)}`)
  }
}
function j_detail(j: RawJob) { return j.source === 'workday' || j.source === 'jobbank' }

const cases: [string, string][] = [['Toronto, ON', 'ontario'], ['Ajax, ON, Canada', 'ontario'], ['Hawthorne, CA', 'usa'], ['Montreal, QC', 'canada'],
  ['Bengaluru, India', 'other'], ['USA - WA - Seattle', 'usa'], ['London, United Kingdom', 'other'], ['Markham, Ontario, Canada', 'ontario'], ['Remote', 'unknown'], ['Everett, Washington', 'usa'], ['Luxembourg, LUX', 'other'], ['SGP', 'other'], ['GBR - Hounslow, UK', 'other'], ['North Reading, Massachusetts, USA', 'usa'], ['Paris, ON, Canada', 'ontario'], ['Taipei, Taiwan', 'other']]
let fails = 0
for (const [loc, want] of cases) { const got = regionOf(loc); if (got !== want) { fails++; console.log(`REGION FAIL ${loc}: ${got} != ${want}`) } }
const mk = (title: string, location: string, big: boolean, description = ''): RawJob => ({ id: 'x', source: 'manual', company: 'c', title, location, url: 'u', applyUrl: 'u', description, postedAt: null, big })
const fc: [RawJob, boolean][] = [
  [mk('Mechanical Engineering Intern', 'Toronto, ON', false), true], [mk('Mechanical Engineering Intern', 'Austin, TX', false), false],
  [mk('Mechanical Engineering Intern', 'Austin, TX', true), true], [mk('Software Engineering Intern', 'Toronto, ON', true), false],
  [mk('Senior Mechanical Engineer', 'Toronto, ON', true), false], [mk('Manufacturing Engineering Co-op', 'Guelph, ON', false, 'Use SolidWorks to design fixtures'), true],
  [mk('Engineering Intern', 'Detroit, MI', true, 'Write Python services'), false], [mk('International Sales Manager', 'Toronto, ON', true), false],
  [mk('Summer 2027 Engineering Internship/Co-op', 'Flexible - Any Site', true, 'mechanical engineering students welcome'), true], [mk('Mechanical Intern', 'Flexible', false), false], [mk('Mechanical Engineer Intern, PhD, Summer 2027', 'Mountain View, CA, USA', true), false]
]
for (const [j, want] of fc) { const got = checkJob(j).keep; if (got !== want) { fails++; console.log(`FILTER FAIL ${j.title} @ ${j.location} big=${j.big}: ${got}`) } }
console.log(fails ? `\n${fails} rule checks FAILED` : '\nAll region and filter rule checks passed')
