// test/agent-bus.test.ts
import { describe, it, expect } from 'vitest'
import { publishActivity, subscribeActivity } from '../server/lib/agent/bus'

describe('agent activity bus', () => {
  it('delivers events to subscribers and stops after unsubscribe', () => {
    const seen: unknown[] = []
    const off = subscribeActivity((e) => seen.push(e))
    publishActivity({ type: 'state', state: 'thinking' })
    expect(seen).toHaveLength(1)
    off()
    publishActivity({ type: 'state', state: 'idle' })
    expect(seen).toHaveLength(1)
  })
})
