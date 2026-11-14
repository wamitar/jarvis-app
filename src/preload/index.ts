import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/api'

const api: Record<string, unknown> = {}
for (const ch of CHANNELS) api[ch] = (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)
const sub = (channel: string) => (fn: (v: unknown) => void) => {
  const h = (_: unknown, v: unknown): void => fn(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}
api.onProgress = sub('progress')
api.onUsage = sub('usage')
api.onPrefillUpdate = sub('prefillUpdate')
contextBridge.exposeInMainWorld('api', api)
