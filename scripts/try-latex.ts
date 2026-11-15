// Renders a resume JSON file through the LaTeX template and compiles it. Usage: try-latex.ts <resume.json> <out.pdf>
import { readFileSync } from 'node:fs'
import { resumeLatex, compileLatex } from '../src/main/resume/latex.ts'
import { normalizeResume } from '../src/main/resume/parse.ts'
const r = normalizeResume(JSON.parse(readFileSync(process.argv[2], 'utf8')))
const out = await compileLatex(resumeLatex(r), process.argv[3])
console.log('pages:', out.pages, '|', out.path)
