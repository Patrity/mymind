# Local AI Analytics (`/analytics`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, Grafana-style `/analytics` page in MyMind showing GPU telemetry, inference-engine stats, LiteLLM spend/usage, and a live request log — all sourced from the existing homelab Prometheus and LiteLLM admin API.

**Architecture:** Server-side named PromQL query catalog + three session-gated Nitro endpoints (`snapshot`/`series`/`requests`); an `analytics_config` settings doc (encrypted LiteLLM master key) mirroring the search/imagegen store pattern; Unovis charts + vue-query polling on the client. No SSE (external data), no new collectors, no migration.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle (existing `settings` table), zod, `@tanstack/vue-query`, Unovis (`@unovis/vue` + `@unovis/ts`), Nuxt UI v4, vitest, playwright-cli.

**Spec:** `docs/superpowers/specs/2026-07-06-local-ai-analytics-design.md`

## Global Constraints

- **pnpm only** (never npm/yarn). Run from repo root.
- Branch: `feat/local-ai-analytics` (worktree isolation via superpowers:using-git-worktrees at execution time).
- **NO `publishChange`/SSE wiring for analytics data** — this is external data; polling via vue-query is the design. The live-data rule's server-write half does not apply (no analytics DB writes except the settings doc, which needs no live event — existing settings tabs don't emit either).
- Client reads use `@tanstack/vue-query` per `.claude/rules/live-data.md` (keys `['analytics', ...]`).
- Nuxt UI v4 components + **semantic color tokens only** (`primary`, `error`, `text-muted`, `bg-elevated`, …) — never raw palette classes. Invoke `nuxt-ui-docs` before using unfamiliar components.
- **Invoke the `dataviz` skill before writing any chart component** (Task 9).
- Browser validation with **playwright-cli** via the `browser-testing` skill — never the Playwright MCP.
- All server-side upstream fetches: 5000 ms timeout (`$fetch(url, { timeout: 5000 })`), failures mapped to HTTP 502.
- Auth: `server/middleware/auth.ts` already gates ALL `/api/**` routes (session or bearer). Add no per-route auth.
- Secrets encrypted with the existing `encryptSecret`/`decryptSecret` from `server/lib/ai/registry/crypto.ts`. The master key is never returned by any GET.
- Gates before finishing: `pnpm typecheck` · `pnpm test` · `pnpm build` all green.
- Lint is red repo-wide and is NOT a gate (per project memory).

## Verified infrastructure facts (do not re-derive)

- Prometheus 3.7.3: `http://192.168.2.90:9090` (Dell **LXC 111**). No auth on LAN.
- LiteLLM admin API: `http://192.168.2.85:4000` (Dell LXC 310).
- Scrape jobs (label `job`): `nvidia-gpu` (192.168.2.25:9835), `vllm-coder` (:8004), `tei` (:8882), `llama-cpp-autocomplete` (:8001), `litellm` (192.168.2.85:9090), `node-ai-rig`, `postgres`, `prometheus`, `blackbox-http` (probes incl. `https://lite.costanzoclan.com` and `http://192.168.2.25:8883/health`). **`vllm-vision` (:8005) missing — added in Task 11.**
- nvidia_gpu_exporter metric names (label `uuid`, lowercase, no `GPU-` prefix): `nvidia_smi_utilization_gpu_ratio` (0–1), `nvidia_smi_memory_used_bytes`, `nvidia_smi_memory_total_bytes`, `nvidia_smi_temperature_gpu`, `nvidia_smi_power_draw_watts`, `nvidia_smi_enforced_power_limit_watts`, `nvidia_smi_gpu_info` (labels `uuid`, `name`).
- vLLM metric names (labels `model_name`, `engine`): `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:prompt_tokens_total`, `vllm:generation_tokens_total`, `vllm:time_to_first_token_seconds_bucket`, `vllm:kv_cache_usage_perc` (0–1).
- TEI: `te_embed_count` (counter).
- litellm-exporter (label `model`): `litellm_requests_total`, `litellm_total_tokens`, `litellm_prompt_tokens`, `litellm_completion_tokens`, `litellm_total_spend` (cumulative USD), `litellm_cache_hits_total`, `litellm_cache_misses_total`.
- GPU UUID seed map (24h-VRAM + power-limit verified 2026-07-06; **editable in settings, confirm at acceptance**):
  - `24d1cd2c-76e0-8a7a-66be-48dc43b0e4ac` → `Coder A (Strix)` (390 W default)
  - `875c12f4-d03b-89ac-528d-57d15bee97bb` → `Coder B (Strix)` (390 W default)
  - `2035bb42-d953-83d3-eb4f-5cb8214873dd` → `Vision (PNY)` (steady ~23.7 GB = vLLM prealloc)
  - `0cbf708d-6235-18d7-8bd2-eaeea0389254` → `Zotac (voice/util)` (near-idle at survey time — flag to Tony)
  - `bbd65887-973e-4982-ced8-2ba8dcd3586d` → `Autocomplete (P2000)` (75 W, 5.4 GB)

## File Structure

```
server/lib/analytics/
  types.ts          # AnalyticsConfig + all response DTOs (shared shapes, no logic)
  store.ts          # analytics_config settings-doc store (mirrors imagegen/search store)
  prom.ts           # Prometheus HTTP client + pure transforms (step/window/toSeries)
  queries.ts        # THE named query catalog (snapshot set + range panels)
  snapshot.ts       # pure buildSnapshot() assembler
  litellm.ts        # /spend/logs fetcher + pure row normalizer
server/api/analytics/
  snapshot.get.ts   # thin: config → catalog → prom → buildSnapshot
  series.get.ts     # thin: validate panel/range → prom range → series
  requests.get.ts   # thin: config → litellm.ts → rows
server/api/settings/
  analytics-config.get.ts   # redacted config (hasLitellmKey)
  analytics-config.put.ts   # validate + probe prometheus + save
app/composables/useAnalytics.ts        # vue-query hooks (snapshot/series/requests/config)
app/utils/analytics-pivot.ts           # pure: Series[] → Unovis row objects
app/components/analytics/
  HealthStrip.vue   # service up/down chips
  GpuTiles.vue      # per-GPU current-state cards
  TimeSeriesChart.vue  # generic Unovis time-series wrapper
  RequestLogTable.vue  # paginated LiteLLM request log
app/components/settings/AnalyticsTab.vue
app/pages/analytics.vue
app/pages/settings/analytics.vue
app/layouts/default.vue                # + nav entries (main item + settings child)
test/analytics-store.test.ts
test/analytics-prom.test.ts
test/analytics-queries.test.ts
test/analytics-snapshot.test.ts
test/analytics-litellm.test.ts
test/analytics-pivot.test.ts
```

---

### Task 1: Analytics config types + store

**Files:**
- Create: `server/lib/analytics/types.ts`
- Create: `server/lib/analytics/store.ts`
- Test: `test/analytics-store.test.ts`

**Interfaces:**
- Consumes: `settings` table (`server/db/schema`), `encryptSecret` (`server/lib/ai/registry/crypto`), `useDb` (`server/db`).
- Produces: `AnalyticsConfig`, `RangeKey`, `RANGE_KEYS`, `Series`, `SeriesPoint`, `SeriesResponse`, `GpuSnapshot`, `ServiceHealth`, `EngineSnapshot`, `SnapshotResponse`, `RequestLogRow`, `RequestLogResponse` (types.ts); `defaultAnalyticsConfig()`, `mergeAnalyticsConfig(raw)`, `analyticsConfigInputSchema`, `parseAnalyticsConfigInput(raw)`, `loadAnalyticsConfig()`, `saveAnalyticsConfig(input)`, `invalidateAnalyticsConfig()` (store.ts).

- [ ] **Step 1: Write types.ts** (no test — pure declarations)

```ts
// server/lib/analytics/types.ts
// Shared shapes for the /analytics slice. No logic here.

export interface AnalyticsConfig {
  prometheusUrl: string
  litellmUrl: string
  /** AES-256-GCM blob via encryptSecret(); never leaves the server. */
  litellmMasterKeyEnc?: string
  /** GPU uuid (lowercase, no "GPU-" prefix) -> friendly label. */
  gpuLabels: Record<string, string>
}

export const RANGE_KEYS = ['1h', '6h', '24h', '7d'] as const
export type RangeKey = typeof RANGE_KEYS[number]

export interface SeriesPoint { t: number, v: number | null } // t = epoch ms
export interface Series { name: string, points: SeriesPoint[] }
export interface SeriesResponse { panel: string, range: RangeKey, series: Series[] }

export interface GpuSnapshot {
  uuid: string
  label: string
  utilPct: number | null
  vramUsedBytes: number | null
  vramTotalBytes: number | null
  tempC: number | null
  powerW: number | null
  powerLimitW: number | null
}

export interface ServiceHealth { id: string, label: string, up: boolean | null } // null = no data
export interface EngineSnapshot { model: string, running: number, waiting: number }

export interface SnapshotResponse {
  gpus: GpuSnapshot[]
  services: ServiceHealth[]
  engines: EngineSnapshot[]
  spendByModel: { model: string, usd: number }[]
}

export interface RequestLogRow {
  id: string
  startedAt: string          // ISO
  model: string
  promptTokens: number | null
  completionTokens: number | null
  latencyMs: number | null
  spendUsd: number | null
  keyAlias: string | null
  cacheHit: boolean | null
  status: 'success' | 'failure' | null
}

export interface RequestLogResponse {
  rows: RequestLogRow[]
  page: number
  pageSize: number
  totalPages: number | null  // null when upstream doesn't report it
}
```

- [ ] **Step 2: Write the failing store tests**

