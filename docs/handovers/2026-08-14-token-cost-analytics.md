---
title: Token & cost analytics — Claude Code + LiteLLM usage tab (cycle 55)
cycle: 55
date: 2026-08-14
status: >
  ✅ SHIPPED. Merged to `master` fast-forward on 2026-08-14 (`a24eee4..985b635`, 15 commits), pushed,
  and deployed by CD run **31861147144** (test ✅ / deploy ✅ — the run that applied migration 0031).
  Prod verified in-container after cutover: both new tables present, `drizzle.__drizzle_migrations`
  at **32** rows (was 31, so 0031 landed), existing data intact (**147,078** messages / **597**
  sessions), and a live authenticated round-trip on `/api/analytics/usage?range=30d` returning real
  aggregates (10.9B tokens, 96.76% cache reads, 83 sessions, 1,197 dispatches), `range=1h` → 400,
  and `/api/analytics/dispatches` returning the real subagent breakdown.
  Tasks 1-8 each review-clean (3 fix rounds: Task 3 ×1, Task 7 ×2, Task 8 ×1). Final whole-branch
  review returned "Merge with fixes"; all six applied and re-reviewed clean.
  Gates at HEAD before merge: **typecheck 0 / test 1136 across 148 files / test:db 37 across 5 files
  / build clean**.
branch: feat/usage-analytics — merged fast-forward into master at 985b635, branch deleted
spec: ../superpowers/specs/2026-08-14-token-cost-analytics-design.md
plan: ../superpowers/plans/2026-08-14-token-cost-analytics.md
docs:
  - ../wiki/analytics.md (Usage tab: two tables, cost formula incl. the residual, API-equivalent
    framing, unpriced bucket, the metrics-storage exception, cold-start window) — mirrored to MyMind
  - ../superpowers/plans/00-roadmap.md (cycle 55 row)
task: d3b04767 (MyMind)
---

# Token & cost analytics (cycle 55)

A **Usage** tab on `/analytics` showing historical token consumption and API-equivalent value across
Claude Code sessions and LiteLLM.

## ⚠️ Read this first if the value tile shows $0.00

**That is the expected cold-start state, not a bug.** `model_prices` is empty until the `0 4 * * *`
cron runs, and `litellm_daily` until `20 0 * * *`. Until then every model falls into the unpriced
bucket and `totals.valueUsd` is 0. Confirmed live immediately after this deploy.

**There is no way to trigger those tasks in production.** `/_nitro/tasks` is dev-only and absent from
the built output, and neither task has an admin endpoint. The remedies are: wait for the cron, or
seed `model_prices` directly. The "N tokens from unpriced models" note under the tiles is the honest
signal during the window.

## The finding that shaped the cycle

**No new collection was needed.** `messages.usage` has carried the data since 2026-04-04 — 81,954 of
96,737 local rows (the gap is user messages, which legitimately have none), with `input_tokens`,
`output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`cache_creation.{ephemeral_5m,ephemeral_1h}`, `service_tier`, `speed`, `server_tool_use`. Plus
`messages.model`, `messages.is_sidechain`, and `tool_events` (`tool_name='Agent'` +
`args.subagent_type`) for the dispatch and fleet panels.

So this was aggregation, pricing and presentation — not instrumentation.

## What shipped

**Tables (migration `0031_zippy_random.sql`)** — `model_prices` (PK `model`, five `numeric` rate
columns, `source`, `fetched_at`) and `litellm_daily` (composite PK `(day, model)`, `tokens`, `spend`,
`requests`). Two `CREATE TABLE`s, no `ALTER`, no `DROP`, no lock on `messages`.

**`server/lib/analytics/cost.ts`** — pure, unit-tested `parseUsage` + `computeValue`.

**`server/services/usage.ts`** — `isUsageRange`, `rangeStart`, `getUsage`, `getDispatches`.
Endpoints `GET /api/analytics/usage` and `/dispatches`, range validated before any query (400 on
unknown).

**Scheduled tasks** — `sync-model-prices` (`0 4 * * *`) mirrors LiteLLM's price map;
`rollup-litellm-daily` (`20 0 * * *`) persists a daily rollup of the Prometheus series the live
panels already query.

**UI** — `/analytics` is now tabbed (Infrastructure / Usage). Four tiles, a daily stacked chart, two
breakdown-bar panels, and a visually distinct LiteLLM panel labelled **actual spend**.

## The cost model — and the two ways it can silently be wrong

```
value = input×in + output×out + cache_read×cread
      + ephemeral_5m×ccreate + ephemeral_1h×c_above_1h
      + residual×ccreate          // residual = max(0, cache_creation − (5m + 1h))
