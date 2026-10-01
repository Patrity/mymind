// askJev's transport contract (cycle 77 fix round 2): every request carries a timeout signal, and a
// non-OK reply throws JevHttpError with the status, so the scorer can tell a bad row from an outage.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { askJev, JevHttpError, JEV_TIMEOUT_MS } from '../server/lib/ai/jev'

const CFG = { baseURL: 'http://jev.invalid', apiKey: 'k', model: 'jev-latest' }

afterEach(() => { vi.unstubAllGlobals() })

describe('askJev', () => {
  it('sends an AbortSignal timeout with every request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1', answers: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    await askJev('state', {}, CFG)
    expect(timeout).toHaveBeenCalledWith(JEV_TIMEOUT_MS)
    expect(JEV_TIMEOUT_MS).toBe(60_000)
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    timeout.mockRestore()
  })

  it('throws JevHttpError carrying the status on a non-OK reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const err = await askJev('state', {}, CFG).catch(e => e)
    expect(err).toBeInstanceOf(JevHttpError)
    expect((err as JevHttpError).status).toBe(404)
  })
})
