---
title: Local AI Analytics
status: shipped
cycle: 55
updated: 2026-08-14
---

# Local AI Analytics — `/analytics`

**status: shipped** (cycle 44 — merged + deployed to prod 2026-07-06; dev live-validated end-to-end against the real homelab). **Usage tab added cycle 55 — 🚧 built, not deployed**: implemented on `feat/usage-analytics` (10 commits), held at an explicit pre-merge pause (this cycle adds tables, so rollback isn't the trivial revert prior no-schema cycles had); nothing below the [Usage tab](#usage-tab-cycle-55) heading is live in prod yet. See the [roadmap](../superpowers/plans/00-roadmap.md) row 55.

A dashboard for the local AI estate, split into two tabs. **Infrastructure** (cycle 44, shipped): per-GPU telemetry on the AI rig, inference-engine activity (vLLM / TEI / llama.cpp), LiteLLM traffic + spend, and a live request log — read-only, everything read server-side from the homelab's existing Prometheus (`192.168.2.90:9090`, Dell LXC 111) and the LiteLLM admin API (`192.168.2.85:4000`), nothing persisted. **Usage** (cycle 55, not yet deployed): historical token consumption and API-equivalent value across Claude Code sessions and LiteLLM spend, sourced from Postgres — see [Usage tab](#usage-tab-cycle-55) below.

MyMind **collects and stores no metrics for the Infrastructure tab** — that data is always read live from Prometheus/LiteLLM, never persisted. **One deliberate, scoped exception**: the Usage tab's `litellm_daily` table persists a daily rollup of LiteLLM traffic, specifically *because* the no-storage rule above caps usable history at Prometheus's own retention window. Do not "fix" `litellm_daily` back to a live Prometheus read — see [Usage tab](#usage-tab-cycle-55).

## Architecture

The browser never talks to Prometheus or LiteLLM. A fixed **named-query catalog** (`server/lib/analytics/queries.ts`) is the security boundary — the client can only name a panel id; only PromQL defined in the catalog ever executes (panel/range membership is validated with `Object.hasOwn` before any upstream call).

### Endpoints (session/bearer-gated by the global auth middleware)

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/analytics/snapshot` | Current-state: per-GPU util/VRAM/temp/power, engine running/waiting, service up/down, spend-by-model | Fans out all 12 instant queries concurrently; missing metrics → `null` (never 0); unscraped service → `up: null` (unknown) |
| `GET /api/analytics/series?panel=<id>&range=1h\|6h\|24h\|7d` | Range series for one panel | Step auto-derived (30s/120s/300s/3600s); rate/increase windows 2m/10m/30m/3h; unknown panel/range → 400 |
| `GET /api/analytics/requests?page=&pageSize=` | LiteLLM request log | Proxies `/spend/logs/ui` with a **UTC `YYYY-MM-DD HH:MM:SS` 7-day window** (this LiteLLM version 400s without it); rows sanitized to a fixed shape; **409** when no master key configured |
| `GET/PUT /api/settings/analytics-config` | Config | GET is redacted (`hasLitellmKey`, never the key); PUT zod-validates + probes a **changed** `prometheusUrl` against `/api/v1/status/buildinfo` (3s) before saving |

Upstream fetches: 5s timeouts, failures → 502, panel-level isolation in the UI (one source down never blanks the page).

### Panel catalog (ids)

`gpu-util`, `gpu-vram`, `gpu-power`, `gpu-temp` (per-card, legends via the gpuLabels map) · `vllm-requests` (running/waiting), `vllm-throughput` (prompt/gen tok/s), `vllm-ttft` (p50/p95 ms), `vllm-kv-cache` · `tei-rate` (embeds/min) · `litellm-requests`, `litellm-tokens`, `litellm-spend` (by model, `increase()` over window, zero-filtered) · `litellm-cache-ratio` (in the catalog, **not gridded** — enable if cache metrics become non-zero).

## Config — `analytics_config` settings doc

Mirrors the `search_config`/`image_config` store pattern (`server/lib/analytics/store.ts`; module cache + `invalidateAnalyticsConfig()`). Edited at **`/settings/analytics`**.

- `prometheusUrl` (default `http://192.168.2.90:9090`), `litellmUrl` (default `http://192.168.2.85:4000`)
- `litellmMasterKeyEnc` — AES-256-GCM via the ai-config `encryptSecret`; write-only in the UI; decrypted only inside `server/lib/analytics/litellm.ts` and only into the outbound Authorization header
- `gpuLabels` — GPU uuid (lowercase, no `GPU-` prefix) → friendly name. Seeded: Strix pair = Coder A/B (390W default limit), Zotac = voice/util (steady ~23 GB stack), PNY = Image Gen (ComfyUI, on-demand), P2000 = Autocomplete. **Saved wholesale** (a PUT with `gpuLabels` replaces the whole map — the settings UI always sends the full map)

## Frontend

`app/pages/analytics.vue` (nav: **Analytics**, after Sessions) — a `UTabs` switches between **Infrastructure** (default) and **Usage** (cycle 55). Each tab keeps its own range `ref` — `range` (`RangeKey`) for Infrastructure, `usageRange` (`UsageRangeKey`) for Usage — deliberately not shared; see [Usage tab](#usage-tab-cycle-55).

**Infrastructure tab**: health strip (`up`/`down`/`unknown` chips) → 5 GPU tiles → 12 Unovis chart panels → request-log table. Shared 1h/6h/24h/7d range tabs.

- **Polling, no SSE** — this is external data; the cycle-21 live bus is for app-owned resources. vue-query: snapshot + requests every 10s, series every 30s; requests hook has `retry: false` (409 must not retry-storm).
- Charts: Unovis (`@unovis/vue`); pure `pivotSeries` util merges series on timestamp; **null gaps render as line breaks** (`?? undefined` in the y accessors — Unovis treats `null` as 0 because `isFinite(null)===true`); one palette array drives lines + crosshair + legend; `--vis-*` CSS vars themed per light/dark; tooltips built with `textContent` (labels are user-editable → XSS-safe).
- Request log: 409 → info alert linking to `/settings/analytics` (not an error); real rows show time/model/tokens/latency/cost/key-alias/status.

**Usage tab**: see the dedicated section below for its data model, endpoints, and frontend detail.

## Usage tab (cycle 55)

**🚧 built, not deployed** — implemented on `feat/usage-analytics`; not yet merged to master or deployed. Everything below is verified against the code on that branch, not confirmation it is live in prod.

Historical token consumption and API-equivalent value, computed from data MyMind already collects (`messages.usage`, populated by the session ingest since April — see [`sessions.md`](sessions.md)) plus two new tables that supply pricing and durable LiteLLM history. No changes to the ingest — `messages`/`sessions`/`tool_events` are read-only inputs to this tab.

### New tables — migration `0031_zippy_random.sql`

| Table | Key | Columns | Populated by |
|---|---|---|---|
| `model_prices` | PK `model` | five `numeric` rate columns — `input_cost_per_token`, `output_cost_per_token`, `cache_read_cost_per_token`, `cache_creation_cost_per_token`, `cache_creation_above_1h_cost_per_token` — plus `source`, `fetched_at` | `server/tasks/sync-model-prices.ts`, cron `0 4 * * *`. Mirrors LiteLLM's public `model_prices_and_context_window.json` for every model MyMind has actually seen (`SELECT DISTINCT model FROM messages`) — no reason to store rates for the thousands of models never used. `numeric`, not `real`: rates are ~1e-7 magnitude multiplied by billions of tokens, where float drift would be visible. 8 rows on the current corpus. |
| `litellm_daily` | composite PK `(day, model)` | `tokens` (bigint), `spend` (numeric), `requests` (bigint) | `server/tasks/rollup-litellm-daily.ts`, cron `20 0 * * *`. Sums the same Prometheus series the Infrastructure tab's live panels already query (`litellm_total_tokens` / `litellm_total_spend` / `litellm_requests_total`, `increase(...[24h])`) into one row per model per day. Idempotent — re-running the same day overwrites via `onConflictDoUpdate`, never duplicates. |

**Rollup skew**: the cron fires at `00:20` UTC and reads `increase(...[24h])` ending at execution time — not a true `00:00`-to-`00:00` calendar-day window. Each row is therefore offset ~20 minutes (~1.4%) from the calendar day it's labelled with. The offset is constant, contiguous, and never causes gaps or double-counting — it just means a `litellm_daily` row will not tie out exactly against a hand-computed true-calendar-day Prometheus aggregate. Don't chase that mismatch as a bug.

### The cost formula — `server/lib/analytics/cost.ts`

`parseUsage(raw)` reads a `messages.usage` jsonb blob into six token counts: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and two ephemeral splits nested under `cache_creation` — `ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`. Never throws; an unreadable blob parses to all-zero.

`computeValue(tokens, rates)` prices six terms:

```
value = input × rate.input
      + output × rate.output
      + cacheRead × rate.cacheRead
      + ephemeral5m × rate.cacheCreation
      + ephemeral1h × rate.cacheCreationAbove1h
      + residual × rate.cacheCreation      // residual = max(0, cacheCreation − (ephemeral5m + ephemeral1h))
```

**The residual term is load-bearing, not padding.** `cache_creation_input_tokens` is the reported total for cache-write tokens; the two ephemeral fields are supposed to split that total by TTL tier, but on the real corpus they don't always sum back to it — 3 rows report exactly 81,954 in `cache_creation_input_tokens` while both ephemeral tiers read 0. Drop the residual term and those tokens silently price at $0. It's priced at the cheaper 5-minute rate (never the 1h rate), so an unknown tier can't inflate the total, and clamped at `≥ 0`, so an over-counted split can't drive the total negative.

**Cache reads must never be priced at the input rate.** On the real corpus, cache reads are **~95% of all tokens** (95.5% measured) and LiteLLM's `cache_read_cost_per_token` prices at roughly **10% of `input_cost_per_token`**. `computeValue` prices `cacheRead` at its own dedicated rate — but collapsing that distinction (e.g. "simplifying" by pricing all input-side tokens at one rate) is the single easiest way a future change breaks the dashboard's headline number: 95% of the token volume would get repriced at ~10× its real rate, roughly **10×ing** the whole figure.

Aggregation (`server/services/usage.ts`) sums the same six jsonb fields **in SQL**, twice: once grouped by `model` — `computeValue` runs once per model over that model's whole-range totals, feeding `byModel` and the headline totals — and once grouped by `(day, model)`, which feeds the daily stacked chart with **raw token sums only** (`UsageDayPoint.byModel`; no per-day pricing). Either way, `computeValue` never runs per row — the real corpus is tens of thousands of `messages` rows, and summing in SQL first keeps the cost math off the per-row path. (A comment in the source says `computeValue` runs "per (model, day) group" — that's stale; the day-grouped query only ever produces token counts, never a priced value.)

### The unpriced bucket

A model with no row in `model_prices` is **skipped, never priced at $0** — its tokens accumulate into `unpriced.tokens` and its name into `unpriced.models`, both returned separately from `totals.valueUsd`. `<synthetic>` — Claude Code's marker for locally-generated (non-API) messages — is the permanent example; it will never appear in a price map because it was never billed. On the current corpus `<synthetic>` has 181 message rows, but every one carries an **all-zero** token count, so `unpriced.tokens` evaluates to `0` and the UI's unpriced-tokens note (`UsageTiles.vue`, only renders when `unpriced.tokens > 0`) doesn't show today. The mechanism is correct — proven during build with a mocked nonzero payload — it's just currently invisible on this data. A future model that both lacks a price entry AND carries nonzero usage will surface it.

### API-equivalent value vs. real spend

Claude Code is **subscription-billed** — nothing on this tab's Claude Code side is money actually spent. The "API-equivalent value" tile computes what the same usage would have cost at API list rates, purely as a cost-awareness signal, and is labelled **"at API rates — not billed"** in the UI (`UsageTiles.vue`). **LiteLLM spend is real money** (`litellm_daily.spend`, sourced from LiteLLM's own billing) and renders as its own visually distinct panel (warning-ring `UCard`, "Actual spend" badge, explicit "never summed with it" copy) — it is never added into the API-equivalent total anywhere in the code (`app/pages/analytics.vue`'s `litellmTotalSpend` is computed independently of `usage.totals.valueUsd`).

### Two range types, deliberately not shared

| | Prometheus (`RangeKey`, `shared/types/analytics.ts`) | Usage (`UsageRangeKey`, `shared/types/usage.ts`) |
|---|---|---|
| Values | `1h \| 6h \| 24h \| 7d` | `7d \| 30d \| 90d \| all` |
| Backs | Infrastructure tab panels | Usage tab (daily Postgres buckets; `rangeStart()` truncates to UTC midnight, `all` = no lower bound) |

Both spell `7d`, but a Prometheus `7d` derives a scrape step for a live query while a Usage `7d` is seven daily rollup buckets — they are not interchangeable. `app/pages/analytics.vue` keeps two separate `ref`s (`range` for Infrastructure, `usageRange` for Usage); a single shared ref would typecheck (both are string-literal unions that happen to contain `'7d'`) while silently querying the wrong granularity the moment the two tabs' selections diverged.

### Endpoints (session/bearer-gated, same `server/middleware/auth.ts` as the rest of `/api/**`)

| Endpoint | Purpose |
|---|---|
| `GET /api/analytics/usage?range=7d\|30d\|90d\|all` | `UsageResponse` — totals (tokens, cache-read %, API-equivalent value, sessions, dispatches), per-model breakdown, daily-by-model series, the unpriced bucket, and the LiteLLM daily series. Unknown `range` → 400. |
| `GET /api/analytics/dispatches?range=` | `DispatchResponse` — counts `tool_events` rows where `tool_name = 'Agent'`, grouped by `args->>'subagent_type'` (falls back to `'(unspecified)'`). Unknown `range` → 400. |

Both backed by `server/services/usage.ts` (`getUsage`, `getDispatches`, `isUsageRange`, `rangeStart`).

### Chart colour assignment

`UsageStackedChart.vue` and `UsageBreakdownBars.vue` share one colour algorithm, duplicated rather than extracted (per the build's file-scope constraint): `hashIndex(modelName) % 8` picks a slot in the existing 8-hue `CATEGORICAL_LIGHT`/`CATEGORICAL_DARK` palette (the `dataviz` skill's categorical palette, copied verbatim from `TimeSeriesChart.vue`, which doesn't export it). A raw hash alone collides on the real model set, so `resolveColorSlots()` walks the label set **alphabetically** (a criterion stable across range switches, unlike a value/count rank) and linear-probes forward from each label's raw slot when it's already taken, bounded to `mod` attempts so it can't spin forever.

The resolution input is deliberately the **canonical** model set — every model ever seen (`useUsage('all')`, fetched once, gated to the Usage tab, cached 30 minutes) — not whichever subset happens to be visible in the currently-selected range. Resolving per-range would let a model's colour reshuffle across a range switch whenever the competing model set changed. `app/pages/analytics.vue` computes the slot map once and passes it to both the stacked chart and the "Where the value went" breakdown bars, so a given model reads the same colour in both places.

With **9** distinct models against an **8**-hue palette, one collision is pigeonhole-forced — no assignment function, deterministic or not, can give 9 items 8 mutually exclusive colours. On the current corpus that's `claude-opus-4-6` and `claude-sonnet-4-6`, both landing on slot 2. This is expected and disclosed, not a bug to chase; it recurs any time the model count exceeds 8.

### Measured on the local corpus (`range=all`)

$25,267.88 API-equivalent value, 26.56B tokens (95.5% cache reads), 2,671 agent dispatches across 454 sessions.

## Homelab-side change (2026-07-06)

Added the missing **`vllm-vision`** scrape job (`192.168.2.25:8005`, Bearer `VllmCoderTest2026`, 30s) to Prometheus on LXC 111 (`promtool` validated; backup at `prometheus.yml.bak-vllm-vision`). The homelab AI-stack doc in MyMind gained a **Monitoring** section (Prometheus/Grafana/exporter inventory — previously undocumented). At change time the vision service was **stopped** (chip correctly red) and the Zotac near-idle — flagged to Tony to confirm intended rig state.

## Known limitations / accepted

- LiteLLM `/spend/logs/ui` contract is version-sensitive (dates required, `YYYY-MM-DD HH:MM:SS`); the `/spend/logs` 404-fallback yields an empty page on very old versions (aggregates are filtered out, never junk rows).
- Spend/latency values are only as good as LiteLLM records them (local models log $0).
- Chart series colors are positional per render; if Prometheus ever reorders results for the same label set, a series' color could shift between polls (one-line upstream sort if it bites).
- Narrow edit race in the settings tab: a background config refetch right after Save can clobber keystrokes typed in that window (dirty-flag guard if it bites).

## Files

**Infrastructure tab (cycle 44):** `server/lib/analytics/{types,store,prom,queries,snapshot,litellm}.ts` · `server/api/analytics/{snapshot,series,requests}.get.ts` · `server/api/settings/analytics-config.{get,put}.ts` · `shared/types/analytics.ts` (DTOs; `AnalyticsConfig` stays server-only) · `app/utils/analytics-pivot.ts` · `app/components/analytics/{HealthStrip,GpuTiles,TimeSeriesChart,RequestLogTable}.vue` · `app/components/settings/AnalyticsTab.vue` · `app/pages/settings/analytics.vue`. Tests: `test/analytics-{store,prom,queries,snapshot,litellm,pivot}.test.ts` (32 unit tests). No migration.

**Usage tab (cycle 55, 🚧 built, not deployed):** `server/db/schema/{model-prices,litellm-daily}.ts` · migration `server/db/migrations/0031_zippy_random.sql` · `server/lib/analytics/{cost,prices}.ts` · `server/services/usage.ts` · `server/tasks/{sync-model-prices,rollup-litellm-daily}.ts` · `server/api/analytics/{usage,dispatches}.get.ts` · `shared/types/usage.ts` · `app/components/analytics/{UsageTiles,UsageStackedChart,UsageBreakdownBars}.vue`. Tests: `test/usage-{range,cost,prices}.test.ts` + `test/usage-aggregation.db.test.ts` (DB-tagged, `pnpm test:db` only — not in the CI/deploy gate).

**Shared across both tabs:** `app/composables/useAnalytics.ts` (`useSnapshot`/`useUsage`/`useDispatches`) · `app/pages/analytics.vue` (now tabbed).
