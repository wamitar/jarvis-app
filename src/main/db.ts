import { DatabaseSync } from 'node:sqlite'
import type { Job, JobStatus, RawJob, Region, Tailored } from '../shared/types'

let db: DatabaseSync

export function openDb(path: string): void {
  db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, source TEXT, company TEXT, title TEXT, location TEXT, url TEXT, apply_url TEXT,
      description TEXT, posted_at TEXT, big INTEGER, region TEXT, fetched_at TEXT,
      score INTEGER, reasons TEXT DEFAULT '[]', missing TEXT DEFAULT '[]',
      status TEXT DEFAULT 'new', notes TEXT DEFAULT '', applied_at TEXT, dedupe TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe);
    CREATE TABLE IF NOT EXISTS tailored (
      job_id TEXT PRIMARY KEY, resume TEXT, cover_letter TEXT, changes TEXT, warnings TEXT, pdf_path TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  `)
}

export function kvGet<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try { return JSON.parse(row.value) as T } catch { return fallback }
}
export function kvSet(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

const dedupeKey = (j: { company: string; title: string; location: string }): string =>
  [j.company, j.title, j.location].map(s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|')

function rowToJob(r: any): Job {
  return {
    id: r.id, source: r.source, company: r.company, title: r.title, location: r.location, url: r.url, applyUrl: r.apply_url,
    description: r.description || '', postedAt: r.posted_at, big: !!r.big, region: r.region, fetchedAt: r.fetched_at,
    score: r.score, reasons: JSON.parse(r.reasons || '[]'), missing: JSON.parse(r.missing || '[]'),
    status: r.status, notes: r.notes || '', appliedAt: r.applied_at, hasTailored: !!r.has_tailored
  }
}

/** Inserts a job unless it (or a duplicate posting) is already stored. Returns true when added. */
export function insertJob(j: RawJob, region: Region): boolean {
  const key = dedupeKey(j)
  const dup = db.prepare('SELECT id FROM jobs WHERE id = ? OR dedupe = ?').get(j.id, key)
  if (dup) return false
  db.prepare(`INSERT INTO jobs(id, source, company, title, location, url, apply_url, description, posted_at, big, region, fetched_at, dedupe)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(j.id, j.source, j.company, j.title, j.location, j.url, j.applyUrl, j.description, j.postedAt, j.big ? 1 : 0, region, new Date().toISOString(), key)
  return true
}
export function hasJob(j: RawJob): boolean {
  return !!db.prepare('SELECT id FROM jobs WHERE id = ? OR dedupe = ?').get(j.id, dedupeKey(j))
}

const SELECT = `SELECT j.*, (SELECT 1 FROM tailored t WHERE t.job_id = j.id) AS has_tailored FROM jobs j`
export function listJobs(): Job[] {
  return (db.prepare(`${SELECT} ORDER BY COALESCE(j.score, -1) DESC, j.fetched_at DESC`).all() as any[]).map(rowToJob)
}
export function getJob(id: string): Job | null {
  const r = db.prepare(`${SELECT} WHERE j.id = ?`).get(id)
  return r ? rowToJob(r) : null
}
export function unscoredJobs(): Job[] {
  return (db.prepare(`${SELECT} WHERE j.score IS NULL AND j.status != 'hidden'`).all() as any[]).map(rowToJob)
}
export function setScore(id: string, score: number, reasons: string[], missing: string[]): void {
  db.prepare('UPDATE jobs SET score = ?, reasons = ?, missing = ? WHERE id = ?').run(score, JSON.stringify(reasons), JSON.stringify(missing), id)
}
export function setDescription(id: string, description: string): void {
  db.prepare('UPDATE jobs SET description = ? WHERE id = ?').run(description, id)
}
export function updateJob(id: string, patch: { status?: JobStatus; notes?: string }): void {
  if (patch.status !== undefined) {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(patch.status, id)
    if (patch.status === 'applied') db.prepare('UPDATE jobs SET applied_at = COALESCE(applied_at, ?) WHERE id = ?').run(new Date().toISOString(), id)
  }
  if (patch.notes !== undefined) db.prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(patch.notes, id)
}
export function countByCompany(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of db.prepare('SELECT company, COUNT(*) AS n FROM jobs GROUP BY company').all() as { company: string; n: number }[]) out[r.company] = r.n
  return out
}
export interface StoredRow { id: string; company: string; title: string; location: string; region: string; description: string }
/** Removes untouched jobs that the current rules no longer allow. Jobs you applied to, saved, dismissed or tailored are left alone. */
export function pruneJobs(allowed: (r: StoredRow) => boolean): number {
  const rows = db.prepare("SELECT id, company, title, location, region, description FROM jobs WHERE status = 'new' AND id NOT IN (SELECT job_id FROM tailored)").all() as unknown as StoredRow[]
  const del = db.prepare('DELETE FROM jobs WHERE id = ?')
  let n = 0
  for (const r of rows) if (!allowed(r)) { del.run(r.id); n++ }
  return n
}
export function clearScores(): void { db.exec('UPDATE jobs SET score = NULL') }

export function getTailored(jobId: string): Tailored | null {
  const r = db.prepare('SELECT * FROM tailored WHERE job_id = ?').get(jobId) as any
  if (!r) return null
  return { jobId, resume: JSON.parse(r.resume), coverLetter: r.cover_letter || '', changes: JSON.parse(r.changes || '[]'),
    warnings: JSON.parse(r.warnings || '[]'), pdfPath: r.pdf_path, updatedAt: r.updated_at }
}
export function saveTailored(t: Tailored): void {
  db.prepare(`INSERT INTO tailored(job_id, resume, cover_letter, changes, warnings, pdf_path, updated_at) VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(job_id) DO UPDATE SET resume = excluded.resume, cover_letter = excluded.cover_letter, changes = excluded.changes,
              warnings = excluded.warnings, pdf_path = excluded.pdf_path, updated_at = excluded.updated_at`)
    .run(t.jobId, JSON.stringify(t.resume), t.coverLetter, JSON.stringify(t.changes), JSON.stringify(t.warnings), t.pdfPath, t.updatedAt)
}
