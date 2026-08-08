import { describe, it, expect } from 'vitest'
import { undoFeedback } from './undo-feedback'

describe('undoFeedback', () => {
  it('says nothing on success', () => {
    expect(undoFeedback({ ok: true })).toBeNull()
  })

  it('surfaces the server reason verbatim on a refusal', () => {
    const f = undoFeedback({ ok: false, reason: 'document changed since the edit — nothing was undone' })
    expect(f).toMatchObject({ color: 'error' })
    expect(f!.description).toBe('document changed since the edit — nothing was undone')
  })

  it('falls back to a usable message when the server gave no reason', () => {
    const f = undoFeedback({ ok: false })
    expect(f).not.toBeNull()
    expect(f!.description.length).toBeGreaterThan(0)
  })
})
