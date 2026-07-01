// server/lib/search/providers/searxng.ts
import type { SearchProvider, SearchResponse, SearchResult } from '../types'

interface SearxngRaw {
  results?: Array<{ title?: string; url?: string; content?: string }>
  unresponsive_engines?: Array<[string, string]>
}

export function normalizeSearxng(res: SearxngRaw, count: number): SearchResult[] {
  return (res.results ?? []).filter(r => r.url).slice(0, count)
    .map(r => ({ title: r.title ?? '', url: r.url as string, snippet: r.content ?? '' }))
}

/** Empty results + every engine down = the BACKEND is degraded, not "no matches".
 *  Surfacing this lets the model report an outage instead of concluding the
 *  information doesn't exist (live incident: rapid-fire agent queries rate-limited
 *  brave/ddg/startpage → 25 searches all returned [] with no signal why). */
export function searxngWarning(res: SearxngRaw, resultCount: number): string | undefined {
  const down = res.unresponsive_engines ?? []
  if (resultCount > 0 || down.length === 0) return undefined
  const detail = down.map(([engine, reason]) => `${engine}: ${reason}`).join(', ')
  return `search backend degraded — all engines unresponsive (${detail}); empty results do NOT mean the information doesn't exist`
}

export function searxngProvider(baseUrl: string): SearchProvider {
  return {
    async search(query, opts): Promise<SearchResponse> {
      const url = new URL('/search', baseUrl)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000), redirect: 'error' })
      if (!res.ok) throw new Error(`SearXNG error: ${res.status}`)
      const json = await res.json() as SearxngRaw
      const results = normalizeSearxng(json, opts?.count ?? 8)
      return { results, warning: searxngWarning(json, results.length) }
    },
  }
}
