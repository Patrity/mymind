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

// ---------------------------------------------------------------------------
// Burst protection — the agent DoS'd its own backend (32 searches in <4 min
// benched every upstream engine). Two module-level guards shared by all
// provider instances:
//   1. TTL cache: repeat/near-duplicate queries return the cached response
//      without touching SearXNG at all.
//   2. Pacing gate: outbound requests are serialized with a minimum interval,
//      so parallel tool-call batches reach the engines as a slow stream.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10 * 60_000
const MIN_INTERVAL_MS = 1100

const cache = new Map<string, { at: number; res: SearchResponse }>()
let gate: Promise<void> = Promise.resolve()
let lastRequestAt = 0

/** Test hook: clear cache + pacing state. */
export function resetSearxngState(): void {
  cache.clear()
  gate = Promise.resolve()
  lastRequestAt = 0
}

export function cacheKey(query: string, count: number): string {
  return `${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${count}`
}

function paced<T>(fn: () => Promise<T>, minIntervalMs: number): Promise<T> {
  const run = gate.then(async () => {
    const wait = lastRequestAt + minIntervalMs - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastRequestAt = Date.now()
    return fn()
  })
  gate = run.then(() => undefined, () => undefined)
  return run
}

export interface SearxngOpts {
  fetchFn?: typeof fetch
  minIntervalMs?: number
  cacheTtlMs?: number
}

export function searxngProvider(baseUrl: string, o: SearxngOpts = {}): SearchProvider {
  const fetchFn = o.fetchFn ?? fetch
  const minInterval = o.minIntervalMs ?? MIN_INTERVAL_MS
  const ttl = o.cacheTtlMs ?? CACHE_TTL_MS
  return {
    async search(query, opts): Promise<SearchResponse> {
      const count = opts?.count ?? 8
      const key = cacheKey(query, count)
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < ttl) return hit.res
      return paced(async () => {
        // Re-check after waiting in the gate — a parallel identical query may
        // have just populated the cache.
        const again = cache.get(key)
        if (again && Date.now() - again.at < ttl) return again.res
        const url = new URL('/search', baseUrl)
        url.searchParams.set('q', query)
        url.searchParams.set('format', 'json')
        const res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(10_000), redirect: 'error' })
        if (!res.ok) throw new Error(`SearXNG error: ${res.status}`)
        const json = await res.json() as SearxngRaw
        const results = normalizeSearxng(json, count)
        const response: SearchResponse = { results, warning: searxngWarning(json, results.length) }
        // Don't cache degraded empties — the backend may recover within the TTL.
        if (!response.warning) cache.set(key, { at: Date.now(), res: response })
        return response
      }, minInterval)
    },
  }
}
