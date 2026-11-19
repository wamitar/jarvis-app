// Checks the U.S.-person and term-length rules on sample wording. No network, no Claude.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-term-rules.ts
import { textProblem } from '../src/main/filter.ts'
const cases: [string, string, boolean][] = [
  ['Mechanical Intern', 'This is a paid, in-person, 12-week internship.', true],
  ['Mechanical Intern', 'Must be available for a 12 - 14 week internship, May-August, 2027.', true],
  ['Mechanical Intern', 'Relocating to Manassas, VA to complete a 3-month internship.', true],
  ['Mechanical Intern', 'Be available to work full-time for at least 10 weeks during summer 2027.', false],
  ['Mechanical Co-op', 'This 6-month Co-op will begin on January 4th, 2027.', true],
  ['Mechanical Co-op', 'Must be available for a 12-month co-op program starting Summer 2027.', false],
  ['Hardware Intern', 'Availability for an 8–12-month internship with in-office collaboration.', true],
  ['Mechanical Engineering Student', 'POSITION TYPE : WINTER TERM (4, 8, 12 or 16 Month Term)', true],
  ['Engineering Student (PEY)', 'Join us for a summer placement.', false],
  ['Mechanical Intern', 'We offer 3 weeks paid vacation. 2+ years of experience preferred.', true],
  ['Mechanical Intern', 'Summer 2027 internship in Toronto.', true],
  ['Mechanical Intern', 'Must be a U.S. citizen or national, U.S. permanent resident (current Green Card holder).', false],
  ['Mechanical Intern', 'ITAR REQUIREMENTS: To conform to U.S. Government export regulations...', false],
  ['Mechanical Co-op', 'Bruce Power Site Access security clearance (asset, but not mandatory).', true],
  ['Mechanical Co-op', 'Ability to obtain a Canadian Government Reliability Status clearance.', true],
  ['Mechanical Intern', 'Our team supports the U.S. military and allied customers.', true]
]
let bad = 0
for (const [t, d, keep] of cases) { const why = textProblem(t, d); const ok = !why === keep; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${keep ? 'keep' : 'drop'} | ${d.slice(0, 60)} ${why ? '→ ' + why : ''}`) }
console.log(bad ? `${bad} FAILED` : 'all passed'); process.exit(bad ? 1 : 0)
