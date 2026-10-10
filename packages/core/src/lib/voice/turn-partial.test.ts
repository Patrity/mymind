// server/lib/voice/turn-partial.test.ts
//
// A turn that aborts, throws, or never returns used to persist NOTHING — and because
// `added` is derived from `s.history`, which is only reassigned when the agent call
// RETURNS, that included the user's own message. The user saw their question on screen
// (client-side state) while the database never received it; on reload it was gone.
//
// Observed 2026-09-21: a /agent thread whose stored assistant reply answers a question
// that appears in no stored user message, because the turn that carried it stalled on an
// exec approval and was then discarded.
//
// A question the user actually asked must survive the model failing to answer it.

import { describe, it, expect } from 'vitest'
import { partialTurnMessages } from './turn-partial'

describe('partialTurnMessages', () => {
  it('keeps the user message when the assistant produced nothing at all', () => {
    expect(partialTurnMessages('what did I do over the weekend?', '')).toEqual([
      { role: 'user', content: 'what did I do over the weekend?' }
    ])
  })

  it('keeps both halves when the assistant produced partial text', () => {
    expect(partialTurnMessages('check the logs', 'Let me look at that — one sec.')).toEqual([
      { role: 'user', content: 'check the logs' },
      { role: 'assistant', content: 'Let me look at that — one sec.' }
    ])
  })

  it('returns nothing when there is no user text — there is no turn to save', () => {
    expect(partialTurnMessages('', '')).toEqual([])
    expect(partialTurnMessages('   ', 'stray assistant output')).toEqual([])
  })

  it('ignores whitespace-only assistant output rather than storing an empty bubble', () => {
    expect(partialTurnMessages('hello', '   \n  ')).toEqual([
      { role: 'user', content: 'hello' }
    ])
  })

  it('does not trim the user text it stores — the question is kept verbatim', () => {
    const q = '  why did you stop?  '
    const [user] = partialTurnMessages(q, '')
    expect(user).toEqual({ role: 'user', content: q })
  })
})
