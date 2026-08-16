---
title: Capture triage — inferring intent from a jot and routing it
cycle: 57
date: 2026-08-16
status: spec — approved in brainstorm, not yet planned
related:
  - ../../wiki/quick-capture.md (the capture surfaces this triages)
  - ../../wiki/enrichment.md (the pipeline this supersedes for /input)
  - ../../wiki/memory.md (createMemory + the auto-review threshold convention this follows)
  - ../../wiki/tasks-projects.md (createTask, the new actuator target)
  - ../specs/2026-06-12-live-reactivity-design.md (the publishChange contract every actuator rides)
  - ../../handovers/2026-08-15-home-dashboard.md (cycle 56 — most recent)
---

# Capture triage (cycle 57)

## Why

The stated purpose of quick capture is a place to jot something down without deciding what it
is. Today the deciding never happens — it just gets deferred forever, and the deferral has a
cost that compounds.

What happens to a jot right now:

1. `POST /api/capture/note` writes `/input/<slug>.md`, where the slug comes from a title you
   probably didn't type, or a nanoid.
2. Within 10 minutes, `enrich-input` may call an LLM and propose frontmatter into
   `review_queue`.
3. You approve it at `/review`, and it gets a project, tags, and a destination path.

Three things are wrong with that, and they're structural rather than cosmetic:

**The inference exists but the actuators don't.** `BASE_SYSTEM_PROMPT` in `server/lib/ai/
enrich.ts` already asks the model for a `type` from `note|reference|meeting|idea|task`. When it
answers `task`, that sets a **string column on a document**. No task row is created. So "remind
me to fix the Yukon loan link" becomes a document *labelled* task, sitting in `/input`, that
never reaches the kanban. The system already understands what you meant and has nowhere to put it.

**The filename never changes.** The prompt instructs the model to "keep the existing filename,"
and the document tree renders filenames, not titles. So even a perfect title proposal leaves
`/input/9O8RQk4EOZ.md` on disk, and the inbox stays unbrowsable — every row reads as a random
slug. This is the single highest-value finding from the 2026-08-15 UX audit.

**The inbox cannot drain.** `runEnrichInput`'s candidate query requires `project IS NULL`, empty
`tags`, **and** no `review_queue` row for that doc *in any status*. A document is therefore
eligible exactly once, ever. Anything you touched, anything whose proposal you rejected, and
anything the model failed to parse is skipped permanently. `/input` is an append-only pile.

## What triage does

One jot in, the right entity out — a task on the board, a durable memory, a properly-named
filed note, or a line appended to the document that already covers the topic. Confident results
apply on their own; only genuine uncertainty reaches you.

### Decisions locked in the brainstorm

| Decision | Choice |
|---|---|
| Timing | Capture never blocks. Triage fires immediately after, out of band, plus a cron sweeper as backstop. |
| Destinations | Task · Note · Memory · Append-to-existing-doc. |
| Multi-intent | One **primary** action plus up to two **secondary** actions in the same proposal. |
| Approval | **Confidence alone decides.** No destination categorically requires review. |
| Source doc | Destination-dependent: a Note *becomes* the artifact; Task/Memory/Append soft-delete the courier. |
| Review surface | `/review` only. Triage is a new `kind` on the existing queue. No new page. |

The approval rule is deliberate and worth restating, because an earlier draft of this design got
it wrong: there is no "secondaries always need approval" rule. That rule would manufacture a
steady review queue out of precisely the captures meant to just work. The only difference
between destinations is **where the confidence bar sits**.

## Architecture

`server/services/triage.ts` exposes one entry point:

```ts
triageCapture(docId: string): Promise<TriageOutcome>
```

Called from two places:

- **Immediately** after `/api/capture/note` and `/api/capture/transcribe` create the document —
  fire-and-forget, so capture returns at write speed and never waits on a model.
- **From the `triage-input` cron sweeper**, catching whatever the immediate path missed: server
  restart mid-flight, model timeout, and documents created by other routes (MCP `quick_capture`,
  direct `POST /api/documents`).

The sweeper's candidate query is **untriaged `/input` documents** — not "sparse documents I have
never seen." This is the fix for the drain problem; a rejected or failed document becomes
eligible again rather than being skipped forever.

Both paths can race, so `documents.triaged_at` is the idempotency guard, claimed in a
conditional update (`where triaged_at is null`) **before** the model call. Losing the claim is a
no-op return, not an error.

### Three stages

The stages are split so that the two things most likely to be wrong — parsing model output and
deciding policy — are pure functions that need neither a model nor a database to test.

**1. `classify()`** — a single `chat('bulk', …)` call at `temperature: 0.1`, strict JSON, with
the active project list injected exactly as `buildEnrichMessages` already does it. Paired with a
pure `parseTriage(raw)` that mirrors the existing `parseProposal`: strip ``` fences, brace-match
the first `{…}`, validate, return `null` on any failure. That helper is already unit-tested and
handles the messy-output cases; the new one follows it rather than reinventing it.