```ts
// test/analytics-store.test.ts
import { describe, it, expect } from 'vitest'
import { defaultAnalyticsConfig, mergeAnalyticsConfig, parseAnalyticsConfigInput } from '../server/lib/analytics/store'

describe('analytics config store (pure parts)', () => {
  it('defaults point at the known homelab endpoints', () => {
    const d = defaultAnalyticsConfig()
    expect(d.prometheusUrl).toBe('http://192.168.2.90:9090')
    expect(d.litellmUrl).toBe('http://192.168.2.85:4000')
    expect(Object.keys(d.gpuLabels)).toHaveLength(5)
    expect(d.litellmMasterKeyEnc).toBeUndefined()
  })

  it('merge overlays stored values onto defaults and keeps unknown gpu labels', () => {
    const m = mergeAnalyticsConfig({ prometheusUrl: 'http://x:1', gpuLabels: { abc: 'My GPU' } })
    expect(m.prometheusUrl).toBe('http://x:1')
    expect(m.litellmUrl).toBe('http://192.168.2.85:4000')
    expect(m.gpuLabels).toEqual({ abc: 'My GPU' }) // stored map replaces default map wholesale
  })

  it('merge of null/undefined returns pure defaults', () => {
    expect(mergeAnalyticsConfig(null)).toEqual(defaultAnalyticsConfig())
    expect(mergeAnalyticsConfig(undefined)).toEqual(defaultAnalyticsConfig())
  })

  it('input schema rejects a non-URL prometheusUrl', () => {
    expect(() => parseAnalyticsConfigInput({ prometheusUrl: 'not a url' })).toThrow()
  })

  it('input schema accepts a partial patch and passes litellmMasterKey through', () => {
    const p = parseAnalyticsConfigInput({ litellmMasterKey: 'sk-1234' })
    expect(p).toEqual({ litellmMasterKey: 'sk-1234' })
  })

  it('input schema trims empty master key to undefined (means "no change")', () => {
    const p = parseAnalyticsConfigInput({ litellmMasterKey: '   ' })
    expect(p.litellmMasterKey).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run test/analytics-store.test.ts`
Expected: FAIL — cannot resolve `../server/lib/analytics/store`.

- [ ] **Step 4: Implement store.ts**

```ts
// server/lib/analytics/store.ts
// Thin DB I/O for the single analytics_config JSONB row + an in-process cache.
// Mirrors server/lib/imagegen/store.ts / server/lib/search/store.ts.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret } from '../ai/registry/crypto'
import type { AnalyticsConfig } from './types'

const KEY = 'analytics_config'
let cache: AnalyticsConfig | null = null

export function defaultAnalyticsConfig(): AnalyticsConfig {
  return {
    prometheusUrl: 'http://192.168.2.90:9090',
    litellmUrl: 'http://192.168.2.85:4000',
    gpuLabels: {
      '24d1cd2c-76e0-8a7a-66be-48dc43b0e4ac': 'Coder A (Strix)',
      '875c12f4-d03b-89ac-528d-57d15bee97bb': 'Coder B (Strix)',
      '2035bb42-d953-83d3-eb4f-5cb8214873dd': 'Vision (PNY)',
      '0cbf708d-6235-18d7-8bd2-eaeea0389254': 'Zotac (voice/util)',
      'bbd65887-973e-4982-ced8-2ba8dcd3586d': 'Autocomplete (P2000)',
    },
  }
}

export function mergeAnalyticsConfig(raw: Partial<AnalyticsConfig> | null | undefined): AnalyticsConfig {
  return { ...defaultAnalyticsConfig(), ...(raw ?? {}) }
}

// Empty-string master key -> undefined ("no change"); non-empty is the new plaintext key.
const masterKeySchema = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional()
)

export const analyticsConfigInputSchema = z.object({
  prometheusUrl: z.string().url().optional(),
  litellmUrl: z.string().url().optional(),
  litellmMasterKey: masterKeySchema,
  gpuLabels: z.record(z.string(), z.string()).optional(),
})
export type AnalyticsConfigInput = z.infer<typeof analyticsConfigInputSchema>

export function parseAnalyticsConfigInput(raw: unknown): AnalyticsConfigInput {
  return analyticsConfigInputSchema.parse(raw)
}

export async function loadAnalyticsConfig(): Promise<AnalyticsConfig> {
  if (cache) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = mergeAnalyticsConfig(row?.value as Partial<AnalyticsConfig> | undefined)
  return cache
}

export async function saveAnalyticsConfig(input: AnalyticsConfigInput): Promise<AnalyticsConfig> {
  const current = await loadAnalyticsConfig()
  const next: AnalyticsConfig = {
    prometheusUrl: input.prometheusUrl ?? current.prometheusUrl,
    litellmUrl: input.litellmUrl ?? current.litellmUrl,
    litellmMasterKeyEnc: current.litellmMasterKeyEnc,
    gpuLabels: input.gpuLabels ?? current.gpuLabels,
  }
  if (input.litellmMasterKey) next.litellmMasterKeyEnc = encryptSecret(input.litellmMasterKey)
  await useDb().insert(settings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache = next
  return next
}

export function invalidateAnalyticsConfig(): void { cache = null }
```

Note: if the vitest run fails because importing `store.ts` pulls in `useDb`→DB env at module load, mirror how existing tests handle it (check `test/` for an existing store test); the exported pure functions must stay importable without a live DB. If needed, move `defaultAnalyticsConfig`/`mergeAnalyticsConfig`/schema into `types.ts`-adjacent pure module `server/lib/analytics/config.ts` and re-export from `store.ts` — keep test imports pointing at the pure module.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm vitest run test/analytics-store.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add server/lib/analytics/types.ts server/lib/analytics/store.ts test/analytics-store.test.ts
git commit -m "feat(analytics): config types + analytics_config settings store"
```

---

### Task 2: Prometheus client + pure transforms

**Files:**
- Create: `server/lib/analytics/prom.ts`
- Test: `test/analytics-prom.test.ts`

**Interfaces:**
- Consumes: `RangeKey`, `Series` from `./types`.
- Produces:
  - `stepForRange(range: RangeKey): number` (seconds)
  - `windowForRange(range: RangeKey): string` (PromQL duration for rate/increase, e.g. `'2m'`)
  - `rangeSeconds(range: RangeKey): number`
  - `toSeries(result: PromMatrixResult[], legend: (labels: Record<string, string>) => string): Series[]`
  - `promInstant(baseUrl: string, expr: string): Promise<PromVectorResult[]>`
  - `promRange(baseUrl: string, expr: string, range: RangeKey, nowMs?: number): Promise<PromMatrixResult[]>`
  - `export interface PromVectorResult { metric: Record<string, string>, value: [number, string] }`
  - `export interface PromMatrixResult { metric: Record<string, string>, values: [number, string][] }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/analytics-prom.test.ts
import { describe, it, expect } from 'vitest'
import { stepForRange, windowForRange, rangeSeconds, toSeries } from '../server/lib/analytics/prom'

describe('prom range math', () => {
  it('steps target 120-300 points per range', () => {
    expect(stepForRange('1h')).toBe(30)
    expect(stepForRange('6h')).toBe(120)
    expect(stepForRange('24h')).toBe(300)
    expect(stepForRange('7d')).toBe(3600)
  })
  it('windows are >= 2x step (rate() needs >= 2 samples)', () => {
    expect(windowForRange('1h')).toBe('2m')
    expect(windowForRange('6h')).toBe('10m')
    expect(windowForRange('24h')).toBe('30m')
    expect(windowForRange('7d')).toBe('3h')
  })
  it('rangeSeconds maps keys', () => {
    expect(rangeSeconds('1h')).toBe(3600)
    expect(rangeSeconds('7d')).toBe(7 * 86400)
  })
})

