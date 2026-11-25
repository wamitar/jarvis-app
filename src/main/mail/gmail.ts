// Read-only Gmail access, used for one thing: finding the verification email a job site has just sent (a code to
// type in, or a link to open), so auto-apply can finish sign-up and sign-in without the user.
//
// Uses Google's own OAuth for desktop apps with the gmail.readonly scope: the app can read mail, never send, change
// or delete it. The user creates the OAuth client in their own Google Cloud project (see REMOTE_AUTOMATION.md),
// so no third party is involved. The refresh token lives in the Mac Keychain, never in the database.
// No Electron imports here, so the same code runs from scripts and a future headless runner.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import * as keychain from '../keychain'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GmailClient { clientId: string; clientSecret: string }
/** Where the app keeps what it needs: the OAuth client (settings) and the connected address (database). */
export interface GmailStore { client(): GmailClient; email(): string; setEmail(email: string): void }

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Connects a Gmail account: opens Google's consent page in the user's browser, receives the answer on a one-off
 * local address (127.0.0.1, random port), and keeps the refresh token in the Keychain. Returns the address.
 */
export async function connect(store: GmailStore, openBrowser: (url: string) => void | Promise<void>): Promise<string> {
  const { clientId, clientSecret } = store.client()
  if (!clientId || !clientSecret) throw new Error('Paste the Google OAuth client ID and secret first (see REMOTE_AUTOMATION.md, "Gmail").')
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('Gmail sign-in timed out after 5 minutes.')) }, 5 * 60_000)
    server.on('request', (req, res) => {
      const u = new URL(req.url || '/', redirect)
      if (u.pathname !== '/') { res.writeHead(404).end(); return }
      const ok = u.searchParams.get('state') === state && !!u.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(ok ? '<p style="font:16px system-ui">Gmail connected (read-only). You can close this tab and go back to J.A.R.V.I.S.</p>'
        : `<p style="font:16px system-ui">Gmail was not connected: ${u.searchParams.get('error') || 'unexpected reply'}. Close this tab and try again.</p>`)
      clearTimeout(timer); server.close()
      if (ok) resolve(u.searchParams.get('code')!); else reject(new Error(`Google did not connect Gmail (${u.searchParams.get('error') || 'unexpected reply'}).`))
    })
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: `${GMAIL_SCOPE} email`,
      access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })
    Promise.resolve(openBrowser(`${AUTH_URL}?${q}`)).catch(reject)
  })
  const tok = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect })
  if (!tok.refresh_token) throw new Error('Google did not hand over a lasting sign-in. Remove J.A.R.V.I.S at myaccount.google.com/permissions and connect again.')
  access = { token: tok.access_token, until: Date.now() + (tok.expires_in - 60) * 1000 }
  const profile = await api<{ emailAddress: string }>('/profile')
  await keychain.setPassword(profile.emailAddress, tok.refresh_token, keychain.GMAIL_SERVICE)
  store.setEmail(profile.emailAddress)
  return profile.emailAddress
}

export async function disconnect(store: GmailStore): Promise<void> {
  const email = store.email()
  const refresh = email ? await keychain.getPassword(email, keychain.GMAIL_SERVICE) : null
  // Revoking at Google ends the access everywhere, not just on this Mac.
  if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => {})
  if (email) await keychain.deletePassword(email, keychain.GMAIL_SERVICE)
  access = null
  store.setEmail('')
}

