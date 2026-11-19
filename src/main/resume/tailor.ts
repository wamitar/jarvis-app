import type { Job, Profile, Resume } from '../../shared/types'
import { plain, resumeToText } from '../../shared/types'
import { askJson } from '../ai/claude'
import { normalizeResume, RESUME_SHAPE } from './parse'

export interface TailorOutput { resume: Resume; coverLetter: string; changes: string[]; warnings: string[] }

/** Material beyond the resume that tailoring may draw on: extra projects and extra skills from the Profile page. */
export interface Bank { projects: Profile['moreProjects']; skills: string }
const NO_BANK: Bank = { projects: [], skills: '' }
export const bankOf = (p: Profile): Bank => ({ projects: (p.moreProjects || []).filter(x => x.name || x.bullets.length), skills: (p.moreSkills || '').trim() })
const bankText = (b: Bank): string => b.projects.map(x => [x.name, x.tech, ...x.bullets].join('\n')).join('\n') + '\n' + b.skills

/** Every skill on the base resume stays on the tailored one: anything the model dropped is put back in its category. */
function keepSkills(base: Resume, r: Resume): void {
  const has = new Set(r.skills.flatMap(c => c.items).map(i => plain(i).trim().toLowerCase()))
  for (const c of base.skills) {
    const lost = c.items.filter(i => !has.has(plain(i).trim().toLowerCase()))
    if (!lost.length) continue
    const target = r.skills.find(x => same(x.category, c.category))
    if (target) target.items.push(...lost); else r.skills.push({ category: c.category, items: lost })
  }
}

const STOP = new Set('The A An And Or For With In On At To Of By From As I We My Our Is Are Was Were Be This That These Those Led Built Designed Developed Created Managed Used Using Improved Reduced Increased Summary Education Experience Projects Skills Dear Sincerely Hiring Team Manager'.split(' '))

