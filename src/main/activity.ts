// What the app is doing right now, for the status light in the sidebar, and the switch that stops all of it.
import type { Activity } from '../shared/types'

const running = new Map<number, string>()
const stoppers = new Set<() => void>()
let nextId = 1
let stopping = false
let listener: (a: Activity) => void = () => {}

export class StoppedError extends Error { constructor() { super('Stopped.') } }
const snapshot = (): Activity => ({ working: running.size > 0, stopping, tasks: [...running.values()] })
const emit = (): void => listener(snapshot())

export function setActivityListener(fn: (a: Activity) => void): void { listener = fn }
export const getActivity = snapshot

/** Marks a piece of work as running. Call the returned function when it ends. */
export function begin(label: string): () => void {
  const id = nextId++
  running.set(id, label)
  emit()
  return () => { if (running.delete(id)) { if (!running.size) stopping = false; emit() } }
}
export async function track<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (stopping) throw new Error('Still stopping the last run. Try again in a moment.')
  const end = begin(label)
  try { return await fn() } finally { end() }
}
/** True once Stop has been pressed, until everything that was running has wound down. Long loops check this. */
export const isStopping = (): boolean => stopping
export function checkStop(): void { if (stopping) throw new StoppedError() }
/** Registers something that can be cut short at once (a Claude call, the Workday watcher). Returns an unregister function. */
export function onStop(fn: () => void): () => void { stoppers.add(fn); return () => { stoppers.delete(fn) } }

/** The stop switch: ends Claude calls, the Workday watcher, form filling and job fetching. The application browser is left open. */
export function stopAll(): Activity {
  if (running.size) {
    stopping = true
    // If something never winds down, the app must not stay locked in "stopping".
    setTimeout(() => { if (stopping) { stopping = false; emit() } }, 20_000)
  }
  for (const fn of [...stoppers]) { try { fn() } catch { /* already gone */ } }
  emit()
  return snapshot()
}
