// The name of the AI the user chose in Settings (Claude or Codex), for on-screen text. App sets it on every render.
let name = 'Claude'
export const setAi = (provider: string | undefined): void => { name = provider === 'codex' ? 'Codex' : 'Claude' }
export const ai = (): string => name