**2. `route()`** — **pure, no I/O.** Takes a parsed proposal plus the threshold config, returns
`Action[]`, each flagged auto-apply or needs-review. All policy lives here.

**3. Actuators** — four small functions. Each returns an undo token and publishes a live-bus
change, following the `createMemoryRelation` pattern in `server/services/memory-relations.ts`.

### The classifier contract

```ts
type TriageKind = 'task' | 'note' | 'memory' | 'append'

interface TriageAction {
  kind: TriageKind
  confidence: number          // 0..1
  title?: string              // task title / note title
  project?: string | null     // slug from the injected list, or null
  priority?: 'low' | 'medium' | 'high'   // task only
  dueDate?: string | null     // task only, ISO
  scope?: 'user' | 'agent' | 'world'     // memory only
  content?: string            // memory text / append block text
  targetDocId?: string        // append only — resolved in stage 3, never by the model
  tags?: string[]
  path?: string               // note only — destination path INCLUDING new filename
}

interface TriageProposal {
  primary: TriageAction
  secondary: TriageAction[]   // 0..2 — parseTriage TRUNCATES beyond 2, it does not reject
  reasoning: string           // one sentence, shown in review
}
```

The `0..2` bound on `secondary` is enforced by `parseTriage`, not by the prompt: a model that
returns five actions gets truncated to the first two, because rejecting the whole proposal over
an over-eager list would throw away a good primary. Confidence outside `0..1` clamps; a missing
or non-numeric confidence is treated as `0`, which routes to review rather than auto-applying.

`TriageKind` is a **destination**, deliberately not shared with `documents.type`
(`note|reference|meeting|idea|task`), which is a *document classification*. The two vocabularies
overlap on the words "note" and "task" while meaning different things. Cycle 56 set the
precedent of keeping a near-duplicate vocabulary separate rather than forcing reuse; do the same
here and do not let an implementer "unify" them.

### Routing policy

| Destination | Bar | Rationale |
|---|---|---|
| Task | 0.70 | Fully reversible — delete the row. |
| Note | 0.70 | Reversible — move and rename back. |
| Memory | 0.80 | A wrong memory surfaces in every future session's recall until noticed. |
| Append | 0.85 | The only actuator that touches an existing document. |

Thresholds live in `runtimeConfig` as `triageThresholds`, following the existing
`memoryAutoReviewThreshold` (default 0.75) convention, so they are tunable without a redeploy.

An action at or above its bar auto-applies. Below it, the whole proposal becomes one pending
`review_queue` row. Note the existing partial unique index
`review_queue_one_pending_per_doc` on `doc_id where status = 'pending'` — a document can only
have one pending row, so a proposal is **one row containing all its actions**, never one row per
action. Mixed proposals (confident primary, uncertain secondary) apply the confident actions
immediately and queue only the remainder, with the applied ones shown as context in the review
row.

### Actuators

| Destination | Action | Source `/input` doc |
|---|---|---|
| **Task** | `createTask({ title, description: raw jot, project, priority, dueDate })` | soft-delete, link |
| **Note** | set title, **rename the file**, move out of `/input` via `moveDoc` | *becomes* the artifact |
| **Memory** | `createMemory({ content, scope, project, confidence })` | soft-delete, link |
| **Append** | append-only delimited block into an existing doc | soft-delete, link |

Renaming is the part that fixes browsability, and it is `moveDoc` — the existing service that
already maintains the `project`/`project_id` derivation from path. Triage must not write those
columns directly.

Soft-delete means `deleted_at`, which is already recoverable. The created entity records
`source: 'triage:<docId>'` so provenance survives the deletion.

**Append** is the most complex actuator and the only one needing retrieval: the model proposes
*that* an append is right, and stage 3 resolves *which document* by semantic search over
existing docs. Its guardrails:

- Append-only. It appends a delimited block; it never rewrites, reorders, or deletes.
- The block carries the capture date and source doc id.
- Highest bar of the four (0.85). If no candidate document clears the similarity floor
  (`triageAppendSimilarityFloor` in `runtimeConfig`, default 0.75 cosine), the action **degrades
  to a Note** rather than guessing at a target.

Build it **last** in the implementation sequence — not cut, but ordered so the other three are
working and proven first.

## The unified review surface

`/review` already discriminates on `review_queue.kind` and renders per kind — `enrichment`,
`memory-supersede`, `memory-contradict`. Triage becomes a fourth kind. This work also:

**Retires `enrich-input`.** Its candidate population (`path LIKE '/input/%'`) is exactly the
population triage now owns, and the Note actuator subsumes what it proposed. Two pipelines
writing frontmatter to the same documents under different rules is a bug waiting to happen. The
`enrichment` kind stays readable for historical rows.

**Folds in the unreviewed-memory flow.** `/memories` currently carries a parallel review path —
an "Unreviewed only" toggle and a "Mark reviewed" button keyed off `memories.reviewed_at`,
separate from the queue, which is why the sidebar shows both a Review badge and a Memory badge.
Surface those in `/review` so there is one place to check. The `/memories` filter can stay as a
view; the *approval* action moves.

