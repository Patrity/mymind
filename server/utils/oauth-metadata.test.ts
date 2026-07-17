import { describe, it, expect } from 'vitest'
import { mcpAuthChallengeHeader, oauthOrigin } from './oauth-metadata'

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
