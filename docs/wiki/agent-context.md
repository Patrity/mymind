---
title: Agent Context Assembly
status: built
cycle: 70
updated: 2026-09-24
---

# Agent Context Assembly

How Bridget's prompt gets built for a turn. One function fills a token budget from ranked tiers;
what does not fit is evicted in a defined order.

**Status: built, not merged.** Migrations 0046–0051 are applied to dev only.

## The seam

`server/lib/agent/assemble.ts` → `assembleContext({ userText, conversationId, projectSlug, turns?, budget? })`

It replaced the ad-hoc pair (`buildLiveContext` + `buildMemoryContext`) that `server/api/voice/ws.ts`
used to pass separately. Its single caller is the `buildMemoryContext` adapter in `ws.ts`, whose
result becomes the `context` string handed to `buildSystemPrompt`.

`buildLiveContext` survives and has exactly one caller — the assembler. `buildMemoryContext` was
deleted; nothing calls it.

## Tiers and eviction

| Tier | Cost | Evicted |
|---|---|---|
| resident facts (`listResidentMemories()`) | fixed | never |
| live state (active projects, open tasks) | fixed | never |
| working summary (`conversations.summary`) | fixed, small | never |
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

**Caveat:** nothing writes `conversations.summary` yet, so the summary tier is always absent and
synthesis degrades to live state alone.

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

`droppedTurns: 0` is not a healthy signal — see below.

## Known gap: turns are not wired

`assembleContext`'s only caller passes **no `turns`**, so the turn tier is always empty and
`fitBudget` never evicts anything in production. `getAgentHistory` returns the full active path and
the orchestrator hands it to the model verbatim.

**Conversation history is therefore still unbounded.** The floor, the ceiling and the front-trimming
are exercised only by unit tests. Wiring it means changing the orchestrator's interface so the
trimmed history reaches the model rather than `s.history`.

## Related

- [`memory.md`](memory.md) — applicability, resident tier, enrichment sources
- [`agent.md`](agent.md) — the agent surface and turn lifecycle
- Spec: `../superpowers/specs/2026-09-23-memory-applicability-context-assembler-design.md`
- Handover: `../handovers/2026-09-24-memory-applicability-context-assembler.md`
