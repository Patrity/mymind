---
title: Memory applicability + resident tier + budgeted context assembler
cycle: 70
date: 2026-09-24
status: built
branch: worktree-cycle-70-memory-assembler
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-09-23-memory-applicability-context-assembler-design.md
plans:
  - ../superpowers/plans/2026-09-23-memory-applicability-context-assembler.md
wiki:
  - ../wiki/memory.md
  - ../wiki/agent.md
migrations:
  - 0046 memories.applicability
  - 0047 memories.resident + retrieval counters + CHECK
  - 0048 conversations.context_epoch_at
  - 0049 mem_enrichment_state PK -> (source_kind, source_id) [hand-written ALTER]
  - 0050 review_queue polymorphic targets [kind-dependent backfill]
  - 0051 review-queue unique index gains `kind`
migrations_run_on_prod: false
---

# Cycle 70 — memory applicability, resident tier, budgeted context assembler

**Built on `worktree-cycle-70-memory-assembler`. NOT merged, NOT pushed, NOT deployed. Migrations
0046–0051 have been applied to the DEV database only** — prod is still at 46 migrations with no
`applicability` column.

Groundwork for a persistent, proactive Bridget. A persistent session is unbounded and the context
window is not, so memory becomes the compression layer that makes it possible at all.

## Read this first: what is NOT delivered

Three things the spec promises that this branch does not do. They are not oversights discovered
late — each was ruled on deliberately — but the cycle's headline claim is weaker than the spec's.

1. **Budget eviction does not run.** `assembleContext` has one caller and it passes no `turns`, so
   `fitBudget`'s turn tier is exercised only by unit tests. Nothing else trims history either.
   **Conversation history remains unbounded**, which is materially different from what spec §4.1
   promises. Confirmed on the live system: a real turn logged `droppedTurns: 0`. Wiring it means
   changing the orchestrator's interface so the *trimmed* history reaches the model rather than
   `s.history` — surgery on the live turn path, deferred rather than rushed at the end of a cycle.
   (Ruling 20.)
2. **`/clear` has no entry point.** The epoch mechanism works end to end and `getAgentHistory`
   honours it, but nothing sets it: `clearConversationContext` has no production caller. This is
   cycle 71's first deliverable (`docs/superpowers/specs/2026-09-24-slash-commands-design.md`).
3. **`conversations.summary` has no writer.** Spec §3.4 claimed this cycle was that worker; it is
   not. So the summary tier is always absent and `synthesiseQuery` — the mechanism that makes a
   proactive turn possible without a user message — degrades to live state alone.

Also: **the applicability backfill underdelivered.** On dev it classified 93% of 1,599 memories as
uncertain and produced **6** `global` memories. The global tier is frozen at 6 with no growth path,
because the resident-promotion path that was supposed to fill it is not wired either (see §4).
Ruling 18's decision to stop queueing the uncertain middle stands; its stated justification does not.

## 1. Shipped

- **`memories.applicability`** (`global` | `project`, default `project`) and **`memories.resident`**
  (boolean, with a DB CHECK that resident implies global). Two columns, not one, because "travels
  across projects" (~200 memories) and "worth tokens on every turn" (~30) are different populations.
- **`memories.retrieval_count` / `last_retrieved_at`**, written batched by the assembler. Intended to
  let the resident tier nominate itself from measured cross-project usage rather than a model's
  opinion of importance.
- **`project` is now documented as provenance** — where a fact was *learned*. Retrieval changed from
  `eq(project, X)` to `applicability = 'global' OR project = X` in both `searchMemories` and
  `listMemories`. `project: null` still means "memories with no project", deliberately not folded in.
- **`server/lib/agent/budget.ts`** — pure tier fitting. Fixed tiers never evicted, retrieval trimmed
  first, recent turns keep a 40% floor *and* a ceiling.
- **`server/lib/agent/salience.ts`** — structural re-ranking (relevance, recency, project match,
  contradiction, trust). Explicit constants, no fitted model, no LLM value judgment.
- **`server/lib/agent/assemble.ts`** — one budgeted assembler replacing the ad-hoc
  `buildLiveContext` + `buildMemoryContext` pair. 1.5s bound around the whole assembly, 0.2 relevance
  floor, fire-and-forget retrieval credit. Emits `memory:assemble` telemetry (`used`, `droppedTurns`,
  `retrievedCount`).
- **`conversations.context_epoch_at` + `clearConversationContext`** — `/clear` forgets without
  deleting. `loadActivePath(id, { sinceEpoch })` is opt-in; `getAgentHistory` passes it,
  `getConversation` does not. That asymmetry is the design.
- **`enrichConversations`** — enrichment now reads Bridget conversations, not just Claude Code
  sessions. `mem_enrichment_state` is keyed `(source_kind, source_id)`.
- **`review_queue` is polymorphic** (`target_kind`, `target_id`), uniqueness now includes `kind`.
- **`sweepMemoryConcerns`** — files contradictions, resident nominations and stale candidates. Built,
  tested, and **deliberately gated out of the cron** (see §4).

## 2. Findings worth keeping

Three production bugs, all in the plan rather than in any implementation, and none visible from a
green test suite:

