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
  let res: UndoResult
  try {
    res = (await e.fn()) ?? { ok: true }
  } catch (err) {
    // An undo closure CAN throw, and this is not theoretical: `documents_path_live_uidx` is a
    // unique index on live paths, so move_document's and update_document's undo — both of which
    // write the old path back, guarded only against OUR row having moved — raise a unique
    // violation when something else has since taken that path. Without this catch the caller
    // gets a raw 500 that escapes the { ok, reason } contract every other outcome honours.
    //
    // A throw CONSUMES the token, deliberately. Consuming only on success (below) exists so a
    // *refusal* — "the document changed, reconcile and try again" — stays retryable. A thrown
    // error is not that: nothing the caller can do turns the same closure into a success, so
    // leaving the token live would just let the failure repeat on every click for the full TTL.
    //
    // The reason is USER-FACING (it returns through POST /api/agent/undo into the chat
    // transcript), so the thrown error's message must not go into it. A DrizzleQueryError
    // embeds the failed query and its bound params in `message`, and for a document undo
    // those params are the entire prior document body — interpolating it republished the
    // whole document as an error string. The real error goes to the log instead.
    console.error('[undo] closure threw:', err)
    store.delete(token)
    return { ok: false, reason: 'the undo failed — the document may have changed since. Check its current state and reconcile manually.' }
  }
  // Consume ONLY on success: a refused undo must stay retryable once the caller reconciles.
  if (res.ok) store.delete(token)
  return res
}
