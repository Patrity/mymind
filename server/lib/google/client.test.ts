import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./connections', async (importOriginal) => {
  const real = await importOriginal<typeof import('./connections')>()
  return {
    ...real,
    markReconnect: vi.fn(async () => {}),
    touchConnection: vi.fn(async () => {})
  }
})

import { google, googleErrorMessage, GoogleApiError } from './client'
import { markReconnect, touchConnection, type Connection } from './connections'
import { GoogleReconnectError } from './token'
import { fakeFetch } from './fake-fetch'

const conn: Connection = {
  id: 'conn-1',
  accountId: 'acc-1',
  userId: 'user-1',
  googleSub: 'sub-1',
  provider: 'google',
  label: 'work',
  email: 'tony@work.com',
  status: 'ok',
  lastError: null
}

beforeEach(() => {
  vi.mocked(markReconnect).mockClear()
  vi.mocked(touchConnection).mockClear()
})

describe('google() client', () => {
  it('sends Authorization: Bearer <token> and repeats array query params', async () => {
    const fetch = fakeFetch({
      'GET /messages': ({ url, headers }) => {
        expect(headers.get('authorization')).toBe('Bearer tok1')
        expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject'])
        return { json: { ok: true } }
      }
    })
    const token = vi.fn(async () => 'tok1')
    const result = await google(conn, { fetch, token }).get<{ ok: boolean }>(
      'https://gmail.googleapis.com/messages',
      { metadataHeaders: ['From', 'Subject'] }
    )
    expect(result).toEqual({ ok: true })
    expect(touchConnection).toHaveBeenCalledWith('conn-1')
  })

  it('401 once → calls token again → retries with the new token → returns body', async () => {
    let calls = 0
    const fetch = fakeFetch({
      'GET /thing': ({ headers }) => {
        calls++
        if (calls === 1) return { status: 401 }
        expect(headers.get('authorization')).toBe('Bearer tok2')
        return { json: { done: true } }
      }
    })
    const token = vi.fn()
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce('tok2')
    const result = await google(conn, { fetch, token }).get('https://gmail.googleapis.com/thing')
    expect(result).toEqual({ done: true })
    expect(token).toHaveBeenCalledTimes(2)
    expect(fetch.calls).toEqual(['GET /thing', 'GET /thing'])
    expect(markReconnect).not.toHaveBeenCalled()
  })

  it('401 twice (different tokens) → throws GoogleApiError(401)', async () => {
    const fetch = fakeFetch({
      'GET /thing': () => ({ status: 401, json: { error: { message: 'still unauthorized' } } })
    })
    const token = vi.fn()
      .mockResolvedValueOnce('tok1')
      .mockResolvedValueOnce('tok2')
    const err = await google(conn, { fetch, token }).get('https://gmail.googleapis.com/thing').catch(e => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect((err as GoogleApiError).status).toBe(401)
    expect(fetch.calls).toEqual(['GET /thing', 'GET /thing'])
    expect(markReconnect).not.toHaveBeenCalled()
  })

  it('401 with an unchanged token on retry → reconnect condition (markReconnect + GoogleReconnectError), no second request', async () => {
    const fetch = fakeFetch({
      'GET /thing': () => ({ status: 401 })
    })
    const token = vi.fn(async () => 'same-token')
    const err = await google(conn, { fetch, token }).get('https://gmail.googleapis.com/thing').catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect(markReconnect).toHaveBeenCalledWith('conn-1', expect.any(String))
    // only the first request actually hit the network — no retry with an identical token
    expect(fetch.calls).toEqual(['GET /thing'])
    expect(token).toHaveBeenCalledTimes(2)
  })

  it('429 then 200 → sleeps ~1000ms once, then succeeds', async () => {
    let calls = 0
    const fetch = fakeFetch({
      'GET /thing': () => {
        calls++
        return calls === 1 ? { status: 429 } : { json: { ok: true } }
      }
    })
    const sleep = vi.fn(async () => {})
    const result = await google(conn, { fetch, token: async () => 'tok', sleep }).get('https://gmail.googleapis.com/thing')
    expect(result).toEqual({ ok: true })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(1000)
    expect(fetch.calls).toHaveLength(2)
  })

  it('503 twice → throws GoogleApiError after one retry', async () => {
    const fetch = fakeFetch({
      'GET /thing': () => ({ status: 503, json: { error: { message: 'unavailable' } } })
    })
    const sleep = vi.fn(async () => {})
    const err = await google(conn, { fetch, token: async () => 'tok', sleep }).get('https://gmail.googleapis.com/thing').catch(e => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect((err as GoogleApiError).status).toBe(503)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(fetch.calls).toHaveLength(2)
  })

  it('403 insufficientPermissions (errors[].reason) → markReconnect + GoogleReconnectError', async () => {
    const fetch = fakeFetch({
      'GET /thing': () => ({ status: 403, json: { error: { errors: [{ reason: 'insufficientPermissions' }], message: 'nope' } } })
    })
    const err = await google(conn, { fetch, token: async () => 'tok' }).get('https://gmail.googleapis.com/thing').catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
    expect(markReconnect).toHaveBeenCalledWith('conn-1', expect.any(String))
  })

  it('403 PERMISSION_DENIED (error.status) → markReconnect + GoogleReconnectError', async () => {
    const fetch = fakeFetch({
      'GET /thing': () => ({ status: 403, json: { error: { status: 'PERMISSION_DENIED', message: 'nope' } } })
    })
    const err = await google(conn, { fetch, token: async () => 'tok' }).get('https://gmail.googleapis.com/thing').catch(e => e)
    expect(err).toBeInstanceOf(GoogleReconnectError)
  })

  it('403 with an unrelated reason → GoogleApiError(403), not a reconnect', async () => {
    const fetch = fakeFetch({
      'GET /thing': () => ({ status: 403, json: { error: { errors: [{ reason: 'somethingElse' }], message: 'blocked' } } })
    })
    const err = await google(conn, { fetch, token: async () => 'tok' }).get('https://gmail.googleapis.com/thing').catch(e => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect((err as GoogleApiError).status).toBe(403)
    expect((err as GoogleApiError).reason).toBe('somethingElse')
    expect(markReconnect).not.toHaveBeenCalled()
  })

  it('del tolerates a 204 response', async () => {
    const fetch = fakeFetch({
      'DELETE /thing/1': () => ({ status: 204 })
    })
    await expect(google(conn, { fetch, token: async () => 'tok' }).del('https://gmail.googleapis.com/thing/1')).resolves.toBeUndefined()
    expect(touchConnection).toHaveBeenCalledWith('conn-1')
  })

  it('post sends a JSON body with a content-type header', async () => {
    const fetch = fakeFetch({
      'POST /thing': ({ body, headers }) => {
        expect(headers.get('content-type')).toBe('application/json')
        expect(body).toEqual({ hello: 'world' })
        return { json: { created: true } }
      }
    })
    const result = await google(conn, { fetch, token: async () => 'tok' }).post('https://gmail.googleapis.com/thing', { hello: 'world' })
    expect(result).toEqual({ created: true })
  })
})

describe('googleErrorMessage', () => {
  it('GoogleReconnectError → reconnect-in-settings message using the given label', () => {
    const err = new GoogleReconnectError(conn, 'revoked')
    expect(googleErrorMessage(err, 'work')).toBe('the work Google account needs reconnecting in Settings → Connections')
  })

  it('404 → the thread/event no longer exists message', () => {
    const err = new GoogleApiError(404, 'Not Found')
    expect(googleErrorMessage(err, 'work')).toBe('that thread/event no longer exists')
  })

  it('other GoogleApiError → Google error <status>: <message>', () => {
    const err = new GoogleApiError(500, 'internal error')
    expect(googleErrorMessage(err, 'work')).toBe('Google error 500: internal error')
  })

  it('a generic error falls back to its own message', () => {
    expect(googleErrorMessage(new Error('boom'), 'work')).toBe('boom')
  })
})
