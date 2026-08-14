---
title: Token & cost analytics — Claude Code + LiteLLM usage tab
cycle: 55
date: 2026-08-14
status: spec — approved in brainstorm, not yet planned
tasks: d3b04767
related:
  - ../../wiki/analytics.md (cycle 44 — the live-telemetry page this adds a tab to)
  - ../../wiki/sessions.md (the ingest that has been collecting this data since April)
  - ../../handovers/2026-08-13-mcp-sdk-v2-migration.md (cycle 54 — most recent)
---

# Token & cost analytics

A **Usage** tab on `/analytics` showing historical token consumption and API-equivalent value across
Claude Code sessions and LiteLLM, with per-model breakdown, cache economics, and agent-dispatch
composition.

## The finding that shapes this cycle

**No new collection is needed for the Claude Code half.** `messages.usage` has been populated since
2026-04-04 and already carries everything the dashboard needs:

```jsonc
{
  "input_tokens": 2, "output_tokens": 2694,
  "cache_read_input_tokens": 833477, "cache_creation_input_tokens": 8271,
  "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 8271 },
  "service_tier": "standard", "speed": "standard",
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "iterations": [ /* per-iteration breakdown */ ]
}
```

Coverage on the local corpus: **81,954 of 96,737** messages have `usage`. The 15% gap is user
messages, which legitimately have none. Alongside it, `messages.model` (9 distinct ids),
`messages.is_sidechain`, and `tool_events` (`tool_name='Agent'` → 2,671 dispatches, with
`args.subagent_type` and `args.model`) supply the dispatch and fleet panels.

So this cycle is **aggregation, pricing, and presentation** — not instrumentation. That is why it is
scoped as one cycle rather than a collection project.

**The pipeline was proven before this spec was written**, not assumed. Running the real cost model
over the real local rows:

| model | API-equivalent value | tokens |
|---|---:|---:|
| claude-opus-4-7 | $16,909.38 | 18.45B |
| claude-opus-4-8 | $7,240.42 | 7.08B |
| claude-fable-5 | $642.13 | 0.36B |
| claude-opus-4-6 | $423.36 | 0.49B |
| others (haiku-4-5, sonnet-4-6, sonnet-4, opus-4-1) | $52.53 | 0.19B |
| **total** | **$25,267.82** | **26.56B** |

95.5% of all tokens are cache reads. (Local dev corpus only, which ends 2026-06-16; prod holds the
live data.)

## Non-goals

**Instrumenting anything new in the Claude Code path.** The data is already there. If a panel needs a
field we don't store, the panel is cut, not the ingest widened.

**A "commits" tile.** The screenshot that prompted this has one, and we cannot build it honestly:
`sessions.git_commit` is the HEAD *at session start*, not commits *made* (49 distinct locally).
Counting `Bash` events matching `git commit` would undercount work done outside Claude Code, and
shelling out to `git log` would put filesystem and repo access into the analytics request path.
Replaced with **Sessions**, which is real and already stored.

**Real-money accounting for Claude Code.** See the framing rule below — this cycle deliberately does
not claim to know what was spent.

**Per-project or per-repo cost attribution.** `sessions.project_id` makes this straightforward later,
but it multiplies the panel count and the query surface. Out of scope; the schema does not preclude it.

## The framing rule (non-negotiable, and the reason for a naming decision)

Claude Code is billed by subscription, not per token. An "Estimated cost: $25,267.82" tile would
therefore assert something false — that is money that was never spent. The figure is still the
interesting one (it is the value of the work at API rates), so it ships as **"API-equivalent value"**,
and every surface that renders it says so.

**LiteLLM spend is different: it is real money.** The two must stay visually and semantically distinct
on the page, and must never be summed into a single headline number.

## Data model

Two new tables. Migration **0031**. Neither alters an existing table.

### `model_prices`

| column | type | note |
|---|---|---|
| `model` | text PK | e.g. `claude-opus-4-7` |
| `input_cost_per_token` | numeric | |
| `output_cost_per_token` | numeric | |
| `cache_read_cost_per_token` | numeric | |
| `cache_creation_cost_per_token` | numeric | the 5-minute tier |
| `cache_creation_above_1h_cost_per_token` | numeric | the 1-hour tier |
| `source` | text | provenance, e.g. `litellm-price-map` |
| `fetched_at` | timestamptz | |

