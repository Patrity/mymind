import { describe, it, expect } from 'vitest'
import { isSessionClient } from '../server/utils/auth-guard'

describe('isSessionClient', () => {
  it('is true for a session client', () => {
    expect(isSessionClient({ type: 'session', userId: 'u1' })).toBe(true)
  })

  it('is false for an api-token client', () => {
    expect(isSessionClient({ type: 'api-token', tokenId: 't1' })).toBe(false)
  })

  it('is false when client is missing', () => {
    expect(isSessionClient(undefined)).toBe(false)
  })
})
