import { describe, it, expect, vi } from 'vitest'
import { TokenBucket, SearchBusyError, type LimiterClock } from '@mymind/core/lib/search/limiter'
import { braveProvider, parseRetryAfter } from '@mymind/core/lib/search/providers/brave'
import { normalizeSearchConfig } from '@mymind/core/lib/search/store'

/** Virtual clock: sleep advances time instantly, so we assert on the schedule, not wall time. */
function fakeClock(): LimiterClock & { t: number, maxSleeping: number } {
  const c = {
    t: 0, now: () => c.t, sleeping: 0, maxSleeping: 0,
    sleep: async (ms: number) => {
      if (!(ms > 0)) throw new Error(`non-positive sleep ${ms} (would spin)`)
      c.sleeping++; c.maxSleeping = Math.max(c.maxSleeping, c.sleeping)
      await Promise.resolve()
      c.t += ms; c.sleeping--
    },
  }
  return c
}

describe('TokenBucket', () => {
  it('serves a burst of 3 immediately, then paces at the rate', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(1, 3, clock)
    const stamps: number[] = []
    for (let i = 0; i < 6; i++) { await b.acquire(); stamps.push(clock.t) }
    expect(stamps).toEqual([0, 0, 0, 1000, 2000, 3000])
  })

  it('refills while idle but never beyond the burst', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(1, 3, clock)
    for (let i = 0; i < 3; i++) await b.acquire()
    clock.t += 60_000
    const stamps: number[] = []
    for (let i = 0; i < 4; i++) { await b.acquire(); stamps.push(clock.t) }
    expect(stamps).toEqual([60_000, 60_000, 60_000, 61_000])
  })

  it('queues concurrent callers FIFO', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(1, 1, clock)
    const order: number[] = []
    await Promise.all([0, 1, 2, 3].map(i => b.acquire().then(() => order.push(i))))
    expect(order).toEqual([0, 1, 2, 3])
    expect(clock.t).toBe(3000)
    expect(clock.maxSleeping).toBe(1) // one waiter at a time, no thundering herd
  })

  it('honours a higher rate set at runtime', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(1, 1, clock)
    await b.acquire()
    b.setRate(4)
    await b.acquire()
    expect(clock.t).toBe(250)
  })
})

describe('TokenBucket abort + queue bound', () => {
  it('an aborted waiter never takes a token and frees the queue', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(1, 1, clock)
    await b.acquire()
    const ac = new AbortController()
    const aborted = b.acquire(ac.signal)
    const next = b.acquire()
    ac.abort()
    await expect(aborted).rejects.toThrow()
    await next
    expect(clock.t).toBe(1000) // `next` got the first refilled token; the aborted waiter consumed none
    await b.acquire()
    expect(clock.t).toBe(2000)
  })

  it('rejects at once for an already-aborted signal', async () => {
    const b = new TokenBucket(1, 3, fakeClock())
    const ac = new AbortController(); ac.abort()
    await expect(b.acquire(ac.signal)).rejects.toThrow()
    // no token was taken: the full burst is still available
    const clock = fakeClock(); const b2 = new TokenBucket(1, 3, clock)
    await expect(b2.acquire(ac.signal)).rejects.toThrow()
    for (let i = 0; i < 3; i++) await b2.acquire()
    expect(clock.t).toBe(0)
  })

  it('fails with SearchBusyError instead of waiting past the max queue wait', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(1, 1, clock)
    await b.acquire()
    await expect(b.acquire(undefined, 500)).rejects.toBeInstanceOf(SearchBusyError)
    await expect(b.acquire(undefined, 500)).rejects.toThrow('search busy, try again')
    expect(clock.t).toBe(0) // failed fast, never slept
    await b.acquire(undefined, 1500) // within budget still works
    expect(clock.t).toBe(1000)
  })

  it('a waiter whose turn would land past the deadline times out behind a slow queue', async () => {
    const clock = fakeClock()
    const b = new TokenBucket(0.1, 1, clock) // 10s per token
    await b.acquire()
    await b.acquire(undefined, 60_000) // waits 10s
    await expect(b.acquire(undefined, 5_000)).rejects.toBeInstanceOf(SearchBusyError)
  })
})

describe('parseRetryAfter', () => {
  it('parses delta-seconds, HTTP dates, and rejects junk', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(parseRetryAfter(new Date(1_000).toUTCString(), 4_000)).toBe(0) // date in the past
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })
})

const resp = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
  ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body }) as unknown as Response

