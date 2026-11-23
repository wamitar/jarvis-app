// Stores the Workday password as an item in the macOS Keychain (login keychain), never in the app's database.
// The password is passed to the `security` tool on stdin, so it never appears in a process argument list.
import { spawn, execFile } from 'node:child_process'

const SERVICE = process.env.IH_USER_DATA ? 'J.A.R.V.I.S Workday (test)' : 'J.A.R.V.I.S Workday'
/** The Gmail sign-in token (read-only access, for verification emails) is kept in its own Keychain item. */
export const GMAIL_SERVICE = process.env.IH_USER_DATA ? 'J.A.R.V.I.S Gmail (test)' : 'J.A.R.V.I.S Gmail'
const q = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => execFile('/usr/bin/security', args, { timeout: 15000 }, (err, stdout) => resolve({ code: err ? 1 : 0, out: String(stdout) })))
}

export async function getPassword(email: string, service = SERVICE): Promise<string | null> {
  if (!email) return null
  const r = await run(['find-generic-password', '-s', service, '-a', email, '-w'])
  return r.code === 0 ? r.out.replace(/\n$/, '') : null
}

export async function deletePassword(email: string, service = SERVICE): Promise<void> {
  if (email) await run(['delete-generic-password', '-s', service, '-a', email])
}

export async function setPassword(email: string, password: string, service = SERVICE): Promise<void> {
  if (!email || !password) throw new Error('Enter both the email and the password.')
  if (/[\r\n]/.test(email + password)) throw new Error('The email and password cannot contain line breaks.')
  // The Keychain tool returns non-ASCII passwords in an encoded form the app cannot read back reliably.
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('Use a password made of standard keyboard characters (letters, digits, symbols).')
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', c => resolve(c ?? 1))
    child.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(email)} -l ${q(service)} -w ${q(password)}\n`)
  })
  const back = await getPassword(email, service)
  if (code !== 0 || back !== password) { await deletePassword(email, service); throw new Error('The Mac Keychain did not accept that password. Nothing was saved.') }
}
