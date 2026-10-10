import { describe, it, expect } from 'vitest'
import { isOauthTokenLive, mcpAuthChallengeHeader, oauthOrigin } from './oauth-metadata'

describe('oauthOrigin', () => {
  it('reduces a full URL to its origin', () => {
    expect(oauthOrigin('https://brain.costanzoclan.com/api/auth')).toBe('https://brain.costanzoclan.com')
  })
  it('falls back to localhost dev origin when unset', () => {
    expect(oauthOrigin(undefined)).toBe('http://localhost:3000')
  })
})

describe('mcpAuthChallengeHeader', () => {
  it('points at the protected-resource metadata on the given origin', () => {
    expect(mcpAuthChallengeHeader('https://brain.costanzoclan.com')).toBe(
      'Bearer resource_metadata="https://brain.costanzoclan.com/.well-known/oauth-protected-resource"'
    )
  })
})

describe('isOauthTokenLive', () => {
  it('accepts a token whose expiry is in the future', () => {
    expect(isOauthTokenLive(new Date(Date.now() + 60_000))).toBe(true)
  })

  it('rejects a token whose expiry is in the past', () => {
    expect(isOauthTokenLive(new Date(Date.now() - 60_000))).toBe(false)
  })

  it('rejects a token whose expiry exactly equals now (boundary is exclusive)', () => {
    const now = Date.now()
    expect(isOauthTokenLive(new Date(now), now)).toBe(false)
  })

  it('accepts an ISO-string expiry (drizzle timestamp columns may serialize as strings)', () => {
    expect(isOauthTokenLive(new Date(Date.now() + 60_000).toISOString())).toBe(true)
  })

  it('rejects a past ISO-string expiry', () => {
    expect(isOauthTokenLive(new Date(Date.now() - 60_000).toISOString())).toBe(false)
  })
})
