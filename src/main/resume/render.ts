import { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Resume } from '../../shared/types'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const link = (s: string): string => esc(s.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))
const bullets = (items: string[]): string => (items.length ? `<ul>${items.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '')

/** Single-column, text-only layout that applicant tracking systems read cleanly. */
export function resumeHtml(r: Resume): string {
  const contact = [r.contact.email, r.contact.phone, r.contact.location, r.contact.linkedin && link(r.contact.linkedin), r.contact.website && link(r.contact.website)]
    .filter(Boolean).map(x => `<span>${x === r.contact.email || x === r.contact.phone || x === r.contact.location ? esc(x as string) : x}</span>`).join('<span class="sep">|</span>')
  const section = (title: string, body: string): string => (body ? `<section><h2>${title}</h2>${body}</section>` : '')
  const head = (left: string, right: string, sub = ''): string =>
    `<div class="row"><div class="left">${left}</div><div class="right">${esc(right)}</div></div>${sub ? `<div class="sub">${sub}</div>` : ''}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.5in 0.6in; }
    * { box-sizing: border-box; }
    body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10pt; line-height: 1.32; color: #111; margin: 0; }
    h1 { font-size: 19pt; margin: 0 0 2pt; text-align: center; letter-spacing: 0.3pt; }
    .contact { text-align: center; font-size: 9.2pt; color: #222; }
    .sep { margin: 0 5pt; color: #777; }
    h2 { font-size: 10.2pt; text-transform: uppercase; letter-spacing: 0.9pt; border-bottom: 0.8pt solid #111; margin: 9pt 0 4pt; padding-bottom: 1.5pt; }
    .row { display: flex; justify-content: space-between; gap: 12pt; margin-top: 4pt; }
    .left { font-weight: 600; } .left em { font-weight: 400; font-style: normal; }
    .right { white-space: nowrap; color: #222; }
    .sub { font-style: italic; color: #222; }
    ul { margin: 1.5pt 0 0; padding-left: 13pt; } li { margin: 0 0 1pt; }
    p { margin: 0; } .skills p { margin: 0 0 1.5pt; }
    section { break-inside: auto; } .row, li { break-inside: avoid; }
  </style></head><body>
  <h1>${esc(r.name)}</h1><div class="contact">${contact}</div>
  ${section('Summary', r.summary ? `<p>${esc(r.summary)}</p>` : '')}
  ${section('Education', r.education.map(e => head(esc(e.school), e.dates, esc(e.degree)) + bullets(e.details)).join(''))}
  ${section('Experience', r.experience.map(e => head(`${esc(e.title)}<em>${e.company ? ', ' + esc(e.company) : ''}${e.location ? ' — ' + esc(e.location) : ''}</em>`, e.dates) + bullets(e.bullets)).join(''))}
  ${section('Projects', r.projects.map(p => head(`${esc(p.name)}<em>${p.tech ? ' — ' + esc(p.tech) : ''}</em>`, p.dates) + bullets(p.bullets)).join(''))}
  ${section('Skills', r.skills.length ? `<div class="skills">${r.skills.map(s => `<p><strong>${esc(s.category)}${s.category ? ': ' : ''}</strong>${esc(s.items.join(', '))}</p>`).join('')}</div>` : '')}
  ${r.extras.map(x => section(esc(x.heading), bullets(x.items))).join('')}
  </body></html>`
}

export function letterHtml(name: string, contactLine: string, letter: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 1in; }
    body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }
    h1 { font-size: 16pt; margin: 0; } .c { font-size: 9.5pt; color: #333; margin-bottom: 22pt; } p { margin: 0 0 11pt; white-space: pre-wrap; }
  </style></head><body><h1>${esc(name)}</h1><div class="c">${esc(contactLine)}</div>
  ${letter.split(/\n\s*\n|\n/).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}</body></html>`
}

export async function htmlToPdf(html: string, outPath: string): Promise<{ path: string; pages: number }> {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'))
    const pdf = await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, preferCSSPageSize: true })
    await mkdir(join(outPath, '..'), { recursive: true })
    await writeFile(outPath, pdf)
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    return { path: outPath, pages }
  } finally { win.destroy() }
}

export const safeName = (s: string): string => s.replace(/[^\w .,&()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
