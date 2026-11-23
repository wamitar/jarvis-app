// Checks which option the app picks for field of study. No browser, no Claude.
// Run: node --no-warnings --import ./scripts/resolve-ts.mjs scripts/test-field-of-study.ts
import { _test } from '../src/main/apply/prefill.ts'
const major = 'Mechanical Engineering'
const choose = _test.studyChooser(major)
const cases: [string[], string | null][] = [
  [['Aerospace Engineering', 'Mechanical Engineering', 'Mechatronics Engineering'], 'Mechanical Engineering'],
  [['Engineering, Aerospace', 'Engineering, Mechanical', 'Engineering, Civil'], 'Engineering, Mechanical'],
  [['Mechanical Engineering Technology', 'Mechanical Engineering', 'Mechanical and Aerospace Engineering'], 'Mechanical Engineering'],
  [['Mechanical Engineering Technology', 'Mechanical and Aerospace Engineering'], 'Mechanical and Aerospace Engineering'],
  [['Aerospace Engineering', 'Agricultural Engineering', 'Architectural Engineering'], null],
  [['No Selection', 'Engineering', 'Science'], null],
  [['Mechanical Engineering (BEng)', 'Mechatronics'], 'Mechanical Engineering (BEng)'],
  [['Mechanical Engineering Technician', 'Mechanical'], 'Mechanical']
]
let bad = 0
for (const [opts, want] of cases) { const i = choose(opts); const got = i < 0 ? null : opts[i]; if (got !== want) bad++; console.log(`${got === want ? 'ok  ' : 'FAIL'} ${opts.join(' | ')} -> ${got}`) }
console.log('search terms:', _test.studyTerms(major).join(' / '))
console.log(bad ? `${bad} FAILED` : 'all passed'); process.exit(bad ? 1 : 0)
