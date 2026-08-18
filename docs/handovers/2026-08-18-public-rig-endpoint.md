---
title: Public rig endpoint for techhivelabs.net (GET /api/public/rig)
cycle: 58-side
date: 2026-08-18
status: >
  ✅ SHIPPED. Merged ff into `master` (`51d4a60..7578d46`) and pushed 2026-08-18; deployed by CD run
  **32158308477** (test ✅ / deploy ✅, no migration). Note the ff also carried three docs-only
  cycle-58 commits (`6d13141`, `96e7cfa`, `bcf48fa`) that were on local master but not yet on origin —
  `docs/**` is path-ignored by the pipeline, so they did not affect the deploy. Verified from outside
  after cutover: `GET https://brain.costanzoclan.com/api/public/rig` → **200 JSON** with
  `access-control-allow-origin: *` and `cache-control: public, max-age=30`; payload carried 5 GPUs by
  prod label (P2000 (Autocomplete), PNY (Image Gen), Strix A/B (LLM), Zotac (voice/util)), engine
  `ornith-1.0-35b`, services 4/5 up (vllm-vision down, as the private dashboard also showed), and
  `tokens24h` ≈ 602K. `/api/analytics/snapshot` still 401s unauthenticated; `/api/health` 200. The
  consumer (techhivelabs.net homepage strip, portfolio-v2 `main` 7f01101) rendered "Live from the
  rig" with that payload within a minute of cutover. Gates on the merged tree: typecheck clean /
  test 1208 across 157 files.
branch: feat/public-rig-endpoint — merged ff into master at 7578d46, worktree removed, branch deleted
spec: none — a small side change requested during the techhivelabs.net redesign session
plan: none
docs:
  - ../wiki/analytics.md (new "Public rig endpoint" section)
  - ../wiki/auth.md (PUBLIC_PREFIXES now lists /api/public)
task: 7ef08dfb-a498-4b3e-b8af-d07d0394f7d7 (MyMind, portfolio project — the consumer side)
---

# Public rig endpoint (side change, 2026-08-18)

## Why

The techhivelabs.net redesign added a "Live from the rig" strip under the homepage stats. The
first draft shipped its own cron (`nvidia-smi` + LiteLLM `/v1/models` → status.json). Tony pointed
out MyMind's analytics slice already scrapes LiteLLM, vLLM, and Prometheus, and the deployment is
already internet-exposed at brain.costanzoclan.com. So: one curated public endpoint here, and the
portfolio's cron + proxy go away.

## What changed

- `server/middleware/auth.ts` — `/api/public` added to `PUBLIC_PREFIXES`. This is the only
  security-relevant line. Everything under `/api/public/**` is unauthenticated by design; there is
  exactly one file there today.
- `server/api/public/rig.get.ts` — the route. Fans out `PUBLIC_RIG_SNAPSHOT_IDS` +
  `tokens24h` via the existing `promInstant`, reuses `buildSnapshot`, then `buildPublicRig`.
  30s in-process cache, `Cache-Control` (30s success / 15s error), CORS `*`, generic 502.
- `server/lib/analytics/public-rig.ts` — pure allow-list curation into `PublicRigResponse`.
- `server/lib/analytics/queries.ts` — `PUBLIC_RIG_SNAPSHOT_IDS`, `PUBLIC_RIG_EXTRA_QUERIES`
  (`sum(increase(litellm_total_tokens[24h]))`), `PUBLIC_RIG_SERVICE_IDS`.
- `shared/types/analytics.ts` — `PublicRigGpu`, `PublicRigResponse`.
- `test/analytics-public-rig.test.ts` — 8 tests (allow-list, no spend/power/uuid leak, service
  filter + tri-state, tokens24h scalar/null, catalog membership).

## What is deliberately NOT public

Spend (money), GPU uuids, power draw/limits, the LiteLLM exporter / edge probe / Prometheus
service rows, request logs, anything from the Usage tab. Extend only in `buildPublicRig()`.

## Shipped

Merged, deployed by CD run 32158308477, and verified from outside (see status). One consumer-side
lesson worth recording: a cross-origin **401 without CORS headers** (this endpoint before it was
deployed) reaches the browser as a status-less network error, and Nuxt's `useFetch` normalises that
into `statusCode: 500`. The portfolio strip first painted "rig asleep" for that case; it now uses a
raw client fetch and hides on any status-less failure or 4xx, showing "asleep" only for a 5xx that
actually carried CORS (i.e. this handler's own generic 502) or a 200 with no GPU reporting.

## Follow-up (same day)

Tony's review of the live strip: the vision service is retired (it only ever showed "down"), and
`engines` under-reports the rig because only vLLM exposes running/waiting — llama.cpp, TEI, TTS and
image gen all route through LiteLLM. Added `models24h` (LiteLLM request roster over 24h, by
model, most-used first, capped at 12) to the payload and dropped `vllm-vision` from
`PUBLIC_RIG_SERVICE_IDS`. Private `SERVICES` in `snapshot.ts` still lists the vision job — that is
the analytics dashboard's call, not this endpoint's.

## Open question

The `Cache-Control` also lands on Pangolin/Cloudflare-side caches. 30s is intentional; if the
strip ever needs to feel more "live" than that, lower `CACHE_MS` and the header together — they are
meant to match.