describe('toSeries', () => {
  const matrix = [
    { metric: { uuid: 'abc', job: 'nvidia-gpu' }, values: [[1751800000, '42.5'], [1751800030, 'NaN']] as [number, string][] },
    { metric: { uuid: 'def', job: 'nvidia-gpu' }, values: [[1751800000, '7']] as [number, string][] },
  ]
  it('maps each result to a named series with epoch-ms points, NaN -> null', () => {
    const s = toSeries(matrix, m => m.uuid ?? '?')
    expect(s).toEqual([
      { name: 'abc', points: [{ t: 1751800000000, v: 42.5 }, { t: 1751800030000, v: null }] },
      { name: 'def', points: [{ t: 1751800000000, v: 7 }] },
    ])
  })
  it('handles empty input', () => {
    expect(toSeries([], () => 'x')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/analytics-prom.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement prom.ts**

```ts
// server/lib/analytics/prom.ts
// Prometheus HTTP API client + pure response transforms.
// The ONLY module that talks to Prometheus. 5s timeout; callers map errors to 502.
import type { RangeKey, Series } from './types'

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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run test/analytics-prom.test.ts`
Expected: 5 passed. (If `$fetch` is undefined at import time in vitest, import it explicitly: `import { $fetch } from 'ofetch'` — check how other `server/lib` modules that use `$fetch` do it, e.g. `grep -rn "from 'ofetch'" server/lib | head`.)

- [ ] **Step 5: Commit**

```bash
git add server/lib/analytics/prom.ts test/analytics-prom.test.ts
git commit -m "feat(analytics): prometheus client + range/step/series transforms"
```

---

### Task 3: Named query catalog

**Files:**
- Create: `server/lib/analytics/queries.ts`
- Test: `test/analytics-queries.test.ts`

**Interfaces:**
- Consumes: `windowForRange` (`./prom`), `RangeKey` (`./types`).
- Produces:
  - `interface RangeQueryDef { expr: (window: string) => string, legend: (labels: Record<string, string>, gpuLabels: Record<string, string>) => string }`
  - `interface RangePanelDef { id: string, queries: RangeQueryDef[] }`
  - `RANGE_PANELS: Record<string, RangePanelDef>` — panel ids: `gpu-util`, `gpu-vram`, `gpu-power`, `gpu-temp`, `vllm-requests`, `vllm-throughput`, `vllm-ttft`, `vllm-kv-cache`, `tei-rate`, `litellm-requests`, `litellm-tokens`, `litellm-spend`, `litellm-cache-ratio`
  - `SNAPSHOT_QUERIES: Record<SnapshotQueryId, string>` with `type SnapshotQueryId = 'gpuInfo' | 'gpuUtil' | 'gpuMemUsed' | 'gpuMemTotal' | 'gpuTemp' | 'gpuPower' | 'gpuPowerLimit' | 'engineRunning' | 'engineWaiting' | 'up' | 'probes' | 'spend'`
  - `resolveGpuLabel(uuid: string, gpuLabels: Record<string, string>): string`

- [ ] **Step 1: Write the failing tests**

```ts
// test/analytics-queries.test.ts
import { describe, it, expect } from 'vitest'
import { RANGE_PANELS, SNAPSHOT_QUERIES, resolveGpuLabel } from '../server/lib/analytics/queries'

const GPU_LABELS = { 'abc-123': 'Vision (PNY)' }

describe('query catalog', () => {
  it('contains exactly the 13 spec panels', () => {
    expect(Object.keys(RANGE_PANELS).sort()).toEqual([
      'gpu-power', 'gpu-temp', 'gpu-util', 'gpu-vram',
      'litellm-cache-ratio', 'litellm-requests', 'litellm-spend', 'litellm-tokens',
      'tei-rate', 'vllm-kv-cache', 'vllm-requests', 'vllm-throughput', 'vllm-ttft',
    ])
  })

  it('every panel produces non-empty PromQL for a window and a legend for empty labels', () => {
    for (const p of Object.values(RANGE_PANELS)) {
      expect(p.id).toBeTruthy()
      expect(p.queries.length).toBeGreaterThan(0)
      for (const q of p.queries) {
        expect(q.expr('5m')).toMatch(/\S/)
        expect(typeof q.legend({}, {})).toBe('string')
      }
    }
  })

  it('gpu panels legend via the gpuLabels map, falling back to short uuid', () => {
    const q = RANGE_PANELS['gpu-util']!.queries[0]!
    expect(q.legend({ uuid: 'abc-123' }, GPU_LABELS)).toBe('Vision (PNY)')
    expect(q.legend({ uuid: 'ffffeeee-1234' }, GPU_LABELS)).toBe('GPU ffffeeee')
  })

  it('rate-based exprs interpolate the window', () => {
    expect(RANGE_PANELS['vllm-throughput']!.queries[0]!.expr('7m')).toContain('[7m]')
  })

  it('snapshot set covers gpu/engine/up/probe/spend', () => {
    expect(Object.keys(SNAPSHOT_QUERIES).sort()).toEqual([
      'engineRunning', 'engineWaiting', 'gpuInfo', 'gpuMemTotal', 'gpuMemUsed',
      'gpuPower', 'gpuPowerLimit', 'gpuTemp', 'gpuUtil', 'probes', 'spend', 'up',
    ])
  })

  it('resolveGpuLabel falls back to shortened uuid', () => {
    expect(resolveGpuLabel('abc-123', GPU_LABELS)).toBe('Vision (PNY)')
    expect(resolveGpuLabel('deadbeef-cafe', {})).toBe('GPU deadbeef')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/analytics-queries.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement queries.ts**

```ts
// server/lib/analytics/queries.ts
// THE named query catalog — the security boundary. Endpoints only ever execute
// PromQL defined here; the client can only name a panel id.
// Metric names verified live against the homelab exporters on 2026-07-06.

export interface RangeQueryDef {
  expr: (window: string) => string
  legend: (labels: Record<string, string>, gpuLabels: Record<string, string>) => string
}
export interface RangePanelDef { id: string, queries: RangeQueryDef[] }

export function resolveGpuLabel(uuid: string, gpuLabels: Record<string, string>): string {
  return gpuLabels[uuid] ?? `GPU ${uuid.slice(0, 8)}`
}

const gpuLegend: RangeQueryDef['legend'] = (l, g) => resolveGpuLabel(l.uuid ?? '?', g)
const modelLegend: RangeQueryDef['legend'] = l => l.model_name ?? l.model ?? '?'

export const RANGE_PANELS: Record<string, RangePanelDef> = {
  'gpu-util': { id: 'gpu-util', queries: [{ expr: () => 'nvidia_smi_utilization_gpu_ratio * 100', legend: gpuLegend }] },
  'gpu-vram': { id: 'gpu-vram', queries: [{ expr: () => 'nvidia_smi_memory_used_bytes', legend: gpuLegend }] },
  'gpu-power': { id: 'gpu-power', queries: [{ expr: () => 'nvidia_smi_power_draw_watts', legend: gpuLegend }] },
  'gpu-temp': { id: 'gpu-temp', queries: [{ expr: () => 'nvidia_smi_temperature_gpu', legend: gpuLegend }] },

  'vllm-requests': {
    id: 'vllm-requests',
    queries: [
      { expr: () => 'vllm:num_requests_running', legend: l => `${l.model_name ?? '?'} running` },
      { expr: () => 'vllm:num_requests_waiting', legend: l => `${l.model_name ?? '?'} waiting` },
    ],
  },
  'vllm-throughput': {
    id: 'vllm-throughput',
    queries: [
      { expr: w => `rate(vllm:prompt_tokens_total[${w}])`, legend: l => `${l.model_name ?? '?'} prompt tok/s` },
      { expr: w => `rate(vllm:generation_tokens_total[${w}])`, legend: l => `${l.model_name ?? '?'} gen tok/s` },
    ],
  },
  'vllm-ttft': {
    id: 'vllm-ttft',
    queries: [
      { expr: w => `histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[${w}]))) * 1000`, legend: l => `${l.model_name ?? '?'} p50 ms` },
      { expr: w => `histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[${w}]))) * 1000`, legend: l => `${l.model_name ?? '?'} p95 ms` },
    ],
  },
  'vllm-kv-cache': { id: 'vllm-kv-cache', queries: [{ expr: () => 'vllm:kv_cache_usage_perc * 100', legend: modelLegend }] },

  'tei-rate': { id: 'tei-rate', queries: [{ expr: w => `rate(te_embed_count[${w}]) * 60`, legend: () => 'embeds/min' }] },

  'litellm-requests': {
    id: 'litellm-requests',
    queries: [{ expr: w => `sum by (model) (increase(litellm_requests_total[${w}])) > 0`, legend: modelLegend }],
  },
  'litellm-tokens': {
    id: 'litellm-tokens',
    queries: [{ expr: w => `sum by (model) (increase(litellm_total_tokens[${w}])) > 0`, legend: modelLegend }],
  },
  'litellm-spend': {
    id: 'litellm-spend',
    queries: [{ expr: w => `sum by (model) (increase(litellm_total_spend[${w}])) > 0`, legend: modelLegend }],
  },
  'litellm-cache-ratio': {
    id: 'litellm-cache-ratio',
    queries: [{
      expr: w => `sum(rate(litellm_cache_hits_total[${w}])) / (sum(rate(litellm_cache_hits_total[${w}])) + sum(rate(litellm_cache_misses_total[${w}]))) * 100`,
      legend: () => 'cache hit %',
    }],
  },
}

export type SnapshotQueryId =
  | 'gpuInfo' | 'gpuUtil' | 'gpuMemUsed' | 'gpuMemTotal' | 'gpuTemp' | 'gpuPower' | 'gpuPowerLimit'
  | 'engineRunning' | 'engineWaiting' | 'up' | 'probes' | 'spend'

export const SNAPSHOT_QUERIES: Record<SnapshotQueryId, string> = {
  gpuInfo: 'nvidia_smi_gpu_info',
  gpuUtil: 'nvidia_smi_utilization_gpu_ratio * 100',
  gpuMemUsed: 'nvidia_smi_memory_used_bytes',
  gpuMemTotal: 'nvidia_smi_memory_total_bytes',
  gpuTemp: 'nvidia_smi_temperature_gpu',
  gpuPower: 'nvidia_smi_power_draw_watts',
  gpuPowerLimit: 'nvidia_smi_enforced_power_limit_watts',
  engineRunning: 'vllm:num_requests_running',
  engineWaiting: 'vllm:num_requests_waiting',
  up: 'up{job=~"vllm-coder|vllm-vision|tei|llama-cpp-autocomplete|litellm|nvidia-gpu|prometheus"}',
  probes: 'probe_success{instance=~"https://lite.costanzoclan.com|http://192.168.2.25:8883/health"}',
  spend: 'topk(10, litellm_total_spend > 0)',
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run test/analytics-queries.test.ts` — 7 passed.

- [ ] **Step 5: Commit**

```bash
git add server/lib/analytics/queries.ts test/analytics-queries.test.ts
git commit -m "feat(analytics): named PromQL query catalog (13 panels + snapshot set)"
```

---

### Task 4: Snapshot assembler + endpoint

**Files:**
- Create: `server/lib/analytics/snapshot.ts`
- Create: `server/api/analytics/snapshot.get.ts`
- Test: `test/analytics-snapshot.test.ts`

**Interfaces:**
- Consumes: `PromVectorResult`, `promInstant` (`./prom`); `SNAPSHOT_QUERIES`, `SnapshotQueryId`, `resolveGpuLabel` (`./queries`); `loadAnalyticsConfig` (`./store`); `SnapshotResponse` (`./types`).
- Produces: `buildSnapshot(results: Partial<Record<SnapshotQueryId, PromVectorResult[]>>, gpuLabels: Record<string, string>): SnapshotResponse` and `GET /api/analytics/snapshot` → `SnapshotResponse`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/analytics-snapshot.test.ts
import { describe, it, expect } from 'vitest'
import { buildSnapshot } from '../server/lib/analytics/snapshot'
import type { PromVectorResult } from '../server/lib/analytics/prom'

const v = (metric: Record<string, string>, value: string): PromVectorResult => ({ metric, value: [1751800000, value] })

describe('buildSnapshot', () => {
  it('assembles gpus keyed by uuid with labels + all fields', () => {
    const snap = buildSnapshot({
      gpuInfo: [v({ uuid: 'aaa', name: 'NVIDIA GeForce RTX 3090' }, '1')],
      gpuUtil: [v({ uuid: 'aaa' }, '55')],
      gpuMemUsed: [v({ uuid: 'aaa' }, '1000')],
      gpuMemTotal: [v({ uuid: 'aaa' }, '2000')],
      gpuTemp: [v({ uuid: 'aaa' }, '61')],
      gpuPower: [v({ uuid: 'aaa' }, '250')],
      gpuPowerLimit: [v({ uuid: 'aaa' }, '350')],
    }, { aaa: 'Vision (PNY)' })
    expect(snap.gpus).toEqual([{
      uuid: 'aaa', label: 'Vision (PNY)', utilPct: 55, vramUsedBytes: 1000, vramTotalBytes: 2000,
      tempC: 61, powerW: 250, powerLimitW: 350,
    }])
  })

  it('missing per-gpu metrics become null, not 0', () => {
    const snap = buildSnapshot({ gpuInfo: [v({ uuid: 'bbb', name: 'Quadro P2000' }, '1')] }, {})
    expect(snap.gpus[0]).toMatchObject({ uuid: 'bbb', utilPct: null, tempC: null, powerW: null })
  })

  it('gpus are sorted by label for stable rendering', () => {
    const snap = buildSnapshot({
      gpuInfo: [v({ uuid: 'z' }, '1'), v({ uuid: 'a' }, '1')],
    }, { z: 'Alpha', a: 'Zulu' })
    expect(snap.gpus.map(g => g.label)).toEqual(['Alpha', 'Zulu'])
  })

  it('services merge up{} and probe_success into known service list; missing = null', () => {
    const snap = buildSnapshot({
      up: [v({ job: 'vllm-coder', instance: '192.168.2.25:8004' }, '1'), v({ job: 'litellm', instance: '192.168.2.85:9090' }, '0')],
      probes: [v({ job: 'blackbox-http', instance: 'https://lite.costanzoclan.com' }, '1')],
    }, {})
    const by = Object.fromEntries(snap.services.map(s => [s.id, s.up]))
    expect(by['vllm-coder']).toBe(true)
    expect(by['litellm-exporter']).toBe(false)
    expect(by['litellm-edge']).toBe(true)
    expect(by['vllm-vision']).toBe(null) // not scraped yet -> unknown, not down
  })

  it('engines pair running/waiting by model_name', () => {
    const snap = buildSnapshot({
      engineRunning: [v({ model_name: 'qwen3.6-35b-a3b' }, '2')],
      engineWaiting: [v({ model_name: 'qwen3.6-35b-a3b' }, '1')],
    }, {})
    expect(snap.engines).toEqual([{ model: 'qwen3.6-35b-a3b', running: 2, waiting: 1 }])
  })

  it('spendByModel sorted desc', () => {
    const snap = buildSnapshot({
      spend: [v({ model: 'a' }, '0.5'), v({ model: 'b' }, '1.25')],
    }, {})
    expect(snap.spendByModel).toEqual([{ model: 'b', usd: 1.25 }, { model: 'a', usd: 0.5 }])
  })

  it('empty input yields empty snapshot with full service list (all null)', () => {
    const snap = buildSnapshot({}, {})
    expect(snap.gpus).toEqual([])
    expect(snap.engines).toEqual([])
    expect(snap.services.length).toBeGreaterThanOrEqual(8)
    expect(snap.services.every(s => s.up === null)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run test/analytics-snapshot.test.ts` fails (module not found).

- [ ] **Step 3: Implement snapshot.ts**

```ts
// server/lib/analytics/snapshot.ts
// Pure assembler: raw instant-query vectors -> SnapshotResponse. No I/O.
import type { PromVectorResult } from './prom'
import type { SnapshotQueryId } from './queries'
import { resolveGpuLabel } from './queries'
import type { GpuSnapshot, ServiceHealth, SnapshotResponse } from './types'

// The fixed service list for the health strip. `match` is tested against up{}/probe_success vectors.
const SERVICES: { id: string, label: string, source: 'up' | 'probes', match: (l: Record<string, string>) => boolean }[] = [
  { id: 'vllm-coder', label: 'vLLM Coder', source: 'up', match: l => l.job === 'vllm-coder' },
  { id: 'vllm-vision', label: 'vLLM Vision', source: 'up', match: l => l.job === 'vllm-vision' },
  { id: 'tei', label: 'TEI Embeddings', source: 'up', match: l => l.job === 'tei' },
  { id: 'llama-autocomplete', label: 'Autocomplete', source: 'up', match: l => l.job === 'llama-cpp-autocomplete' },
  { id: 'litellm-exporter', label: 'LiteLLM Exporter', source: 'up', match: l => l.job === 'litellm' },
  { id: 'litellm-edge', label: 'LiteLLM (edge)', source: 'probes', match: l => (l.instance ?? '').includes('lite.costanzoclan.com') },
  { id: 'reranker', label: 'Reranker', source: 'probes', match: l => (l.instance ?? '').includes('8883') },
  { id: 'prometheus', label: 'Prometheus', source: 'up', match: l => l.job === 'prometheus' },
]

const num = (r: PromVectorResult | undefined): number | null => {
  if (!r) return null
  const n = parseFloat(r.value[1])
  return Number.isFinite(n) ? n : null
}

export function buildSnapshot(
  results: Partial<Record<SnapshotQueryId, PromVectorResult[]>>,
  gpuLabels: Record<string, string>,
): SnapshotResponse {
  const byUuid = (rs: PromVectorResult[] | undefined) =>
    new Map((rs ?? []).map(r => [r.metric.uuid ?? '', r]))

  const info = results.gpuInfo ?? []
  const util = byUuid(results.gpuUtil)
  const memU = byUuid(results.gpuMemUsed)
  const memT = byUuid(results.gpuMemTotal)
  const temp = byUuid(results.gpuTemp)
  const pow = byUuid(results.gpuPower)
  const powL = byUuid(results.gpuPowerLimit)

  const gpus: GpuSnapshot[] = info
    .map((r) => {
      const uuid = r.metric.uuid ?? ''
      return {
        uuid,
        label: resolveGpuLabel(uuid, gpuLabels),
        utilPct: num(util.get(uuid)),
        vramUsedBytes: num(memU.get(uuid)),
        vramTotalBytes: num(memT.get(uuid)),
        tempC: num(temp.get(uuid)),
        powerW: num(pow.get(uuid)),
        powerLimitW: num(powL.get(uuid)),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const upVec = results.up ?? []
  const probeVec = results.probes ?? []
  const services: ServiceHealth[] = SERVICES.map((s) => {
    const vec = s.source === 'up' ? upVec : probeVec
    const hit = vec.find(r => s.match(r.metric))
    return { id: s.id, label: s.label, up: hit ? num(hit) === 1 : null }
  })

  const waiting = new Map((results.engineWaiting ?? []).map(r => [r.metric.model_name ?? '?', num(r) ?? 0]))
  const engines = (results.engineRunning ?? []).map(r => ({
    model: r.metric.model_name ?? '?',
    running: num(r) ?? 0,
    waiting: waiting.get(r.metric.model_name ?? '?') ?? 0,
  }))

  const spendByModel = (results.spend ?? [])
    .map(r => ({ model: r.metric.model ?? '?', usd: num(r) ?? 0 }))
    .sort((a, b) => b.usd - a.usd)

  return { gpus, services, engines, spendByModel }
}
```

- [ ] **Step 4: Implement the endpoint**

```ts
// server/api/analytics/snapshot.get.ts
import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promInstant } from '../../lib/analytics/prom'
import { SNAPSHOT_QUERIES, type SnapshotQueryId } from '../../lib/analytics/queries'
import { buildSnapshot } from '../../lib/analytics/snapshot'
import type { PromVectorResult } from '../../lib/analytics/prom'

export default defineEventHandler(async () => {
  const cfg = await loadAnalyticsConfig()
  const ids = Object.keys(SNAPSHOT_QUERIES) as SnapshotQueryId[]
  let entries: [SnapshotQueryId, PromVectorResult[]][]
  try {
    entries = await Promise.all(ids.map(async id =>
      [id, await promInstant(cfg.prometheusUrl, SNAPSHOT_QUERIES[id])] as [SnapshotQueryId, PromVectorResult[]]
    ))
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Prometheus unreachable: ${(err as Error).message}` })
  }
  return buildSnapshot(Object.fromEntries(entries), cfg.gpuLabels)
})
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run test/analytics-snapshot.test.ts` — 7 passed. `pnpm typecheck` — clean.

- [ ] **Step 6: Live smoke test against the real Prometheus** (dev server must run: `pnpm dev`)

```bash
curl -s http://localhost:3000/api/analytics/snapshot -H "Authorization: Bearer $DEV_API_TOKEN" | jq '{gpus: (.gpus | length), services: [.services[] | {id, up}], engines}'
```
Expected: 5 gpus, `vllm-coder/tei/litellm-exporter/prometheus` up=true, `vllm-vision` up=null. (Get a dev bearer token from the `browser-testing` skill fixtures, or run the curl via an authenticated browser fetch.)

- [ ] **Step 7: Commit**

```bash
git add server/lib/analytics/snapshot.ts server/api/analytics/snapshot.get.ts test/analytics-snapshot.test.ts
git commit -m "feat(analytics): snapshot assembler + GET /api/analytics/snapshot"
```

---

### Task 5: Series endpoint

**Files:**
- Create: `server/api/analytics/series.get.ts`

**Interfaces:**
- Consumes: `RANGE_PANELS` (`../../lib/analytics/queries`), `promRange`, `toSeries`, `windowForRange` (`../../lib/analytics/prom`), `loadAnalyticsConfig` (`../../lib/analytics/store`), `RANGE_KEYS`, `RangeKey`, `SeriesResponse` (`../../lib/analytics/types`).
- Produces: `GET /api/analytics/series?panel=<id>&range=<key>` → `SeriesResponse`.

- [ ] **Step 1: Implement the endpoint** (thin composition of already-tested parts — no new unit test; covered by the Task 4/12 live checks)

```ts
// server/api/analytics/series.get.ts
import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { promRange, toSeries, windowForRange } from '../../lib/analytics/prom'
import { RANGE_PANELS } from '../../lib/analytics/queries'
import { RANGE_KEYS, type RangeKey, type SeriesResponse } from '../../lib/analytics/types'

export default defineEventHandler(async (event): Promise<SeriesResponse> => {
  const q = getQuery(event)
  const panelId = String(q.panel ?? '')
  const range = String(q.range ?? '') as RangeKey
  const panel = RANGE_PANELS[panelId]
  if (!panel) throw createError({ statusCode: 400, statusMessage: `unknown panel: ${panelId}` })
  if (!RANGE_KEYS.includes(range)) throw createError({ statusCode: 400, statusMessage: `unknown range: ${range}` })

  const cfg = await loadAnalyticsConfig()
  const w = windowForRange(range)
  try {
    const perQuery = await Promise.all(panel.queries.map(async (def) => {
      const matrix = await promRange(cfg.prometheusUrl, def.expr(w), range)
      return toSeries(matrix, labels => def.legend(labels, cfg.gpuLabels))
    }))
    return { panel: panelId, range, series: perQuery.flat() }
  } catch (err) {
    throw createError({ statusCode: 502, statusMessage: `Prometheus unreachable: ${(err as Error).message}` })
  }
})
```

- [ ] **Step 2: Typecheck + live smoke**

Run: `pnpm typecheck` — clean. Then (dev server running, authenticated):
```bash
curl -s "http://localhost:3000/api/analytics/series?panel=gpu-util&range=1h" -H "Authorization: Bearer $DEV_API_TOKEN" | jq '{panel, n: (.series | length), first: .series[0].name, pts: (.series[0].points | length)}'
curl -s "http://localhost:3000/api/analytics/series?panel=nope&range=1h" -H "Authorization: Bearer $DEV_API_TOKEN" -o /dev/null -w "%{http_code}\n"
```
Expected: 5 series with friendly GPU names, ~120 points; second call → `400`.

- [ ] **Step 3: Commit**

```bash
git add server/api/analytics/series.get.ts
git commit -m "feat(analytics): GET /api/analytics/series (catalog-validated range queries)"
```

---

### Task 6: LiteLLM spend-logs proxy

**Files:**
- Create: `server/lib/analytics/litellm.ts`
- Create: `server/api/analytics/requests.get.ts`
- Test: `test/analytics-litellm.test.ts`

**Interfaces:**
- Consumes: `decryptSecret` (`../ai/registry/crypto`), `AnalyticsConfig`, `RequestLogRow`, `RequestLogResponse` (`./types`), `loadAnalyticsConfig` (`./store`).
- Produces: `normalizeSpendRow(raw: Record<string, unknown>): RequestLogRow`, `fetchSpendLogs(cfg: AnalyticsConfig, page: number, pageSize: number): Promise<RequestLogResponse>`, and `GET /api/analytics/requests?page=&pageSize=` → `RequestLogResponse` (409 `litellm key not configured` when no key stored).

**LiteLLM API notes (verify live in Step 5):** primary endpoint `GET {litellmUrl}/spend/logs/ui?page=<n>&page_size=<n>` (admin-UI pagination; returns `{ data: rows[], total_pages }`), header `Authorization: Bearer <masterKey>`. Fallback if `/ui` 404s on this LiteLLM version: `GET /spend/logs` with `start_date`/`end_date` (ISO dates, last 24 h) and paginate server-side by slicing. SpendLogs row fields (Prisma schema, stable across versions): `request_id`, `model`, `spend`, `total_tokens`, `prompt_tokens`, `completion_tokens`, `startTime`, `endTime`, `cache_hit` (string `"True"`/`"False"` or bool), `metadata` (object; may carry `user_api_key_alias`, `status`, `error_information`).

- [ ] **Step 1: Write the failing normalizer tests**

```ts
// test/analytics-litellm.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeSpendRow } from '../server/lib/analytics/litellm'

describe('normalizeSpendRow', () => {
  it('maps a full LiteLLM SpendLogs row', () => {
    const row = normalizeSpendRow({
      request_id: 'req-1',
      model: 'claude-haiku-4-5',
      spend: 0.00123,
      prompt_tokens: 100,
      completion_tokens: 20,
      startTime: '2026-07-06T10:00:00.000Z',
      endTime: '2026-07-06T10:00:02.500Z',
      cache_hit: 'True',
      metadata: { user_api_key_alias: 'mymind-prod', status: 'success' },
    })
    expect(row).toEqual({
      id: 'req-1',
      startedAt: '2026-07-06T10:00:00.000Z',
      model: 'claude-haiku-4-5',
      promptTokens: 100,
      completionTokens: 20,
      latencyMs: 2500,
      spendUsd: 0.00123,
      keyAlias: 'mymind-prod',
      cacheHit: true,
      status: 'success',
    })
  })

  it('is defensive: missing/odd fields become nulls, not throws', () => {
    const row = normalizeSpendRow({ request_id: 'req-2', model: 'qwen' })
    expect(row).toEqual({
      id: 'req-2', startedAt: '', model: 'qwen',
      promptTokens: null, completionTokens: null, latencyMs: null,
      spendUsd: null, keyAlias: null, cacheHit: null, status: null,
    })
  })

  it('parses boolean cache_hit and failure status from error_information', () => {
    const row = normalizeSpendRow({
      request_id: 'r3', model: 'm', cache_hit: false,
      metadata: { error_information: { error_class: 'Timeout' } },
    })
    expect(row.cacheHit).toBe(false)
    expect(row.status).toBe('failure')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run test/analytics-litellm.test.ts` fails.

- [ ] **Step 3: Implement litellm.ts**

```ts
// server/lib/analytics/litellm.ts
// LiteLLM admin-API client for the request log. The master key is decrypted
// here and only ever placed in the outbound Authorization header.
import { decryptSecret } from '../ai/registry/crypto'
import type { AnalyticsConfig, RequestLogResponse, RequestLogRow } from './types'

const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const asStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function normalizeSpendRow(raw: Record<string, unknown>): RequestLogRow {
  const meta = (raw.metadata ?? {}) as Record<string, unknown>
  const start = asStr(raw.startTime)
  const end = asStr(raw.endTime)
  const startMs = start ? Date.parse(start) : NaN
  const endMs = end ? Date.parse(end) : NaN

  let cacheHit: boolean | null = null
  if (typeof raw.cache_hit === 'boolean') cacheHit = raw.cache_hit
  else if (raw.cache_hit === 'True') cacheHit = true
  else if (raw.cache_hit === 'False') cacheHit = false

  let status: RequestLogRow['status'] = null
  if (meta.status === 'success' || meta.status === 'failure') status = meta.status
  else if (meta.error_information) status = 'failure'

  return {
    id: asStr(raw.request_id) ?? crypto.randomUUID(),
    startedAt: start ?? '',
    model: asStr(raw.model) ?? '?',
    promptTokens: asNum(raw.prompt_tokens),
    completionTokens: asNum(raw.completion_tokens),
    latencyMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
    spendUsd: asNum(raw.spend),
    keyAlias: asStr(meta.user_api_key_alias),
    cacheHit,
    status,
  }
}

export async function fetchSpendLogs(cfg: AnalyticsConfig, page: number, pageSize: number): Promise<RequestLogResponse> {
  if (!cfg.litellmMasterKeyEnc) throw createError({ statusCode: 409, statusMessage: 'litellm key not configured' })
  const headers = { authorization: `Bearer ${decryptSecret(cfg.litellmMasterKeyEnc)}` }

  try {
    // Primary: paginated admin-UI endpoint
    const res = await $fetch<{ data?: Record<string, unknown>[], total_pages?: number } | Record<string, unknown>[]>(
      `${cfg.litellmUrl}/spend/logs/ui`,
      { query: { page, page_size: pageSize }, headers, timeout: 5000 },
    )
    const rows = Array.isArray(res) ? res : (res.data ?? [])
    const totalPages = Array.isArray(res) ? null : (typeof res.total_pages === 'number' ? res.total_pages : null)
    return { rows: rows.map(normalizeSpendRow), page, pageSize, totalPages }
  } catch (err) {
    const status = (err as { statusCode?: number, response?: { status?: number } }).response?.status
    if (status !== 404) throw err
  }

  // Fallback for LiteLLM versions without /spend/logs/ui: last-24h window, slice server-side.
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 3600 * 1000)
  const all = await $fetch<Record<string, unknown>[]>(`${cfg.litellmUrl}/spend/logs`, {
    query: { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) },
    headers, timeout: 5000,
  })
  const sorted = [...all].sort((a, b) => String(b.startTime ?? '').localeCompare(String(a.startTime ?? '')))
  const slice = sorted.slice((page - 1) * pageSize, page * pageSize)
  return { rows: slice.map(normalizeSpendRow), page, pageSize, totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)) }
}
```

- [ ] **Step 4: Implement the endpoint**

```ts
// server/api/analytics/requests.get.ts
import { loadAnalyticsConfig } from '../../lib/analytics/store'
import { fetchSpendLogs } from '../../lib/analytics/litellm'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(String(q.pageSize ?? '25'), 10) || 25))
  const cfg = await loadAnalyticsConfig()
  try {
    return await fetchSpendLogs(cfg, page, pageSize)
  } catch (err) {
    const e = err as { statusCode?: number, statusMessage?: string, message?: string }
    if (e.statusCode === 409) throw err
    throw createError({ statusCode: 502, statusMessage: `LiteLLM unreachable: ${e.statusMessage ?? e.message}` })
  }
})
```

- [ ] **Step 5: Run tests + typecheck** — `pnpm vitest run test/analytics-litellm.test.ts` (3 passed), `pnpm typecheck` clean.
  Live verification of the `/spend/logs/ui` shape needs the master key, which arrives at acceptance — until then the endpoint 409s cleanly (verify: authenticated `curl .../api/analytics/requests` → 409).

- [ ] **Step 6: Commit**

```bash
git add server/lib/analytics/litellm.ts server/api/analytics/requests.get.ts test/analytics-litellm.test.ts
git commit -m "feat(analytics): LiteLLM spend-logs proxy + request-log endpoint"
```

---

### Task 7: Settings endpoints (GET redacted / PUT with probe)

**Files:**
- Create: `server/api/settings/analytics-config.get.ts`
- Create: `server/api/settings/analytics-config.put.ts`

**Interfaces:**
- Consumes: `loadAnalyticsConfig`, `saveAnalyticsConfig`, `parseAnalyticsConfigInput` (`../../lib/analytics/store`).
- Produces: `GET /api/settings/analytics-config` → `{ prometheusUrl, litellmUrl, hasLitellmKey, gpuLabels }` (the **redacted DTO** — the client-side `AnalyticsSettings` interface in Task 8 mirrors this); `PUT` accepts `AnalyticsConfigInput`, probes Prometheus when the URL changes, returns the same redacted shape.

- [ ] **Step 1: Implement GET**

```ts
// server/api/settings/analytics-config.get.ts
import { loadAnalyticsConfig } from '../../lib/analytics/store'

