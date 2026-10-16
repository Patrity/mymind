// server/lib/search/providers/brave.ts
import type { SearchProvider, SearchResult } from '../types'
import { braveLimiter, raceAbort, type TokenBucket } from '../limiter'

export function normalizeBrave(
  res: { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } },
  count: number
): SearchResult[] {
  return (res.web?.results ?? []).filter(r => r.url).slice(0, count)
    .map(r => ({ title: r.title ?? '', url: r.url as string, snippet: r.description ?? '' }))
}

export const MAX_429_RETRIES = 3
const BACKOFF_BASE_MS = 1000
const MAX_WAIT_MS = 30_000
export const TOTAL_DEADLINE_MS = 45_000

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  let t: ReturnType<typeof setTimeout>
  return raceAbort(new Promise<void>(r => { t = setTimeout(r, ms) }), signal).finally(() => clearTimeout(t))
}

/** Retry-After is delta-seconds or an HTTP date; returns ms, or null when absent/unparseable. */
export function parseRetryAfter(h: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!h) return null
  const s = h.trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs)
}

export interface BraveOpts {
  fetchFn?: typeof fetch
  limiter?: Pick<TokenBucket, 'acquire'>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  totalDeadlineMs?: number
}

export function braveProvider(apiKey: string, o: BraveOpts = {}): SearchProvider {
  const fetchFn = o.fetchFn ?? fetch
  const limiter = o.limiter ?? braveLimiter
  const sleep = o.sleep ?? abortableSleep
  const now = o.now ?? Date.now
  const totalDeadline = o.totalDeadlineMs ?? TOTAL_DEADLINE_MS
  return {
    async search(query, opts) {
      if (!apiKey) {
        return { results: [], warning: 'web search is not configured: no Brave API key is set (Settings → Search). Empty results do NOT mean the information does not exist.' }
      }
      const count = opts?.count ?? 8
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(count))
      const signal = opts?.signal
      const deadline = now() + totalDeadline
      for (let attempt = 0; ; attempt++) {
        await limiter.acquire(signal)
        const res = await fetchFn(url.toString(), {
          headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
          signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
          redirect: 'error',
        })
        if (res.status === 429 && attempt < MAX_429_RETRIES) {
          const wait = parseRetryAfter(res.headers?.get('retry-after')) ?? BACKOFF_BASE_MS * 2 ** attempt
          const pause = Math.min(wait, MAX_WAIT_MS)
          // Give up rather than sleep past the total budget for this tool call.
          if (now() + pause <= deadline) {
            await sleep(pause, signal)
            continue
          }
        }
        if (!res.ok) throw new Error(`Brave Search error: ${res.status}`)
        const json = await res.json() as { web?: { results?: unknown[] } }
        return { results: normalizeBrave(json as never, count) }
      }
    },
  }
}
