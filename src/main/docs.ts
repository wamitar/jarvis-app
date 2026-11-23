// Additional documents (transcripts, portfolios, reference letters, certificates...). The user adds files; the
// app copies them into its own folder and works out what each one is, so auto-apply can attach the right file
// to a form's upload box ("Upload your transcript", "Portfolio", "Reference letter").
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DocFile, DocKind } from '../shared/types'
import { DOC_KIND_LABEL } from '../shared/types'
import { pdfToText } from './resume/parse'
import { askJson } from './ai/claude'

const KINDS = Object.keys(DOC_KIND_LABEL) as DocKind[]

// Clear signs in a file's name or first page. Checked in order; the first match wins.
const SIGNS: [DocKind, RegExp][] = [
  ['transcript', /\btranscripts?\b|grade report|academic record|statement of grades|unofficial record|\bcgpa\b|term gpa|cumulative gpa/i],
  ['reference', /\breference letter|letter of (reference|recommendation)|recommendation letter|to whom it may concern|\breferences?\b(?!.*(transcript))/i],
  ['portfolio', /\bportfolio\b|work samples?|design samples?|project samples?/i],
  ['certificate', /\bcertificat(e|ion)\b|\blicen[cs]e\b|whmis|first aid|\bcpr\b|solidworks associate|\bcswa\b|\bcswp\b|has successfully completed/i],
  ['cover_letter', /cover[ _-]?letter|dear hiring|dear recruit/i],
  ['writing_sample', /writing sample|technical report|lab report|essay/i],
  ['resume', /\b(resume|résumé|curriculum vitae|\bcv\b)\b/i]
]

/** A quick guess from the file name and text alone (also the answer when the AI is unavailable). */
export function guessKind(name: string, text: string): DocKind | null {
  name = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_\-.]+/g, ' ')   // "Unofficial_Transcript.pdf" -> "Unofficial Transcript"
  for (const [kind, re] of SIGNS) if (re.test(name)) return kind
  const head = text.slice(0, 2500)
  for (const [kind, re] of SIGNS) if (re.test(head)) return kind
  return null
}

/** What a document is: the AI reads the start of it; a clear file name or heading settles it without the AI. */
export async function classify(name: string, path: string, model: string): Promise<{ kind: DocKind; summary: string }> {
  const text = extname(path).toLowerCase() === '.pdf' ? await pdfToText(path).catch(() => '') : ''
  const guess = guessKind(name, text)
  if (!text.trim()) return { kind: guess || 'other', summary: guess ? DOC_KIND_LABEL[guess] : 'No readable text (an image or a scan): set the kind yourself if it is wrong.' }
  try {
    const r = await askJson<{ kind: string; summary: string }>(`Classify a document a student keeps for internship applications.
Kinds: ${KINDS.map(k => `"${k}" (${DOC_KIND_LABEL[k]})`).join(', ')}.
File name: ${name}
Start of its text:
"""
${text.slice(0, 3000)}
"""
Reply with JSON only: {"kind": one of the kinds, "summary": one short line saying what it is, e.g. "Carleton University unofficial transcript, up to Fall 2025" (no personal numbers such as student IDs or grades)}`, { model, timeoutMs: 90_000 })
    const kind = KINDS.includes(r.kind as DocKind) ? (r.kind as DocKind) : guess || 'other'
    return { kind, summary: String(r.summary || DOC_KIND_LABEL[kind]).slice(0, 140) }
  } catch {
    return { kind: guess || 'other', summary: guess ? DOC_KIND_LABEL[guess] : 'Could not be classified automatically: set the kind yourself.' }
  }
}

/** Copies the files into the app's documents folder and classifies each one. */
export async function addDocuments(paths: string[], dir: string, model: string): Promise<DocFile[]> {
  mkdirSync(dir, { recursive: true })
  const out: DocFile[] = []
  for (const src of paths) {
    const id = randomUUID().slice(0, 8)
    const name = basename(src)
    const dest = join(dir, `${id}-${name}`)
    copyFileSync(src, dest)
    const { kind, summary } = await classify(name, dest, model)
    out.push({ id, name, path: dest, kind, summary, byUser: false, addedAt: new Date().toISOString() })
  }
  return out
}

export function removeDocumentFile(d: DocFile): void { if (existsSync(d.path)) rmSync(d.path) }

// Which kind of document an upload box asks for, from its label / name.
const WANTS: [DocKind, RegExp][] = [
  ['transcript', /transcript|grade|academic record/i],
  ['portfolio', /portfolio|work sample|design sample/i],
  ['reference', /reference|recommendation/i],
  ['certificate', /certificat|licen[cs]e/i],
  ['writing_sample', /writing sample/i],
  ['cover_letter', /cover/i]
]
/** The document to put in an upload box with this label, or null when none of the user's documents fits it. */
export function documentFor(label: string, docs: DocFile[]): DocFile | null {
  for (const [kind, re] of WANTS) if (re.test(label)) return docs.find(d => d.kind === kind && existsSync(d.path)) || null
  return null
}
