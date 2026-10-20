// Stack review 2026-10-19 (D1): the write-time secret gate must fail OPEN within 1.5 s, so askJev
// takes a per-call `timeoutMs` (default unchanged — the 60 s scorer contract in jev-client.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { askJev, JEV_TIMEOUT_MS } from '@mymind/core/lib/ai/jev'

const CFG = { baseURL: 'http://jev.invalid', apiKey: 'k', model: 'clef-flash' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('askJev timeoutMs', () => {
  it('uses the caller-supplied timeout for the request signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'clef-flash', answers: {} }), { status: 200 })))
    await askJev('state', {}, CFG, { timeoutMs: 1500 })
    expect(timeout).toHaveBeenCalledWith(1500)
    expect(timeout).not.toHaveBeenCalledWith(JEV_TIMEOUT_MS)
  })

  // D3 A2: the 429 loop (up to 5 retries, 0.5 + 1 + 2 + 4 + 8 s back-off, each with its own
  // fresh timeout) defeated the gate's 1.5 s fail-open budget. `maxAttempts: 1` disables it.
  it('does not retry a 429 when maxAttempts is 1 — throws JevHttpError(429) after one fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '5' } }))
    vi.stubGlobal('fetch', fetchMock)
    const started = Date.now()
    await expect(askJev('state', {}, CFG, { timeoutMs: 1500, maxAttempts: 1 }))
      .rejects.toMatchObject({ name: 'JevHttpError', status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('still retries a 429 by default (the scorer contract)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: 'clef-flash', answers: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const p = askJev('state', {}, CFG)
    await vi.advanceTimersByTimeAsync(600)
    await expect(p).resolves.toMatchObject({ model: 'clef-flash' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('keeps the default timeout when none is given', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'clef-flash', answers: {} }), { status: 200 })))
    await askJev('state', {}, CFG)
    expect(timeout).toHaveBeenCalledWith(JEV_TIMEOUT_MS)
  })
})