export default defineEventHandler(async () => {
  const c = await loadAnalyticsConfig()
  return {
    prometheusUrl: c.prometheusUrl,
    litellmUrl: c.litellmUrl,
    hasLitellmKey: !!c.litellmMasterKeyEnc,
    gpuLabels: c.gpuLabels,
  }
})
```

- [ ] **Step 2: Implement PUT**

```ts
// server/api/settings/analytics-config.put.ts
import { loadAnalyticsConfig, parseAnalyticsConfigInput, saveAnalyticsConfig } from '../../lib/analytics/store'

export default defineEventHandler(async (event) => {
  let input
  try {
    input = parseAnalyticsConfigInput(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: (err as Error).message })
  }

  // Save-time validation: the new Prometheus URL must answer buildinfo.
  const current = await loadAnalyticsConfig()
  if (input.prometheusUrl && input.prometheusUrl !== current.prometheusUrl) {
    try {
      await $fetch(`${input.prometheusUrl}/api/v1/status/buildinfo`, { timeout: 3000 })
    } catch {
      throw createError({ statusCode: 422, statusMessage: `Prometheus did not answer at ${input.prometheusUrl}` })
    }
  }

  const saved = await saveAnalyticsConfig(input)
  return {
    prometheusUrl: saved.prometheusUrl,
    litellmUrl: saved.litellmUrl,
    hasLitellmKey: !!saved.litellmMasterKeyEnc,
    gpuLabels: saved.gpuLabels,
  }
})
```

- [ ] **Step 3: Typecheck + live smoke** — `pnpm typecheck`; authenticated `curl` GET returns defaults with `hasLitellmKey: false`; PUT with `{"prometheusUrl":"http://192.168.2.90:9090"}` → 200; PUT `{"prometheusUrl":"http://192.0.2.1:9"}` → 422.

- [ ] **Step 4: Commit**

```bash
git add server/api/settings/analytics-config.get.ts server/api/settings/analytics-config.put.ts
git commit -m "feat(analytics): settings endpoints (redacted GET, probing PUT)"
```

---

### Task 8: Frontend data layer + `/analytics` page skeleton (health strip + GPU tiles)

**Files:**
- Create: `app/composables/useAnalytics.ts`
- Create: `app/components/analytics/HealthStrip.vue`
- Create: `app/components/analytics/GpuTiles.vue`
- Create: `app/pages/analytics.vue`
- Modify: `app/layouts/default.vue` (add main-nav item after Sessions, before Activity: `{ label: 'Analytics', icon: 'i-lucide-chart-line', to: '/analytics' }` in `mainItems`, around line 68)

**Interfaces:**
- Consumes: server DTOs (`SnapshotResponse`, `SeriesResponse`, `RequestLogResponse` — mirror them as local interfaces in the composable; app code does not import from `server/`; check whether a `shared/types/` home is preferred — `shared/types/` already exists and is the repo's cross-boundary pattern. **Preferred: move the DTO interfaces from `server/lib/analytics/types.ts` into `shared/types/analytics.ts` and import from `~~/shared/types/analytics` on both sides; keep `AnalyticsConfig` server-only in `server/lib/analytics/types.ts`.**)
- Produces: `useAnalytics()` returning `{ useSnapshot, useSeries, useRequests, useSettings, saveSettings }`; `<AnalyticsHealthStrip :services>`; `<AnalyticsGpuTiles :gpus>`; the page shell with the shared range picker (`ref<RangeKey>`) that Task 9 charts consume.

- [ ] **Step 1: Move DTOs to `shared/types/analytics.ts`** (all interfaces from Task 1 types.ts except `AnalyticsConfig`; update server imports: `server/lib/analytics/{prom,snapshot,litellm,queries}.ts` + endpoints import DTOs from `~~/shared/types/analytics`, config from `./types`). Run `pnpm vitest run test/analytics-store.test.ts test/analytics-prom.test.ts test/analytics-queries.test.ts test/analytics-snapshot.test.ts test/analytics-litellm.test.ts` + `pnpm typecheck` — all green before proceeding.

- [ ] **Step 2: Write the composable**

```ts
// app/composables/useAnalytics.ts
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { RangeKey, SeriesResponse, SnapshotResponse, RequestLogResponse } from '~~/shared/types/analytics'