/** Flags numbers and proper nouns in the tailored text that appear in neither the base resume nor the posting-independent facts. */
export function findInventions(base: Resume, baseRaw: string, tailored: Resume, job: Job, bank: Bank = NO_BANK): string[] {
  const known = (resumeToText(base) + '\n' + baseRaw + '\n' + bankText(bank)).toLowerCase()
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

const same = (a: string, b: string): boolean => plain(a).trim().toLowerCase() === plain(b).trim().toLowerCase()
/** Layout facts (which line is bold, places, dates) always come from the base resume, never from the model. */
function keepLayout(base: Resume, r: Resume): void {
  for (const e of r.experience) {
    const b = base.experience.find(x => same(x.company, e.company) && same(x.title, e.title)) || base.experience.find(x => same(x.company, e.company))
    if (b) { e.headline = b.headline; e.location = b.location; e.dates = b.dates }
  }
  for (const e of r.education) { const b = base.education.find(x => same(x.school, e.school)); if (b) { e.location = b.location; e.dates = b.dates } }
}

/** Asks Claude to cut a tailored resume that ran past one page. Nothing may be added. */
export async function shortenResume(base: Resume, resume: Resume, job: Job, pages: number, model: string): Promise<Resume> {
  const prompt = `This tailored resume ran to ${pages} pages when typeset. It must fit on exactly one page.

<resume>
${JSON.stringify(resume)}
</resume>

<job>
${job.title} at ${job.company}
${job.description.slice(0, 2500)}
</job>

Shorten it by about ${pages > 2 ? 'a third' : '4 to 6 printed lines'}: remove the bullets least relevant to this job, or tighten wordy ones. Keep every section and every entry's heading. Never remove anything from the skills section. Do not add or change any fact, and keep the **bold** markers.

Reply with JSON: {"resume": <the same shape as the input>}`
  const out = await askJson<{ resume?: unknown }>(prompt, { model, timeoutMs: 300_000 })
  const r = normalizeResume(out.resume)
  if (!r.experience.length && !r.projects.length) return resume
  r.name = base.name; r.contact = base.contact
  keepLayout(base, r)
  keepSkills(resume, r)
  return r
}

export async function tailorResume(base: Resume, baseRaw: string, job: Job, withCover: boolean, extraFacts: string, model: string, bank: Bank = NO_BANK): Promise<TailorOutput> {
  const slots = Math.max(base.projects.length, 1)
  const prompt = `Tailor this candidate's resume for one internship posting.

<resume>
${JSON.stringify(base)}
</resume>

${bank.projects.length ? `<more_projects>
${JSON.stringify(bank.projects)}
</more_projects>

` : ''}${bank.skills ? `<more_skills>
${bank.skills}
</more_skills>

` : ''}<job>
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description.slice(0, 9000)}
</job>

What you may change:
${base.summary.trim() ? '- Rewrite the summary (2 sentences at most) to point at this role.' : '- The resume has no summary section. Leave "summary" as "".'}
- Reword bullets to foreground the work most relevant to this posting, using the posting's vocabulary where it truthfully describes what the candidate did.
- Reorder bullets within an entry, reorder projects, reorder skill categories and the items within them, most relevant first.
- Drop the least relevant bullets if needed to keep the resume to one page.
${bank.projects.length ? `- Projects: the candidate has more projects than fit on the page. From the resume's own projects and the ones in more_projects, choose the ${slots} that best match this posting and list only those, most relevant first. A project from more_projects is used as written there (you may reword and trim its bullets under the same rules as any other bullet). Say in "changes" which projects you chose and which you left out.` : '- Drop the least relevant project only if the page cannot fit otherwise.'}

Skills section (the candidate has broad experience and wants it shown):
- Keep every skill, tool and piece of software that the base resume's skills section lists. Never remove one, even when the posting does not mention it. You may reorder them, most relevant first.
- Add any software or tool that appears in the chosen projects or experience bullets but is missing from the skills section.${bank.skills ? '\n- Add the items from more_skills that are relevant to this posting.' : ''}
- Add the software, tools and technical skills this posting asks for, even when the resume does not mention them, each to the category it belongs in. List every skill you added this way in "changes", starting the note with "Added skill:", so the candidate can remove any they cannot back up.

Format rules:
- Text marks bold as **like this**. Keep that style: in each bullet, bold the 2 to 4 tools, methods or key numbers that matter most for this posting. Never bold a whole sentence.
- The resume must still fit on one page. Do not make it longer than the base: the total amount of bullet text must be the same or less.
- Copy "headline", "location" and "dates" fields unchanged.

Hard rules (the candidate will be held to every word):
- Outside the skills section, never invent or imply experience, tools, employers, degrees, dates, titles, awards or numbers that are not in the base resume${bank.projects.length ? ' or more_projects' : ''}.
- Every bullet must trace back to a bullet in the base resume${bank.projects.length ? ' or in more_projects' : ''}. Do not merge unrelated facts into a new claim. Do not write a bullet claiming work with a tool just because it was added to the skills section.
- Keep all names, employers, schools, titles and dates exactly as written.
- Write in plain, direct language. No buzzwords the base resume does not use.
${withCover ? `
Also write a cover letter: 3 short paragraphs, under 220 words, plain and specific, first person, no flattery, no clichés ("I am excited to", "passionate"), and only facts from the resume${extraFacts ? ' or these extra facts: ' + extraFacts.slice(0, 1500) : ''}. Start with "Dear Hiring Team," and end with the candidate's name.` : ''}

Reply with JSON:
{"resume": ${RESUME_SHAPE.replace(/\n\s*/g, ' ')},
 "changes": ["3 to 6 short notes on what you changed and why, then one \"Added skill: ...\" note for each skill you added that the resume did not show"],
 "coverLetter": "${withCover ? 'the letter, with \\n between paragraphs' : ''}"}`
  const out = await askJson<{ resume?: unknown; changes?: unknown; coverLetter?: unknown }>(prompt, { model, timeoutMs: 360_000 })
  const resume = normalizeResume(out.resume)
  if (!resume.name) resume.name = base.name
  resume.contact = base.contact   // contact details are never model-written
  keepLayout(base, resume)
  keepSkills(base, resume)
  resume.name = base.name
  return {
    resume, coverLetter: typeof out.coverLetter === 'string' ? out.coverLetter.trim() : '',
    changes: Array.isArray(out.changes) ? out.changes.map(String).slice(0, 20) : [],
    warnings: findInventions(base, baseRaw, resume, job, bank)
  }
}