- **`fitBudget` starved retrieval to zero.** The turn-floor arithmetic was algebraically dead
  (`min(turnFloor, turnTokens) <= turnTokens` makes the guard a no-op) and turns packed greedily into
  all remaining budget. A probe at budget 1000 / fixed 100 / 40 turns / 10 memories returned
  **9 turns, 0 memories**. Turns needed a ceiling as well as a floor. The plan's own mutation check
  passed — it specified the wrong mutation.
- **`/clear` silently ate the next message.** The epoch was stamped with the *app* clock
  (`new Date()`) while `conversation_messages.created_at` comes from the *Postgres* clock. Real skew
  is ~1ms, but **18 of 20** rows written straight after an epoch landed earlier than it. Fixed by
  sourcing the epoch from `sql\`now()\`` so both timestamps share one clock. A single-shot test
  passed ~90% of the time, which is why it presented as a flake.
- **Migration 0050 would have caused an outage.** The plan named three `review_queue` writers; there
  are six. `triage.ts` and `enrichment.ts` also insert directly and would have raised NOT NULL on
  `target_id` on every write the moment it shipped.

**Five tests in this cycle could not fail** (a sixth was caught by the final review). The recurring
shape: a test whose name describes a behaviour that an unrelated gate makes unreachable. One was
caught only because a mutation check produced *zero* failures and the implementer treated that as
suspicious rather than as a pass.

## 3. Verified on prod before merging

Prod state read 2026-09-24: 46 migrations, 2,187 live memories, 535 `mem_enrichment_state` rows,
65 conversations / 269 conversation_messages, 11 active `contradicts` edges, and review_queue holding
**41 `memory-contradict` + 21 `memory-supersede`** rows whose `doc_id` is a `memories.id`.

After migrating, verify both backfills landed on the right side:

```sql
select source_kind, count(*) from mem_enrichment_state group by 1;   -- expect session|535
select target_kind, kind, count(*) from review_queue group by 1,2;
```

Every `memory-supersede`/`memory-contradict` row must read `target_kind='memory'`, the enrichment and
triage rows `document`. A zero in the memory row means the backfill flattened two id namespaces.

**Back up first** — 0049 renames a column and swaps a primary key on 535 rows. Data-preserving and
verified on dev's 370, but the one awkward-to-reverse step. Dump to `/root/db-backups`, not
`/opt/mymind` (CD wipes that tree).

**Watch the first enrichment cron cycle.** `enrichConversations` will sweep 65 real conversations for
the first time ever. It requires ≥5 new messages, ~1h idle, and has a 24h error backoff, but it has
never run against real data.

## 4. Deliberately gated off

`sweepMemoryConcerns()` is **not** called from `server/tasks/enrich-memories.ts`. It files
`contradiction`, `resident-promotion` and `stale` kinds, and `server/api/review/kinds.ts` has approve
handlers for none of them — approving returns `400 Unknown review kind`, and `/review` renders them
as a malformed enrichment card. A 15-minute cron filing rows a human cannot resolve is worse than no
sweep. (Ruling 22.)

Consequence: **nothing writes `memories.resident`.** `listResidentMemories()` returns `[]` in
production, the resident fixed tier is permanently empty, and the resident-promotion path that was
meant to grow the global tier does not exist end-to-end. Unblocking it needs approve/reject handlers
plus a `/review` card — a follow-up cycle.

## 5. Browser validation

Done on a dev server at :3070 (`PORT=` plus a matching `BETTER_AUTH_URL`, or every login 400s).

**Passed:** a real turn runs through the assembler end to end —
`memory:assemble | ok | {"used": 254, "droppedTurns": 0, "retrievedCount": 5}`, reply in 1.8s at
142.9 tok/s. New columns surface through the live API. `/review` renders 47 pending items. `/agent`
renders fine — the tracked "blank in dev" issue (`3201e7a4`) did not reproduce.

**Not proven:** I asked Bridget a question only answerable from a seeded resident memory and she
answered from a different one. Inconclusive. `listResidentMemories`' predicate does return the
memory, and the assembler pushes that result unconditionally — so the resident tier reaches the
prompt *by code path*, observed through the query rather than by reading a prompt.

**The budget-drift test stays `it.skip`.** `contextTokens` reaches the UI (the meter read 5.5%) but
is not recorded in `activity_log`, so there is still no measured number for the fixture. An invented
one would pass forever and hide the drift it exists to catch.

## 6. Deferred, with MyMind tasks

| Item | Why deferred |
|---|---|
| Wire `turns` into `assembleContext` | Orchestrator surgery; needs browser validation first (Ruling 20) |
| `/clear` entry point | Cycle 71 |
| `conversations.summary` writer | No task in the plan; spec §3.4 undelivered |
| Approve/reject handlers + `/review` cards for the 3 concern kinds | Unblocks `sweepMemoryConcerns` and the resident tier |
| Route conversation enrichment through `resolveEnrichedMemory` | Today it bypasses dedup/relations and lands `project: null` |
| Repo-wide `.db.test.ts` constant-embedding stub hazard | Cost one red gate this cycle and one real flake later |
| 4 parked residuals from the final fix wave | See ledger Ruling 24 |
| `c-users-tonyc` project-resolution bug | A Windows home dir canonicalised into a project slug |
| `memory-judge.ts` → a Jev `Choice` | Narrow enum call; deliberately not bundled |