export interface AnalyticsSettings {
  prometheusUrl: string
  litellmUrl: string
  hasLitellmKey: boolean
  gpuLabels: Record<string, string>
}

export function useAnalytics() {
  const qc = useQueryClient()

  const useSnapshot = () => useQuery({
    queryKey: ['analytics', 'snapshot'] as const,
    queryFn: () => $fetch<SnapshotResponse>('/api/analytics/snapshot'),
    refetchInterval: 10_000,
  })

  const useSeries = (panel: string, range: MaybeRefOrGetter<RangeKey>) => {
    const r = computed(() => toValue(range))
    return useQuery({
      queryKey: computed(() => ['analytics', 'series', panel, r.value] as const),
      queryFn: () => $fetch<SeriesResponse>('/api/analytics/series', { query: { panel, range: r.value } }),
      refetchInterval: 30_000,
    })
  }

  const useRequests = (page: MaybeRefOrGetter<number>) => {
    const p = computed(() => toValue(page))
    return useQuery({
      queryKey: computed(() => ['analytics', 'requests', p.value] as const),
      queryFn: () => $fetch<RequestLogResponse>('/api/analytics/requests', { query: { page: p.value, pageSize: 25 } }),
      refetchInterval: 10_000,
      retry: false, // 409 (no key) must not retry-storm
    })
  }

  const useSettings = () => useQuery({
    queryKey: ['analytics', 'config'] as const,
    queryFn: () => $fetch<AnalyticsSettings>('/api/settings/analytics-config'),
  })

  async function saveSettings(patch: Partial<AnalyticsSettings> & { litellmMasterKey?: string }) {
    const saved = await $fetch<AnalyticsSettings>('/api/settings/analytics-config', { method: 'PUT', body: patch })
    qc.setQueryData(['analytics', 'config'], saved)
    qc.invalidateQueries({ queryKey: ['analytics'] })
    return saved
  }

  return { useSnapshot, useSeries, useRequests, useSettings, saveSettings }
}
```

- [ ] **Step 3: HealthStrip + GpuTiles components** (invoke `nuxt-ui-docs` for `UBadge`/`UCard`/`UProgress` props first)

```vue
<!-- app/components/analytics/HealthStrip.vue -->
<script setup lang="ts">
import type { ServiceHealth } from '~~/shared/types/analytics'
defineProps<{ services: ServiceHealth[] }>()
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <UBadge
      v-for="s in services" :key="s.id" variant="subtle" size="lg"
      :color="s.up === true ? 'success' : s.up === false ? 'error' : 'neutral'"
      :icon="s.up === true ? 'i-lucide-circle-check' : s.up === false ? 'i-lucide-circle-x' : 'i-lucide-circle-help'"
    >
      {{ s.label }}
    </UBadge>
  </div>
