// Renders a resume into the user's own LaTeX template and compiles it with Tectonic.
// Every piece of resume text is escaped before it enters the .tex, so resume or Claude text can never run TeX commands.
// Bold is written in the resume data as **like this**.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Resume } from '../../shared/types'

const UNICODE: Record<string, string> = {
  '’': "'", '‘': '`', '“': '``', '”': "''", '–': '--', '—': '---', '°': '$^\\circ$', 'μ': '$\\mu$', 'µ': '$\\mu$', '±': '$\\pm$', '·': '$\\cdot$',
  '×': '$\\times$', '≤': '$\\le$', '≥': '$\\ge$', '≈': '$\\approx$', '→': '$\\rightarrow$', '•': '\\textbullet{}', '…': '\\ldots{}', '\u00a0': '~', '|': '$|$',
  '<': '$<$', '>': '$>$', 'Ω': '$\\Omega$', 'Δ': '$\\Delta$', 'π': '$\\pi$', '²': '$^2$', '³': '$^3$', '½': '$\\frac{1}{2}$', '™': '\\texttrademark{}', '®': '\\textregistered{}'
}
const ACCENT: Record<string, string> = { '\u0301': "'", '\u0300': '`', '\u0302': '^', '\u0308': '"', '\u0303': '~', '\u0327': 'c ' }

