---
title: Local AI Analytics (`/analytics`)
status: approved
date: 2026-07-06
cycle: 44
---

# Local AI Analytics — Design

A read-only, MyMind-native, Grafana-style dashboard for the local AI estate: GPU load on the AI rig, inference-engine activity (vLLM / TEI / llama.cpp), and LiteLLM traffic + spend. One glanceable page, usable remotely through Pangolin. All data comes from monitoring infrastructure that **already exists** — MyMind collects and stores no metrics itself.

## Decisions (locked with Tony, 2026-07-04)

| Decision | Choice |
|---|---|
| Data path | **Prometheus-native**: Nitro endpoints run PromQL server-side against the existing Prometheus; MyMind renders its own charts. No Grafana embedding. |
| Panel scope (v1) | All four: GPU telemetry, inference-engine stats, LiteLLM spend & usage, request-log table. |
| Request-log source | **LiteLLM admin API** (`/spend/logs`) with the master key stored encrypted in MyMind settings. No direct DB coupling to LiteLLM's Postgres. |
| Homelab fix | Add the missing `vllm-vision` (`192.168.2.25:8005`) scrape job to Prometheus + mirror the change into the homelab docs. Approved. |

## Existing infrastructure (verified live, 2026-07-04)

- **Prometheus 3.7.3** at `http://192.168.2.90:9090` (Dell LXC; Grafana lives separately on `.91:3000`). Already-scraped jobs relevant to this page:
  - `nvidia-gpu` → `nvidia_gpu_exporter` on the AI rig (`192.168.2.25:9835`): per-GPU `nvidia_smi_utilization_gpu_ratio`, `nvidia_smi_memory_used_bytes`, `nvidia_smi_temperature_gpu`, `nvidia_smi_power_draw_watts`, `nvidia_smi_name`, … labeled by **uuid** (lowercase, no `GPU-` prefix). 5 cards: 4× 3090 (PNY / Strix ×2 / Zotac) + Quadro P2000.
  - `vllm-coder` → vLLM native `/metrics` on `:8004` (`qwen3.6-35b-a3b`): `vllm:num_requests_running`, `vllm:num_requests_waiting`, prompt/generation token counters, TTFT histogram, KV-cache utilization. (Exact metric names re-verified at build time against the running vLLM 0.20.0.)
  - `tei` (`:8882`) and `llama-cpp-autocomplete` (`:8001`) native metrics.
  - `litellm` → `litellm-exporter` (`192.168.2.85:9090`): `litellm_total_spend{model}`, `litellm_requests_total`, `litellm_total_tokens`, `litellm_prompt_tokens`, `litellm_completion_tokens`, `litellm_cache_hits_total`/`_misses_total`, per-key/user/team spend + budget gauges.
  - `blackbox-http` probes incl. `https://lite.costanzoclan.com`, reranker `:8883/health`; `node-*` exporters on every host; `postgres` (`:9187`); `pve`.
- **Gap:** the vision vLLM (`qwen3-vl-30b-a3b`, `:8005`) is **not** scraped — only `:8004` is. Fixed as part of this slice.
- **LiteLLM** admin API at `http://192.168.2.85:4000` (LAN) / `https://lite.costanzoclan.com`. Request-level history (per-request model/tokens/latency/cost) is only available here (or in its DB) — the exporter exposes aggregates only.
- MyMind prod (LXC 114, `192.168.2.89`) and the dev Mac are both on the LAN, so server-side fetches reach all sources directly.

## Architecture

**Named-query catalog, server-side only.** The browser never talks to Prometheus or LiteLLM. A fixed catalog in `server/lib/analytics/queries.ts` maps panel IDs → PromQL templates (instant or range). The catalog is the security boundary — **no PromQL passthrough from the client**.

Three session-gated Nitro endpoints under `/api/analytics/`:

1. `GET /api/analytics/snapshot`
   One batched set of **instant** queries: per-GPU util/VRAM/temp/power, engine requests running/waiting, service `up{}` states. Powers the current-state tiles + health strip. One client request per poll; the server fans out the instant queries to Prometheus concurrently.
2. `GET /api/analytics/series?panel=<id>&range=1h|6h|24h|7d`
   `query_range` with the step auto-derived from the range (targets ~150–300 points/series). Returns normalized `{ series: [{ name, points: [t, v][] }] }`. Unknown `panel` or `range` → 400.
3. `GET /api/analytics/requests?page=&pageSize=`
   Proxies LiteLLM `/spend/logs` (master key attached server-side only), returns normalized rows: time, model, prompt/completion tokens, latency, cost, key alias, status. Response rows are sanitized to that fixed shape — request/response bodies are never forwarded.

