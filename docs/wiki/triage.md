---
title: Capture Triage
status: shipped
cycle: 57
updated: 2026-08-17
mymind_id: 323bbf97-f177-429b-beea-675ff0388799
mymind_hash: 09bffc61baa5d3e391fc51628e33727a220c9c6edb0ce80b8eb16c33b3297379
---

# Capture Triage

Infers what a captured jot actually *is* — a task, a durable memory, a filed note, or an
addition to an existing document — and routes it there. Confident results apply on their own;
genuine uncertainty lands in `/review`. Supersedes `enrich-input` as the owner of `/input` (see
[enrichment.md](enrichment.md)).

**Rollout state, read this before touching config** (updated 2026-08-17):

| Destination | Bar | Auto-applies? |
|---|---|---|
| Task | **0.70** | **Yes** — lowered 2026-08-17, first step of the staged rollout |
| Note | `1.1` | No |
| Memory | `1.1` | No — **gated on MyMind task `f80622b9`** |
| Append | `1.1` | No |

`1.1` is above the maximum possible confidence (`1.0`), so those three destinations cannot
auto-apply at all; every such proposal lands in `/review`. Task was lowered first because it is
the safest bar to drop: the action is one row you can delete, and an undo now fully recovers.

The Memory bar **stays at `1.1` until `f80622b9`** (enrich-memories dedup under-catching)
closes — a hard dependency, not a tuning preference. Triage is a second inlet to the same
table, and a bad memory degrades recall everywhere, invisibly, until someone notices a wrong
answer weeks later.

## Pipeline

One entry point, `triageCapture(docId)` (`server/services/triage.ts`), fired from two places:

1. **Immediately** after `POST /api/capture/note` creates the document — fire-and-forget
   (`void triageCapture(doc.id).catch(...)`), so capture returns at write speed and a triage
   failure never fails the capture.
