// server/lib/agent/undo.ts
import { nanoid } from 'nanoid'

export type UndoResult = { ok: boolean, reason?: string }
export type UndoFn = () => Promise<void | UndoResult>

interface Entry { fn: UndoFn, expires: number }
const store = new Map<string, Entry>()
const TTL_MS = 10 * 60 * 1000 // 10 minutes

function sweep() {
  const now = Date.now()
  for (const [k, v] of store) if (v.expires < now) store.delete(k)
}

export function registerUndo(fn: UndoFn): string {
  sweep()
  const token = nanoid(12)
  store.set(token, { fn, expires: Date.now() + TTL_MS })
  return token
}

export function hasUndo(token: string): boolean {
  const e = store.get(token)
  return !!e && e.expires >= Date.now()
}

export async function runUndo(token: string): Promise<UndoResult> {
  const e = store.get(token)
  if (!e || e.expires < Date.now()) { store.delete(token); return { ok: false, reason: 'undo expired or already used' } }
  const res = (await e.fn()) ?? { ok: true }
  // Consume ONLY on success: a refused undo must stay retryable once the caller reconciles.
  if (res.ok) store.delete(token)
  return res
}
