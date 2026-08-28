import { describe, it, expect } from 'vitest'
import { mapServerMessage } from './messages'

describe('mapServerMessage — usage', () => {
  it('maps a usage frame onto the usage effect', () => {
    const fx = mapServerMessage({ type: 'usage', inputTokens: 12, outputTokens: 34, totalTokens: 46 }, false)
    expect(fx.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46 })
  })

  it('passes through a partial usage payload rather than fabricating zeros', () => {
    const fx = mapServerMessage({ type: 'usage', totalTokens: 46 }, false)
    expect(fx.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: 46 })
  })

  it('does not set usage for an unrelated frame', () => {
    const fx = mapServerMessage({ type: 'state', state: 'idle' }, false)
    expect(fx.usage).toBeUndefined()
  })
})
