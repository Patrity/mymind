import { describe, it, expect } from 'vitest'
import { publishChange, subscribeChanges } from '../server/utils/live-bus'
import type { LiveEvent } from '../shared/types/live'

describe('live-bus', () => {
  it('delivers a published change to a subscriber as a versioned, timestamped event', async () => {
    const received: LiveEvent[] = []
    const unsub = subscribeChanges(e => received.push(e))

    publishChange({ resource: 'image', action: 'updated', id: 'img-123' })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ v: 1, resource: 'image', action: 'updated', id: 'img-123' })
    expect(typeof received[0]!.at).toBe('number')
    unsub()
  })

  it('stops delivering after unsubscribe', () => {
    const received: LiveEvent[] = []
    const unsub = subscribeChanges(e => received.push(e))
    unsub()
    publishChange({ resource: 'document', action: 'created', id: 'doc-1' })
    expect(received).toHaveLength(0)
  })
})
