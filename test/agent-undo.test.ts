// test/agent-undo.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerUndo, runUndo, hasUndo } from '../server/lib/agent/undo'

describe('undo store', () => {
  it('registers, runs once, then forgets the token', async () => {
    const fn = vi.fn(async () => {})
    const token = registerUndo(fn)
    expect(hasUndo(token)).toBe(true)
    expect(await runUndo(token)).toEqual({ ok: true })
    expect(fn).toHaveBeenCalledOnce()
    expect(hasUndo(token)).toBe(false)
    expect(await runUndo(token)).toEqual({ ok: false, reason: 'undo expired or already used' }) // already consumed
  })

  it('returns a failure result for an unknown token', async () => {
    expect(await runUndo('nope')).toEqual({ ok: false, reason: 'undo expired or already used' })
  })

  // Final fix wave, Finding 3: an undo closure can genuinely throw — move_document's and
  // update_document's undo write the old path back, and `documents_path_live_uidx` (unique on
  // live paths) raises a unique violation if that path was re-occupied. Unhandled, that escaped
  // the { ok, reason } contract as a raw 500 from POST /api/agent/undo.
  it('turns a throwing closure into { ok: false } instead of rejecting', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const token = registerUndo(async () => { throw new Error('duplicate key value violates unique constraint') })
      const res = await runUndo(token)
      // Resolves with the { ok, reason } contract rather than rejecting — that's the subject
      // here. What the reason may NOT contain is covered by the leak test below.
      expect(res).toEqual({ ok: false, reason: expect.any(String) })
    } finally {
      err.mockRestore()
    }
  })

  // The reason is user-facing: it goes back through POST /api/agent/undo into the chat
  // transcript. A DrizzleQueryError's message embeds the failed query AND its bound params,
  // and for a document undo those params are the entire prior document body — so
  // interpolating err.message republished the whole document as an error string.
  it('does not leak the thrown error message into the user-facing reason', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const body = 'PRIOR-DOCUMENT-BODY-fca19b'
      const token = registerUndo(async () => {
        throw new Error(`Failed query: update "documents" set "content" = $1\nparams: ${body}`)
      })
      const res = await runUndo(token)
      expect(res.ok).toBe(false)
      expect(res.reason).not.toContain(body)
      expect(res.reason).not.toContain('Failed query')
      // The operator still gets the real error — it moves to the log, it doesn't vanish.
      expect(err).toHaveBeenCalledWith('[undo] closure threw:', expect.any(Error))
    } finally {
      err.mockRestore()
    }
  })

  // ...and consumes the token, unlike a refusal. Consuming only on success exists so a
  // reconcilable refusal stays retryable; a throw is not reconcilable, and a live token would
  // just replay the same failure on every click for the rest of the 10-minute TTL.
  it('consumes the token when the closure throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fn = vi.fn(async () => { throw new Error('boom') })
      const token = registerUndo(fn)
      expect((await runUndo(token)).ok).toBe(false)
      expect(hasUndo(token)).toBe(false)
      expect(await runUndo(token)).toEqual({ ok: false, reason: 'undo expired or already used' })
      expect(fn).toHaveBeenCalledOnce()
    } finally {
      err.mockRestore()
    }
  })

  // A refusal is the opposite case, and the contrast is the point: it must NOT be consumed.
  it('keeps the token after a refusal so it can be retried', async () => {
    const token = registerUndo(async () => ({ ok: false, reason: 'document changed since' }))
    expect(await runUndo(token)).toEqual({ ok: false, reason: 'document changed since' })
    expect(hasUndo(token)).toBe(true)
  })
})
