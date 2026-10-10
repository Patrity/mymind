import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { googleToken, forceRefresh, GoogleReconnectError, UNDECRYPTABLE_REASON } from './token'
import { connectionDeps, defaultLabel, type Connection } from './connections'
import { googleRefreshAccessToken } from './refresh-probe'

const conn: Connection = {
  id: 'conn-1',
  accountId: 'acc-row-1',
  userId: 'user-1',
  googleSub: 'sub-123',
  provider: 'google',
  label: 'costanzoclan',
  email: 'tony@costanzoclan.com',
  status: 'ok',
  lastError: null
}

let markSpy: ReturnType<typeof vi.fn>
const realMark = connectionDeps.markReconnect
const realUndecryptable = connectionDeps.tokensUndecryptable

beforeEach(() => {
  markSpy = vi.fn(async () => {})
  connectionDeps.markReconnect = markSpy as unknown as typeof connectionDeps.markReconnect
  connectionDeps.tokensUndecryptable = async () => false
})
afterEach(() => {
  connectionDeps.markReconnect = realMark
  connectionDeps.tokensUndecryptable = realUndecryptable
  vi.unstubAllGlobals()
})

describe('googleToken', () => {
  it('returns the access token from getAccessToken with the google sub + userId', async () => {
    const getAccessToken = vi.fn(async () => ({ accessToken: 'ya29.tok' }))
    await expect(googleToken(conn, { getAccessToken })).resolves.toBe('ya29.tok')
    expect(getAccessToken).toHaveBeenCalledWith({ providerId: 'google', accountId: 'sub-123', userId: 'user-1' })
    expect(markSpy).not.toHaveBeenCalled()
  })

  it('invalid_grant → markReconnect + GoogleReconnectError naming the label', async () => {
    const getAccessToken = vi.fn(async () => {
      throw Object.assign(new Error('refresh failed'), { body: { error: 'invalid_grant' } })
    })
    const err = await googleToken(conn, { getAccessToken }).catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect((err as Error).message).toContain('costanzoclan')
    expect((err as GoogleReconnectError).connection).toBe(conn)
    expect(markSpy).toHaveBeenCalledWith('conn-1', 'Google access was revoked or expired')
  })

  it('invalid_grant swallowed by better-auth (generic FAILED_TO_GET_ACCESS_TOKEN) is still detected via the refresh probe', async () => {
    // Google's token endpoint answers 400 invalid_grant for a revoked refresh token.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )))
    // Mirrors better-auth 1.6.13 getValidAccessToken: provider.refreshAccessToken runs inside a
    // try whose catch discards the cause and throws a generic BAD_REQUEST.
    const getAccessToken = vi.fn(async () => {
      try {
        await googleRefreshAccessToken({ clientId: 'cid', clientSecret: 'secret' })('1//refresh')
      } catch {
        throw Object.assign(new Error('Failed to get a valid access token'), { body: { code: 'FAILED_TO_GET_ACCESS_TOKEN' } })
      }
      return { accessToken: 'never' }
    })
    const err = await googleToken(conn, { getAccessToken }).catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect(markSpy).toHaveBeenCalledWith('conn-1', 'Google access was revoked or expired')
  })

  it('other errors propagate unchanged (not marked)', async () => {
    const boom = new Error('ECONNRESET')
    const getAccessToken = vi.fn(async () => { throw boom })
    await expect(googleToken(conn, { getAccessToken })).rejects.toBe(boom)
    expect(markSpy).not.toHaveBeenCalled()
  })

  it('a non-invalid_grant refresh failure (Google 500) is not marked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'internal_failure' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    )))
    const generic = new Error('Failed to get a valid access token')
    const getAccessToken = vi.fn(async () => {
      try {
        await googleRefreshAccessToken({ clientId: 'cid', clientSecret: 'secret' })('1//refresh')
      } catch {
        throw generic
      }
      return { accessToken: 'never' }
    })
    await expect(googleToken(conn, { getAccessToken })).rejects.toBe(generic)
    expect(markSpy).not.toHaveBeenCalled()
  })
})

