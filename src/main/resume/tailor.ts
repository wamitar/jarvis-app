import type { Job, Resume } from '../../shared/types'
import { resumeToText } from '../../shared/types'
import { askJson } from '../ai/claude'
import { normalizeResume, RESUME_SHAPE } from './parse'

export interface TailorOutput { resume: Resume; coverLetter: string; changes: string[]; warnings: string[] }

const STOP = new Set('The A An And Or For With In On At To Of By From As I We My Our Is Are Was Were Be This That These Those Led Built Designed Developed Created Managed Used Using Improved Reduced Increased Summary Education Experience Projects Skills Dear Sincerely Hiring Team Manager'.split(' '))

/** Flags numbers and proper nouns in the tailored text that appear in neither the base resume nor the posting-independent facts. */
export function findInventions(base: Resume, baseRaw: string, tailored: Resume, job: Job): string[] {
  const known = (resumeToText(base) + '\n' + baseRaw).toLowerCase()
  const jobText = `${job.company} ${job.title}`.toLowerCase()
  const text = resumeToText(tailored)
  const warnings = new Set<string>()
  for (const m of text.matchAll(/\d[\d,.]*\+?%?/g)) {
    const n = m[0].replace(/[.,]$/, '')
    if (n.length && !known.includes(n.toLowerCase())) warnings.add(`Number not in your original resume: "${n}"`)
  }
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9&+#.-]{2,}\b/g)) {
    const w = m[0].replace(/[.-]$/, '')
    if (STOP.has(w) || /^(SUMMARY|EDUCATION|EXPERIENCE|PROJECTS|SKILLS)$/.test(w) || known.includes(w.toLowerCase()) || jobText.includes(w.toLowerCase())) continue
    // Sentence-initial ordinary words are fine; only flag words capitalised mid-sentence or that look like tools/names.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0)
    const sentenceStart = (m.index ?? 0) === 0 || /[\n•.:]\s?$/.test(before)
    if (sentenceStart && /^[A-Z][a-z]+$/.test(w)) continue
    warnings.add(`Term not in your original resume: "${w}"`)
  }
  return [...warnings].slice(0, 25)
}

export async function tailorResume(base: Resume, baseRaw: string, job: Job, withCover: boolean, extraFacts: string, model: string): Promise<TailorOutput> {
  const prompt = `Tailor this candidate's resume for one internship posting.

<resume>
${JSON.stringify(base)}
</resume>

<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description.slice(0, 9000)}
</job>

What you may change:
- Rewrite the summary (2 sentences at most) to point at this role. Leave it "" if the base resume has none and there is nothing true to say.
- Reword bullets to foreground the work most relevant to this posting, using the posting's vocabulary where it truthfully describes what the candidate did.
- Reorder bullets within an entry, reorder projects, reorder skill categories and the items within them, most relevant first.
- Drop the least relevant bullets or projects if needed to keep the resume to one page.

Hard rules (the candidate will be held to every word):
- Never invent or imply experience, tools, skills, employers, degrees, dates, titles, awards or numbers that are not in the base resume.
- Every bullet must trace back to a bullet in the base resume. Do not merge unrelated facts into a new claim.
- Keep all names, employers, schools, titles and dates exactly as written.
- Do not add a skill because the posting asks for it. Only list skills the base resume already shows.
- Write in plain, direct language. No buzzwords the base resume does not use.
${withCover ? `
Also write a cover letter: 3 short paragraphs, under 220 words, plain and specific, first person, no flattery, no clichés ("I am excited to", "passionate"), and only facts from the resume${extraFacts ? ' or these extra facts: ' + extraFacts.slice(0, 1500) : ''}. Start with "Dear Hiring Team," and end with the candidate's name.` : ''}

Reply with JSON:
{"resume": ${RESUME_SHAPE.replace(/\n\s*/g, ' ')},
 "changes": ["3 to 6 short notes on what you changed and why"],
 "coverLetter": "${withCover ? 'the letter, with \\n between paragraphs' : ''}"}`
  const out = await askJson<{ resume?: unknown; changes?: unknown; coverLetter?: unknown }>(prompt, { model, timeoutMs: 360_000 })
  const resume = normalizeResume(out.resume)
  if (!resume.name) resume.name = base.name
  resume.contact = base.contact   // contact details are never model-written
  resume.name = base.name
  return {
    resume, coverLetter: typeof out.coverLetter === 'string' ? out.coverLetter.trim() : '',
    changes: Array.isArray(out.changes) ? out.changes.map(String).slice(0, 8) : [],
    warnings: findInventions(base, baseRaw, resume, job)
  }
}