Populated by a periodic task from LiteLLM's public
`model_prices_and_context_window.json`. **Verified before speccing:** that map contains **all eight
real models** in our corpus (`claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-4-6`,
`claude-opus-4-1-20250805`, `claude-fable-5`, `claude-sonnet-4-6`, `claude-sonnet-4-20250514`,
`claude-haiku-4-5-20251001`), each carrying the granular fields the cost model requires
(`cache_read_input_token_cost`, `cache_creation_input_token_cost`,
`cache_creation_input_token_cost_above_1hr`).

The ninth id seen in the data, `<synthetic>`, is **not** in the map and never will be — it is Claude
Code's marker for locally-generated messages, not a billable model. It is the concrete case the
unpriced bucket below exists to handle, and the fixture the "unpriced model" test should use.

Rates are **stored, not fetched per render**, for three reasons: the map is 1.7 MB (far too heavy for
a page load), storing it keeps the cost tile working when the network or homelab is unreachable, and
it leaves an auditable record of which rate produced a given number.

### `litellm_daily`

| column | type |
|---|---|
| `day` | date |
| `model` | text |
| `tokens` | bigint |
| `spend` | numeric |
| `requests` | bigint |

Primary key `(day, model)`. A daily task rolls up the LiteLLM metrics already scraped into
Prometheus (`litellm_total_spend`, `litellm_total_tokens`, `litellm_requests_total` — the same series
the existing panels query via `server/lib/analytics/queries.ts:50-66`).

**Correcting a premise raised during brainstorm:** LiteLLM history is *not* limited to 7 days. That
cap applies only to the request-log endpoint (`/spend/logs/ui`); the aggregate metrics live in
Prometheus. What persistence actually buys is history beyond Prometheus retention (undocumented in
this repo, commonly 15d by default, and unverifiable from outside the LAN) plus a single-store query
for the combined chart instead of a Postgres⋈Prometheus join per render.

This is a deliberate, scoped exception to the cycle-44 rule that "MyMind collects and stores no
metrics." The rule stands for live telemetry; it is what caps usable history here. The wiki must
record the exception and its reason so a later reader doesn't "fix" it.

## The cost calculation

```
value = input                × input_cost_per_token
      + output               × output_cost_per_token
      + cache_read           × cache_read_cost_per_token
      + ephemeral_5m         × cache_creation_cost_per_token
      + ephemeral_1h         × cache_creation_above_1h_cost_per_token
      + residual             × cache_creation_cost_per_token
```

where `residual = cache_creation_input_tokens − (ephemeral_5m + ephemeral_1h)`.

**The residual term is not defensive padding — it is load-bearing.** 3 rows of 81,954 carry a
non-zero `cache_creation_input_tokens` while both ephemeral tiers read `0` (9,084 tokens
unaccounted). Dropping it would silently under-report. It is priced at the 5-minute rate, the
cheaper of the two, so the unknown tier cannot inflate the figure.

Getting this wrong is the single most likely way this feature ships a wrong number: cache reads are
95.5% of all tokens and price at roughly **10%** of the input rate. Applying a flat input rate to
them would overstate the total by close to an order of magnitude.

**Unpriced models are never silently zeroed.** `<synthetic>` (181 rows) and any future model absent
from the price map aggregate into an explicit "unpriced" bucket, surfaced on the page with its token
count. A zero that looks like data is worse than a gap that admits it.

## Panels

**Tiles (4):** Total tokens (with cache-read %), API-equivalent value, Agent dispatches, Sessions.

**Charts:**
- Stacked daily bar — tokens by model over the range (the primary chart)
- "Where the value went" — horizontal bars, value by model
- Fleet composition — dispatch counts by `args.subagent_type`
- LiteLLM row — real spend, from `litellm_daily`, labelled as actual money and kept visually distinct

Default range **30 days, daily buckets**; selector for 7d / 30d / 90d / all.