describe('M1: stored tokens that no longer decrypt (BETTER_AUTH_SECRET changed)', () => {
  // better-auth's getAccessToken / refreshToken swallow the decrypt failure into a generic error
  // that never reaches Google, so the invalid_grant probe can't fire; the decrypt check does.
  it('googleToken: generic failure + undecryptable tokens → needs_reconnect + GoogleReconnectError', async () => {
    const undecryptable = vi.fn(async () => true)
    connectionDeps.tokensUndecryptable = undecryptable
    const getAccessToken = vi.fn(async () => { throw new Error('Failed to get a valid access token') })
    const err = await googleToken(conn, { getAccessToken }).catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect(undecryptable).toHaveBeenCalledWith(conn)
    expect(markSpy).toHaveBeenCalledWith('conn-1', UNDECRYPTABLE_REASON)
  })

  it('forceRefresh: same detection', async () => {
    connectionDeps.tokensUndecryptable = async () => true
    const refreshToken = vi.fn(async () => { throw new Error('Failed to refresh access token') })
    const err = await forceRefresh(conn, { refreshToken }).catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect(markSpy).toHaveBeenCalledWith('conn-1', UNDECRYPTABLE_REASON)
  })

  it('tokens that DO decrypt → the original error propagates, nothing marked', async () => {
    connectionDeps.tokensUndecryptable = async () => false
    const boom = new Error('Failed to get a valid access token')
    await expect(googleToken(conn, { getAccessToken: async () => { throw boom } })).rejects.toBe(boom)
    expect(markSpy).not.toHaveBeenCalled()
  })
})

describe('forceRefresh', () => {
  it('returns the access token from refreshToken with the google sub + userId', async () => {
    const refreshToken = vi.fn(async () => ({ accessToken: 'ya29.fresh' }))
    await expect(forceRefresh(conn, { refreshToken })).resolves.toBe('ya29.fresh')
    expect(refreshToken).toHaveBeenCalledWith({ providerId: 'google', accountId: 'sub-123', userId: 'user-1' })
    expect(markSpy).not.toHaveBeenCalled()
  })

  it('invalid_grant → markReconnect + GoogleReconnectError naming the label', async () => {
    const refreshToken = vi.fn(async () => {
      throw Object.assign(new Error('refresh failed'), { body: { error: 'invalid_grant' } })
    })
    const err = await forceRefresh(conn, { refreshToken }).catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect((err as Error).message).toContain('costanzoclan')
    expect((err as GoogleReconnectError).connection).toBe(conn)
    expect(markSpy).toHaveBeenCalledWith('conn-1', 'Google access was revoked or expired')
  })

  it('invalid_grant swallowed by better-auth (generic FAILED_TO_REFRESH_ACCESS_TOKEN) is still detected via the refresh probe', async () => {
    // Google's token endpoint answers 400 invalid_grant for a revoked refresh token.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )))
    // Mirrors better-auth 1.6.13's /refresh-token: provider.refreshAccessToken runs inside a try
    // whose catch discards the cause and throws a generic BAD_REQUEST.
    const refreshToken = vi.fn(async () => {
      try {
        await googleRefreshAccessToken({ clientId: 'cid', clientSecret: 'secret' })('1//refresh')
      } catch {
        throw Object.assign(new Error('Failed to refresh access token'), { body: { code: 'FAILED_TO_REFRESH_ACCESS_TOKEN' } })
      }
      return { accessToken: 'never' }
    })
    const err = await forceRefresh(conn, { refreshToken }).catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect(markSpy).toHaveBeenCalledWith('conn-1', 'Google access was revoked or expired')
  })

  it('a network failure propagates unchanged (not marked)', async () => {
    const boom = new Error('ECONNRESET')
    const refreshToken = vi.fn(async () => { throw boom })
    await expect(forceRefresh(conn, { refreshToken })).rejects.toBe(boom)
    expect(markSpy).not.toHaveBeenCalled()
  })

  it('a non-invalid_grant refresh failure (Google 500) is not marked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'internal_failure' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    )))
    const generic = new Error('Failed to refresh access token')
    const refreshToken = vi.fn(async () => {
      try {
        await googleRefreshAccessToken({ clientId: 'cid', clientSecret: 'secret' })('1//refresh')
      } catch {
        throw generic
      }
      return { accessToken: 'never' }
    })
    await expect(forceRefresh(conn, { refreshToken })).rejects.toBe(generic)
    expect(markSpy).not.toHaveBeenCalled()
  })
})

describe('defaultLabel', () => {
  it('defaultLabel derives domain label and de-duplicates', () => {
    expect(defaultLabel('tony@costanzoclan.com')).toBe('costanzoclan')
    expect(defaultLabel('t@gmail.com')).toBe('gmail')
    expect(defaultLabel('Tony@Mail.Example.COM')).toBe('example')
    expect(defaultLabel('t@gmail.com', new Set(['gmail']))).toBe('gmail-2')
    expect(defaultLabel('t@gmail.com', new Set(['gmail', 'gmail-2']))).toBe('gmail-3')
  })
})
