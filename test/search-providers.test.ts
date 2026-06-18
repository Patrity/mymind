import { describe, it, expect } from 'vitest'
import { normalizeSearxng } from '../server/lib/search/providers/searxng'
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
describe('normalizeBrave', () => {
  it('maps web.results[].{title,url,description} → SearchResult', () => {
    const res = { web: { results: [{ title: 'A', url: 'https://a.com', description: 'd' }] } }
    expect(normalizeBrave(res, 5)).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'd' }])
  })
  it('tolerates missing web/results', () => { expect(normalizeBrave({}, 5)).toEqual([]) })
})
