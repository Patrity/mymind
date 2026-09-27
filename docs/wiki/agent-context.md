---
title: Agent Context Assembly
status: built
cycle: 73
updated: 2026-09-27
mymind_id: 4802c314-4adc-45e1-b9de-9484f1aba301
mymind_hash: 6627d663eec6df8c2338917ca31e07b218b38470c279b76a35b249384f43ac29
---

# Agent Context Assembly

How Bridget's prompt gets built for a turn. One function fills a token budget from ranked tiers;
what does not fit is evicted in a defined order.

**Status: built, not merged.** Migrations 0046–0051 are applied to dev only.

## The seam

`server/lib/agent/assemble.ts` → `assembleContext({ userText, conversationId, conversationKind?, projectSlug, turns?, budget? })`

It replaced the ad-hoc pair (`buildLiveContext` + `buildMemoryContext`) that `server/api/voice/ws.ts`
used to pass separately. **Since cycle 73 its caller is the runtime runner**
(`server/lib/agent/runtime/runner.ts`, see [agent-runtime.md](agent-runtime.md)), which passes
`turns` and `budget: RUNTIME_CONTEXT_BUDGET` (**20000**) and hands the result to `handleTurn` as the
`context` string for `buildSystemPrompt`. (The legacy in-socket path, `server/lib/voice/ws-legacy.ts`,
still calls it the cycle-70 way — no turns, default budget 6000 — until cycle 74 deletes it.)

`buildLiveContext` survives and has exactly one caller — the assembler. `buildMemoryContext` was
deleted; nothing calls it.

## Tiers and eviction

| Tier | Cost | Evicted |
|---|---|---|
| resident facts (`listResidentMemories()`) | fixed | never |
| live state (active projects, open tasks) | fixed | never |
| working summary (`conversations.summary`) | fixed, small | never |
| `recent-threads` (main thread only, cycle 73) | fixed, ≤ 600 tokens | never |
| `main-state` (side threads only, cycle 73) | fixed, ≤ 300 tokens | never |
| retrieved memories | elastic | **first** |
| recent turns | elastic, floor **and** ceiling | only below its floor |

`server/lib/agent/budget.ts` owns the arithmetic:

```
available    = budget - fixedTokens          // throws ResidentOverflowError if fixed alone > budget
turnFloor    = floor(budget * 0.4)
turnCeiling  = max(turnFloor, available - retrievalWant)
```

Turns get a **ceiling as well as a floor**. Without the ceiling they pack greedily into all remaining
budget and retrieval is starved to zero — which is what the first implementation did (9 turns, 0
memories on a persistent-session shape). Turns are kept newest-first, trimmed from the front.

`ResidentOverflowError` is thrown rather than absorbed: a self-nominating resident tier can outgrow
its allocation, and silently truncating it would degrade every turn with nothing in the logs.

## Proactive turns

A proactive turn has no user message, so there is nothing to embed against. When `userText` is empty
the query is **synthesised from state** — the rolling summary plus live state
(`synthesiseQuery()`). With neither text nor state, it does not search at all.

