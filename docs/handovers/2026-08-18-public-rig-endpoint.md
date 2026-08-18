---
title: Public rig endpoint for techhivelabs.net (GET /api/public/rig)
cycle: 58-side
date: 2026-08-18
status: >
  🟡 BUILT, NOT MERGED. Branch `feat/public-rig-endpoint` (worktree `../mymind-public-rig`),
  cut from `master` at bcf48fa so it is independent of the in-flight cycle-58 branch. Gates on the
  branch: typecheck clean / test 1208 across 157 files (was 1200/156 on master; +8 tests, +1 file).
  Dev-verified on port 3050: `/api/analytics/snapshot` still 401 unauthenticated, `/api/public/rig`
  reaches the handler (no 401), sends `Access-Control-Allow-Origin: *` + `Cache-Control`, and returns
  the generic 502 because Prometheus (192.168.2.90) is not reachable from the laptop that built it —
  the real payload could NOT be observed here. Not committed, not pushed, not deployed.
branch: feat/public-rig-endpoint (worktree ../mymind-public-rig)
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

## To ship

1. Review the branch, merge ff into master, push — CD deploys it (no migration).
2. Confirm from outside: `curl -i https://brain.costanzoclan.com/api/public/rig` → 200 JSON with
   `gpus[]` (labels like "Coder A (Strix)"), `engines[]`, `services[]`, `tokens24h`, and the CORS +
   cache headers. If the rig is powered off, `gpus` is `[]` — that is the expected "asleep" shape.
3. The portfolio (branch `redesign/round-2` in portfolio-v2) fetches this URL client-side; nothing
   else to configure on the Vercel side.

## Open question

The `Cache-Control` also lands on Pangolin/Cloudflare-side caches. 30s is intentional; if the
strip ever needs to feel more "live" than that, lower `CACHE_MS` and the header together — they are
meant to match.
