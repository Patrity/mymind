// Cycle 75, Task 11: toUIMessages carries a user row's `origin` (an iMessage arrival is marked 📱)
// and an assistant row's channel `deliveries` (badged under the reply) into message metadata.
import { describe, it, expect } from 'vitest'
import { toUIMessages } from '../app/lib/agent/to-ui-messages'

describe('toUIMessages — cycle 75 channel metadata', () => {
  it('forwards an imessage origin on a user row into metadata.origin', () => {
    const [m] = toUIMessages([{ id: 'u1', role: 'user', content: 'hi from my phone', origin: 'imessage:iMessage;-;+15550001111' }])
    expect(m!.role).toBe('user')
    expect(m!.metadata?.origin).toBe('imessage:iMessage;-;+15550001111')
  })

  it('a user row without an origin has no metadata.origin', () => {
    const [m] = toUIMessages([{ id: 'u1', role: 'user', content: 'typed here', origin: null }])
    expect(m!.metadata).not.toHaveProperty('origin')
  })

  it('does not put origin on an assistant row (its origin is the wake that caused it, not a channel)', () => {
    const [m] = toUIMessages([{ id: 'a1', role: 'assistant', content: 'ok', origin: 'wake:admin' }])
    expect(m!.metadata).not.toHaveProperty('origin')
  })

  it('forwards deliveries on an assistant row', () => {
    const deliveries = [{ channel: 'imessage' as const, status: 'sent' }, { channel: 'email' as const, status: 'pending' }]
    const [m] = toUIMessages([{ id: 'a1', role: 'assistant', content: 'reply', deliveries }])
    expect(m!.metadata?.deliveries).toEqual(deliveries)
  })

  it('an assistant row with no deliveries has no metadata.deliveries', () => {
    const [a, b] = toUIMessages([
      { id: 'a1', role: 'assistant', content: 'reply' },
      { id: 'a2', role: 'assistant', content: 'reply', deliveries: [] }
    ])
    expect(a!.metadata).not.toHaveProperty('deliveries')
    expect(b!.metadata).not.toHaveProperty('deliveries')
  })
})
