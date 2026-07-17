import { describe, it, expect } from 'vitest'
import { decideConsentRedirect } from './oauth-consent-guard'

const PATH = '/api/auth/mcp/authorize'

/** Parse the query of a redirect result for value-level assertions. */
function paramsOf(redirect: string): URLSearchParams {
  return new URLSearchParams(redirect.slice(redirect.indexOf('?')))
}

describe('decideConsentRedirect', () => {
  it('forces consent when prompt is absent entirely', () => {
    const search = '?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A19191%2Fcb&response_type=code&scope=openid+profile+offline_access&state=e2e-state&code_challenge=xyz&code_challenge_method=S256'
    expect(decideConsentRedirect('GET', PATH, search)).toBe(`${PATH}${search}&prompt=consent`)
  })

  it('preserves other params byte-for-byte on the absent-prompt path, appending only prompt', () => {
    // Deliberately includes characters that would come out differently if
    // round-tripped through URLSearchParams (e.g. '+' vs '%20') to prove the
    // absent-prompt branch never reconstructs the query string, only appends.
    const search = '?client_id=abc&scope=openid+profile&redirect_uri=http%3A%2F%2Fexample.com%2Fcb'
    expect(decideConsentRedirect('GET', PATH, search)).toBe(`${PATH}${search}&prompt=consent`)
  })

  it('adds a leading ? when there is no existing query string at all', () => {
    expect(decideConsentRedirect('GET', PATH, '')).toBe(`${PATH}?prompt=consent`)
  })

  it('passes through only the canonical single prompt=consent (no loop)', () => {
    expect(decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=consent')).toBeNull()
    expect(decideConsentRedirect('GET', PATH, '?prompt=consent')).toBeNull()
  })

  it('rewrites prompt=none to prompt=consent (better-auth would silently mint, not interaction_required)', () => {
    const redirect = decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=none')
    expect(redirect).not.toBeNull()
    const params = paramsOf(redirect!)
    expect(params.getAll('prompt')).toEqual(['consent'])
    expect(params.get('client_id')).toBe('abc')
  })

  it('rewrites case variants like prompt=Consent (better-auth compares case-sensitively)', () => {
    const redirect = decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=Consent')
    expect(redirect).not.toBeNull()
    expect(paramsOf(redirect!).getAll('prompt')).toEqual(['consent'])
  })

  it('rewrites multi-value prompt like "consent login" (strict-equality gate fails on it)', () => {
    const redirect = decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=consent+login')
    expect(redirect).not.toBeNull()
    expect(paramsOf(redirect!).getAll('prompt')).toEqual(['consent'])
  })

  it('collapses duplicate prompt keys (consent&none) to exactly one prompt=consent', () => {
    const redirect = decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=consent&prompt=none')
    expect(redirect).not.toBeNull()
    expect(paramsOf(redirect!).getAll('prompt')).toEqual(['consent'])
  })

  it('collapses duplicate prompt=consent&prompt=consent to exactly one', () => {
    const redirect = decideConsentRedirect('GET', PATH, '?client_id=abc&prompt=consent&prompt=consent')
    expect(redirect).not.toBeNull()
    expect(paramsOf(redirect!).getAll('prompt')).toEqual(['consent'])
  })

  it('preserves every other param key/value on the rewrite path', () => {
    const search = '?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A19191%2Fcb&response_type=code&scope=openid+profile+offline_access&state=e2e-state&code_challenge=xyz&code_challenge_method=S256&prompt=none'
    const redirect = decideConsentRedirect('GET', PATH, search)
    expect(redirect).not.toBeNull()
    const params = paramsOf(redirect!)
    const original = new URLSearchParams(search)
    for (const key of ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
      expect(params.getAll(key)).toEqual(original.getAll(key))
    }
    expect(params.getAll('prompt')).toEqual(['consent'])
  })

  it('never loops: feeding any redirect output back through returns null', () => {
    for (const search of ['', '?client_id=abc', '?client_id=abc&prompt=none', '?prompt=Consent', '?prompt=consent&prompt=none']) {
      const redirect = decideConsentRedirect('GET', PATH, search)
      expect(redirect).not.toBeNull()
      const next = redirect!.slice(redirect!.indexOf('?'))
      expect(decideConsentRedirect('GET', PATH, next)).toBeNull()
    }
  })

  it('does not touch other paths', () => {
    expect(decideConsentRedirect('GET', '/api/auth/oauth2/authorize', '')).toBeNull()
    expect(decideConsentRedirect('GET', '/api/mcp', '')).toBeNull()
    expect(decideConsentRedirect('GET', '/login', '?client_id=abc&prompt=none')).toBeNull()
  })

  it('does not touch non-GET requests to the guarded path', () => {
    expect(decideConsentRedirect('POST', PATH, '')).toBeNull()
    expect(decideConsentRedirect('HEAD', PATH, '?prompt=none')).toBeNull()
  })
})