</template>
```

```vue
<!-- app/components/analytics/GpuTiles.vue -->
<script setup lang="ts">
import type { GpuSnapshot } from '~~/shared/types/analytics'
defineProps<{ gpus: GpuSnapshot[] }>()
const gb = (b: number | null) => b == null ? '—' : (b / 1024 ** 3).toFixed(1)
</script>

<template>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
    <UCard v-for="g in gpus" :key="g.uuid" :ui="{ body: 'p-3 sm:p-4' }">
      <div class="text-sm font-medium text-highlighted truncate">{{ g.label }}</div>
      <div class="mt-2 flex items-baseline justify-between">
        <span class="text-2xl font-semibold">{{ g.utilPct == null ? '—' : Math.round(g.utilPct) + '%' }}</span>
        <span class="text-xs text-muted">{{ g.tempC == null ? '—' : g.tempC + '°C' }} · {{ g.powerW == null ? '—' : Math.round(g.powerW) + 'W' }}</span>
      </div>
      <UProgress class="mt-2" :model-value="g.utilPct ?? 0" size="sm" />
      <div class="mt-2 text-xs text-muted">VRAM {{ gb(g.vramUsedBytes) }} / {{ gb(g.vramTotalBytes) }} GB</div>
      <UProgress
        class="mt-1" size="sm" color="neutral"
        :model-value="g.vramUsedBytes != null && g.vramTotalBytes ? (g.vramUsedBytes / g.vramTotalBytes) * 100 : 0"
      />
    </UCard>
  </div>
</template>
```

- [ ] **Step 4: Page skeleton** (charts land in Task 9 — leave the labeled grid slots rendering `USkeleton` placeholders)

```vue
<!-- app/pages/analytics.vue -->
<script setup lang="ts">
import type { RangeKey } from '~~/shared/types/analytics'
definePageMeta({ title: 'Analytics' })

const { useSnapshot } = useAnalytics()
const range = ref<RangeKey>('1h')
const rangeItems = [
  { label: '1h', value: '1h' }, { label: '6h', value: '6h' },
  { label: '24h', value: '24h' }, { label: '7d', value: '7d' },
]
const { data: snapshot, error: snapshotError } = useSnapshot()
</script>

<template>
  <UDashboardPanel id="analytics" grow>
    <template #header>
      <UDashboardNavbar title="Analytics">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <UTabs v-model="range" :items="rangeItems" size="xs" :content="false" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="space-y-6 p-4">
        <UAlert v-if="snapshotError" color="error" variant="subtle" title="Prometheus unreachable"
                :description="(snapshotError as any)?.data?.statusMessage ?? 'Check Settings → Analytics'" />
        <AnalyticsHealthStrip v-if="snapshot" :services="snapshot.services" />
        <AnalyticsGpuTiles v-if="snapshot" :gpus="snapshot.gpus" />
        <!-- Task 9 replaces these placeholders with TimeSeriesChart panels -->
        <div class="grid gap-4 lg:grid-cols-2">
          <USkeleton class="h-56" /><USkeleton class="h-56" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 5: Add the nav item** in `app/layouts/default.vue` `mainItems` (after Sessions):

```ts
  { label: 'Analytics', icon: 'i-lucide-chart-line', to: '/analytics' },
```

