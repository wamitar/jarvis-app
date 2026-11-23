export type Region = 'ontario' | 'canada' | 'usa' | 'uk' | 'other'
export type JobStatus = 'new' | 'saved' | 'tailored' | 'applied' | 'interview' | 'offer' | 'rejected' | 'hidden'
export type BoardAts = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'amazon' | 'google' | 'apple' | 'eightfold' | 'oracle' | 'smartrecruiters' | 'jibe' | 'successfactors' | 'ukg' | 'bamboohr' | 'workable'
export type Ats = BoardAts | 'jobbank' | 'adzuna' | 'manual' | 'simplify' | 'linkedin'

export interface RawJob {
  id: string            // unique: source:company:postingId
  source: Ats
  company: string
  title: string
  location: string
  url: string
  applyUrl: string
  description: string   // plain text; may be empty until fetched
  postedAt: string | null
  big: boolean          // searched across the USA and Canada (large employers and larger hardware startups)
  detailUrl?: string    // where to fetch the full description when the list result lacks it (not stored)
}

export interface Job extends RawJob {
  region: Region
  fetchedAt: string
  score: number | null
  reasons: string[]
  missing: string[]
  status: JobStatus
  notes: string
  appliedAt: string | null
  hasTailored: boolean
}

export interface Board {
  company: string
  ats: BoardAts
  id: string            // board token; workday "tenant|wdN|site"; eightfold "host|domain|flavour"; oracle "host|site"
  big: boolean
}

export interface Resume {
  name: string
  contact: { email: string; phone: string; location: string; linkedin: string; website: string }
  summary: string
  education: { school: string; degree: string; dates: string; location?: string; details: string[] }[]
  // headline = which of company/title is the bold first line of the entry. Text may mark bold as **like this**.
  experience: { company: string; title: string; location: string; dates: string; bullets: string[]; headline?: 'company' | 'title' }[]
  projects: { name: string; dates: string; tech: string; bullets: string[] }[]
  skills: { category: string; items: string[] }[]
  extras: { heading: string; items: string[] }[]
}

export interface Profile {
  firstName: string; lastName: string; email: string; phone: string
  address: string; city: string; province: string; postalCode: string; country: string
  linkedin: string; website: string; github: string
  school: string; degree: string; major: string; gpa: string; graduation: string
  citizenship: string
  citizenshipDates?: string   // when each citizenship was obtained, e.g. "Canada: 2005-03-14 (by birth); United States: 2005-03-14 (by birth)"
  workAuthCanada: string; workAuthUsa: string; workAuthUk: string
  needsSponsorship: string    // for Canada
  sponsorshipUsa: string; sponsorshipUk: string
  availability: string; termLength: string; willingToRelocate: string
  extra: string         // free-form facts Claude may use for screening answers
  moreProjects: Resume['projects']   // projects not on the resume; tailoring picks whichever fit a posting best
  moreSkills: string    // software and skills the candidate has beyond the resume; tailoring may list them
}

/** One job's outcome from an auto-apply run. */
/** One job in the current (or last) auto-apply run, for the Status page. */
export interface LiveJob {
  jobId: string; company: string; title: string
  state: 'waiting' | 'tailoring' | 'working' | 'applied' | 'flagged' | 'dryrun' | 'skipped'
  page: string           // the application page it is on, e.g. "Workday: My Experience"
  reason: string         // why it was flagged, when it was
  steps: string[]        // what was done, newest last ("My Information: filled 6, pressed Save and Continue")
  startedAt?: string; endedAt?: string
}
export interface LiveRun { running: boolean; startedAt: string; endedAt?: string; jobs: LiveJob[] }
export interface AutoApplyResult { jobId: string; outcome: 'applied' | 'flagged' | 'dryrun'; reason: string; page: string; at: string; shot: string }

/** What the app is doing right now (sidebar status light). */
export interface Activity { working: boolean; stopping: boolean; tasks: string[] }

export interface Tailored {
  jobId: string
  resume: Resume
  coverLetter: string
  changes: string[]
  warnings: string[]
  pdfPath: string | null
  updatedAt: string
  coverPdfPath?: string | null   // set only while applying: the cover letter PDF to attach, when there is one
}

export interface RefreshProgress { stage: string; detail: string; done: number; total: number }
export interface RefreshResult { fetched: number; passed: number; added: number; scored: number; removed: number; errors: string[] }

export interface PrefillResult {
  page: string          // which page of the application this describes
  filled: string[]
  skipped: string[]
  drafted: { question: string; answer: string }[]
  note: string
}

