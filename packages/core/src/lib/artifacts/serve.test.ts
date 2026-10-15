import { describe, it, expect } from 'vitest'
import { parseArtifactUrl, decideArtifactRequest, artifactHeaders, ARTIFACT_CSP } from './serve'
import type { Manifest } from './limits'

const file = { key: 'k', sha256: 's', size: 1, contentType: 'text/html; charset=utf-8' }
const manifest: Manifest = { 'index.html': file, 'my chart.png': { ...file, contentType: 'image/png' } }
const found = (isPublic: boolean) => ({ artifactId: 'id1', slug: 'demo', isPublic, manifest, entry: 'index.html', spaFallback: false })
const input = (o: Partial<Parameters<typeof decideArtifactRequest>[0]>) => ({
  pathname: '/artifact/demo/', search: '', found: found(true), hasSession: false, tokenStatus: 'absent' as const,
  isNavigation: true, mintToken: () => 'TOK', ...o
})

describe('parseArtifactUrl', () => {
  it('slug only, no slash', () => expect(parseArtifactUrl('/artifact/demo')).toEqual({ slug: 'demo', token: null, path: '', trailingSlash: false }))
  it('slug with slash', () => expect(parseArtifactUrl('/artifact/demo/')).toEqual({ slug: 'demo', token: null, path: '', trailingSlash: true }))
  it('token + path', () => expect(parseArtifactUrl('/artifact/demo/~abc.def/assets/a.js')).toEqual({ slug: 'demo', token: 'abc.def', path: 'assets/a.js', trailingSlash: true }))
  it('decodes percent-encoding once', () => expect(parseArtifactUrl('/artifact/demo/my%20chart.png')?.path).toBe('my chart.png'))
  it('encoded traversal stays a literal miss', () => expect(parseArtifactUrl('/artifact/demo/%2e%2e/x')?.path).toBe('../x'))
  it('bad percent-encoding → null', () => expect(parseArtifactUrl('/artifact/demo/%E0%A4%A')).toBeNull())
  it('invalid slug → null', () => expect(parseArtifactUrl('/artifact/Bad_Slug/')).toBeNull())
  it('collapses double slashes in the path', () => expect(parseArtifactUrl('/artifact/demo/a//b.js')?.path).toBe('a/b.js'))
})

describe('decideArtifactRequest', () => {
  it('adds the trailing slash (keeps the query)', () => {
    expect(decideArtifactRequest(input({ pathname: '/artifact/demo', search: '?x=1' }))).toEqual({ kind: 'redirect', status: 301, location: '/artifact/demo/?x=1' })
  })
  it('public serves the entry', () => {
    const d = decideArtifactRequest(input({}))
    expect(d).toMatchObject({ kind: 'serve', path: 'index.html', isPublic: true })
  })
  it('public ignores a token segment', () => {
    expect(decideArtifactRequest(input({ pathname: '/artifact/demo/~junk/my%20chart.png' }))).toMatchObject({ kind: 'serve', path: 'my chart.png' })
  })
  it('missing artifact → not_found', () => expect(decideArtifactRequest(input({ found: null }))).toEqual({ kind: 'not_found' }))
  it('encoded traversal → not_found', () => expect(decideArtifactRequest(input({ pathname: '/artifact/demo/%2e%2e/etc/passwd' }))).toEqual({ kind: 'not_found' }))
  it('private, no session, no token, navigation → login', () => {
    expect(decideArtifactRequest(input({ found: found(false) }))).toEqual({ kind: 'redirect', status: 302, location: '/login?redirect=%2Fartifact%2Fdemo%2F' })
  })
  it('private, no session, subresource → not_found (same as missing — no slug leak)', () => {
    expect(decideArtifactRequest(input({ found: found(false), isNavigation: false, pathname: '/artifact/demo/app.js' }))).toEqual({ kind: 'not_found' })
  })
  it('private + session, no token → token redirect, same path', () => {
    expect(decideArtifactRequest(input({ found: found(false), hasSession: true, pathname: '/artifact/demo/my%20chart.png' })))
      .toEqual({ kind: 'redirect', status: 302, location: '/artifact/demo/~TOK/my%20chart.png' })
  })
  it('private + valid token serves without a session', () => {
    expect(decideArtifactRequest(input({ found: found(false), tokenStatus: 'ok', pathname: '/artifact/demo/~TOK/' }))).toMatchObject({ kind: 'serve', path: 'index.html', isPublic: false })
  })
  it('private + expired token, navigation → back through the session check (strip the token)', () => {
    expect(decideArtifactRequest(input({ found: found(false), tokenStatus: 'expired', pathname: '/artifact/demo/~OLD/x.png', hasSession: true })))
      .toEqual({ kind: 'redirect', status: 302, location: '/artifact/demo/~TOK/x.png' })
  })
  it('private + invalid token, subresource → forbidden', () => {
    expect(decideArtifactRequest(input({ found: found(false), tokenStatus: 'invalid', isNavigation: false, pathname: '/artifact/demo/~BAD/a.js' }))).toEqual({ kind: 'forbidden' })
  })
})

describe('artifactHeaders', () => {
  it('always sandboxes', () => {
    expect(ARTIFACT_CSP).toBe('sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads')
    for (const pub of [true, false]) {
      const h = artifactHeaders(pub)
      expect(h['content-security-policy']).toBe(ARTIFACT_CSP)
      expect(h['x-content-type-options']).toBe('nosniff')
      expect(h['referrer-policy']).toBe('no-referrer')
    }
    expect(artifactHeaders(true)['cache-control']).toBe('public, max-age=60')
    expect(artifactHeaders(false)['cache-control']).toBe('private, no-store')
  })
})