- [ ] **Step 6: Validate in the browser** — invoke the `browser-testing` skill; `playwright-cli`: log in, click the new Analytics nav item, assert 5 GPU tiles with friendly names and a health strip with green chips for vLLM Coder/TEI/Prometheus and a gray "vLLM Vision" chip. Screenshot.

- [ ] **Step 7: Commit**

```bash
git add app/composables/useAnalytics.ts app/components/analytics/ app/pages/analytics.vue app/layouts/default.vue shared/types/analytics.ts server/
git commit -m "feat(analytics): /analytics page skeleton — data layer, health strip, GPU tiles, nav"
```

---

### Task 9: Time-series charts (Unovis)

**Files:**
- Create: `app/utils/analytics-pivot.ts`
- Create: `app/components/analytics/TimeSeriesChart.vue`
- Modify: `app/pages/analytics.vue` (replace placeholders with the panel grid)
- Test: `test/analytics-pivot.test.ts`

**Interfaces:**
- Consumes: `Series` (`~~/shared/types/analytics`), `useAnalytics().useSeries`, the page's `range` ref.
- Produces: `pivotSeries(series: Series[]): { rows: Record<string, number | null>[], keys: string[] }` (rows have `t` epoch-ms plus one key per series name); `<AnalyticsTimeSeriesChart :panel :range :title :unit :format?>` self-fetching chart card.

