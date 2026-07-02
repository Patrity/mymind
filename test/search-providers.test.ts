import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeSearxng, searxngWarning, searxngProvider, resetSearxngState, cacheKey } from '../server/lib/search/providers/searxng'
import { normalizeBrave } from '../server/lib/search/providers/brave'

describe('normalizeSearxng', () => {
  it('maps results[].{title,url,content} → SearchResult and caps count', () => {
    const res = { results: [
      { title: 'A', url: 'https://a.com', content: 'snip a' },
      { title: 'B', url: 'https://b.com', content: 'snip b' },
      { title: 'C', url: 'https://c.com', content: 'snip c' }
    ] }
    expect(normalizeSearxng(res, 2)).toEqual([
      { title: 'A', url: 'https://a.com', snippet: 'snip a' },
      { title: 'B', url: 'https://b.com', snippet: 'snip b' }
    ])
  })
  it('drops results with no url and tolerates missing fields', () => {
    expect(normalizeSearxng({ results: [{ title: 'x' }, { url: 'https://y.com' }] }, 5))
      .toEqual([{ title: '', url: 'https://y.com', snippet: '' }])
    expect(normalizeSearxng({}, 5)).toEqual([])
  })
})
describe('searxngWarning', () => {
  it('warns when results are empty and engines are unresponsive', () => {
    const w = searxngWarning({ results: [], unresponsive_engines: [['brave', 'too many requests'], ['duckduckgo', 'CAPTCHA']] }, 0)
    expect(w).toMatch(/degraded/)
    expect(w).toMatch(/brave: too many requests/)
    expect(w).toMatch(/duckduckgo: CAPTCHA/)
  })
  it('no warning when results exist, even with some engines down', () => {
    expect(searxngWarning({ results: [{ url: 'https://a.com' }], unresponsive_engines: [['brave', 'CAPTCHA']] }, 1)).toBeUndefined()
  })
  it('no warning for a genuinely empty result with healthy engines', () => {
    expect(searxngWarning({ results: [] }, 0)).toBeUndefined()
    expect(searxngWarning({ results: [], unresponsive_engines: [] }, 0)).toBeUndefined()
  })
})

describe('searxng burst protection', () => {
  beforeEach(() => resetSearxngState())

  const okResponse = (results: unknown[]) => ({
    ok: true,
    json: async () => ({ results })
  }) as unknown as Response

  it('serves repeat queries from the cache without re-fetching', async () => {
    const fetchFn = vi.fn(async () => okResponse([{ title: 'A', url: 'https://a.com', content: 's' }]))
    const p = searxngProvider('http://x', { fetchFn, minIntervalMs: 0 })
    const first = await p.search('DDR4 price', { count: 5 })
    const second = await p.search('  ddr4   PRICE ', { count: 5 }) // normalized-identical
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('does NOT cache degraded empty responses (backend may recover)', async () => {
    const degraded = { ok: true, json: async () => ({ results: [], unresponsive_engines: [['brave', 'CAPTCHA']] }) } as unknown as Response
    const fetchFn = vi.fn(async () => degraded)
    const p = searxngProvider('http://x', { fetchFn, minIntervalMs: 0 })
    await p.search('q', { count: 5 })
    await p.search('q', { count: 5 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('paces concurrent outbound requests through the shared gate', async () => {
    const stamps: number[] = []
    const fetchFn = vi.fn(async () => { stamps.push(Date.now()); return okResponse([{ url: 'https://a.com' }]) })
    const p = searxngProvider('http://x', { fetchFn, minIntervalMs: 40 })
    await Promise.all([p.search('one'), p.search('two'), p.search('three')])
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(35)
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(35)
  })

  it('cacheKey normalizes whitespace and case, and keys on count', () => {
    expect(cacheKey('  Foo   BAR ', 5)).toBe('foo bar|5')
    expect(cacheKey('foo bar', 8)).not.toBe(cacheKey('foo bar', 5))
  })
})

describe('normalizeBrave', () => {
  it('maps web.results[].{title,url,description} → SearchResult', () => {
    const res = { web: { results: [{ title: 'A', url: 'https://a.com', description: 'd' }] } }
    expect(normalizeBrave(res, 5)).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'd' }])
  })
  it('tolerates missing web/results', () => { expect(normalizeBrave({}, 5)).toEqual([]) })
})