2. **The `triage-input` cron sweeper** (`server/tasks/triage-input.ts`, `*/10 * * * *`) —
   `sweepUntriaged({ limit: 20 })`, the backstop for everything the immediate path misses:
   server restart mid-flight, model timeout, and every `/input` inlet that isn't
   `POST /api/capture/note` (MCP `quick_capture`, `save_document` with no project, a direct
   `POST /api/documents` under `/input/...` — see [quick-capture.md](quick-capture.md)'s "What
   else lands in /input"). Those other inlets rely on the sweeper entirely; nothing calls
   `triageCapture` immediately for them.

**Idempotency.** Both paths can race, so `documents.triaged_at` is a conditional-UPDATE claim
(`WHERE triaged_at IS NULL`) taken **before** the model call. Losing the claim returns
`{ skipped: 'already-triaged' }`, not an error. A parse failure (`classify` returns `null`)
still leaves `triaged_at` stamped — retrying a doc the model can't parse on every ten-minute
sweep would burn tokens forever; the sweeper's job is coverage, not retry-until-success.

**The pending-review guard.** Before claiming, `triageCapture` checks whether the document
already has a `review_queue` row with `status = 'pending'` of a kind *other than* `triage`; if
so it returns `{ skipped: 'review-pending' }` **without claiming**, leaving `triaged_at` NULL so
the document stays eligible for a later sweep.

This is not hypothetical tidiness. `review_queue_one_pending_per_doc` is a partial unique index
on `doc_id WHERE status = 'pending'` spanning **all kinds**, so a document still holding a
pending `enrichment` row from the retired `enrich-input` cron would have had its triage row
silently swallowed by `onConflictDoNothing()` — after the claim was stamped and the model call
paid for. The document would have gone terminal with no proposal to show. Both of production's
live `/input` documents were in exactly that state when this shipped, so the first sweep after
deploy would have consumed the entire backlog this cycle exists to drain while appearing inert.
The `ne(kind, 'triage')` exclusion is load-bearing: without it, a proposal's own queued row would
trip the guard on every later call for that document.

**Sweeper candidates** are simply live `/input` documents with `triaged_at IS NULL` —
deliberately **not** the retired `enrich-input`'s filter (`project IS NULL AND tags = '{}' AND
no review_queue row in any status`), which could leave a document permanently ineligible for
reasons unrelated to triage (some other flow had set a tag, or an unrelated review row already
existed) **without it ever being considered even once**. Under triage, every `/input` document
is guaranteed exactly one claim-and-classify pass. That guarantee is also the limit of the fix:
`triaged_at` is only ever set, never cleared, anywhere in this codebase — not by `restoreDoc`,
not by a rejection. **A rejected or parse-failed proposal is a terminal state for that
document**, same as an approved one: `rejectTriage` (`server/api/review/kinds.ts`) explicitly
*re-stamps* `triaged_at` (to keep the sweeper from immediately re-proposing a doc a human just
rejected) rather than clearing it, and a parse failure leaves the original claim-time stamp in
place so a document the model can't parse isn't retried every ten minutes forever. In practice,
then, the sweeper's population is "documents that have never been through `triageCapture`" — a
real fix for the old permanently-invisible-document bug, but not the literal "rejected items
become eligible again" the design doc describes; see the handover.

**Re-triage is the way back (added 2026-08-17).** Automatic one-pass semantics left a real hole:
a capture whose proposal you rejected — or whose applied action you *undid* — sat in `/input`
under its machine name with nothing able to reconsider it. That fired on day one in production:
an approved task was undone, the courier was restored, and the sweeper's candidate count went to
zero.

The fix is deliberately **not** "clear `triaged_at` on revert." The sweeper runs every ten
minutes, so that re-proposes the same jot immediately, and once a bar sits below `1.0` it
becomes an apply → undo → re-apply loop on a timer. A rejection or an undo is the user saying
the proposal was wrong. So re-eligibility is an explicit action:

- `retriageDocument(docId)` (`server/services/triage.ts`) clears `triaged_at`. It reads with the
  live-only `getDoc`, so it can never resurrect a soft-deleted courier.
- `POST /api/documents/[id]/retriage` exposes it.
- The documents-tree context menu shows **Re-triage** for `/input` files only — it is
  meaningless anywhere else.

**Reverting one action of a multi-destination proposal** no longer hands the courier back while
a sibling action still holds it (`courierStillHeld`). Previously, undoing the task half of a
task+memory proposal restored the document while the memory still existed, leaving one jot as
both a live entity and the original note.

## The classifier contract

`server/lib/ai/triage.ts`:

- **`buildTriageMessages(doc, projects)`** — a system prompt naming all four destinations plus
  the active project list (slug — name — description, injected the same way
  `buildEnrichMessages` does for enrichment), and a user message with `Path:`/`Content:`
  (content sliced to 6000 chars). The Note branch of the prompt is explicit that `path` "MUST
  include a new, human-readable filename... never reuse the incoming random filename" — the
  fix for the old enrichment prompt's "keep the existing filename" instruction, which is why
  `/input` used to stay unbrowsable.
- **`classify(doc, projects)`** — one `chat('bulk', ..., { temperature: 0.1 })` call. Returns
  `null` on any AI or parse failure; the caller (`triageCapture`) decides what that means.
- **`parseTriage(raw)`** — pure. Mirrors `parseProposal` in `enrich.ts`: strip ``` fences,
  brace-match the first `{…}`, `JSON.parse`, validate, `null` on any failure.

```ts
type TriageKind = 'task' | 'note' | 'memory' | 'append'   // a DESTINATION, not documents.type

interface TriageAction {
  kind: TriageKind
  confidence: number          // 0..1, clamped; missing/non-numeric → 0 (routes to review)
  title?: string               // task title / note title
  project?: string | null      // slug from the injected list, or null
  priority?: 'low' | 'medium' | 'high'   // task only
  dueDate?: string | null      // task only, ISO
  scope?: 'user' | 'agent' | 'world'     // memory only
  content?: string             // memory text / append block text
  targetDocId?: string         // append only — NEVER read from the model; parseAction strips it
  tags?: string[]
  path?: string                 // note only — destination path INCLUDING the new filename
}

interface TriageProposal {
  primary: TriageAction
  secondary: TriageAction[]    // 0..2 — parseTriage TRUNCATES beyond 2, does not reject
  reasoning: string
}
```

`TriageKind` is deliberately **not** shared with `documents.type`
(`note|reference|meeting|idea|task`) — the two overlap on the words "note" and "task" while
meaning different things (a destination vs. a document classification).

## Routing policy (`server/lib/triage/route.ts`, pure)

`route(proposal, thresholds)` decides, independently for the primary and each secondary action,
whether it auto-applies (`confidence >= thresholds[kind]`, so a bar is a floor — exactly-at
applies) or waits for review. **No destination categorically requires review** — destinations
differ only in where their bar sits, and a confident secondary applies even if the primary was
uncertain (and vice versa).

| Destination | Threshold **as shipped** | Spec's target bar (once trusted) | Rationale |
|---|---|---|---|
| Task | **1.1 (never)** | 0.70 | Fully reversible — delete the row. |
| Note | **1.1 (never)** | 0.70 | Reversible — move and rename back. |
| Memory | **1.1 (never) — hard-gated on `f80622b9`** | 0.80 | A wrong memory surfaces in every future session's recall until noticed. |
| Append | **1.1 (never)** | 0.85 | The only actuator that touches a document you didn't open. |

Config lives in `runtimeConfig.triageThresholds` (`nuxt.config.ts`), plus
`triageAppendSimilarityFloor` (`0.75`, cosine) for the Append actuator's target-resolution
guardrail. Because a clamped confidence tops out at `1.0` and every bar is `1.1`, **nothing can
auto-apply under the shipped config, including a perfect `1.0`** — this is intentional and
covered by its own test (`test/triage-route.test.ts`).

## The four actuators (`server/services/triage.ts`)

Each actuator returns `{ actionRowId, entityType, entityId, undoToken }`, records one
`triage_actions` row, and publishes on the live bus (`publishChange`, singular `resource`).

| Destination | Action | Source `/input` doc |
|---|---|---|
| **Task** (`applyTask`) | `createTask({ title, description: raw jot, project, priority, dueDate })` | soft-deleted (`deleteDoc`) |
| **Note** (`applyNote`) | retitle + `moveDoc` out of `/input` to the proposed path | **becomes the artifact** — never deleted |
| **Memory** (`applyMemory`) | `createMemory({ content, scope, project, tags, confidence, source: 'triage:<docId>' })` | soft-deleted |
| **Append** (`applyAppend`) | append a delimited block into an existing document | soft-deleted |

**Multi-destination reads.** A proposal's primary and secondary actions can both consume the
same courier document (e.g. primary=task, secondary=memory). `applyTask`, `applyMemory`, and
`applyAppend` all read the courier via `getDocIncludingDeleted` (not the live-only `getDoc`) so
a later action in the same proposal still finds the document even after an earlier one has
soft-deleted it — this is what makes the spec's locked multi-intent decision ("one primary plus
up to two secondaries, all of which should actually apply") real rather than aspirational. See
[the handover](../handovers/2026-08-16-capture-triage.md) for the mid-cycle defect this fixed
(Task 11b).

**Note stays live-only, deliberately.** `applyNote` never soft-deletes its courier (the
document *is* the artifact), so it also never resurrects one: if the courier was already
consumed by a sibling action, there is nothing left that "note" can mean, and it refuses with an
error rather than silently duplicating the other action's output as a second, stale copy.

**Append is the most complex actuator** and the only one that runs its own retrieval:

- The model proposes *that* an append is right; `resolveAppendTarget(content)` resolves
  *which* document, via a direct vector query — **not** `documents.embedding` (dead; see
  [document-spine.md](document-spine.md)) but `chunks.embedding` joined to `documents`,
  matching `searchDocIds`'s vector lane. It excludes skill documents (`notSkill()`) and
  anything still under `/input/`.
  - If no candidate clears `triageAppendSimilarityFloor` (0.75 cosine), or an explicitly
    supplied `targetDocId` fails the same guardrails (`isValidAppendTarget` — not a skill, not
    under `/input/`), the action **degrades to a Note** rather than guessing. Today the model
    never actually emits `targetDocId` (`parseAction` strips it), so this re-validation branch
    is currently reachable only via a direct actuator call, not the classifier — kept as
    structural defense-in-depth rather than "safe because an upstream step cooperates."
  - The degrade **synthesizes a real note action** (`degradeAppendToNote`) rather than passing
    the append action through. The classifier's `append` prompt only asks for `content`, never a
    `title` or `path`, so a bare pass-through reached `applyNote` with neither, mutated nothing,
    and still recorded an action and reported success — "Applied 1 action" for a document that
    never left `/input`. `applyNote` now **throws on any action that would produce zero
    mutation**, which closes that class for every caller rather than only this one. Because the
    similarity floor is 0.75 cosine, degrade is the *common* outcome for short jots, so this
    path is well-travelled, not an edge case.
- Append-only: it concatenates a delimited block (`<!-- triage:<docId> <date> -->` + content)
  and never rewrites, reorders, or removes existing content.

## Review + reversal surfaces

`/review` (`app/pages/review.vue`) renders `kind: 'triage'` as a fourth card type alongside
`enrichment`, `memory-supersede`, `memory-contradict`, and the synthetic `memory-unreviewed`
items (see [memory.md](memory.md) and [enrichment.md](enrichment.md)). A triage card shows the
queued action(s) awaiting a decision, the model's one-sentence reasoning, and — read-only,
for context — any sibling actions from the same proposal that already auto-applied.

**Approve/reject dispatch through a per-kind handler map** (`server/api/review/kinds.ts`,
`approveHandlers`/`rejectHandlers` keyed by `kind`), replacing what used to be a growing
if/else chain in `approve.post.ts`/`reject.post.ts`:

- **`approveTriage`** runs each queued action through its actuator with `autoApplied: false` (a
  human decided, not the classifier), and returns the count that **actually** applied — a
  single actuator failure is logged and excluded from that count rather than rolling back its
  siblings or leaving the row stuck pending, and the UI toast reports the server's real applied
  count rather than the pre-request queue length.
- **`rejectTriage`** re-stamps `documents.triaged_at` (already set by `triageCapture`'s claim;
  re-stamping here keeps the "don't immediately re-propose" guarantee explicit even if that
  invariant changes upstream) and marks the row `rejected`.

One `review_queue` row per document (`review_queue_one_pending_per_doc`, a partial unique index
on `doc_id WHERE status = 'pending'`) — a mixed-confidence proposal is one row containing every
queued action, never one row per action.

**The "recently applied" strip** — `GET /api/triage/recent`, rendered at the bottom of
`/review` as a flat feed (not a card stack, no Approve/Reject) — lists the 20 most recent
non-reverted `triage_actions` rows from the last 7 days, auto-applied or human-approved alike.
It exists because `registerUndo`'s in-memory token expires after **10 minutes**, and with
auto-apply as the norm, "I noticed this an hour later" needs to still be reversible.

**Durable reversal** — `POST /api/triage/[id]/revert` → `revertTriageAction(actionRowId)` —
reverses from the persisted `triage_actions.payload` jsonb rather than a live closure, so it
still works the next day:

- **Task** → `deleteTask` (soft) + `restoreDoc`.
- **Memory** → archive the memory (never hard-delete — dedup may have merged into a
  pre-existing row) + `restoreDoc`.
- **Note** → `moveDoc` back to `originalPath` and restore `originalTitle`, both captured in the
  payload at apply time (`originalTitle` is three-state: absent on rows written before the
  field existed → leave alone; present-and-`null` → "had no title" → restore to `null`;
  present-and-a-string → restore it).
- **Append** → only restores the target if its current content is byte-identical to
  `priorContent + appendedBlock` — if the document was edited since, the revert is a no-op
  rather than corrupting the newer content by blind string subtraction.

Reversal failure never interpolates a caught error into the user-facing `reason` string — that
exact class of bug (a `DrizzleQueryError` leaking bound params, including entire prior document
bodies) shipped and was fixed earlier the same day (`4a3792f`) in the sibling `runUndo` path.

## Data model

| Table / column | Detail |
|---|---|
| `documents.triaged_at` | `timestamptz null`, indexed (`documents_triaged_at_idx`). Idempotency claim + sweeper candidate filter. |
| `triage_actions` | New table. `id, doc_id, kind, entity_type ('task'\|'memory'\|'document'), entity_id, confidence, auto_applied, payload jsonb, reverted_at, created_at`. One row per action **actually executed** (auto-applied or human-approved) — this is what makes reversal work past the undo TTL and is the audit trail for "why is this task on my board." Indexed on `created_at` and `doc_id`. |
| `review_queue` | No schema change. New `kind = 'triage'`; `proposed` holds `{ primary, secondary, reasoning, queued, applied }`. |

## Rollout

Per the spec, deliberately staged and **not yet advanced past step 1**:

1. **Shipped:** all four thresholds at `1.1`. Every proposal lands in `/review`; nothing writes
   on its own. This exercises the whole pipeline against real captures with zero risk.
2. Read the queue for a few days; compare proposals against what you'd have done by hand.
3. Lower the bars to the table's target defaults by hand, one destination at a time, starting
   with Task. **The Memory bar stays at `1.1` until MyMind task `f80622b9`** (enrich-memories
   dedup under-catching) closes — Task, Note, and Append are not blocked by it and may move
   independently.
4. Backfill the existing `/input` backlog with the sweeper once thresholds are trusted.

## Known gaps

See [the handover](../handovers/2026-08-16-capture-triage.md) for the full deferred-minors
ledger. The wiki-relevant ones: `parseTriage`'s brace-matching doesn't skip string literals (a
literal `}` inside a proposed value can close the JSON match early — inherited from
`parseProposal`, fails safe to `null`); actuators are not transactional (a mid-sequence throw
can orphan a created entity with no audit row, matching this repo's existing no-cross-service-
transactions convention); a second courier-consuming action in a multi-intent proposal still
publishes a `document deleted` live event for a delete that actually no-opped (inert today —
nothing dispatches on it beyond a query invalidation).