**Refactors `approve.post.ts`.** It is currently a growing `if (MEMORY_CONFLICT_KINDS.has(kind))`
/ else chain. Adding a fourth kind to it as-is makes it worse. Replace with a per-kind handler
map keyed on `kind`, each handler owning its own approve/reject logic. Same for `reject.post.ts`.

**Adds a "recently auto-applied" strip.** With auto-apply as the norm, the undo toast is the
main safety net — and `registerUndo`'s TTL is **10 minutes**, so a toast is useless an hour
later. The strip lists the **20 most recent** auto-applied triage actions (7-day window) with a
reversal control that does not depend on a live token: it reverses from the `triage_actions` row
(delete the task, restore the document, archive the memory), so it still works the next day.
This is a feed, not a queue — nothing here is waiting on you.

## Data model

| Change | Detail |
|---|---|
| `documents.triaged_at` | `timestamptz null`, indexed. Idempotency claim + sweeper candidate filter. |
| `triage_actions` | New table: `id`, `doc_id`, `kind`, `entity_id`, `entity_type`, `confidence`, `auto_applied` bool, `reverted_at`, `created_at`. Powers the recently-applied strip and reversal. |
| `review_queue` | No schema change. New `kind = 'triage'`; `proposed` holds the full `TriageProposal`. |

`triage_actions` is what makes reversal work past the undo TTL, and it is the audit trail for
"why is this task on my board" — without it, an auto-applied action is indistinguishable from
one you created by hand.

## Live reactivity

Every actuator publishes on the existing bus: `tasks`, `documents`, `memory`, `review`, and
`home` (the Needs Attention panel counts `/input` captures, which triage drains). Follow
`publishChange({ resource, action, id })` as in `createMemoryRelation`.

## Testing

The split exists to make most of this testable without a model or a database:

- **`parseTriage`** — pure. Fenced JSON, prose-wrapped JSON, nested braces, malformed, missing
  fields, out-of-range confidence, more than two secondaries. Mirrors the existing
  `parseProposal` tests.
- **`route()`** — pure, and this is where the policy lives. Each destination at, just below, and
  just above its bar; mixed confident-primary/uncertain-secondary; every action below bar.
- **Idempotency** — a DB test proving the conditional `triaged_at` claim makes a double
  invocation (immediate + sweeper) produce exactly one set of actions.
- **Actuators** — DB tests against real Postgres (`*.db.test.ts`, matching the cycle 55/56
  pattern) asserting the entity is created, the source document is disposed of correctly, and
  the undo token reverses it.
- **Browser** — a real capture through the UI, proving the toast appears and the task lands on
  the board. Per project rule, `playwright-cli`, not the MCP.

A note for whoever writes the plan: a test that asserts `route()` returns *something* proves
nothing. Each policy test must name the production change that would make it fail.

## Rollout

1. Ship with all four thresholds set to `1.1` — effectively "never auto-apply." Every proposal
   lands in `/review`. This exercises the whole pipeline against real captures with zero risk of
   an unwanted write.
2. Read the queue for a few days. Compare what the model proposed against what you'd have done.
3. Lower the bars to the table's defaults once the proposals look right, one destination at a
   time, starting with Task.
4. **Backfill** the existing `/input` backlog with the sweeper once thresholds are trusted.

Step 1 is not ceremony. It is the only way to calibrate thresholds against your actual captures
rather than a guess, and it costs one config value.

## Out of scope

- **New capture entry points.** Triage consumes what the existing surfaces produce (`/capture`,
  MCP `quick_capture`, ShareX). A global hotkey or a faster jot box is its own cycle.
- **Image/gallery triage.** Uploaded images have their own enrichment path. Transcriptions land
  in `/input` as markdown and *are* covered.
- **Re-triaging documents outside `/input`.**
- **The wider sidebar IA consolidation** (task `4e087adb`). This cycle removes one approval
  surface; it does not resolve the four-inboxes problem.

## Risks

**A confident, wrong append edits a document you did not open.** Accepted deliberately — the
brainstorm chose auto-apply for all four destinations after the risk was raised. Mitigated by
the highest bar, append-only semantics, the recently-applied strip, and durable reversal. The
staged rollout means it cannot fire at all until you have read real proposals.

**Memory bloat.** Task `f80622b9` (enrich-memories dedup under-catching) is open and unresolved.
Triage adds a *second* inlet to the same table. The Memory actuator must run through the same
dedup path as the enrichment loop, not a parallel one — if that path is genuinely
under-catching, this cycle makes it worse, so it is worth confirming before lowering the memory
threshold below 1.1.

**Model quality on short input.** A five-word jot carries little signal. Expect low confidence,
which correctly routes to review. The failure mode to watch for is *confident and wrong* on
short input, which the staged rollout surfaces before it can act.
