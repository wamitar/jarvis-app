// Checks the U.S.-person and term-length rules on sample wording. No network, no Claude.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-term-rules.ts
import { checkJob, regionOf, textProblem } from '../src/main/filter.ts'
import { canonicalCompany } from '../src/main/sources/simplify.ts'
import { eligibilityFor } from '../src/main/apply/prefill.ts'
import type { RawJob } from '../src/shared/types.ts'
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
const job = (company: string, title: string, location: string, description: string): RawJob =>
  ({ id: `greenhouse:${company}:1`, source: 'greenhouse', company, title, location, url: '', applyUrl: '', description, postedAt: null, big: true })
const jobCases: [RawJob, boolean, string][] = [
  [job('Red Bull Racing', 'Industrial Placement', 'Milton Keynes, Buckinghamshire, United Kingdom', 'A 12 month placement in our aerodynamics department using CFD and wind tunnel testing.'), true, 'uk'],
  [job('Dyson', 'Industrial Placement', 'Milton Keynes, Buckinghamshire, United Kingdom', 'A 12 month placement in our aerodynamics department using CFD and wind tunnel testing.'), false, 'uk'],
  [job('Ferrari', 'Mechanical Design Internship (Maranello)', 'Maranello', 'Six month internship designing components in CATIA.'), true, 'other'],
  [job('Leonardo', 'Mechanical Engineering Intern', 'Rome, Italy', 'Mechanical design of avionics housings.'), false, 'other'],
  [job('Ferrari', 'Vehicle Dynamics Internship (Maranello)', 'Maranello', 'Six month internship in vehicle dynamics. We do not offer visa sponsorship.'), false, 'other']
]
for (const [j, keep, region] of jobCases) { const v = checkJob(j); const ok = v.keep === keep && v.region === region; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${keep ? 'keep' : 'drop'} | ${j.company}: ${j.title} → ${v.keep ? 'keep' : v.reason} (${v.region})`) }
const checks: [string, boolean][] = [
  ["regionOf('Grove, Oxfordshire, UK') === 'uk'", regionOf('Grove, Oxfordshire, UK') === 'uk'],
  ["regionOf('Grove, OK') === 'usa'", regionOf('Grove, OK') === 'usa'],
  ["canonicalCompany('Oracle Red Bull Racing') === 'Red Bull Racing'", canonicalCompany('Oracle Red Bull Racing') === 'Red Bull Racing'],
  ["canonicalCompany('MoneyGram Haas F1 Team') === 'Haas F1 Team'", canonicalCompany('MoneyGram Haas F1 Team') === 'Haas F1 Team'],
  ["canonicalCompany('Red Bull') === 'Red Bull'", canonicalCompany('Red Bull') === 'Red Bull'],
  ["eligibilityFor(Maranello job) === Italy / No / Yes", JSON.stringify(eligibilityFor({ region: 'other', location: 'Maranello' } as any, { workAuthCanada: 'Yes', needsSponsorship: 'No' } as any)) === JSON.stringify({ country: 'Italy', authorized: 'No', sponsorship: 'Yes' })]
]
for (const [label, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`) }
console.log(bad ? `${bad} FAILED` : 'all passed'); process.exit(bad ? 1 : 0)
