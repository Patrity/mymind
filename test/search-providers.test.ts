import { describe, it, expect, vi } from 'vitest'
import { normalizeBrave, braveProvider, parseRetryAfter } from '@mymind/core/lib/search/providers/brave'

describe('normalizeBrave', () => {
  it('maps web.results[].{title,url,description} → SearchResult', () => {
    const res = { web: { results: [{ title: 'A', url: 'https://a.com', description: 'd' }] } }
    expect(normalizeBrave(res, 5)).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'd' }])
  })
  it('tolerates missing web/results', () => { expect(normalizeBrave({}, 5)).toEqual([]) })
})