let access: { token: string; until: number } | null = null
let activeStore: GmailStore | null = null
/** Remembers where the client and address live, so auto-apply can look for mail without being handed them. */
export function useStore(store: GmailStore): void { activeStore = store }
export const connected = (): boolean => !!activeStore?.email()

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) })
  const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description || j.error || r.status}`)
  return { access_token: j.access_token, expires_in: j.expires_in || 3600, refresh_token: j.refresh_token }
}

async function token(): Promise<string> {
  if (access && Date.now() < access.until) return access.token
  const store = activeStore
  if (!store?.email()) throw new Error('Gmail is not connected.')
  const refresh = await keychain.getPassword(store.email(), keychain.GMAIL_SERVICE)
  if (!refresh) throw new Error('The Gmail sign-in is missing from the Keychain. Connect Gmail again in Settings.')
  const { clientId, clientSecret } = store.client()
  const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
  access = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 }
  return access.token
}

async function api<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(20_000) })
    if (r.status === 401) { access = null; throw new Error('Gmail turned the sign-in down. Connect Gmail again in Settings.') }
    // Gmail limits how fast one account is read (403 "rate limit exceeded" or 429): wait and try again.
    if ((r.status === 429 || r.status === 403) && attempt < 4) {
      const body = await r.text().catch(() => '')
      if (r.status === 429 || /rate ?limit|quota|userRateLimitExceeded/i.test(body)) { await new Promise(res => setTimeout(res, 2000 * 2 ** attempt)); continue }
      throw new Error(`403 from Gmail: ${body.slice(0, 120)}`)
    }
    if (!r.ok) throw new Error(`${r.status} from Gmail`)
    return r.json() as Promise<T>
  }
}

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }
interface Msg { id: string; internalDate: string; payload: Part; snippet?: string }

const decode = (d?: string): string => (d ? Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '')
function bodies(p: Part, out: { text: string[]; html: string[] }): void {
  if (p.mimeType === 'text/plain') out.text.push(decode(p.body?.data))
  else if (p.mimeType === 'text/html') out.html.push(decode(p.body?.data))
  for (const c of p.parts || []) bodies(c, out)
}
const header = (m: Msg, name: string): string => m.payload.headers?.find(h => h.name.toLowerCase() === name)?.value || ''
const stripHtml = (h: string): string => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

/** One email's readable parts, for the other mail readers (LinkedIn job alerts). */
export interface MailItem { id: string; from: string; subject: string; text: string; html: string; at: number }

/** Emails matching a Gmail search ("from:x after:123"), newest first, at most `max`. Read-only. */
export async function searchMessages(q: string, max = 20): Promise<MailItem[]> {
  if (!connected()) return []
  const list = await api<{ messages?: { id: string }[] }>(`/messages?maxResults=${max}&q=${encodeURIComponent(q)}`)
  const out: MailItem[] = []
  for (const { id } of list.messages || []) {
    const m = await api<Msg>(`/messages/${id}?format=full`)
    const parts = { text: [] as string[], html: [] as string[] }
    bodies(m.payload, parts)
    out.push({ id, from: header(m, 'from'), subject: header(m, 'subject'), text: parts.text.join('\n'), html: parts.html.join('\n'), at: Number(m.internalDate) })
  }
  return out
}

/** Ids of every email matching a Gmail search (spam and trash left out), newest first, following the pages up to `cap`. Read-only. */
export async function searchAllIds(q: string, cap = 3000): Promise<string[]> {
  if (!connected()) return []
  const ids: string[] = []
  let page = ''
  do {
    const list = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?maxResults=500&includeSpamTrash=false&q=${encodeURIComponent(q)}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)
    for (const { id } of list.messages || []) ids.push(id)
    page = list.nextPageToken || ''
  } while (page && ids.length < cap)
  return ids.slice(0, cap)
}

/** One email in full; `text` is the plain-text part, or the HTML part with tags removed when there is none. Read-only. */
export async function getMessage(id: string): Promise<MailItem> {
  const m = await api<Msg>(`/messages/${id}?format=full`)
  const parts = { text: [] as string[], html: [] as string[] }
  bodies(m.payload, parts)
  const html = parts.html.join('\n')
  return { id, from: header(m, 'from'), subject: header(m, 'subject'), text: parts.text.join('\n').trim() || stripHtml(html).trim(), html, at: Number(m.internalDate) }
}

export interface Verification { code?: string; link?: string; from: string; subject: string; at: number }

// Senders and words that mark a job site's verification email.
const SITE_SENDER = /workday|myworkday|oracle|taleo|successfactors|sapsf|sap\.com|icims|greenhouse|lever|ashby|smartrecruiters|ultipro|ukg|bamboohr|workable|jobvite|eightfold|avature|phenom|no-?reply|donotreply|careers|talent|recruit/i
const VERIFY_WORDS = /verif|confirm|activate|one-time|passcode|security code|access code|sign[- ]in code|login code|your code|pin\b/i
const LINK_WORDS = /verif|confirm|activat|validate|token=|code=/i
const RESET_WORDS = /reset|forgot|new password|change (your )?password/i
const RESET_LINK = /passwordreset|reset[-_]?password|resetpassword|password[-_]?reset|\/reset\//i

/** Pulls a code (4 to 8 digits, or a short letter-digit code) and a verification link out of one email. */
export function extract(subject: string, text: string, links: string[], kind: 'verify' | 'reset' = 'verify'): { code?: string; link?: string } {
  const all = `${subject}\n${text}`
  if (kind === 'reset') return { link: links.find(l => RESET_LINK.test(l) && !/unsubscribe|privacy|terms|preferences/i.test(l)) }
  // A code is a short token right after words like "code", "passcode" or "PIN", or alone on its own line.
  // Every candidate is tried, since the word after "code" is often ordinary text ("Your one-time passcode\nYour ...").
  const near = [...all.matchAll(/(?:code|passcode|pin|one-time password|otp)\s*(?:is|:|-)?\s*[:\s]\s*([A-Z0-9]{4,8})\b/gi)].map(m => m[1]).find(c => /\d/.test(c))
  // Or after a sentence about the code that ends in a colon (Greenhouse: "paste this code into the security code field
  // on your application: 01877316"; its HTML-only email loses the line break before the code).
  const after = [...all.matchAll(/(?:code|passcode)\b[^.:\n]{0,80}:\s*([A-Z0-9]{4,10})\b/gi)].map(m => m[1]).find(c => /\d/.test(c))
  const code = near || after || all.match(/^\s*(\d{4,8})\s*$/m)?.[1]
  const link = links.find(l => LINK_WORDS.test(l) && !RESET_LINK.test(l) && !/unsubscribe|privacy|terms|preferences/i.test(l))
  return { code, link }
}

/**
 * The newest verification email (kind 'verify': a code or a confirm link) or password-reset email (kind 'reset': the
 * reset link) received after `since` (ms), from a sender or about a company matching `hint` (e.g. the Workday tenant
 * "jabil"). Waits up to `waitMs`, checking every 5 seconds, since mail takes a moment.
 */
export async function findVerification(opts: { since: number; hint?: string; waitMs?: number; kind?: 'verify' | 'reset' }): Promise<Verification | null> {
  if (!connected()) return null
  const kind = opts.kind || 'verify'
  const end = Date.now() + (opts.waitMs ?? 90_000)
  const after = Math.floor((opts.since - 60_000) / 1000)   // a minute of slack for clock differences
  const hint = (opts.hint || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  // Searched narrowly: a busy inbox (application receipts, job alerts) otherwise pushes the one email wanted out of the first page.
  const words = kind === 'reset' ? '(reset OR password OR forgot)' : '(verify OR verification OR confirm OR activate OR code OR passcode OR "one-time")'
  const q = `after:${after} -in:chats ${words}`
  const seen = new Set<string>()
  for (;;) {
    const list = await api<{ messages?: { id: string }[] }>(`/messages?includeSpamTrash=true&maxResults=40&q=${encodeURIComponent(q)}`)
    const found: Verification[] = []
    for (const { id } of list.messages || []) {
      if (seen.has(id)) continue
      const m = await api<Msg>(`/messages/${id}?format=full`)
      const at = Number(m.internalDate)
      if (at < opts.since - 60_000) { seen.add(id); continue }
      const from = header(m, 'from'), subject = header(m, 'subject')
      const parts = { text: [] as string[], html: [] as string[] }
      bodies(m.payload, parts)
      const text = parts.text.join('\n') || stripHtml(parts.html.join('\n'))
      const marker = kind === 'reset' ? RESET_WORDS : VERIFY_WORDS
      // Not a job site's account email: never looked at again in this search.
      if ((!SITE_SENDER.test(from) && !marker.test(subject)) || !marker.test(`${subject} ${text.slice(0, 3000)}`)) { seen.add(id); continue }
      if (kind === 'verify' && RESET_WORDS.test(subject)) { seen.add(id); continue }
      if (hint && !`${from} ${subject} ${text.slice(0, 4000)}`.toLowerCase().replace(/[^a-z0-9]/g, '').includes(hint)) { seen.add(id); continue }
      const links = [...parts.html.join('\n').matchAll(/href="(https:\/\/[^"]+)"/gi)].map(x => x[1].replace(/&amp;/g, '&'))
        .concat([...text.matchAll(/https:\/\/\S+/g)].map(x => x[0].replace(/[).,>]+$/, '')))
      const got = extract(subject, text, links, kind)
      if (got.code || got.link) found.push({ ...got, from, subject, at })
      else seen.add(id)
    }
    if (found.length) return found.sort((a, b) => b.at - a.at)[0]
    if (Date.now() >= end) return null
    await new Promise(r => setTimeout(r, 5000))
  }
}
