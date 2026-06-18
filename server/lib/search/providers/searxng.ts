// server/lib/search/providers/searxng.ts
import type { SearchProvider, SearchResult } from '../types'

export function normalizeSearxng(
  res: { results?: Array<{ title?: string; url?: string; content?: string }> },
  count: number
): SearchResult[] {
  return (res.results ?? []).filter(r => r.url).slice(0, count)
    .map(r => ({ title: r.title ?? '', url: r.url as string, snippet: r.content ?? '' }))
}

export function searxngProvider(baseUrl: string): SearchProvider {
  return {
    async search(query, opts) {
      const url = new URL('/search', baseUrl)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`SearXNG error: ${res.status}`)
      const json = await res.json() as { results?: unknown[] }
      return normalizeSearxng(json as never, opts?.count ?? 8)
    },
  }
}
