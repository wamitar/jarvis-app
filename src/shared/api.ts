import type { Job, JobStatus, PrefillResult, Profile, RefreshProgress, RefreshResult, Resume, Settings, Tailored, Board, Coverage, Usage, WorkdayLogin } from './types'

export interface AppState {
  resume: Resume; hasResume: boolean; profile: Profile; settings: Settings
  cliFound: boolean; usage: Usage; workday: WorkdayLogin; lastRefresh: string | null; boards: Board[]; coverage: Coverage[]
  resumePdf: { name: string; path: string } | null   // the user's own resume PDF, attached when a job has no tailored one
}

export interface Api {
  getState(): Promise<AppState>
  importResume(): Promise<Resume | null>
  chooseResumePdf(): Promise<{ name: string; path: string } | null>
  revealResumePdf(): Promise<void>
  saveResume(r: Resume): Promise<void>
  saveProfile(p: Profile): Promise<void>
  saveSettings(s: Settings): Promise<void>
  listJobs(): Promise<Job[]>
  getJob(id: string): Promise<{ job: Job; tailored: Tailored | null } | null>
  updateJob(id: string, patch: { status?: JobStatus; notes?: string }): Promise<void>
  refresh(): Promise<RefreshResult>
  score(): Promise<number>
  rescore(): Promise<number>
  setWorkdayLogin(email: string, password: string): Promise<WorkdayLogin>
  clearWorkdayLogin(): Promise<WorkdayLogin>
  addJob(input: { url: string; text: string }): Promise<Job>
  tailor(jobId: string, withCover: boolean): Promise<Tailored>
  saveTailored(jobId: string, resume: Resume, coverLetter: string): Promise<Tailored & { pages: number }>
  revealPdf(jobId: string): Promise<void>
  prefill(jobId: string): Promise<PrefillResult>
  fillAgain(jobId: string): Promise<PrefillResult>
  openExternal(url: string): Promise<void>
  onProgress(fn: (p: RefreshProgress | null) => void): () => void
  onUsage(fn: (u: Usage) => void): () => void
  onPrefillUpdate(fn: (u: { jobId: string; result: PrefillResult }) => void): () => void
}

export const CHANNELS = ['getState', 'importResume', 'chooseResumePdf', 'revealResumePdf', 'saveResume', 'saveProfile', 'saveSettings', 'listJobs', 'getJob', 'updateJob', 'refresh',
  'score', 'rescore', 'setWorkdayLogin', 'clearWorkdayLogin', 'addJob', 'tailor', 'saveTailored', 'revealPdf', 'prefill', 'fillAgain', 'openExternal'] as const