`conversations.summary` has a writer since cycle 73 (see [Summaries](#summaries-and-the-two-flow-up-tiers-cycle-73)),
so a thread with more than 6 turns and enough history has a summary to synthesise from; a short
thread still degrades to live state alone.

## Ranking

`server/lib/agent/salience.ts` re-ranks search results before they compete for budget. Semantic
relevance alone knows nothing about contradictions, recency or trust.

`WEIGHTS` are **explicit constants, not a fitted model** — with 45 hand labels a learned ranker would
fit noise. Every feature is observable structure:

- semantic relevance, recency (90-day half-life), project match, `applicability='global'`
- **active `contradicts` edge → the largest boost (0.5)** — a contradiction is the most damaging
  thing in the store because agents act on it confidently
- `reviewed_at IS NULL` → reduced trust

Measured on those 45 labels, an LLM's 4-level "value" rubric predicted keep-vs-stale at **AUC 0.55 —
chance**. No signal here is a model's opinion of importance.

`searchMemories` hydrates relations (via `fetchRelationsForIds`) so the contradiction boost can
actually fire; without that `contradictedIds` is always empty and the weight is inert.

## Bounds and hygiene

- **1.5s timeout around the whole assembly** (`ASSEMBLE_TIMEOUT_MS`). A `safe()` wrapper catches
  throws, not hangs — a slow embeddings rig must degrade the turn, not block it. On timeout the turn
  proceeds with no memory augmentation.
- **0.2 relevance floor.** Below that a hit is noise, and it would otherwise earn a `retrieval_count`
  credit — polluting the very signal resident nomination depends on.
- **Retrieval credit is fire-and-forget** (`.catch` attached), never awaited on the turn path, and
  only for memories that survived the budget.
- Resident memories are de-duplicated out of the retrieved set so they are never paid for twice.

## Telemetry

Each assembly records `memory:assemble` to `activity_log` with `used`, `droppedTurns`,
`retrievedCount` and `conversationId`. A real turn on dev logged:

```
memory:assemble | ok | {"used": 254, "droppedTurns": 0, "conversationId": null, "retrievedCount": 5}
```

That row predates cycle 73: with no turns wired, `droppedTurns: 0` was vacuous. Runtime turns now
pass turns and budget 20000; a main-thread turn on dev (cycle 73) logged
`{"used": 14015, "droppedTurns": 0, "retrievedCount": 12, "runId": "…", "conversationId": "…"}`.

## Turns are wired (cycle 73)

The cycle-70 gap — `assembleContext`'s only caller passed no `turns`, so history was unbounded — is
closed. The runner:

1. reads history with `getAgentHistory`, which walks the active path with `sinceEpoch` **and**
   `sinceSummary` (rows at or before `conversations.summarized_through` reach the model only as the
   summary tier; `getConversation`, the UI read, still returns everything);
2. groups it into turns (`groupTurns`, `server/lib/agent/runtime/history.ts` — a turn starts at a
   user-role row that follows a non-user row, so an assistant's tool blocks never split from it
   and a steer joins the turn it was typed into) and costs each with `turnTier`;
3. passes `turns.map(turnTier)` + `budget: 20000` (turn floor 40% = 8000);
4. keeps only the trailing `turns.length - droppedTurns` turns (`keepTrailingTurns`) as the
   structured history the model receives.

The `memory:assemble` activity row now carries a real `droppedTurns`, plus `runId`.

## Summaries and the two flow-up tiers (cycle 73)

- **Writer:** `maybeSummarize` (`server/lib/agent/runtime/summarize.ts`). Skips threads with ≤ 6
  turns, and (unless forced) tails ≤ 12 000 tokens. Otherwise folds all but the last 6 turns into
  `summary` via `chat('bulk')` (incremental: previous summary + new turns), sets
  `summarized_through` to the last folded row's Postgres `created_at`, re-embeds
  `summary_embedding`. Called after every persisted run (fire-and-forget) and by the `*/10`
  `summarize-threads` task for side threads idle ≥ 30 min.
- **`recent-threads`** (when `conversationKind === 'main'`): `Recent side threads (summaries):` then
  `- <title>: <summary>` for up to 8 side threads with a summary and `last_message_at` in the last
  48 h, newest first, capped to 600 tokens (`capToTokens`).
- **`main-state`** (when `conversationKind === 'thread'`): `Bridget's main thread, lately: <first
  paragraph of main's summary>`, capped to 300 tokens; absent until main has a summary.
- Both are capped **at the source**: an unbounded fixed tier that overflows `fitBudget` throws
  `ResidentOverflowError` and blanks every fixed tier (the cycle-71 lesson).

Verified in the browser (cycle 73 acceptance): after a 7-turn side thread was folded, the next main
turn's assembled context contained `Recent side threads (summaries):` with that thread's title.

## Related

- [`memory.md`](memory.md) — applicability, resident tier, enrichment sources
- [`agent.md`](agent.md) — the agent surface and turn lifecycle
- Spec: `../superpowers/specs/2026-09-23-memory-applicability-context-assembler-design.md`
- Handover: `../handovers/2026-09-24-memory-applicability-context-assembler.md`