export interface Settings {
  adzunaAppId: string; adzunaAppKey: string
  customBoards: Board[]
  scoreModel: string; writeModel: string
  aiProvider?: 'claude' | 'codex'   // which signed-in AI tool does the work (Claude Code or Codex); models are tiers: haiku / sonnet / opus
  workdayAutoCreate: boolean   // also tick the agreement box and press Create Account on Workday
  workdayAutoContinue?: boolean // press Save and Continue between Workday pages (on unless set to false); never Submit
  gmailClientId?: string; gmailClientSecret?: string   // the user's own Google OAuth desktop client, for read-only Gmail
  autoApplyWindow?: 'hidden' | 'minimized'   // auto-apply's Chrome: no window at all (default) or a minimized window
  useSimplify?: boolean        // read the SimplifyJobs internship list (on unless set to false)
  useLinkedInAlerts?: boolean  // read LinkedIn job-alert emails through Gmail (on unless set to false)
}

/** An extra document the user keeps for applications (Profile › Additional documents). */
export type DocKind = 'transcript' | 'portfolio' | 'reference' | 'certificate' | 'cover_letter' | 'writing_sample' | 'resume' | 'other'
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  transcript: 'Transcript', portfolio: 'Portfolio / work samples', reference: 'Reference letter', certificate: 'Certificate or licence',
  cover_letter: 'Cover letter', writing_sample: 'Writing sample', resume: 'Resume / CV', other: 'Other'
}
export interface DocFile {
  id: string; name: string; path: string; kind: DocKind
  summary: string        // one line saying what it is ("Carleton University unofficial transcript, Fall 2024")
  byUser: boolean        // the user set the kind (otherwise the app's classification)
  addedAt: string
}

/** What the last "Get jobs" run found at one company. */
export interface Coverage { company: string; read: number; interns: number; matched: number; error?: string }

export interface Usage { calls: number; input: number; output: number }
export interface WorkdayLogin { email: string; hasPassword: boolean }

export const emptyResume = (): Resume => ({
  name: '', contact: { email: '', phone: '', location: '', linkedin: '', website: '' },
  summary: '', education: [], experience: [], projects: [], skills: [], extras: []
})

export const emptyProfile = (): Profile => ({
  firstName: '', lastName: '', email: '', phone: '', address: '', city: '', province: '', postalCode: '', country: 'Canada',
  linkedin: '', website: '', github: '', school: '', degree: '', major: 'Mechanical Engineering', gpa: '',
  graduation: '', citizenship: '', citizenshipDates: '', workAuthCanada: '', workAuthUsa: '', workAuthUk: '', needsSponsorship: '', sponsorshipUsa: '', sponsorshipUk: '', availability: '',
  termLength: '', willingToRelocate: '', extra: '', moreProjects: [], moreSkills: ''
})

export const defaultSettings = (): Settings => ({
  adzunaAppId: '', adzunaAppKey: '', customBoards: [], scoreModel: 'haiku', writeModel: 'sonnet', workdayAutoCreate: false
})

/** Removes the **bold** markers used in resume text. */
export const plain = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, '$1')

export function resumeToText(r: Resume): string {
  return plain(resumeToMarkedText(r))
}
function resumeToMarkedText(r: Resume): string {
  const out: string[] = []
  out.push(r.name)
  out.push([r.contact.email, r.contact.phone, r.contact.location, r.contact.linkedin, r.contact.website].filter(Boolean).join(' | '))
  if (r.summary) out.push('', 'SUMMARY', r.summary)
  if (r.education.length) {
    out.push('', 'EDUCATION')
    for (const e of r.education) { out.push(`${e.school} — ${e.degree} (${e.dates})`); for (const d of e.details) out.push(`  • ${d}`) }
  }
  if (r.experience.length) {
    out.push('', 'EXPERIENCE')
    for (const e of r.experience) { out.push(`${e.title}, ${e.company}${e.location ? ', ' + e.location : ''} (${e.dates})`); for (const b of e.bullets) out.push(`  • ${b}`) }
  }
  if (r.projects.length) {
    out.push('', 'PROJECTS')
    for (const p of r.projects) { out.push(`${p.name}${p.tech ? ' — ' + p.tech : ''}${p.dates ? ' (' + p.dates + ')' : ''}`); for (const b of p.bullets) out.push(`  • ${b}`) }
  }
  if (r.skills.length) { out.push('', 'SKILLS'); for (const s of r.skills) out.push(`${s.category}: ${s.items.join(', ')}`) }
  for (const x of r.extras) { out.push('', x.heading.toUpperCase()); for (const i of x.items) out.push(`  • ${i}`) }
  return out.join('\n')
}