- [ ] **Step 0: Invoke the `dataviz` skill** before writing any chart code — apply its form/color/axis/tooltip guidance to the component below (adjust colors/ticks to the skill's system; the code below is the structural contract).

- [ ] **Step 1: Install Unovis**

```bash
pnpm add @unovis/vue @unovis/ts
```

- [ ] **Step 2: Write the failing pivot tests**

```ts
// test/analytics-pivot.test.ts
import { describe, it, expect } from 'vitest'
import { pivotSeries } from '../app/utils/analytics-pivot'

describe('pivotSeries', () => {
  it('merges series on timestamp into row objects', () => {
    const { rows, keys } = pivotSeries([
      { name: 'A', points: [{ t: 1000, v: 1 }, { t: 2000, v: 2 }] },
      { name: 'B', points: [{ t: 1000, v: 9 }] },
    ])
    expect(keys).toEqual(['A', 'B'])
    expect(rows).toEqual([
      { t: 1000, A: 1, B: 9 },
      { t: 2000, A: 2, B: null },
    ])
  })
  it('keeps null gaps and sorts by time', () => {
    const { rows } = pivotSeries([{ name: 'A', points: [{ t: 2000, v: null }, { t: 1000, v: 5 }] }])
    expect(rows).toEqual([{ t: 1000, A: 5 }, { t: 2000, A: null }])
  })
  it('empty input -> empty rows/keys', () => {
    expect(pivotSeries([])).toEqual({ rows: [], keys: [] })
  })
})
```

- [ ] **Step 3: Run to verify failure**, then implement

```ts
// app/utils/analytics-pivot.ts
// Pure: Series[] -> Unovis row objects (one row per timestamp, one key per series).
import type { Series } from '~~/shared/types/analytics'

export function pivotSeries(series: Series[]): { rows: Record<string, number | null>[], keys: string[] } {
  const keys = series.map(s => s.name)
  const byT = new Map<number, Record<string, number | null>>()
  for (const s of series) {
    for (const p of s.points) {
      let row = byT.get(p.t)
      if (!row) { row = { t: p.t }; byT.set(p.t, row) }
      row[s.name] = p.v
    }
  }
  const rows = [...byT.values()].sort((a, b) => (a.t! - b.t!))
  for (const row of rows) for (const k of keys) if (!(k in row)) row[k] = null
  return { rows, keys }
}
```

Run: `pnpm vitest run test/analytics-pivot.test.ts` — 3 passed.

- [ ] **Step 4: TimeSeriesChart component** (structure below; finalize colors/formatting per dataviz)

```vue
<!-- app/components/analytics/TimeSeriesChart.vue -->
<script setup lang="ts">
import { VisXYContainer, VisLine, VisAxis, VisCrosshair, VisTooltip } from '@unovis/vue'
import type { RangeKey } from '~~/shared/types/analytics'

const props = defineProps<{
  panel: string
  range: RangeKey
  title: string
  unit?: string
  format?: (v: number) => string
}>()

const { useSeries } = useAnalytics()
const { data, error, isPending } = useSeries(props.panel, () => props.range)

const pivoted = computed(() => pivotSeries(data.value?.series ?? []))
const x = (d: Record<string, number | null>) => d.t as number
const yAccessors = computed(() => pivoted.value.keys.map(k => (d: Record<string, number | null>) => d[k]))
const fmt = (v: number) => props.format ? props.format(v) : `${Math.round(v * 10) / 10}${props.unit ?? ''}`
const tooltipTemplate = (d: Record<string, number | null>) =>
  [new Date(d.t as number).toLocaleTimeString(), ...pivoted.value.keys.map(k => `${k}: ${d[k] == null ? '—' : fmt(d[k] as number)}`)].join('<br>')
</script>

<template>
  <UCard :ui="{ body: 'p-3 sm:p-4' }">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-sm font-medium text-highlighted">{{ title }}</span>
      <UBadge v-if="error" color="error" variant="subtle" size="sm">source down</UBadge>
    </div>
    <USkeleton v-if="isPending" class="h-48" />
    <div v-else-if="!pivoted.rows.length" class="flex h-48 items-center justify-center text-sm text-muted">no data in range</div>
    <VisXYContainer v-else :data="pivoted.rows" :height="192">
      <VisLine :x="x" :y="yAccessors" />
      <VisAxis type="x" :x="x" :tick-format="(t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })" :num-ticks="5" />
      <VisAxis type="y" :tick-format="fmt" :num-ticks="4" />
      <VisCrosshair :template="tooltipTemplate" />
      <VisTooltip />
    </VisXYContainer>
    <div v-if="pivoted.keys.length > 1" class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      <span v-for="k in pivoted.keys" :key="k">{{ k }}</span>
    </div>
  </UCard>
</template>
```

(Legend swatch colors: read the actual series colors from Unovis theme config per the dataviz skill — wire legend + line colors from one palette array so they can't drift.)

- [ ] **Step 5: Wire the panel grid into `app/pages/analytics.vue`** (replace the Task 8 placeholders)

```vue
        <div class="grid gap-4 lg:grid-cols-2">
          <AnalyticsTimeSeriesChart panel="gpu-util" :range="range" title="GPU utilization" unit="%" />
          <AnalyticsTimeSeriesChart panel="gpu-vram" :range="range" title="GPU VRAM" :format="(v) => (v / 1024 ** 3).toFixed(1) + ' GB'" />
          <AnalyticsTimeSeriesChart panel="gpu-power" :range="range" title="GPU power" unit=" W" />
          <AnalyticsTimeSeriesChart panel="gpu-temp" :range="range" title="GPU temperature" unit="°C" />
          <AnalyticsTimeSeriesChart panel="vllm-requests" :range="range" title="vLLM requests" />
          <AnalyticsTimeSeriesChart panel="vllm-throughput" :range="range" title="vLLM token throughput" unit=" tok/s" />
          <AnalyticsTimeSeriesChart panel="vllm-ttft" :range="range" title="Time to first token" unit=" ms" />
          <AnalyticsTimeSeriesChart panel="vllm-kv-cache" :range="range" title="KV-cache usage" unit="%" />
          <AnalyticsTimeSeriesChart panel="litellm-requests" :range="range" title="LiteLLM requests" />
          <AnalyticsTimeSeriesChart panel="litellm-tokens" :range="range" title="LiteLLM tokens" />
          <AnalyticsTimeSeriesChart panel="litellm-spend" :range="range" title="LiteLLM spend" :format="(v) => '$' + v.toFixed(4)" />
          <AnalyticsTimeSeriesChart panel="tei-rate" :range="range" title="Embedding rate" unit="/min" />
        </div>
```

(`litellm-cache-ratio` is in the catalog but not gridded — add it only if the cache metrics are non-zero on dev; YAGNI otherwise.)

- [ ] **Step 6: Browser validation** — playwright-cli: charts render with real data on 1h; click 6h tab (real click per reka-ui rule) → charts re-render; screenshot light+dark.

- [ ] **Step 7: Gates + commit**

```bash
pnpm typecheck && pnpm vitest run && pnpm build
git add package.json pnpm-lock.yaml app/utils/analytics-pivot.ts app/components/analytics/TimeSeriesChart.vue app/pages/analytics.vue test/analytics-pivot.test.ts
git commit -m "feat(analytics): Unovis time-series charts for all panels"
```

---

### Task 10: Request-log table + settings tab UI

**Files:**
- Create: `app/components/analytics/RequestLogTable.vue`
- Create: `app/components/settings/AnalyticsTab.vue`
- Create: `app/pages/settings/analytics.vue`
- Modify: `app/pages/analytics.vue` (append table below the chart grid)
- Modify: `app/layouts/default.vue` (`settingsChildren`: add `{ label: 'Analytics', icon: 'i-lucide-chart-line', to: '/settings/analytics' }` after Image Gen, ~line 57)

**Interfaces:**
- Consumes: `useAnalytics().useRequests/useSettings/saveSettings`, `RequestLogRow` (`~~/shared/types/analytics`).
- Produces: `<AnalyticsRequestLogTable />` (self-fetching, paginated, shows the configure-prompt when the 409 comes back); `/settings/analytics` subpage.

- [ ] **Step 1: RequestLogTable** (check `nuxt-ui-docs` for UTable v4 column defs before writing)

```vue
<!-- app/components/analytics/RequestLogTable.vue -->
<script setup lang="ts">
import type { RequestLogRow } from '~~/shared/types/analytics'

const { useRequests } = useAnalytics()
const page = ref(1)
const { data, error, isPending } = useRequests(() => page.value)

const needsKey = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 409
  || (error.value as { data?: { statusCode?: number } } | null)?.data?.statusCode === 409)

const columns = [
  { accessorKey: 'startedAt', header: 'Time', cell: ({ row }: any) => row.original.startedAt ? new Date(row.original.startedAt).toLocaleString() : '—' },
  { accessorKey: 'model', header: 'Model' },
  { accessorKey: 'promptTokens', header: 'In' },
  { accessorKey: 'completionTokens', header: 'Out' },
  { accessorKey: 'latencyMs', header: 'Latency', cell: ({ row }: any) => row.original.latencyMs == null ? '—' : `${row.original.latencyMs} ms` },
  { accessorKey: 'spendUsd', header: 'Cost', cell: ({ row }: any) => row.original.spendUsd == null ? '—' : `$${row.original.spendUsd.toFixed(5)}` },
  { accessorKey: 'keyAlias', header: 'Key' },
  { accessorKey: 'status', header: 'Status' },
]
const rows = computed<RequestLogRow[]>(() => data.value?.rows ?? [])
</script>

<template>
  <UCard :ui="{ body: 'p-0' }">
    <template #header>
      <span class="text-sm font-medium text-highlighted">Recent LiteLLM requests</span>
    </template>
    <UAlert v-if="needsKey" color="info" variant="subtle" class="m-4" title="LiteLLM key not configured"
            description="Add the master key to enable the request log.">
      <template #actions>
        <UButton size="xs" variant="subtle" to="/settings/analytics">Open Settings → Analytics</UButton>
      </template>
    </UAlert>
    <UAlert v-else-if="error" color="error" variant="subtle" class="m-4" title="LiteLLM unreachable" />
    <template v-else>
      <UTable :data="rows" :columns="columns" :loading="isPending" />
      <div class="flex items-center justify-end gap-2 border-t border-default p-2">
        <UButton size="xs" variant="ghost" icon="i-lucide-chevron-left" :disabled="page <= 1" @click="page--" />
        <span class="text-xs text-muted">page {{ page }}<template v-if="data?.totalPages"> / {{ data.totalPages }}</template></span>
        <UButton size="xs" variant="ghost" icon="i-lucide-chevron-right" :disabled="!!data?.totalPages && page >= data.totalPages" @click="page++" />
      </div>
    </template>
  </UCard>
</template>
```

Append to the page body (after the chart grid): `<AnalyticsRequestLogTable />`

- [ ] **Step 2: AnalyticsTab settings component**

```vue
<!-- app/components/settings/AnalyticsTab.vue -->
<script setup lang="ts">
const { useSettings, saveSettings } = useAnalytics()
const toast = useToast()
const { data: cfg } = useSettings()

const form = reactive({ prometheusUrl: '', litellmUrl: '', litellmMasterKey: '' })
const gpuLabels = ref<{ uuid: string, label: string }[]>([])
watch(cfg, (c) => {
  if (!c) return
  form.prometheusUrl = c.prometheusUrl
  form.litellmUrl = c.litellmUrl
  gpuLabels.value = Object.entries(c.gpuLabels).map(([uuid, label]) => ({ uuid, label }))
}, { immediate: true })

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await saveSettings({
      prometheusUrl: form.prometheusUrl,
      litellmUrl: form.litellmUrl,
      litellmMasterKey: form.litellmMasterKey || undefined,
      gpuLabels: Object.fromEntries(gpuLabels.value.map(g => [g.uuid, g.label])),
    })
    form.litellmMasterKey = ''
    toast.add({ color: 'success', title: 'Analytics settings saved' })
  } catch (e) {
    toast.add({ color: 'error', title: 'Save failed', description: (e as { data?: { statusMessage?: string } }).data?.statusMessage })
  } finally { saving.value = false }
}
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <UFormField label="Prometheus URL" help="Validated on save (buildinfo probe)">
      <UInput v-model="form.prometheusUrl" class="w-full" />
    </UFormField>
    <UFormField label="LiteLLM URL">
      <UInput v-model="form.litellmUrl" class="w-full" />
    </UFormField>
    <UFormField label="LiteLLM master key"
      :help="cfg?.hasLitellmKey ? 'A key is configured. Enter a new value to replace it.' : 'Required only for the request log.'">
      <UInput v-model="form.litellmMasterKey" type="password" class="w-full"
              :placeholder="cfg?.hasLitellmKey ? '••••••••  (configured)' : 'sk-…'" />
    </UFormField>
    <UFormField label="GPU labels" help="Friendly names per GPU UUID, used in chart legends">
      <div class="space-y-2">
        <div v-for="g in gpuLabels" :key="g.uuid" class="flex items-center gap-2">
          <code class="w-28 shrink-0 truncate text-xs text-muted">{{ g.uuid.slice(0, 8) }}</code>
          <UInput v-model="g.label" class="w-full" size="sm" />
        </div>
      </div>
    </UFormField>
    <UButton :loading="saving" @click="save">Save</UButton>
  </div>
</template>
```

```vue
<!-- app/pages/settings/analytics.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Analytics' })
</script>

<template>
  <SettingsAnalyticsTab />
</template>
```

- [ ] **Step 3: Add the settings nav child** in `app/layouts/default.vue` `settingsChildren`.

- [ ] **Step 4: Browser validation** — playwright-cli: `/analytics` shows the request-log card with the "not configured" prompt (409 path); `/settings/analytics` renders defaults + 5 GPU label rows; edit one label + save → toast; back to `/analytics` → legend uses the new label; save a bogus Prometheus URL → error toast (422 propagated).

- [ ] **Step 5: Gates + commit**

```bash
pnpm typecheck && pnpm vitest run && pnpm build
git add app/components/analytics/RequestLogTable.vue app/components/settings/AnalyticsTab.vue app/pages/settings/analytics.vue app/pages/analytics.vue app/layouts/default.vue
git commit -m "feat(analytics): request-log table + /settings/analytics tab"
```

---

### Task 11: Homelab — add `vllm-vision` scrape job (CONTROLLER-RUN, not a code subagent)

**Files:** none in this repo (Prometheus config on Dell LXC 111 + MyMind homelab doc).

- [ ] **Step 1: Inspect the current scrape config**

```bash
ssh dell "pct exec 111 -- grep -n -A3 'vllm-coder' /etc/prometheus/prometheus.yml"
```
Expected: the `vllm-coder` job with target `192.168.2.25:8004`. (If the config file lives elsewhere, find it: `pct exec 111 -- ps aux | grep prometheus` → `--config.file` flag.)

- [ ] **Step 2: Append the job** (mirror the vllm-coder stanza exactly; typical shape):

```yaml
  - job_name: 'vllm-vision'
    static_configs:
      - targets: ['192.168.2.25:8005']
```

Apply + validate + reload:
```bash
ssh dell "pct exec 111 -- promtool check config /etc/prometheus/prometheus.yml"
ssh dell "pct exec 111 -- systemctl reload prometheus || pct exec 111 -- systemctl restart prometheus"
```

- [ ] **Step 3: Verify the target is up**

```bash
curl -s 'http://192.168.2.90:9090/api/v1/targets?state=active' | jq -r '.data.activeTargets[] | select(.labels.job=="vllm-vision") | .health'
```
Expected: `up`. Then confirm the dashboard's vLLM Vision chip turns green and `vllm-kv-cache`/`vllm-requests` panels show the `qwen3-vl-30b-a3b` series.

- [ ] **Step 4: Mirror to the homelab doc in MyMind** — `edit_section` on doc `6d14a9c3-c421-4e49-a162-86536b8f534c` (`/projects/homelab/homelab-ai-stack-vllm-litellm-gpus.md`): add a `## Monitoring` section documenting Prometheus (LXC 111, `192.168.2.90:9090`), Grafana (LXC 112, `.91:3000`, admin user `tonycos92`), the exporter inventory (nvidia `:9835`, node `:9100`, litellm-exporter `192.168.2.85:9090`, vLLM/TEI/llama.cpp native), and the new `vllm-vision` job. Note the near-idle Zotac observation for Tony to confirm.

---

### Task 12: Final integration — live E2E, gates, docs (CONTROLLER-RUN)

**Files:**
- Create: `docs/wiki/analytics.md`
- Create: `docs/handovers/2026-07-XX-local-ai-analytics.md` (use actual date)
- Modify: `docs/superpowers/plans/00-roadmap.md` (cycle 44 row)
- Modify: `docs/BACKLOG.md` (only if items were deferred)

- [ ] **Step 1: Full-suite gates** — `pnpm typecheck` (0 errors) · `pnpm vitest run` (all green, note count) · `pnpm build` (clean).
- [ ] **Step 2: Live E2E via playwright-cli** (browser-testing skill): login → Analytics nav → health strip correct (vision green post-Task-11) → 5 GPU tiles → range switch 1h→24h re-renders → request log (409 prompt, or rows if Tony has provided the master key) → settings roundtrip (label edit reflected in legend).
- [ ] **Step 3: Wiki page** `docs/wiki/analytics.md` — status `shipped`, current behaviour: endpoints + params, panel catalog table (id → PromQL), config doc shape, defaults, the no-SSE/polling decision, the LiteLLM 409 behaviour, known limitation (spend-log latency fields only as good as LiteLLM records them).
- [ ] **Step 4: Handover doc** with accurate frontmatter (what shipped, gates evidence, deferred items, acceptance checklist for Tony: paste master key, confirm GPU labels, eyeball panels against Grafana).
- [ ] **Step 5: Roadmap row** for cycle 44 (status per actual state) linking spec/plan/handover.
- [ ] **Step 6: Commit docs; leave the branch ready for merge review** (superpowers:finishing-a-development-branch).

```bash
git add docs/
git commit -m "docs(analytics): wiki page + handover + roadmap row (cycle 44)"
```

---

## Self-Review Notes

- **Spec coverage:** data path (T2–5), all four panel groups + health strip (T3/4/8/9/10), request log via admin API (T6/10), config store + settings subpage (T1/7/10), `:8005` scrape fix + doc mirror (T11), error handling (502 mapping T4/5/6; 409 prompt T10; probe-on-save T7), testing strategy (unit tests T1–4/6/9; playwright T8–10/12), out-of-scope respected (no alerting/SSE/PromQL passthrough).
- **Type consistency:** DTOs defined once in Task 1, relocated to `shared/types/analytics.ts` in Task 8 Step 1 (server imports updated there); all later tasks import from `~~/shared/types/analytics`.
- **Known verify-at-build points (explicitly flagged, not placeholders):** `$fetch` import style in vitest (T2 S4), `/spend/logs/ui` response shape (T6 notes + fallback), Unovis prop names against installed version (T9; consult docs at build), UTable v4 column API (T10 S1).
