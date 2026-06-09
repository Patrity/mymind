// server/lib/agent/undo.ts
import { nanoid } from 'nanoid'

interface Entry { fn: () => Promise<void>, expires: number }
const store = new Map<string, Entry>()
const TTL_MS = 10 * 60 * 1000 // 10 minutes

function sweep() {
  const now = Date.now()
  for (const [k, v] of store) if (v.expires < now) store.delete(k)
}

export function registerUndo(fn: () => Promise<void>): string {
  sweep()
  const token = nanoid(12)
  store.set(token, { fn, expires: Date.now() + TTL_MS })
  return token
}

export function hasUndo(token: string): boolean {
  const e = store.get(token)
  return !!e && e.expires >= Date.now()
}

export async function runUndo(token: string): Promise<boolean> {
  const e = store.get(token)
  store.delete(token)
  if (!e || e.expires < Date.now()) return false
  await e.fn()
  return true
}
