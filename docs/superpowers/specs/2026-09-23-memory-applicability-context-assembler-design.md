---
title: "Memory applicability + resident tier + budgeted context assembler — groundwork for a persistent, proactive Bridget (cycle 70)"
cycle: 70
date: 2026-09-23
status: spec
supersedes: null
mymind_task: e6a18a43
---

# Memory applicability + budgeted context assembler (cycle 70)

Bridget is meant to become a proactive, always-on agent with a **persistent session** on `/agent` —
one continuous thread rather than a series of conversations you start and abandon.

A persistent session is unbounded. The context window is not. So memory stops being a lookup
Bridget consults and becomes **the compression layer that makes the persistent session possible at
all**. That is the whole reason this cycle comes before the agent work: get it wrong and the
persistent session either forgets everything the moment it overflows, or never overflows because it
was never really persistent.

This cycle builds the memory substrate and the retrieval machinery. It does **not** build the
proactive behaviours themselves — see [Out of scope](#out-of-scope).

## 1. What is actually wrong today

Four findings, all measured against prod on 2026-09-22/23, not assumed.

### 1.1 `project` records where a fact was learned, not where it applies

**69 of 74 live `scope='user'` memories carry a project**, spread across 22 different projects.
Enrichment runs per-session, a session has a project, and the memory inherits it. The column is
provenance wearing applicability's clothes.

| project | memory |
|---|---|
| `3d-rpg` | Tony rejects time-based implementation estimates; prefers scoping by concrete work items |
| `bulk-wave-materials-2` | Tony prefers to leave others' uncommitted edits alone |
| `claude-agent` | Tony values persistent memory as 'the magic' in his AI agent workflow |
| `c-users-tonyc` | Tony sets Claude Code effortLevel to xhigh, alwaysThinkingEnabled |

The first two are universal working preferences filed under whichever project happened to reveal
them.

Note also that `c-users-tonyc` is a **Windows home directory canonicalised into a project slug**,
holding four user-scope memories. That is a separate data bug in project resolution, recorded in
[§8](#8-open-questions-and-known-defects) rather than fixed here.

### 1.2 The silo is not in retrieval — there is simply no resident tier

`searchMemories` filters by project only when a caller passes one, and `buildMemoryContext` does
not pass one. Global search already reaches every memory.

The real gap is in `server/lib/agent/context.ts`: **active projects and open tasks are loaded into
every turn unconditionally; memories are only ever fetched by semantic relevance to the user's
message** — top 5, relevance threshold 0.2.

That asymmetry is the bug. A preference surfaces only if the user's wording happens to embed near
it, and preferences are precisely the thing you need loaded *before* you know they are relevant.
You cannot query for a preference you do not know exists.

### 1.3 Talking to Bridget produces no memories at all

`server/services/memory-enrich.ts` reads `sessions` + `messages`. `conversations` and
`conversation_messages` are a different pair of tables and nothing enriches them.
`mem_enrichment_state` is keyed on `session_id` as its primary key.

**Every one of the 2,117 live memories came from a Claude Code transcript.** For a persistent
session this is fatal: it would accumulate forever and graduate nothing.

### 1.4 The salience ranker cannot use an LLM value judgment

45 hand-labelled memories (`scripts/data/memory-labels-2026-09-22.jsonl`, blinded, built this week)
scored against Jev:

| signal | what it predicts | AUC |
|---|---|---|
| `value` (4-level rubric) | keep vs stale/noise | **0.55 — chance** |
| `value` | not noise | 0.71 |
| `durable` (yes/no) | not noise | **0.73–0.74, survives its CI on both the unbiased 28 and the full 45** |

`value` can spot outright garbage and cannot rank quality. The rubric is also scope-biased: on
user-scope memories Jev scores 0.84 where Tony scores 2.20 (gap −1.36), while *over*-rating agent
memories (+0.25). The sign flips by scope.

**Constraint for this cycle: ranking uses observable structure. A model is used only for narrow
yes/no calls that measured well.**

## 2. Approach

Three were considered:

- **A. Enrichment-driven** — one store; session overflow distils into memories. Rejected:
  enrichment is batch/async and a live session needs it in-turn, and it couples Bridget's coherence
  to enrichment quality, which §1.4 shows is shaky.
- **B. Working memory separate from long-term** — a session-local rolling summary, with durable
  facts graduating. Rejected as the primary frame: two mechanisms that can quietly disagree.
- **C. Budget-assembled tiers — chosen.** One `assembleContext(budget)` fills a fixed token budget
  from ranked tiers. Forgetting is budget eviction. It absorbs B's rolling summary as one tier
  rather than a parallel system, and it is the only option that is honestly testable — a budget and
  a ranker are both things you can write assertions about.

## 3. Data model

### 3.1 `memories` — two new columns, deliberately not one

| column | type | default | meaning |
|---|---|---|---|
| `applicability` | text | `'project'` | `global` \| `project` — does this fact travel |
| `resident` | boolean | `false` | is this worth tokens on *every* turn |

These are different populations. "Travels" is on the order of 200 memories; "resident" is on the
order of 30. Collapsing them into one flag either starves the global tier or blows the budget.
`resident = true` implies `applicability = 'global'` (enforced by a check constraint); the reverse
does not hold.

`project` keeps its current values and gains honest documentation: **it is provenance**. Nothing
moves. "Tony rejects time-based estimates" stays attributable to the `3d-rpg` session that revealed
it while becoming visible everywhere.

Retrieval changes from `eq(project, X)` to `applicability = 'global' OR project = X`.

This also resolves the `finances` case without special-casing: those memories are `scope='user'`
but `applicability='project'`, so a mortgage rate stays out of a game session's context.

### 3.2 `memories` — retrieval counters

| column | type | purpose |
|---|---|---|
| `retrieval_count` | integer, default 0 | how often this memory has entered a context |
| `last_retrieved_at` | timestamptz, null | when it last did |

Written **batched** by the assembler (one grouped `UPDATE` per turn, never per-memory). These exist
to make the resident tier self-nominating — see [§5.3](#53-resident-promotions).

### 3.3 `review_queue` — polymorphic target

`review_queue` is keyed on `doc_id` and cannot hold a memory item. Add `target_kind` text +
`target_id` uuid and backfill existing rows (`target_kind = 'document'`, `target_id = doc_id`).

**`doc_id` is made nullable and left in place, not dropped** — expand/contract, with the contract
half deferred to a later cycle. Prod is live; a column drop is the one irreversible step in this
migration and it buys nothing this cycle needs.

A second queue with a second UI is the thing that makes people stop reading either one. The
`one_pending_per_doc` partial unique index is replaced by an equivalent on
`(target_kind, target_id)`.

### 3.4 `conversations` — epoch marker

| column | type | purpose |
|---|---|---|
| `context_epoch_at` | timestamptz, null | context assembly reads only messages at or after this |

`conversations.summary` and `summary_embedding` already exist, commented *"reserved for a future
summarization worker."* This cycle is that worker. No new table.

### 3.5 `mem_enrichment_state` — generalised key

Primary key moves from `session_id` to `(source_kind, source_id)` where `source_kind` is
`'session' | 'conversation'`. Existing rows migrate to `('session', session_id)`.

## 4. The context assembler

`server/lib/agent/assemble.ts`, replacing the ad-hoc `buildLiveContext` + `buildMemoryContext` pair
that `server/api/voice/ws.ts` currently passes into `handleTurn`.

```ts
assembleContext({
  userText: string          // '' on a proactive turn — the load-bearing case
  conversationId: string
  projectId?: string
  budget: number            // tokens
}): Promise<AssembledContext>
```

### 4.1 Tiers and eviction

| tier | cost | evicted |
|---|---|---|
| resident facts | fixed | never |
| live state (active projects, open tasks) | fixed | never |
| working summary (`conversations.summary`) | fixed, small | never |
| retrieved memories | elastic | **first** |
| recent turns | elastic, with a floor | only below its floor |

Fixed costs are taken first; the remainder splits between the two elastic tiers. **Recent turns get
a floor of 40% of the total budget** — in a persistent session the tail is what makes Bridget
coherent, and a ranker that *can* starve it eventually will, at the worst possible moment.
Retrieval is the tier that flexes.

If the resident tier alone exceeds its allocation, that is a configuration error and must throw
loudly rather than silently truncate. The resident set growing past its budget is a real failure
mode of a self-nominating tier.

### 4.2 Proactive turns: synthesising the query

A proactive turn has no user message, so there is nothing to embed against. This is the core
problem with bolting proactivity onto query-driven retrieval, and it is what the summary tier
exists to solve.

**When `userText` is empty, the query is synthesised from state**: the working summary plus recent
activity. The rolling summary is a running description of what Tony is doing — exactly the query a
proactive agent needs and never has.

### 4.3 Ranking

One feature-extraction pass per memory feeds **two thin heads**. They share inputs and
infrastructure, not a score — relevance and problematic-ness are different targets and one number
cannot be both.

Features (all structural):

- `resident` / `applicability` match; project match
- recency (`source_date`)
- **active `contradicts` edge in `memory_relations` → hard boost.** Cycle 13 built this graph and
  the judge that populates it; nothing reads those edges at turn time today.
- semantic similarity, when a query exists
- `reviewed_at IS NULL` → reduced trust

`relevanceScore(memory, query)` gates entry to context. `concernScore(memory)` feeds the review
queue ([§5](#5-the-ambient-review-surface)).

**Weights are explicit constants, not fitted.** With 45 labels a learned ranker would be fitting
noise, and weights you can read and argue with beat a model you cannot at this scale.

### 4.4 Token budgeting

Uses the existing `estimateTokens` from `server/lib/chunking/chunk-markdown.ts` rather than adding
a tokenizer dependency. It is a heuristic — but `MessageUsage.contextTokens` already records what a
turn actually cost, so the estimate is checkable against reality rather than trusted. Drift beyond
a tolerance fails a test.

## 5. The ambient review surface

`/review` expands to four item kinds. Nothing here is driven by the `value` rubric.

### 5.1 Contradictions

Active `contradicts` edges in `memory_relations`. The flagship, and nearly free — the graph and its
judge already ship. A contradiction is the most damaging thing in the store because agents act on
it confidently.

### 5.2 Stale candidates

Driven by `durable`, the one facet that survived its CI in §1.4. **Surfaced, never auto-archived.**

### 5.3 Resident promotions

Rather than asking a model whether a fact deserves to live in every prompt, watch what is actually
retrieved: **a memory pulled repeatedly across *different* projects is demonstrating that it
travels and that it matters.** That is measured behaviour, and it sidesteps precisely the value
judgment §1.4 proved unreliable. This is what §3.2's counters are for.

### 5.4 Applicability proposals

From the one-time backfill and ongoing at write time. "This looks global — promote it?"

## 6. `/clear` and the forgetting ladder

Forgetting is a ladder, not a delete. Each rung is cheaper and lossier:

```
recent turns  →  rolling summary  →  memories  →  gone
  (verbatim)      (compressed)      (durable,
   in context      in context        retrieved)
```

A fact that matters climbs before its turns fall out of budget.

`/clear` **writes an epoch marker** (`conversations.context_epoch_at = now()`) and **resets
`summary` + `summary_embedding` to null**.

Resetting the summary is not optional. The summary is derived from the transcript, so wiping turns
while leaving it means Bridget still remembers everything just cleared, in compressed form. A
`/clear` that does not reset the summary is a lie.

Rows are **not** deleted. Cycle 68 established that a conversation is a tree and nothing is ever
deleted (retry branches rather than truncates; `app/lib/agent/retry.ts` was removed to enforce it).
An epoch preserves that invariant, keeps the transcript searchable via the cycle-13 session/message
search, and makes an accidental clear recoverable. Memories already graduated are untouched — that
is the ladder working, not a leak.

## 7. Migration and testing

### 7.1 Migration

Every step is additive; there is no destructive operation. Prod is live and migration 0045 only
just landed.

1. `memories`: `applicability`, `resident`, `retrieval_count`, `last_retrieved_at` + check constraint
2. `review_queue`: `target_kind`, `target_id`; backfill from `doc_id`; replace the partial unique
   index; make `doc_id` nullable and stop writing it (drop deferred — see §3.3)
3. `conversations`: `context_epoch_at`
4. `mem_enrichment_state`: composite key, existing rows → `('session', id)`

**Backfill.** `applicability` is classified once over 2,117 memories by the narrow yes/no
"does this fact depend on a specific project" — observable, with a right answer, and the question
shape that measured well. It writes `global` only above a confidence gate; everything uncertain
lands in the review queue rather than guessing. `resident` starts empty and fills by promotion.

### 7.2 Testing

- **Budget math is pure**: tier order, floors, eviction order, and the resident-overflow throw are
  unit-testable with no DB.
- **Budget drift**: assert `estimateTokens` against real `MessageUsage.contextTokens` within a
  tolerance, so drift fails rather than silently truncating Bridget mid-thought.
- **Epoch boundaries** get DB tests: a cleared conversation must return **zero** context and a
  **non-zero** searchable history. Those are exactly the two things that could silently diverge.
- **Ranking**: each feature's contribution asserted in isolation, weights being explicit constants.
- **Retrieval counters**: assert the update is batched — one grouped statement per turn, not N.
- Every test must be verified to fail when the behaviour it covers is broken on purpose. Five of
  cycle 68's findings were tests that could not fail.

### 7.3 Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | The backfill classifier underdelivers | `applicability` defaults to `project` = today's behaviour. A bad classifier means the global tier fills slowly, not that anything regresses. |
| 2 | Enrichment over conversations produces junk — Bridget talks more loosely than a work transcript, and the extraction prompt is tuned for work sessions | Everything lands review-gated; the write-time gate stays on. Measure yield before trusting it. |
| 3 | The budget is estimated, not measured — under-estimating truncates Bridget mid-thought | §7.2's drift assertion plus a conservative 40% floor on recent turns. |

## 8. Open questions and known defects

1. **`c-users-tonyc`** — a Windows home directory canonicalised into a project slug, holding four
   user-scope memories. Project resolution bug; out of scope here, worth its own task.
2. **Resident budget size** is unset. 30 items is the working assumption; the real number comes from
   measuring what the fixed tiers cost against a real model's window.
3. **Does enrichment over conversations need its own prompt?** Assumed yes, unmeasured. Risk 2.
4. **`memory-judge.ts` could move to a Jev `Choice`** — relation classification is the narrow enum
   call Jev measured well on, and it would delete a hand-rolled JSON parser and a silent
   `catch { return [] }`. Separate change; do not bundle it.

## Out of scope

- **The proactive behaviours themselves.** This cycle builds the substrate and the machinery. What
  Bridget decides to say, when, and through which surface is the next cycle.
- **Push notification / email proactivity.** Ambient review only.
- **Auto-discard of any memory.** Nothing in this cycle deletes or archives a memory without a
  human. The evidence does not support an automated destructive rule, and there is no undo.
- **Re-ranking retrieval with the local reranker** (`mxbai-rerank-large-v2`). Worth testing, needs
  labelled queries, not this cycle.
