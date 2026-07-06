---
title: Local AI Analytics dashboard (/analytics) — Cycle 44
cycle: 44
date: 2026-07-06
status: SHIPPED — merged to master (e28510d) + deployed to prod (deploy run green, /analytics live, 2026-07-06); gates typecheck 0 / 757 tests / build; full live E2E on dev against the REAL homelab. Remaining for Tony: paste LiteLLM master key at prod /settings/analytics
branch: feat/local-ai-analytics (worktree .claude/worktrees/local-ai-analytics; built subagent-driven, 10 impl tasks + 2 controller tasks, per-task two-verdict review)
docs:
  - ../wiki/analytics.md (living reference — architecture, endpoints, panel catalog, config)
  - ../superpowers/specs/2026-07-06-local-ai-analytics-design.md (spec)
  - ../superpowers/plans/2026-07-06-local-ai-analytics.md (plan)
  - ../superpowers/plans/00-roadmap.md (cycle-44 row)
problem: >
  Tony wants Grafana-like monitoring of the local AI estate inside MyMind: GPU load on the AI rig,
  vLLM/TEI/llama.cpp engine activity, and LiteLLM request/spend analytics — one unified "Local AI"
  dashboard, usable remotely through Pangolin, without duplicating the homelab's monitoring stack.
keydecision: >
  Prometheus-native, read-and-render only: discovery established the homelab already runs Prometheus 3.7.3
  (Dell LXC 111, 192.168.2.90:9090) scraping everything needed (nvidia_gpu_exporter, vLLM native /metrics,
  TEI, llama.cpp, litellm-exporter, blackbox). MyMind adds NO collectors and NO metrics storage — a fixed
  server-side PromQL catalog (the security boundary; client can only name panel ids) + three thin endpoints
  + an encrypted analytics_config settings doc. Request-level rows come from the LiteLLM admin API
  (/spend/logs/ui) with the master key stored write-only/AES-GCM — Tony chose the admin-API path over a
  read-only pg role. External data → vue-query polling (10s/30s), explicitly NO SSE/live-bus wiring.
---

# Cycle 44 — Local AI Analytics (`/analytics`)

## What shipped (all on `feat/local-ai-analytics`, bbf505e → 6c92313)

1. **Server** — `server/lib/analytics/`: `store.ts` (analytics_config doc, encrypted `litellmMasterKeyEnc`, gpuLabels uuid→name map), `prom.ts` (the only Prometheus client; step/window tables; `toSeries` NaN→null), `queries.ts` (13 range panels + 12 snapshot queries, all metric names live-verified), `snapshot.ts` (pure assembler; null-not-zero, unknown-not-down), `litellm.ts` (spend-logs fetcher + defensive row normalizer; key decrypted only into the outbound header). Endpoints: `snapshot` / `series` (400 on unknown panel/range, `Object.hasOwn` guard) / `requests` (409 without key) + redacted GET / probing PUT settings endpoints.
2. **Frontend** — `/analytics` page (nav after Sessions): health strip (up/down/unknown chips), 5 GPU tiles, 12 Unovis chart panels (single-palette, dark-mode `--vis-*` theming, textContent-only tooltips, null gaps = line breaks), auto-refreshing request-log table (409 → "configure key" prompt), shared 1h/6h/24h/7d range tabs. `/settings/analytics` subpage (URLs, write-only master key, editable GPU labels sent as full map).
3. **Homelab** — added the missing `vllm-vision` (:8005) scrape job on LXC 111 (promtool-validated, backup kept); mirrored a new **Monitoring** section (Prometheus/Grafana/exporters — previously undocumented) into the homelab AI-stack doc in MyMind.
4. **Shared types** — DTOs in `shared/types/analytics.ts`; `AnalyticsConfig` (carries the key) stays server-only.

No DB migration. New dep: `@unovis/vue`/`@unovis/ts` (+ `maplibre-gl: false` in pnpm-workspace onlyBuiltDependencies — approve-builds byproduct).

## Review-loop finds (all fixed + re-reviewed clean)

- `series` panel lookup bypassable via prototype-chain keys (`__proto__` → 502 leak) → `Object.hasOwn` guard (7deb6e0).
- Unovis renders `null` as 0 (`isFinite(null)===true`) → gaps became zero-dips → `?? undefined` in y accessors; verified on a real TTFT gap (3 disjoint SVG subpaths) (be62e94).
- **LiteLLM contract mismatch found in live E2E**: this LiteLLM version 400s `/spend/logs/ui` without `start_date`/`end_date` in UTC `YYYY-MM-DD HH:MM:SS`; plain `/spend/logs` returns aggregates, not rows → 7-day datetime window added, error-key responses → 502, fallback filters to `request_id` rows (6c92313). End-to-end verified: real rows (key alias "James", totalPages 4866) render in the table.

## Live E2E evidence (dev, 2026-07-06)

Snapshot/series/requests + settings endpoints all exercised against the real homelab (bearer + browser): 5 GPUs with friendly labels + real telemetry; health strip caught the coder vLLM being down mid-test AND the vision chip flipped gray→red once its scrape job landed (service genuinely stopped); charts light+dark with range switching; GPU-label edit round-trip; probe-422 on bogus Prometheus URL; request log with real traffic incl. a defensively-normalized failure row. Screenshots in `.superpowers/sdd/` (worktree): `final-analytics-e2e.png`, `task-9-charts-{light,dark}.png`, `task-10-*.png`.

## Acceptance checklist (Tony)

1. Merge `feat/local-ai-analytics` → master (deploy runs migrations; none here) — or say the word and I'll finish the branch.
2. On prod `/settings/analytics`: paste the LiteLLM master key (write-only field). Note: dev already validated with the real key from the homelab doc.
3. Eyeball the GPU labels — the PNY/Zotac uuid assignment was inferred (Strix pair + P2000 are certain); labels are editable in the same tab.
4. **Rig state check (flagged during the cycle):** `vllm-vision` (:8005) is STOPPED (chip red) and the Zotac card is near-idle (~0.3 GB — voice/TEI/reranker stack apparently not resident) while blackbox still says :8883/health is up. Confirm intended state after the rig reshuffle.

## Deferred / follow-ups (none blocking)

- `litellm-cache-ratio` panel exists in the catalog but isn't gridded (cache metrics all zero today).
- Spec's "local-vs-cloud grouping" on the spend panel was dropped (plain by-model; local models log $0, making the split near-meaningless today) — flagged by the final review.
- Snapshot DTO carries `engines` (running/waiting) + `spendByModel` that the page doesn't render yet (future tiles seam) — either render or drop those 3 instant queries in a follow-up.
- Minor polish backlog from reviews: settings-tab edit race after save-invalidate (dirty-flag guard); GPU tile progress bars render null as empty-bar (text correctly shows —); positional chart colors could shift if Prometheus reorders series (one-line sort fix); `formatLitellmDate` TZ test could pin `process.env.TZ`; proto-key regression unit test.
- Ideas parked: per-key spend drill-down, request-body inspection (LiteLLM stores it), Grafana deep-links, alert thresholds (Grafana + Activity alerts already cover alerting).