describe('braveProvider 429 retry', () => {
  const ok = resp(200, {}, { web: { results: [{ title: 'A', url: 'https://a.com', description: 'd' }] } })
  const deps = () => ({ limiter: { acquire: vi.fn(async () => {}) }, sleep: vi.fn(async () => {}) })

  it('retries after a 429, waiting Retry-After, and takes a token per attempt', async () => {
    const d = deps()
    const fetchFn = vi.fn().mockResolvedValueOnce(resp(429, { 'retry-after': '3' })).mockResolvedValueOnce(ok)
    const r = await braveProvider('k', { fetchFn, ...d }).search('q')
    expect(r.results).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'd' }])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(d.sleep).toHaveBeenCalledWith(3000, undefined)
    expect(d.limiter.acquire).toHaveBeenCalledTimes(2)
  })

  it('falls back to exponential backoff without Retry-After', async () => {
    const d = deps()
    const fetchFn = vi.fn().mockResolvedValueOnce(resp(429)).mockResolvedValueOnce(resp(429)).mockResolvedValueOnce(ok)
    await braveProvider('k', { fetchFn, ...d }).search('q')
    expect(d.sleep.mock.calls.map(c => c[0])).toEqual([1000, 2000])
  })

  it('caps an absurd Retry-After', async () => {
    const d = deps()
    const fetchFn = vi.fn().mockResolvedValueOnce(resp(429, { 'retry-after': '9999' })).mockResolvedValueOnce(ok)
    await braveProvider('k', { fetchFn, ...d }).search('q')
    expect(d.sleep).toHaveBeenCalledWith(30_000, undefined)
  })

  it('gives up after MAX_429_RETRIES and throws', async () => {
    const d = deps()
    const fetchFn = vi.fn(async () => resp(429))
    await expect(braveProvider('k', { fetchFn, ...d }).search('q')).rejects.toThrow('Brave Search error: 429')
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })

  it('does not retry other errors', async () => {
    const d = deps()
    const fetchFn = vi.fn(async () => resp(500))
    await expect(braveProvider('k', { fetchFn, ...d }).search('q')).rejects.toThrow('Brave Search error: 500')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('aborted before the call: no token, no fetch', async () => {
    const ac = new AbortController(); ac.abort()
    const limiter = new TokenBucket(1, 3, fakeClock())
    const acquire = vi.spyOn(limiter, 'acquire')
    const fetchFn = vi.fn()
    await expect(braveProvider('k', { fetchFn, limiter, sleep: vi.fn() }).search('q', { signal: ac.signal })).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledWith(ac.signal)
  })

  it('abort during the Retry-After wait stops at once, with no further fetch', async () => {
    const ac = new AbortController()
    const fetchFn = vi.fn(async () => resp(429, { 'retry-after': '20' }))
    const p = braveProvider('k', { fetchFn, limiter: { acquire: vi.fn(async () => {}) } }).search('q', { signal: ac.signal })
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 30)
    await expect(p).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('gives up with the 429 once the total deadline would be exceeded', async () => {
    let t = 0
    const sleep = vi.fn(async (ms: number) => { t += ms })
    const fetchFn = vi.fn(async () => resp(429, { 'retry-after': '20' }))
    await expect(braveProvider('k', { fetchFn, limiter: { acquire: vi.fn(async () => {}) }, sleep, now: () => t, totalDeadlineMs: 45_000 })
      .search('q')).rejects.toThrow('Brave Search error: 429')
    // 20s + 20s fit in 45s; a third 20s wait does not
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('returns a warning, with no request, when no key is set', async () => {
    const d = deps()
    const fetchFn = vi.fn()
    const r = await braveProvider('', { fetchFn, ...d }).search('q')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(r).toMatchObject({ results: [], warning: expect.stringMatching(/no Brave API key/) })
  })
})

describe('normalizeSearchConfig', () => {
  it('resolves a legacy searxng doc to Brave, dropping the url and keeping the key', () => {
    const c = normalizeSearchConfig({ provider: 'searxng', searxngUrl: 'http://searxng:8080', braveApiKeyEnc: 'enc' })
    expect(c).toEqual({ provider: 'brave', braveApiKeyEnc: 'enc', braveQps: 1 })
  })
  it('defaults when there is no stored doc, and validates qps', () => {
    expect(normalizeSearchConfig(undefined)).toEqual({ provider: 'brave', braveQps: 1 })
    expect(normalizeSearchConfig({}, 2)).toMatchObject({ braveQps: 2 })
    for (const bad of [0, -1, 51, NaN, '2', null]) expect(normalizeSearchConfig({}, bad).braveQps).toBe(1)
  })
})