```

1. **Cache reads are ~95% of all tokens and price at ~10% of the input rate.** Pricing them at the
   input rate overstates the whole dashboard ~10×. There is a dedicated regression test for this.
2. **The residual term is load-bearing.** 3 of the 81,954 usage-bearing rows report a non-zero
   `cache_creation_input_tokens` (**3,028 each, 9,084 total**) while both ephemeral tiers read 0.
   Priced at the cheaper 5m rate, clamped at ≥0. Deleting the term must break its tests — proven
   red-then-green during Task 2.

**The headline number was derived six independent ways** and all agree at **$25,267.88** on the local
corpus (26,557,846,570 tokens, 95.5% cache reads): raw SQL during brainstorm, the shipped cost
function, the aggregation endpoint, a reviewer's from-scratch SQL, exact Postgres `numeric`
arithmetic, and the shipped JS path. Per-day sums reconcile with per-model sums at **diff 0**.

## Framing rules that must not be relaxed

- Claude Code is subscription-billed, so its figure is **"API-equivalent value"**, never "cost". The
  tile carries "at API rates — not billed".
- **LiteLLM spend is real money** — visually distinct panel, and the two are **never summed**.
- **Unpriced models are never zeroed.** A model absent from the price map is skipped and its tokens
  surface in an explicit bucket. `<synthetic>` is the permanent example (Claude Code's marker for
  locally-generated messages; its 181 local rows carry all-zero token counts, so the UI note doesn't
  render on that corpus today — the mechanism is correct but currently invisible there).
- **The two range types are deliberately separate.** `RangeKey` (`1h|6h|24h|7d`, Prometheus) vs
  `UsageRangeKey` (`7d|30d|90d|all`, daily Postgres buckets). Both spell `7d` and mean different
  things; one shared ref would typecheck and silently query wrongly.
- **`litellm_daily` is a deliberate exception** to the analytics page's "collects and stores no
  metrics" rule — that rule is what caps history at Prometheus retention. The wiki records the
  exception; don't "fix" it back.

## Seven plan defects execution caught (all mine)

The plan was written from verified APIs, and execution still found seven errors in it. Two would
have shipped broken:

1. **`raw.githubusercontent.com` serves `.json` as `text/plain`**, so Nitro's `$fetch` returned a
   *string* and the first price sync upserted **0 of 9 models** — every model unpriced, value tile
   $0. Caught by the plan's own "confirm cache-read is ~10% of input" step.
2. **`responseType: 'json'` wasn't sufficient**: `destr` silently returns the raw string on a parse
   failure, so a GitHub outage page would have reproduced the same silent zero-pricing. Now guarded,
   with the guard observed firing.
3. A db-test ignored that `useRuntimeConfig` is a Nuxt auto-import unavailable under plain vitest.
4. **My arithmetic was wrong** — a fixture asserted 0.0042 where the correct sum is 0.0043. The
   implementer fixed the *expectation*, not the implementation; the reverse would have been a bug.
5. & 6. **`defineTask`'s generic inference collapses across multi-shape returns** — hit twice, in two
   different tasks. Any future multi-return `defineTask` needs an explicit return-type annotation.
7. **"3 rows of 81,954" was ambiguous** (meaning 3-*of*-81,954) and became a false claim about token
   values in the wiki before being corrected. The source comment is now unambiguous.

## Two fixes that needed their own scrutiny

Worth knowing, because both would have passed every gate:

- **Closing the chart-colour collision added an unbounded full-history query to every `/analytics`
  load**, including for users who never opened the Usage tab. `range='all'` has no date bound and
  grows with the corpus (prod: ~95 MB temp spill, 180 ms). Now gated to the tab with a 30-min
  `staleTime`.
- The same round **also closed a latent correctness bug**: with an empty canonical set, each chart
  fell back to its *own* colour resolution, and since the breakdown bars render a priced-only subset,
  the two panels could have disagreed on a model's colour.

## Follow-ups

1. **Cheap canonical-model source.** The chart's model set still comes from `useUsage('all')` — the
   endpoint's most expensive query. A `SELECT DISTINCT model` endpoint is the right answer; deferred
   as server scope.
2. **`num()` doesn't clamp negatives** (`cost.ts`) — but note the service uses an independent SQL
   path (`coalesce(…::bigint, 0)`) that also doesn't clamp, so fixing `num()` alone protects nothing.
   Fix the SQL with `greatest(0, …)` or neither.
3. **`toFixed(20)` isn't decimal-safe** (`prices.ts`) — one live row stores `0.00007499999999999999`.
   Relative error 1.3e-13; `String(v)` is the one-line fix and the next cron overwrites the value.
4. **Palette + `hashIndex` + `chromeVars` are triplicated** across three chart components (forced by
   task file scope). Extract to `app/utils/chart-palette.ts`; the copies are byte-identical today.
5. **`UsageStackedChart` has no `pending` prop** — shows the empty state during load rather than a
   skeleton.
6. **Days with no usage are dropped, not zero-filled** — a calendar gap renders as adjacent bars.
7. **No index on `messages.created_at`** — every range does a full parallel seq scan.
8. **One forced colour collision on prod.** 10 distinct models (prod has `claude-opus-5`, which local
   lacks) against an 8-hue palette means two pigeonhole-forced collisions.
9. **`(usage->>'…')::bigint` throws where `parseUsage` doesn't** — a non-integer token field would
   500 the endpoint. Zero such rows across all prod blobs today; latent only.

## Process notes

- **The prod DB is reached at `127.0.0.1:5432`**, not the `db:5432` host in `/opt/mymind/.env` — that
  hostname is a Docker-era leftover and resolves to a public IP from a shell. Rewrite the host when
  running psql by hand: `sed "s#@db:#@127.0.0.1:#"`.
- `pgrep -f <repo path>` has matched unrelated browser processes on this machine — walk the real
  process tree with `pgrep -P` instead, and killing a `pnpm` wrapper PID doesn't kill its
  `nuxt.mjs dev` child.
- Dev-server checks must read the startup log for the actual port; 3000 is often taken and Nuxt
  silently falls back to 3001.
