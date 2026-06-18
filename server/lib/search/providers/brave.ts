// server/lib/search/providers/brave.ts
import type { SearchProvider, SearchResult } from '../types'

export function normalizeBrave(
  res: { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } },
  count: number
): SearchResult[] {
  return (res.web?.results ?? []).filter(r => r.url).slice(0, count)
    .map(r => ({ title: r.title ?? '', url: r.url as string, snippet: r.description ?? '' }))
}

export function braveProvider(apiKey: string): SearchProvider {
  return {
    async search(query, opts) {
      const count = opts?.count ?? 8
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(count))
      const res = await fetch(url.toString(), {
        headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
      if (!res.ok) throw new Error(`Brave Search error: ${res.status}`)
      const json = await res.json() as { web?: { results?: unknown[] } }
      return normalizeBrave(json as never, count)
    },
  }
}
