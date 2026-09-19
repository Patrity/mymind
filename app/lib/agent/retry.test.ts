import { describe, it, expect } from 'vitest'
import { truncateForRetry } from './retry'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const user = (id: string, text: string, attachments?: AgentUIMessage['metadata']): AgentUIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], metadata: attachments })
const bot = (id: string, text: string): AgentUIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text, state: 'done' }] })

describe('truncateForRetry', () => {
  it('drops the preceding user turn and everything after, returning what to re-send', () => {
    const att = [{ id: 'i1', kind: 'image' as const, mime: 'image/png' }]
    const msgs = [user('u1', 'first'), bot('a1', 'one'), user('u2', 'second', { attachments: att }), bot('a2', 'two')]
    expect(truncateForRetry(msgs, 'a2')).toEqual({ messages: [msgs[0], msgs[1]], text: 'second', attachments: att })
  })
  it('retrying an earlier reply drops the later turns too', () => {
    const msgs = [user('u1', 'first'), bot('a1', 'one'), user('u2', 'second'), bot('a2', 'two')]
    expect(truncateForRetry(msgs, 'a1')).toEqual({ messages: [], text: 'first', attachments: [] })
  })
  it('returns null for an unknown id or no preceding user turn', () => {
    expect(truncateForRetry([bot('a1', 'x')], 'a1')).toBeNull()
    expect(truncateForRetry([user('u1', 'x')], 'nope')).toBeNull()
  })
})
