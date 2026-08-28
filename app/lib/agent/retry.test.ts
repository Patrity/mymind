import { describe, it, expect } from 'vitest'
import { truncateForRetry } from './retry'
import type { TranscriptEntry } from '~/composables/useVoice'

const user = (id: string, text = 'hi'): TranscriptEntry => ({ id, role: 'user', text })
const assistant = (id: string, text = 'hello'): TranscriptEntry => ({ id, role: 'assistant', text })
const tool = (id: string): TranscriptEntry => ({ id, role: 'tool', text: '', name: 'x', summary: 'did a thing' })

describe('truncateForRetry', () => {
  it('walks back to the preceding user turn and drops it plus everything after', () => {
    const t = [user('u1'), assistant('a1')]
    const plan = truncateForRetry(t, 'a1')
    expect(plan).not.toBeNull()
    expect(plan!.transcript).toEqual([])
    expect(plan!.userTurn).toBe(t[0])
  })

  it('keeps everything before the preceding user turn intact', () => {
    const t = [user('u0'), assistant('a0'), user('u1'), assistant('a1')]
    const plan = truncateForRetry(t, 'a1')
    expect(plan!.transcript).toEqual([t[0], t[1]])
    expect(plan!.userTurn).toBe(t[2])
  })

  it('returns null for an entry id that is not in the transcript', () => {
    const t = [user('u1'), assistant('a1')]
    expect(truncateForRetry(t, 'nope')).toBeNull()
  })

  it('returns null for an assistant entry with no preceding user turn', () => {
    // e.g. a stray reasoning-only entry, or a corrupted/legacy transcript.
    const t = [assistant('a1')]
    expect(truncateForRetry(t, 'a1')).toBeNull()
  })

  it('skips interleaved tool entries between the user turn and the assistant reply', () => {
    const t = [user('u1'), tool('t1'), tool('t2'), assistant('a1')]
    const plan = truncateForRetry(t, 'a1')
    expect(plan!.transcript).toEqual([])
    expect(plan!.userTurn).toBe(t[0])
  })

  it('retrying a turn that is not the last one drops it and everything after', () => {
    const t = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    const plan = truncateForRetry(t, 'a1')
    expect(plan!.transcript).toEqual([])
    expect(plan!.userTurn).toBe(t[0])
  })

  it('retrying a middle turn preserves an earlier unrelated turn', () => {
    const t = [user('u0'), assistant('a0'), user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    const plan = truncateForRetry(t, 'a1')
    expect(plan!.transcript).toEqual([t[0], t[1]])
    expect(plan!.userTurn).toBe(t[2])
  })

  it('carries the user turn\'s attachments through for re-send', () => {
    const withAttachments: TranscriptEntry = { id: 'u1', role: 'user', text: 'look', attachments: [{ id: 'img1', kind: 'image', mime: 'image/png' }] }
    const t = [withAttachments, assistant('a1')]
    const plan = truncateForRetry(t, 'a1')
    expect(plan!.userTurn.attachments).toEqual(withAttachments.attachments)
  })
})