function esc(s: string): string {
  let out = ''
  for (const ch of s.normalize('NFC')) {
    if (UNICODE[ch]) { out += UNICODE[ch]; continue }
    if ('&%$#_{}'.includes(ch)) { out += '\\' + ch; continue }
    if (ch === '\\') { out += '\\textbackslash{}'; continue }
    if (ch === '~') { out += '\\textasciitilde{}'; continue }
    if (ch === '^') { out += '\\textasciicircum{}'; continue }
    if (ch.charCodeAt(0) < 128) { out += ch; continue }
    const d = ch.normalize('NFD')   // é -> e + combining acute -> \'{e}
    if (d.length === 2 && ACCENT[d[1]] && /[A-Za-z]/.test(d[0])) out += `\\${ACCENT[d[1]]}{${d[0]}}`
  }
  return out
}
/** Escapes text and turns **bold** into \textbf{bold}. */
export function tex(s: string): string {
  return s.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? `\\textbf{${esc(part)}}` : esc(part))).join('')
}
const url = (s: string): string => (/^https?:\/\//i.test(s) ? s : 'https://' + s).replace(/[\\{}%#^~\s]/g, '')
const labelled = (s: string): string => { const m = s.match(/^([A-Z][A-Za-z /&-]{1,30}:)\s+(.*)$/s); return m && !s.includes('**') ? `\\textbf{${esc(m[1])}} ${tex(m[2])}` : tex(s) }

const PREAMBLE = String.raw`\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage{fontawesome5}
\usepackage{multicol}
\usepackage[margin=1.4cm]{geometry}

\setlength{\multicolsep}{-3.0pt}
\setlength{\columnsep}{-1pt}
% pdfTeX-only setup; skipped by engines that do not have it (the output looks the same).
\ifdefined\pdfgentounicode \input{glyphtounicode} \fi

\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

\addtolength{\oddsidemargin}{-0.15in}
\addtolength{\textwidth}{0.3in}

\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

%-----------SECTION FORMATTING-----------
\titleformat{\section}
{\scshape\raggedright\large\bfseries}
{}{0em}{}
[\color{black}\titlerule]

\titlespacing*{\section}{0pt}{7pt}{4pt}

\ifdefined\pdfgentounicode \pdfgentounicode=1 \fi

%-----------CUSTOM COMMANDS-----------
\newcommand{\resumeItem}[1]{
\item \small{#1}
}

\newcommand{\classesList}[4]{
\item\small{
{#1 #2 #3 #4 \vspace{-2pt}}
}
}

\newcommand{\resumeSubheading}[4]{
\item
\begin{tabular*}{1.0\textwidth}[t]{l@{\extracolsep{\fill}}r}
\textbf{#1} & \textbf{\small #2} \\
\textit{\small #3} & \textit{\small #4} \\
\end{tabular*}\vspace{-4pt}
}

\newcommand{\resumeSubSubheading}[2]{
\item
\begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
\textit{\small #1} & \textit{\small #2} \\
\end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeSubItem}[1]{
\resumeItem{#1}\vspace{-4pt}
}

\renewcommand\labelitemi{$\vcenter{\hbox{\tiny$\bullet$}}$}
\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}

\newcommand{\resumeSubHeadingListStart}{
\begin{itemize}[
leftmargin=0in,
label={},
itemsep=5pt,
topsep=0pt,
parsep=0pt,
partopsep=0pt
]
}

\newcommand{\resumeSubHeadingListEnd}{
\end{itemize}
}

\newcommand{\resumeItemListStart}{
\begin{itemize}[
leftmargin=0.22in,
itemsep=1pt,
topsep=2pt,
parsep=0pt,
partopsep=0pt
]
}

\newcommand{\resumeItemListEnd}{
\end{itemize}
}

\newcommand{\projectTitle}[1]{
\noindent\textbf{\small #1}\vspace{-1pt}
}

%========================================================
\begin{document}
`

const items = (list: string[], f: (s: string) => string = tex): string =>
  list.length ? `\\resumeItemListStart\n\n${list.map(b => `\\resumeItem{\n${f(b)}\n}`).join('\n\n')}\n\n\\resumeItemListEnd\n` : ''

export function resumeLatex(r: Resume): string {
  const c = r.contact
  const head = [
    c.phone && `\\faPhone\\ \\underline{${esc(c.phone)}}`,
    c.email && `\\faEnvelope\\\n\\href{mailto:${url(c.email).replace(/^https:\/\//, '')}}\n{\\underline{${esc(c.email)}}}`,
    c.linkedin && (/linkedin\.com|^https?:/i.test(c.linkedin) ? `\\faLinkedin\\\n\\href{${url(c.linkedin)}}\n{\\underline{LinkedIn}}` : `\\faLinkedin\\ \\underline{${esc(c.linkedin)}}`),
    c.website && `\\faGlobe\\\n\\href{${url(c.website)}}\n{\\underline{Portfolio}}`
  ].filter(Boolean).join('\n\\quad\n')
  const out: string[] = [PREAMBLE]
  out.push(`%-----------HEADING-----------\n\\begin{center}\n{\\Large \\scshape ${esc(r.name)}} \\\\[2mm]\n\n\\footnotesize\n${head}\n\n\\end{center}\n`)
  if (r.summary.trim()) out.push(`\\section{Summary}\n\n{\\small ${tex(r.summary)}}\n`)
  if (r.education.length) {
    out.push('%-----------EDUCATION-----------\n\\section{Education}\n')
    for (const e of r.education) {
      out.push(`\\resumeSubHeadingListStart\n\n\\resumeSubheading\n{${tex(e.school)}}\n{${tex(e.dates)}}\n{${tex(e.degree)}}\n{${tex(e.location || '')}}\n\n\\resumeSubHeadingListEnd\n`)
      out.push(items(e.details, labelled))
    }
  }
  if (r.skills.length) {
    out.push('%-----------TECHNICAL SKILLS-----------\n\\section{Technical Skills}\n\n\\begin{itemize}[\nleftmargin=0in,\nlabel={},\ntopsep=2pt,\nitemsep=1pt,\nparsep=0pt\n]\n\n\\small{\n')
    out.push(r.skills.map(s => `\\item\n${s.category ? `\\textbf{${esc(s.category)}:}\n` : ''}${s.items.map(tex).join(', ')}`).join('\n\n'))
    out.push('\n}\n\n\\end{itemize}\n')
  }
  if (r.experience.length) {
    out.push('%-----------WORK EXPERIENCE-----------\n\\section{Work Experience}\n\n\\resumeSubHeadingListStart\n')
    for (const e of r.experience) {
      const [first, second] = e.headline === 'title' ? [e.title, e.company] : [e.company, e.title]
      out.push(`\\resumeSubheading\n{${tex(first)}}\n{${tex(e.dates)}}\n{${tex(second)}}\n{${tex(e.location)}}\n\n${items(e.bullets)}`)
    }
    out.push('\\resumeSubHeadingListEnd\n')
  }
  if (r.projects.length) {
    out.push('%-----------PROJECTS-----------\n\\section{Projects}\n')
    out.push(r.projects.map(p => `\\projectTitle{${tex(p.name)}}\n\\hfill \\textbf{${esc([p.tech, p.dates].filter(Boolean).join(' | '))}}\n\n${items(p.bullets)}`).join('\n\\vspace{-3pt}\n\n'))
  }
  for (const x of r.extras) if (x.items.length) out.push(`\\section{${esc(x.heading)}}\n\n${items(x.items, labelled)}`)
  out.push('\\end{document}\n')
  return out.join('\n')
}

let enginePath: string | null | undefined
/** Tectonic, a self-contained LaTeX engine. Looked for in the app's data folder first, then the usual install places. */
export function findTectonic(userData?: string): string | null {
  if (enginePath && existsSync(enginePath)) return enginePath
  const places = [userData && join(userData, 'bin', 'tectonic'), join(homedir(), 'Library/Application Support/internship-hunter/bin/tectonic'), '/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic']
  return (enginePath = places.find((p): p is string => !!p && existsSync(p)) || null)
}

export async function pdfPages(path: string): Promise<number> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(path)) })
  try { return (await parser.getText()).total || 1 } finally { await parser.destroy().catch(() => {}) }
}

/** Writes <name>.tex next to the PDF and compiles it. The first run downloads the template's LaTeX packages. */
export async function compileLatex(source: string, outPdf: string, userData?: string): Promise<{ path: string; pages: number; texPath: string }> {
  const engine = findTectonic(userData)
  if (!engine) throw new Error('The LaTeX engine (Tectonic) is not installed.')
  const dir = dirname(outPdf)
  await mkdir(dir, { recursive: true })
  const texPath = outPdf.replace(/\.pdf$/i, '.tex')
  await writeFile(texPath, source, 'utf8')
  const log = await new Promise<string>((resolve, reject) => {
    const child = spawn(engine, ['-X', 'compile', basename(texPath), '--outdir', '.'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('LaTeX took too long to compile.')) }, 300_000)
    child.stdout.on('data', d => (text += d)); child.stderr.on('data', d => (text += d))
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error('LaTeX could not compile the resume: ' + (text.match(/^error:.*$/m)?.[0] || text.slice(-300)))) })
  })
  void log
  for (const ext of ['.aux', '.log', '.out']) await rm(outPdf.replace(/\.pdf$/i, ext), { force: true })
  return { path: outPdf, pages: await pdfPages(outPdf), texPath }
}
