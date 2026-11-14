import { readFile } from 'node:fs/promises'
import type { Resume } from '../../shared/types'
import { emptyResume } from '../../shared/types'
import { askJson } from '../ai/claude'

export async function pdfToText(path: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(path)) })
  try { return (await parser.getText()).text.trim() } finally { await parser.destroy().catch(() => {}) }
}

const arr = <T>(v: unknown, map: (x: any) => T): T[] => (Array.isArray(v) ? v.map(map) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v))
const strs = (v: unknown): string[] => arr(v, str).filter(Boolean)

/** Coerces whatever Claude returned into a well-formed Resume so the UI never sees missing fields. */
export function normalizeResume(x: any): Resume {
  const base = emptyResume()
  if (!x || typeof x !== 'object') return base
  const c = x.contact || {}
  return {
    name: str(x.name),
    contact: { email: str(c.email), phone: str(c.phone), location: str(c.location), linkedin: str(c.linkedin), website: str(c.website) },
    summary: str(x.summary),
    education: arr(x.education, e => ({ school: str(e.school), degree: str(e.degree), dates: str(e.dates), details: strs(e.details) })),
    experience: arr(x.experience, e => ({ company: str(e.company), title: str(e.title), location: str(e.location), dates: str(e.dates), bullets: strs(e.bullets) })),
    projects: arr(x.projects, p => ({ name: str(p.name), dates: str(p.dates), tech: str(p.tech), bullets: strs(p.bullets) })),
    skills: arr(x.skills, s => ({ category: str(s.category), items: strs(s.items) })),
    extras: arr(x.extras, s => ({ heading: str(s.heading), items: strs(s.items) }))
  }
}

export const RESUME_SHAPE = `{
  "name": "", "contact": {"email": "", "phone": "", "location": "", "linkedin": "", "website": ""},
  "summary": "",
  "education": [{"school": "", "degree": "", "dates": "", "details": [""]}],
  "experience": [{"company": "", "title": "", "location": "", "dates": "", "bullets": [""]}],
  "projects": [{"name": "", "dates": "", "tech": "", "bullets": [""]}],
  "skills": [{"category": "", "items": [""]}],
  "extras": [{"heading": "", "items": [""]}]
}`

export async function structureResume(text: string, model: string): Promise<Resume> {
  const prompt = `Convert this resume text (extracted from a PDF, so line breaks may be odd) into JSON.

<resume>
${text.slice(0, 20000)}
</resume>

Rules:
- Copy the content faithfully. Do not add, improve, summarise or invent anything.
- Rejoin bullets that were split across lines. Keep every bullet.
- Design teams, clubs and competitions with engineering work go in "experience" or "projects", whichever the resume used.
- Sections that fit nowhere else (awards, certifications, interests) go in "extras".
- Use "" or [] for anything the resume does not have.

Reply with JSON in exactly this shape:
${RESUME_SHAPE}`
  return normalizeResume(await askJson<unknown>(prompt, { model }))
}
