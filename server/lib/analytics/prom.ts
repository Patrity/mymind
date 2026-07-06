// server/lib/analytics/prom.ts
// Prometheus HTTP API client + pure response transforms.
// The ONLY module that talks to Prometheus. 5s timeout; callers map errors to 502.
import type { RangeKey, Series } from '../../../shared/types/analytics'

// `$fetch` is Nitro's ambient global (ofetch) — used bare here exactly like
// server/lib/imagegen/comfy.ts / server/lib/ai/embeddings.ts. Do NOT
// `declare const $fetch` (clashes with the ambient global type). Tests stub
// it via vi.stubGlobal('$fetch', ...).

export interface PromVectorResult { metric: Record<string, string>, value: [number, string] }
export interface PromMatrixResult { metric: Record<string, string>, values: [number, string][] }

const RANGE_SECONDS: Record<RangeKey, number> = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400 }
const STEP: Record<RangeKey, number> = { '1h': 30, '6h': 120, '24h': 300, '7d': 3600 }
const WINDOW: Record<RangeKey, string> = { '1h': '2m', '6h': '10m', '24h': '30m', '7d': '3h' }

export function rangeSeconds(range: RangeKey): number { return RANGE_SECONDS[range] }
export function stepForRange(range: RangeKey): number { return STEP[range] }
export function windowForRange(range: RangeKey): string { return WINDOW[range] }

export function toSeries(result: PromMatrixResult[], legend: (labels: Record<string, string>) => string): Series[] {
  return result.map(r => ({
    name: legend(r.metric),
    points: r.values.map(([t, v]) => {
      const n = parseFloat(v)
      return { t: t * 1000, v: Number.isFinite(n) ? n : null }
    }),
  }))
}

interface PromResponse<T> { status: 'success' | 'error', data: { resultType: string, result: T }, error?: string }

export async function promInstant(baseUrl: string, expr: string): Promise<PromVectorResult[]> {
  const res = await $fetch<PromResponse<PromVectorResult[]>>(`${baseUrl}/api/v1/query`, {
    query: { query: expr },
    timeout: 5000,
  })
  if (res.status !== 'success') throw new Error(res.error ?? 'prometheus query failed')
  return res.data.result
}

export async function promRange(baseUrl: string, expr: string, range: RangeKey, nowMs = Date.now()): Promise<PromMatrixResult[]> {
  const end = Math.floor(nowMs / 1000)
  const start = end - rangeSeconds(range)
  const res = await $fetch<PromResponse<PromMatrixResult[]>>(`${baseUrl}/api/v1/query_range`, {
    query: { query: expr, start, end, step: stepForRange(range) },
    timeout: 5000,
  })
  if (res.status !== 'success') throw new Error(res.error ?? 'prometheus query failed')
  return res.data.result
}
