import { describe, it, expect } from 'vitest'
import { normalizeSearxng, searxngWarning } from '../server/lib/search/providers/searxng'
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

describe('normalizeBrave', () => {
  it('maps web.results[].{title,url,description} → SearchResult', () => {
    const res = { web: { results: [{ title: 'A', url: 'https://a.com', description: 'd' }] } }
    expect(normalizeBrave(res, 5)).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'd' }])
  })
  it('tolerates missing web/results', () => { expect(normalizeBrave({}, 5)).toEqual([]) })
})
