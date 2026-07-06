---
title: Local AI Analytics
status: built
cycle: 44
updated: 2026-07-06
---

# Local AI Analytics — `/analytics`

**status: built** (cycle 44 — dev live-validated end-to-end; awaiting Tony's acceptance + prod deploy)

A read-only, Grafana-style dashboard for the local AI estate: per-GPU telemetry on the AI rig, inference-engine activity (vLLM / TEI / llama.cpp), LiteLLM traffic + spend, and a live request log. MyMind **collects and stores no metrics** — everything is read server-side from the homelab's existing Prometheus (`192.168.2.90:9090`, Dell LXC 111) and the LiteLLM admin API (`192.168.2.85:4000`).

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
- `gpuLabels` — GPU uuid (lowercase, no `GPU-` prefix) → friendly name. Seeded: Strix pair = Coder A/B (390W default limit), PNY = Vision, Zotac = voice/util, P2000 = Autocomplete. **Saved wholesale** (a PUT with `gpuLabels` replaces the whole map — the settings UI always sends the full map)

## Frontend

`app/pages/analytics.vue` (nav: **Analytics**, after Sessions) — health strip (`up`/`down`/`unknown` chips) → 5 GPU tiles → 12 Unovis chart panels → request-log table. Shared 1h/6h/24h/7d range tabs.

- **Polling, no SSE** — this is external data; the cycle-21 live bus is for app-owned resources. vue-query: snapshot + requests every 10s, series every 30s; requests hook has `retry: false` (409 must not retry-storm).
- Charts: Unovis (`@unovis/vue`); pure `pivotSeries` util merges series on timestamp; **null gaps render as line breaks** (`?? undefined` in the y accessors — Unovis treats `null` as 0 because `isFinite(null)===true`); one palette array drives lines + crosshair + legend; `--vis-*` CSS vars themed per light/dark; tooltips built with `textContent` (labels are user-editable → XSS-safe).
- Request log: 409 → info alert linking to `/settings/analytics` (not an error); real rows show time/model/tokens/latency/cost/key-alias/status.

## Homelab-side change (2026-07-06)

Added the missing **`vllm-vision`** scrape job (`192.168.2.25:8005`, Bearer `VllmCoderTest2026`, 30s) to Prometheus on LXC 111 (`promtool` validated; backup at `prometheus.yml.bak-vllm-vision`). The homelab AI-stack doc in MyMind gained a **Monitoring** section (Prometheus/Grafana/exporter inventory — previously undocumented). At change time the vision service was **stopped** (chip correctly red) and the Zotac near-idle — flagged to Tony to confirm intended rig state.

## Known limitations / accepted

- LiteLLM `/spend/logs/ui` contract is version-sensitive (dates required, `YYYY-MM-DD HH:MM:SS`); the `/spend/logs` 404-fallback yields an empty page on very old versions (aggregates are filtered out, never junk rows).
- Spend/latency values are only as good as LiteLLM records them (local models log $0).
- Chart series colors are positional per render; if Prometheus ever reorders results for the same label set, a series' color could shift between polls (one-line upstream sort if it bites).
- Narrow edit race in the settings tab: a background config refetch right after Save can clobber keystrokes typed in that window (dirty-flag guard if it bites).

## Files

`server/lib/analytics/{types,store,prom,queries,snapshot,litellm}.ts` · `server/api/analytics/{snapshot,series,requests}.get.ts` · `server/api/settings/analytics-config.{get,put}.ts` · `shared/types/analytics.ts` (DTOs; `AnalyticsConfig` stays server-only) · `app/composables/useAnalytics.ts` · `app/utils/analytics-pivot.ts` · `app/components/analytics/{HealthStrip,GpuTiles,TimeSeriesChart,RequestLogTable}.vue` · `app/components/settings/AnalyticsTab.vue` · `app/pages/analytics.vue` · `app/pages/settings/analytics.vue`. Tests: `test/analytics-{store,prom,queries,snapshot,litellm,pivot}.test.ts` (32 unit tests). No migration.
