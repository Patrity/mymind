import { describe, it, expect } from 'vitest'
import { decideConsentRedirect } from './oauth-consent-guard'

const PATH = '/api/auth/mcp/authorize'

describe('decideConsentRedirect', () => {
  it('forces consent when prompt is absent entirely', () => {
    const search = '?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A19191%2Fcb&response_type=code&scope=openid+profile+offline_access&state=e2e-state&code_challenge=xyz&code_challenge_method=S256'
    expect(decideConsentRedirect('GET', PATH, search)).toBe(`${PATH}${search}&prompt=consent`)
  })

  it('preserves every other query param byte-for-byte, appending only prompt', () => {
    // Deliberately includes characters that would come out differently if
    // round-tripped through URLSearchParams (e.g. '+' vs '%20') to prove we
    // never reconstruct the query string, only append to it.
    const search = '?client_id=abc&scope=openid+profile&redirect_uri=http%3A%2F%2Fexample.com%2Fcb'
    expect(decideConsentRedirect('GET', PATH, search)).toBe(`${PATH}${search}&prompt=consent`)
  })

  it('adds a leading ? when there is no existing query string at all', () => {
    expect(decideConsentRedirect('GET', PATH, '')).toBe(`${PATH}?prompt=consent`)
  })

  it('does not redirect when prompt=consent is already present (no loop)', () => {
    expect(decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=consent')).toBeNull()
  })

  it('does not override an explicit prompt=none', () => {
    expect(decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=none')).toBeNull()
  })

  it('does not touch other paths', () => {
    expect(decideConsentRedirect('GET', '/api/auth/oauth2/authorize', '')).toBeNull()
    expect(decideConsentRedirect('GET', '/api/mcp', '')).toBeNull()
    expect(decideConsentRedirect('GET', '/login', '?client_id=abc')).toBeNull()
  })

  it('does not touch non-GET requests to the guarded path', () => {
    expect(decideConsentRedirect('POST', PATH, '')).toBeNull()
    expect(decideConsentRedirect('HEAD', PATH, '')).toBeNull()
  })
})
