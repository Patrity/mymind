import { describe, it, expect } from 'vitest'
import { safeRedirect } from './auth-redirect'

// The auth guard (app/middleware/auth.global.ts) used to send every unauthenticated visitor to
// a bare `/login`, so a bookmarked or shared deep link always landed them on `/` after sign-in.
// It now passes the intended route through `?redirect=`, which makes that param a same-origin
// gate: everything below is about not turning a login link into an open redirect.
describe('safeRedirect', () => {
  it('keeps a rooted internal path, query and hash included', () => {
    expect(safeRedirect('/projects/mymind')).toBe('/projects/mymind')
    expect(safeRedirect('/gallery?image=abc123')).toBe('/gallery?image=abc123')
    expect(safeRedirect('/docs#section')).toBe('/docs#section')
  })

  it('rejects anything that leaves the origin', () => {
    expect(safeRedirect('https://evil.com')).toBeNull()
    expect(safeRedirect('//evil.com')).toBeNull()
    expect(safeRedirect('/\\evil.com')).toBeNull()
    expect(safeRedirect('javascript:alert(1)')).toBeNull()
    expect(safeRedirect('relative/path')).toBeNull()
  })

  it('rejects control characters browsers would strip before resolving', () => {
    expect(safeRedirect('/\tevil')).toBeNull()
    expect(safeRedirect('/\nevil')).toBeNull()
    expect(safeRedirect('/\r\n/evil.com')).toBeNull()
  })

  it('refuses to bounce back to the login page', () => {
    expect(safeRedirect('/login')).toBeNull()
    expect(safeRedirect('/login?redirect=%2F')).toBeNull()
    expect(safeRedirect('/login#x')).toBeNull()
  })

  it('returns null for absent or non-string values', () => {
    expect(safeRedirect(undefined)).toBeNull()
    expect(safeRedirect('')).toBeNull()
    expect(safeRedirect(['/a', '/b'])).toBeNull()
    expect(safeRedirect(42)).toBeNull()
  })
})
