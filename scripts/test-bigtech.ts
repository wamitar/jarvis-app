// Live check of the big-tech sources. Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-bigtech.ts
import { BOARDS } from '../src/main/companies.ts'
import { FETCHERS_FOR_TEST as F, fetchDetail } from '../src/main/sources/index.ts'
import { checkJob } from '../src/main/filter.ts'
for (const name of (process.argv[2] ? process.argv[2].split(',') : ['Amazon', 'Apple', 'Google', 'Microsoft', 'Netflix', 'Ford', 'Honeywell', 'Bosch', 'Intel', 'OpenAI', 'Helion'])) {
  const b = BOARDS.find(x => x.company === name)!
  try {
    const jobs = await F[b.ats](b)
    const kept = jobs.map(j => ({ j, v: checkJob(j) })).filter(x => x.v.keep)
    console.log(`\n${name} (${b.ats}): ${jobs.length} postings, ${jobs.filter(j => !j.id || !j.title || !j.url).length} malformed, ${kept.length} pass the filter`)
    for (const { j, v } of kept.slice(0, 4)) console.log(`  [${v.region}${v.needBody ? ', needs body' : ''}] ${j.title} — ${j.location.slice(0, 60)}`)
    const nb = kept.find(x => x.v.needBody && x.j.detailUrl)
    if (nb) { const d = await fetchDetail(nb.j); console.log(`  detail: ${d.description.length} chars -> keep=${checkJob({ ...nb.j, description: d.description }).keep}`) }
  } catch (e) { console.log(`\n${name}: FAILED ${(e as Error).message}`) }
}
