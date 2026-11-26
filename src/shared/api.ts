import type { Job, JobStatus, PrefillResult, Profile, RefreshProgress, RefreshResult, Resume, SavedAnswer, Settings, Tailored, Board, Coverage, Usage, WorkdayLogin, Activity, AutoApplyResult, DocFile, DocKind, LiveRun } from './types'

export interface AppState {
  resume: Resume; hasResume: boolean; profile: Profile; settings: Settings
  cliFound: boolean; usage: Usage; workday: WorkdayLogin; lastRefresh: string | null; boards: Board[]; coverage: Coverage[]
  resumePdf: { name: string; path: string } | null   // the user's own resume PDF, attached when a job has no tailored one
  autoApply: Record<string, AutoApplyResult>        // last auto-apply outcome per job
  gmail: { email: string }                          // the Gmail account connected read-only for verification emails ('' when none)
  documents: DocFile[]                              // extra documents attached to applications by kind
}

export interface Api {
  getState(): Promise<AppState>
  importResume(): Promise<Resume | null>
  chooseResumePdf(): Promise<{ name: string; path: string } | null>
  addDocuments(): Promise<DocFile[]>                  // pick files, copy them in, classify them
  setDocumentKind(id: string, kind: DocKind): Promise<void>
  removeDocument(id: string): Promise<void>
  revealDocument(id: string): Promise<void>
  revealResumePdf(): Promise<void>
  saveResume(r: Resume): Promise<void>
  saveProfile(p: Profile): Promise<void>
  saveSettings(s: Settings): Promise<void>
  listJobs(): Promise<Job[]>
  getJob(id: string): Promise<{ job: Job; tailored: Tailored | null } | null>
  updateJob(id: string, patch: { status?: JobStatus; notes?: string }): Promise<void>
  refresh(recheckRejected?: boolean): Promise<RefreshResult>
  score(): Promise<number>
  rescore(): Promise<number>
  setWorkdayLogin(email: string, password: string): Promise<WorkdayLogin>
  clearWorkdayLogin(): Promise<WorkdayLogin>
  connectGmail(clientId: string, clientSecret: string): Promise<{ email: string }>
  disconnectGmail(): Promise<{ email: string }>
  addJob(input: { url: string; text: string }): Promise<Job>
  tailor(jobId: string, withCover: boolean): Promise<Tailored>
  saveTailored(jobId: string, resume: Resume, coverLetter: string): Promise<Tailored & { pages: number }>
  revealPdf(jobId: string): Promise<void>
  prefill(jobId: string): Promise<PrefillResult>
  fillAgain(jobId: string): Promise<PrefillResult>
  openExternal(url: string): Promise<void>
  autoApply(jobIds: string[]): Promise<{ applied: number; flagged: number; left: number }>
  clearAutoApplyFlag(jobId: string): Promise<void>
  saveAnswers(jobId: string, answers: SavedAnswer[]): Promise<void>   // keeps answers for every later form and clears the job's flag
  clearAllAutoApplyFlags(): Promise<void>
  resetUsage(): Promise<void>                        // sets the tokens-used counter back to zero
  showAutoApplyShot(jobId: string): Promise<void>
  checkRejections(): Promise<RejectionCheck>         // reads Gmail (read-only) for rejection emails and marks the matching tracked jobs Rejected
  onAutoApply(fn: (r: AutoApplyResult) => void): () => void
  onLiveRun(fn: (r: LiveRun) => void): () => void
  getLiveRun(): Promise<LiveRun | null>
  getScheduledRun(): Promise<ScheduledRun | null>   // the last 9:00 / 21:00 run started by launchd
  onScheduledRun(fn: (r: ScheduledRun) => void): () => void
  skipAutoApply(jobId: string): Promise<boolean>
  getActivity(): Promise<Activity>
  stopAll(): Promise<Activity>
  onActivity(fn: (a: Activity) => void): () => void
  onProgress(fn: (p: RefreshProgress | null) => void): () => void
  onUsage(fn: (u: Usage) => void): () => void
  onPrefillUpdate(fn: (u: { jobId: string; result: PrefillResult }) => void): () => void
}

/** One rejection email matched to a tracked job, which the check marked Rejected. */
export interface RejectionMatch { jobId: string; company: string; title: string; previous: JobStatus; subject: string; from: string; at: string }
/** A rejection email the check could not tie to one tracked job (no such job, several possible jobs, or older than the application). */
export interface RejectionUnmatched { company: string; subject: string; from: string; at: string; why: string }
/** Result of "Check email for rejections". */
export interface RejectionCheck { searched: number; newEmails: number; rejections: number; marked: RejectionMatch[]; alreadyRejected: number; unmatched: RejectionUnmatched[] }

/** Summary of one scheduled run (kv lastScheduledRun). */
export interface ScheduledRun { startedAt: string; endedAt?: string; refresh?: { fetched: number; added: number; removed: number; errors: number }; scored?: number; targets?: number; applied?: number; flagged?: number; left?: number; error?: string; refreshError?: string; scoreError?: string; applyError?: string }

export const CHANNELS = ['getState', 'importResume', 'chooseResumePdf', 'addDocuments', 'setDocumentKind', 'removeDocument', 'revealDocument', 'revealResumePdf', 'saveResume', 'saveProfile', 'saveSettings', 'listJobs', 'getJob', 'updateJob', 'refresh',
  'score', 'rescore', 'setWorkdayLogin', 'clearWorkdayLogin', 'connectGmail', 'disconnectGmail', 'addJob', 'tailor', 'saveTailored', 'revealPdf', 'prefill', 'fillAgain', 'openExternal', 'getActivity', 'stopAll', 'autoApply', 'clearAutoApplyFlag', 'saveAnswers', 'clearAllAutoApplyFlags', 'getLiveRun', 'getScheduledRun', 'skipAutoApply', 'showAutoApplyShot', 'checkRejections', 'resetUsage'] as const