Aggregation runs as a direct query over `messages` (81k rows locally, filtered by date and joined to
`model_prices`). No pre-aggregation table for Claude Code data in this cycle — if the query proves
slow on the prod corpus, a rollup is a follow-up, not a prerequisite. That decision should be
revisited with a real `EXPLAIN` against prod rather than assumed either way.

## Placement

`/analytics` gains tabs: **Infrastructure** (everything the page shows today — live GPU, engine, and
LiteLLM telemetry) and **Usage** (this).

The current page is 48 lines (`app/pages/analytics.vue`), so this is a small restructure. Note the
two tabs need **different range controls**: Infrastructure uses the existing `RangeKey`
(1h/6h/24h/7d) bound to Prometheus step derivation; Usage uses day-granularity ranges
(7d/30d/90d/all).

**Decision: the range control moves out of the navbar and into each tab's own body**, with its own
ref and its own type (`RangeKey` for Infrastructure, a new `UsageRangeKey` for Usage). The
alternative — keeping one navbar control and making it tab-aware — was rejected because it invites a
single shared `range` ref, and the two value spaces are disjoint: a `7d` that means "Prometheus range
query with a 3h rate window" and a `7d` that means "seven daily buckets from Postgres" are different
things that happen to spell the same. Sharing that ref would typecheck and silently produce wrong
queries on tab switch.

Live telemetry and historical usage are different kinds of data, and interleaving them on one scroll
makes both harder to read — that is the reason for tabbing rather than appending.

## Endpoints

Two new, both session/bearer-gated by the existing global middleware, following the established
`server/api/analytics/*` shape:

| Endpoint | Returns |
|---|---|
| `GET /api/analytics/usage?range=7d\|30d\|90d\|all` | tiles + daily series by model + value by model + unpriced bucket |
| `GET /api/analytics/dispatches?range=…` | dispatch counts by `subagent_type` |

Range values are validated against a fixed set before any query runs, matching how the existing
catalog validates panel ids — an unknown range is a 400, never an interpolated string.

## Testing

- **Pure cost function, unit-tested** (`server/lib/analytics/cost.ts`): the five rate terms, the
  residual branch (its own case, with the real 3-row shape), an unpriced model returning a bucket
  rather than 0, and a zero-usage row. This is the piece most likely to be wrong and the easiest to
  test in isolation — it must take usage + rates as arguments and touch no DB.
- **Aggregation query** against a seeded fixture: correct day bucketing across a boundary, correct
  per-model grouping, sidechain rows included (they are real usage).
- **Price-map extraction**: given a fixture slice of the LiteLLM JSON, upserts the five rates; a
  model missing `cache_creation_input_token_cost_above_1hr` falls back to the 5m rate rather than
  writing null.
- **Endpoints**: unknown `range` → 400.
- DB-touching tests go in `*.db.test.ts` (excluded from the CI gate, which has no Postgres).
- Browser-validate the tab with `playwright-cli` per project convention — the two tabs' range
  controls not sharing state is exactly the kind of wiring bug green unit tests never catch.

## Risks

**The cost model is the risk.** Everything else is presentation. The mitigations are the pure
unit-tested function, the explicit unpriced bucket, and the residual term above.

**Price drift.** Rates change; stored rates are a snapshot with `fetched_at`. This cycle applies
*current* rates to *historical* usage, so the headline figure will shift when prices change. That is
acceptable and should be stated on the page. Applying period-correct historical rates is a
substantially larger design (rate versioning + effective dating) and is explicitly deferred.

**Prometheus retention is unverified.** The `litellm_daily` backfill can only reach as far back as
Prometheus retains. Early history may be thin; the first rollup should record what window it actually
found rather than presenting a short series as complete.

**Local corpus ≠ prod.** All numbers in this spec come from the local dev DB, which ends 2026-06-16.
Prod is larger. Query performance must be checked there.

## Documentation

`docs/wiki/analytics.md` gains a Usage section: the two new tables, the cost formula including the
residual, the API-equivalent-value framing rule, and the explicit note that `litellm_daily` is a
deliberate exception to the page's "stores no metrics" design. Mirrored to MyMind.
