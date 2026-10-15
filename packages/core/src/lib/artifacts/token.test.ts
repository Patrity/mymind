import { describe, it, expect } from 'vitest'
import { signViewToken, verifyViewToken, ARTIFACT_TOKEN_TTL_MS } from './token'

const S = { secret: 'test-secret-123' }
const ID = '6f1c1b0e-0000-4000-8000-000000000001'

describe('view tokens', () => {
  it('round-trips', () => expect(verifyViewToken(signViewToken(ID, { ...S, now: 1000 }), ID, { ...S, now: 2000 })).toBe('ok'))
  it('is url-path safe', () => expect(signViewToken(ID, S)).toMatch(/^[A-Za-z0-9_.-]+$/))
  it('expires after the TTL', () => {
    const t = signViewToken(ID, { ...S, now: 0 })
    expect(verifyViewToken(t, ID, { ...S, now: ARTIFACT_TOKEN_TTL_MS + 1 })).toBe('expired')
  })
  it('is bound to the artifact', () => expect(verifyViewToken(signViewToken(ID, S), ID.replace(/1$/, '2'), S)).toBe('invalid'))
  it('rejects a different secret', () => expect(verifyViewToken(signViewToken(ID, S), ID, { secret: 'other' })).toBe('invalid'))
  it('rejects tampering of the expiry', () => {
    const [body, sig] = signViewToken(ID, { ...S, now: 0 }).split('.')
    const forged = Buffer.from(`${ID}.${Date.now() + 1e9}`).toString('base64url') + '.' + sig
    expect(verifyViewToken(forged, ID, S)).toBe('invalid')
    expect(body).toBeTruthy()
  })
  it.each(['', 'x', 'a.b.c', '.', 'abc.'])('rejects garbage %j', t => expect(verifyViewToken(t, ID, S)).toBe('invalid'))
  it('throws without a secret', () => expect(() => signViewToken(ID, { secret: '' })).toThrow(/BETTER_AUTH_SECRET/))
})