**Config** — new `analytics_config` settings doc mirroring the `search_config`/`image_config` store pattern (`server/lib/analytics/store.ts`):

- `prometheusUrl` (default `http://192.168.2.90:9090`)
- `litellmUrl` (default `http://192.168.2.85:4000`)
- `litellmMasterKey` — encrypted at rest (same AES-256-GCM crypto as ai-config keys), **write-only** in the UI
- `gpuLabels` — uuid → friendly-name map (PNY / Strix A / Strix B / Zotac / P2000), because the exporter only reports "3090". Seeded at build time from the rig's `nvidia-smi --query-gpu=uuid,pci.bus_id,name` cross-referenced with the homelab bus→card table; editable in settings. UUID format normalized (exporter uses lowercase without the `GPU-` prefix).

Edited at a new `/settings/analytics` subpage (routed subpage pattern from the settings-subpages cycle). Saving probes `{prometheusUrl}/api/v1/status/buildinfo` to validate; the master key field is optional (only the request-log panel needs it).

## Panels (v1)

1. **Health strip** (top) — up/down chips from `up{}` + existing blackbox probes: vLLM coder, vLLM vision, TEI, reranker, llama.cpp autocomplete, LiteLLM, Prometheus itself.
2. **GPU telemetry** — per-card current-state tiles (name, util %, VRAM used/total bar, temp, power) + time-series charts: utilization, VRAM, power (one line per card, friendly names).
3. **Inference engines** — vLLM requests running/waiting; token throughput (prompt vs generation, `rate()`); TTFT p50/p95 (`histogram_quantile`); KV-cache %; TEI request rate. Vision engine appears once its scrape job lands.
4. **LiteLLM spend & usage** — requests & tokens over time by model; spend by model with local-vs-cloud grouping (local = the rig-served model names); cache hit ratio.
5. **Request log** — auto-refreshing paginated table from `/spend/logs`.

Shared time-range picker (1h / 6h / 24h / 7d) top-right; all range charts follow it.

## Frontend

- Page `app/pages/analytics.vue`; sidebar item **Analytics** (chart icon) next to Activity.
- Charts: **Unovis** (`@unovis/vue` + `@unovis/ts`) — Vue-native, tree-shakeable, composes with Nuxt UI. The **`dataviz` skill governs** chart form, color, and layout decisions at build time.
- Data via **vue-query polling**: snapshot + request log every ~10 s, range series every ~30 s and on range change. This is *external* data — **no SSE/live-channel wiring**; the cycle-21 `publishChange` bus is for app-owned resources only (`add-live-resource` deliberately does not apply).
- Panel isolation: each panel renders/fails independently. A source being down shows an inline panel error; the page never blanks.

## Error handling

- 5 s timeouts on all server-side fetches; upstream failure → structured 502 from the endpoint, rendered as a panel-level error state.
- No master key configured → request-log panel shows a "configure in Settings → Analytics" prompt (not an error).
- LiteLLM `/spend/logs` failures (bad key, 5xx) surface the upstream status without retry storms (vue-query default backoff).

## Homelab-side change

Add a `vllm-vision` scrape job (`192.168.2.25:8005/metrics`) to the Prometheus config on the monitoring LXC (`192.168.2.90`) and reload. Mirror the change into the homelab AI-stack doc in MyMind (which also gains the previously-undocumented monitoring-stack facts found during discovery: Prometheus `.90:9090`, Grafana `.91:3000`, exporter inventory).

## Prerequisites / credentials

- **LiteLLM master key**: Tony pastes it into `/settings/analytics` at acceptance time (write-only field, encrypted at rest). Not needed for any other panel.
- No new Prometheus credentials — it is unauthenticated on the LAN and only ever accessed server-side.

## Testing

- **Unit** (vitest, pure helpers, no network): query-catalog builders, Prometheus response → series transform, step derivation, spend-log row normalizer, GPU-uuid label resolution.
- **Live E2E** (playwright-cli on dev, real LAN sources): page renders, all panels populate from the real Prometheus, range switch re-queries, request log populates once a key is configured, settings save validates the Prometheus URL.
- Gates: `pnpm typecheck` / `pnpm test` / `pnpm build`.

## Out of scope (v1)

- Alerting (Grafana + the Activity alert channels already cover it).
- Arbitrary PromQL explorer / custom user-defined panels.
- Non-AI homelab panels (media stack, cameras, storage).
- Grafana embedding; request-body drill-down; per-request tracing.
- Historical retention beyond what Prometheus keeps.
