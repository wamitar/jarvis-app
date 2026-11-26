// Tracker › Export to Excel: one row per tracked job, its text coloured by status.
import ExcelJS from 'exceljs'
import type { Job, JobStatus } from '../shared/types'

const ORDER: JobStatus[] = ['offer', 'interview', 'applied', 'tailored', 'saved', 'rejected']
const LABEL: Partial<Record<JobStatus, string>> = { saved: 'Saved', tailored: 'Resume ready', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' }
// Text colours (ARGB). The yellow is a deep gold so it stays readable on Excel's white cells.
const COLOR: Partial<Record<JobStatus, string>> = { applied: 'FFC99A00', rejected: 'FFD32F2F', interview: 'FF2E7D32', offer: 'FF1565C0' }

const day = (iso: string | null | undefined): string => { if (!iso) return ''; const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10) }

/** Writes the tracker to an .xlsx file at `path`. Returns the number of rows written. */
export async function exportTracker(jobs: Job[], path: string): Promise<number> {
  const rows = jobs.filter(j => ORDER.includes(j.status))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.appliedAt || '').localeCompare(a.appliedAt || ''))
  const wb = new ExcelJS.Workbook()
  wb.creator = 'J.A.R.V.I.S'
  const ws = wb.addWorksheet('Tracker', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Company', key: 'company', width: 30 },
    { header: 'Title', key: 'title', width: 50 },
    { header: 'Location', key: 'location', width: 28 },
    { header: 'Applied', key: 'applied', width: 12 },
    { header: 'Link', key: 'link', width: 50 },
    { header: 'Notes', key: 'notes', width: 50 }
  ]
  ws.getRow(1).font = { bold: true }
  for (const j of rows) {
    const link = j.applyUrl || j.url || ''
    const row = ws.addRow({ status: LABEL[j.status] || j.status, company: j.company, title: j.title, location: j.location, applied: day(j.appliedAt), link, notes: (j.notes || '').replace(/\s*\n\s*/g, ' · ') })
    const argb = COLOR[j.status]
    if (argb) row.font = { color: { argb } }
    if (/^https?:\/\//.test(link)) { const c = row.getCell('link'); c.value = { text: link, hyperlink: link }; c.font = { color: { argb: argb || 'FF000000' }, underline: true } }
  }
  ws.autoFilter = { from: 'A1', to: 'G1' }
  await wb.xlsx.writeFile(path)
  return rows.length
}
