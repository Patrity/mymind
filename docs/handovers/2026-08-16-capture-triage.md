---
title: Capture triage — inferring intent from a jot and routing it (cycle 57)
cycle: 57
date: 2026-08-16
status: >
  BUILT, NOT MERGED. All 14 tasks complete on `feat/capture-triage`, subagent-driven, per-task
  two-verdict review with fix rounds where needed (Tasks 6, 9, 10, 11b, 12, 13 — six of thirteen
  build tasks needed at least one fix round; two mid-cycle escalations, one of them a new task
  inserted outside the plan). Gates measured fresh at HEAD for this handover: **typecheck 0
  errors / test 1200 passed (156 files) / test:db 93 passed (11 files) / build clean.** All four
  triage confidence thresholds ship at `1.1` (above the max possible `1.0`) — **nothing
  auto-applies in production until Tony lowers them by hand**, per the spec's staged rollout.
  Not pushed, not deployed, no migration applied anywhere but local dev.
branch: feat/capture-triage
spec: ../superpowers/specs/2026-08-16-capture-triage-design.md
plan: ../superpowers/plans/2026-08-16-capture-triage.md
docs:
  - ../wiki/triage.md (new page, status "shipped") — mirrored to MyMind at /projects/mymind/wiki/triage.md
  - ../wiki/quick-capture.md ("Why /input" section rewritten for triage; intro line corrected)
  - ../wiki/enrichment.md (enrich-input marked SUPERSEDED; embeddings/hybrid-search sections corrected for cycle 31)
  - ../wiki/document-spine.md (documents.embedding corrected from "the doc vector" to vestigial)
  - ../superpowers/plans/00-roadmap.md (cycle 57 row added)
task: e7081099-baf3-42f4-a0b6-f5ea726e24b3 (MyMind)
---

# Capture triage (cycle 57)

One captured jot in, the right entity out — a task on the board, a durable memory, a properly
renamed filed note, or a line appended to the document that already covers the topic. Confident
results were meant to apply on their own from day one; in practice every result queues for
review today, because all four confidence bars ship at `1.1` — above the maximum possible
confidence of `1.0` — as the spec's own deliberate first rollout step. Full architecture, the
routing table, the actuators, and current behaviour are in
[`../wiki/triage.md`](../wiki/triage.md); this document is about how the cycle went.

## Read this first: four things this cycle found, all consequential

The task brief for this documentation pass specifically asked that these be prominent, because
each is a lesson about trusting stale documentation or an unverified plan, not just a bug in
this branch.

**1. The plan specified an endpoint deleted two months earlier — because the wiki said it was
live.** The plan's Task 8 brief targeted `server/api/capture/transcribe.post.ts`. That file was
deleted on 2026-06-12 in `8e96834` ("refactor(images): remove legacy ocr/transcribe/cron").
`docs/wiki/quick-capture.md` kept describing a "Transcribe" tab and that endpoint as live for
two months after the deletion, and the cycle-57 **brainstorm itself was written against that
stale page** — the spec's own "what happens to a jot right now" section assumed a code path
that hadn't existed since June. Caught during the build (`d35940f`, "docs: correct a stale wiki
page that misled this cycle's own spec"), adjudicated void with no functional gap — the Task 9
sweeper already covers every other `/input` inlet, transcribe included (transcriptions land in
`/input` as plain markdown, same as any other capture). The wiki page has since been corrected;
see the cycle-56 lesson this repeats below.

**2. The plan's own append-target resolver queried a database column that has never been
written to — it would have compiled, run, and silently degraded forever.** Task 10's brief
sketched `resolveAppendTarget` against `documents.embedding`. That column's own schema comment
has read `// schema only in cycle 1; stays null` since cycle 1
(`server/db/schema/documents.ts:28`), and a live count on the dev DB at the time showed 18 of
3229 rows non-null — legacy noise, not a real signal. **Four of the plan's five prescribed
tests for this actuator would have passed anyway**, because they bypass the resolver entirely;
the fifth would have passed *incidentally* (an always-empty result reading as "correctly found
nothing" rather than "structurally can't find anything"). No test in the plan would have caught
this. It was caught only because Task 10's implementer checked the live column instead of
trusting the wiki's claim that `documents.embedding halfvec(2560)` was the document vector — and
that wiki claim was itself wrong (see `document-spine.md`'s correction, deliverable 4 of this
task). The real vector lane joins `chunks.embedding` (cycle 31's chunking work moved it there);
the resolver was rewritten to copy `searchDocIds`'s existing join rather than reinvent it.
**This defect cost the cycle a full fix round in Task 10** (`b65c40e..0fe0c5f`) — it is exactly
the kind of thing that only surfaces when someone reads the schema comment instead of the prose
describing it, which is why the wiki correction carries a note pointing back here.

**3. The plan's actuator design defeated the spec's own locked multi-intent decision.** The
spec's brainstorm explicitly locked "one primary action plus up to two secondaries, and there is
no 'secondaries always need review' rule — confidence alone decides, and a confident secondary
applies even when the primary doesn't." The plan's actuators, as briefed, each read their
courier document with the live-only `getDoc` and three of the four (task/memory/append)
soft-delete it on success. That meant **only the first courier-consuming action in a proposal
could ever actually apply** — a second action targeting the same document would find it already
gone and fail. Worse, the failure didn't surface as a failure: the leftover action landed in
`/review`, and *approving* it there silently no-op'd (the actuator hit the same missing-courier
case) while still marking the row `approved` — **the review queue reported success for work it
never did.** This was not caught by any task's own tests; it surfaced during Task 11's browser
validation, was written up as an unplanned Task 11b brief by the controller
(`task-11b-brief.md`), and fixed by widening `applyTask`/`applyMemory`/`applyAppend` to read via
a new `getDocIncludingDeleted` (so a later action in the same proposal can still see the
courier's content after an earlier one consumed it) while deliberately keeping `applyNote` on
the live-only `getDoc` — a Note is never soft-deleted itself, so if it finds its courier already
gone, there's nothing left that "note" can mean, and it now refuses with an error instead of
resurrecting a stale duplicate. See [`triage.md`](../wiki/triage.md#the-four-actuators-serverservicestriagets)
for the shipped behaviour.

**4. `deleteTask` is a soft delete, and the plan's own prescribed test would have passed even if
undo did nothing.** `server/services/tasks.ts:177`'s `deleteTask` sets `deletedAt` and is
filtered out by the live `getTask`/list queries — it does not remove the row. The plan's Task 5
brief (task/note actuator undo tests) and Task 12's brief (durable reversal tests) both asserted
`toHaveLength(0)` against a **raw, unfiltered** `select().from(tasks)` — a query that still finds
a soft-deleted row, so the assertion would pass whether or not the undo actually worked. Flagged
by Task 5's implementer as a "FACT FOR LATER TASKS" ledger entry specifically so Task 12
wouldn't repeat it; verified in this documentation pass that both call sites now assert through
`getTask()` instead (`test/triage-actuators.db.test.ts:110,528`), with an inline comment at the
second site spelling out exactly why the raw select was wrong. This is the same defect *class*
as cycle 56's `UButtonGroup`/routeRules misses and this cycle's own transcribe-endpoint miss:
**a plan asserting something about the codebase that was true once and is no longer checked
against the current code.**

## What shipped

One entry point, `triageCapture(docId)` (`server/services/triage.ts`), fired immediately
(fire-and-forget) after `POST /api/capture/note` and swept every ten minutes by
`server/tasks/triage-input.ts` as the backstop for every other `/input` inlet (MCP
`quick_capture`, `save_document` with no project, direct `POST /api/documents`). A conditional
`documents.triaged_at` UPDATE (`WHERE triaged_at IS NULL`) claims a document before the model
call, making the two triggers race-safe. Three pure/testable stages — `classify()` (one
`chat('bulk', …)` call + `parseTriage`, mirroring the existing `parseProposal`), `route()` (pure
policy, confidence vs. per-destination threshold, no I/O), and four actuators
(`applyTask`/`applyNote`/`applyMemory`/`applyAppend`) that each create or dispose of an entity,
record a `triage_actions` row, publish on the live bus, and return an undo token. `enrich-input`
is retired (`server/tasks/enrich-input.ts` deleted in `223f38e`; `runEnrichInput()` and its
manual admin trigger remain in the codebase but are no longer scheduled). `/review` gained a
fourth `kind` (`triage`) rendered through a new per-kind approve/reject handler map
(`server/api/review/kinds.ts`) that replaced a growing if/else chain, plus a "recently applied"
feed (`GET /api/triage/recent`, last 20 non-reverted actions / 7 days) with durable reversal
(`POST /api/triage/[id]/revert`) that survives past `registerUndo`'s 10-minute in-memory TTL by
reversing from the persisted `triage_actions.payload` jsonb. Task 13, technically a review-
surface change rather than a triage change, folded the separate `/memories` "Mark reviewed" flow
into the same `/review` feed as a synthetic `memory-unreviewed` item, closing the two-badges
problem the spec called out. Full data model, routing table, and actuator detail:
[`triage.md`](../wiki/triage.md).

**Rollout state, unambiguous:** every threshold — Task, Note, Memory, Append — ships at `1.1`.
Since a clamped model confidence tops out at `1.0`, **nothing can auto-apply under the shipped
config**, including a hypothetical perfect `1.0` score; this is asserted directly in
`test/triage-route.test.ts`. **The Memory threshold has an additional, independent hard gate:**
it must stay at `1.1` until MyMind task `f80622b9` ("Investigate enrich-memories dedup
under-catching") closes — confirmed still open (`status: todo`) as of this handover. Task, Note,
and Append are not blocked by that dependency and may be lowered independently once the queue
has been read against real captures for a few days, per the spec's rollout steps.

## The review loop — what it actually caught

Fourteen tasks plus one mid-cycle addition (Task 11b), subagent-driven, per-task two-verdict
review with fix rounds where a reviewer found Important-severity issues. In commit order:

**Tasks 1–4 (schema, types + `parseTriage`, `route()` + thresholds, prompt + `classify()`).**
All clean on first review. Task 3 independently verified all four thresholds shipping at `1.1`
in the committed `nuxt.config.ts`. Task 4's implementer verified the note-path system prompt
actually *reverses* `enrich.ts`'s "keep the existing filename" instruction — the change this
whole cycle exists to make browsable. Deferred minors: `triage.ts`'s schema uses `t => ({`
where all 19 sibling schema files use `(t) => (` (cosmetic, inherited from the brief verbatim);
`parseTriage`'s brace-matching doesn't skip string literals, inherited unchanged from the
pre-existing `parseProposal` (fails safe to `null`, but triage inputs are more likely than
enrichment inputs to contain a literal `}` in a value); no regression test proving a
model-supplied `targetDocId` is silently dropped (the property holds in code, guarded only by
review — flagged forward, never picked up); pure-logic layout split across
`server/lib/ai/triage.ts` and `server/lib/triage/route.ts` (both plan-specified, unreconciled).

**Task 5 (task + note actuators).** Clean, but produced the `deleteTask`-is-a-soft-delete
finding recorded above, plus two other deferred minors: `{ ...action, originalPath } as
TriageAction` stores a field the type doesn't declare (works only because `recordAction` erases
the type at the jsonb boundary — carried forward as a note for Tasks 10/12, which do read that
field back out); actuators are not transactional (a mid-sequence throw can orphan a created
entity with no audit row — matches this repo's existing no-cross-service-transactions
convention, not a regression). A controller-level fix outside any task's declared scope
(`3296cb7`) also landed here: an unrelated undo test (`undo-cas.db.test.ts`) was pinned against
a leaking-undo-message bug that a same-session commit had already fixed, and because
`pnpm test` excludes `*.db.test.ts` and CI runs no Postgres (MyMind task `70bcc740`, still open),
that break would have shipped to prod uncaught.

**Task 6 (memory actuator) — 1 Important, one fix round.** The `$fetch` shim in the new test
proxied to a **live embeddings rig on the homelab GPU box**, making `pnpm test:db` depend on
real network hardware being up. In-repo precedent for a canned mock already existed
(`comfy.test.ts`, `edit.test.ts`); the reviewer also noted the asserted dedup case is the
`sha256` content-hash branch, which never needed a real vector in the first place. Fix round 1
replaced the live passthrough with a canned mock.

**Task 7 (orchestrator + idempotency).** Clean, and the implementer independently caught a
false-negative in the brief's own prescribed vacuity check: at a low threshold, auto-apply
soft-deletes the courier, so a racing second call bails via "document not found" instead of via
the claim — which would have masked a genuinely broken claim as a passing test. Two deferred
minors: the triage.ts/route.ts file split (repeat of Task 3's note); losing the claim and
targeting a nonexistent doc id both return the same `skipped: 'already-triaged'`, so a caller
can't distinguish "raced" from "bad id" — inherited from the brief.

**Task 8 (wire into capture).** This is where the transcribe-endpoint plan defect (item 1 above)
surfaced and was fixed by the controller, adjudicated void with no functional gap. Live-validated:
capture returns in 13ms; the pending triage review row for a low-confidence proposal appeared
roughly 10 seconds later, correctly queued (confidence 0.9, below the shipped 1.1 bar), with
`applied: []`.

**Task 9 (cron sweeper, retire `enrich-input`) — 1 Important, one fix round.** `sweepUntriaged`
had no per-candidate `try`/`catch`: one throw would abort the whole batch **and** permanently
strand the doc it was on (its `triaged_at` already claimed, no review row ever written) — the
retired `runEnrichInput` had per-doc isolation that wasn't carried forward into its replacement.
Fix round 1 added the isolation plus a headline regression test proving a doc with a project and
tags is still swept (the exact case the old `enrich-input` filter permanently excluded). A scope
addition — `vitest.db.config.ts` `fileParallelism: false` — was escalated and adjudicated OK by
the re-reviewer: `sweepUntriaged` is the first broad-predicate `test:db` file, all DB tests share
one real Postgres with no per-file isolation, the config file is local-only (CI never runs
`test:db`), and no narrower lever exists in vitest for this. Deferred minor: the sweeper's own
DB test "parks" real pre-existing `/input` documents for the test's duration (stamping and later
un-stamping `triaged_at`) rather than only touching fixtures — a kill mid-test leaves a real
capture permanently claimed with no review row. The reviewer judged the alternative (writing fake
review rows onto real production-shaped docs on every local test run) worse, and left this
flagged rather than fixed.

**Task 10 (append actuator) — the `documents.embedding` plan defect (item 2 above), plus 2
Important on top of the implementer's own fix, one further fix round.** Beyond the resolver
rewrite: (1) the resolver omitted `notSkill()`, so a jot could in principle get appended into a
live agent skill file (6 skill docs / 21 chunks reachable on the corpus at the time); (2) the
resolver itself had zero *direct* test coverage — four of five brief-mandated tests bypass it,
and the fifth passed only incidentally. Fix round 1 added `notSkill()` to the resolver, a shared
`isValidAppendTarget` guard applied even to an explicitly supplied `targetDocId` (defense in
depth for a path the classifier can't currently reach, since `parseAction` strips
`targetDocId` from model output), and four deterministic resolver tests against controlled
vectors — the skill guard was verified red before the fix and green after. An incidental fix:
the test's `useRuntimeConfig` stub was missing `triageAppendSimilarityFloor`, which made the
floor comparison `>= undefined` (always false) and would have made the new floor tests
vacuous — caught and fixed by the implementer before it shipped. Deferred minor: the "returns
null below the similarity floor" test depends on ambient dev-corpus content (its fixture vector
never actually wins the ranking, so the assertion is really "does any real chunk clear 0.75
against this probe" rather than a controlled case) — its three siblings are deterministic; this
one isn't, and wasn't fixed.

**Task 11 (review-kind rendering) — clean, but its browser validation is what exposed item 3
above** (the multi-intent defeat), leading directly to the unplanned Task 11b. A pure refactor
commit inside this task (extracting the handler map) was independently verified
behaviour-preserving byte-for-byte via `git show --stat` with zero test edits. Three deferred
minors: the approve-success toast counted the *pre-request* queued-action length rather than
what the server actually applied (fixed in Task 11b once the endpoint's return shape changed to
carry the real count); no automated test covered `approveTriage` partial-failure tolerance,
`rejectTriage`'s `triaged_at` re-stamp, or the 400-on-unknown-kind branch — browser-validated
only, and this remains the case (see the sweeper-population correction in `triage.md`, which
depends on exactly this re-stamp behaviour and still has no direct test); `TRIAGE_KIND_LABEL`/
`TRIAGE_KIND_COLOR` have no runtime fallback for an unexpected kind, unlike `triageDestination`'s
own default case.

**Task 11b (unplanned, controller-authored brief) — clean on review.** Fixed item 3 above:
`getDocIncludingDeleted` for task/memory/append, `applyNote` kept live-only and made to refuse
rather than resurrect a consumed courier (verified by a dedicated test that the deleted-inclusive
read is used only to phrase the refusal's error message, never to proceed), an end-to-end guard
(stubbed classify → task + memory both apply from one proposal, `queued: false`), and the toast
now reports the server's real applied count. The reviewer independently re-verified the RED run's
authenticity against the base commit's actual line numbers before accepting the GREEN fix.
Two deferred minors: a second courier-consuming action in a multi-action proposal still publishes
a `document deleted` live event for a delete that actually no-op'd (inert today — nothing
currently dispatches on it beyond a query invalidation); `applyAppend`'s degrade-to-note path
when the courier is already consumed *and* no append target resolves is reachable but untested
(a one-line delegation to the already-tested `applyNote`, fails safe).

**Task 12 (recently-applied strip + durable reversal) — 1 Important (plan-mandated), fixed
in-loop.** Durable note-revert restored the document's `path` but not its `title` —
`applyNote`'s payload never captured `originalTitle`, so `revertTriageAction` returned `ok: true`
while silently leaving the AI-assigned title in place. Same failure class as the Task 11b bug:
reporting success for work not fully done. Ruled fix-in-loop (additive, and consistent with the
plan's own intent that durable reversal actually reverses). Fix round 1 added faithful
three-state `originalTitle` handling (absent / present-null / present-string, so "this document
had no title before triage" round-trips correctly) and retargeted a leak-guard assertion that
could never fail (it checked for content that was never in the failing query's bound params) at
`originalPath`, a real bound param.

**Task 13 (fold memory review into `/review`) — 2 Important, one fix round.** (1) A memory
already the subject of a *pending* memory-supersede/contradict conflict row could also surface as
a synthetic `memory-unreviewed` item — listed and counted twice, with "Mark reviewed" on the
synthetic leaving the real conflict decision orphaned (the conflict path ignores confidence
while the memory's own `reviewedAt` uses `shouldAutoReview` against a different number, so this
was genuinely reachable, not theoretical). (2) the new `['review', *]` live-invalidation on
memory events was undebounced — the exact burst `live-dispatch.ts`'s own existing comments exist
to prevent. Fix round 1 added a `NOT EXISTS` exclusion for conflict-pending memories in the
shared `unreviewedLive()` (used by both the list and the count, scoped to `status = 'pending'`
so a *resolved* conflict doesn't hide real unreviewed work) and a 700ms debounced invalidator
mirroring the existing `invalidateGraph`/`invalidateHome` pattern. One deferred minor:
`/api/memories/count`, `useMemories().count()`, and the `['memory', 'count']` invalidation are
now dead code (zero callers) after the badge removal — not deleted, just orphaned.

One transient, non-reproducing failure was observed once during the branch, in
`test/mcp-transport.test.ts` (its self-hosted HTTP server 404'd on one run); it did not
reproduce in isolation or on re-run and is unrelated to anything this cycle touched.

## Gate numbers (measured this task, at HEAD)

```
pnpm typecheck   → 0 errors
pnpm test        → 1200 passed, 156 test files, 0 failed
pnpm test:db     → 93 passed, 11 test files, 0 failed   (real Postgres — dev DB)
pnpm build       → clean, exit 0 ("✨ Build complete!")
```

All four measured directly for this handover, not copied from the ledger — the task brief for
this documentation pass required that. `pnpm test:db` is not part of the CI/deploy gate (no
Postgres in CI, MyMind task `70bcc740`, still open) but is the gate every `*.db.test.ts` file in
this cycle actually runs under locally.

## Deferred minors carried forward (not fixed this cycle)

Everything the ledger flagged as deferred or "FLAG TO FINAL REVIEW," for whoever does a
whole-branch review before merge. None of these are correctness bugs in what shipped under the
`1.1` thresholds — they're test-quality gaps, cosmetic inconsistencies, or accepted residuals,
each already triaged during its own task's review.

1. `triage.ts`'s schema definition uses `t => ({` where all 19 sibling schema files use
   `(t) => (` — cosmetic, inherited verbatim from the brief (Task 1).
2. `parseTriage`'s brace-matching doesn't skip string literals, so a literal `}` inside a
   proposed value can close the JSON match early — inherited unchanged from `parseProposal`,
   fails safe to `null` (Task 2).
3. No regression test proves a model-supplied `targetDocId` is dropped by `parseAction` — the
   property holds in code, guarded only by review (Task 2).
4. Pure triage logic is split across `server/lib/ai/triage.ts` and `server/lib/triage/route.ts`
   — both plan-specified, never reconciled into one location (Tasks 3, 7).
5. `{ ...action, originalPath }`-style payload spreads store fields `TriageAction` doesn't
   declare, working only because `recordAction` erases the type at the jsonb boundary (Task 5).
6. Actuators are not transactional — a mid-sequence throw can orphan a created entity with no
   `triage_actions` row. Matches this repo's existing no-cross-service-transactions convention,
   not a regression introduced here (Task 5).
7. `sweepUntriaged`'s own DB test temporarily "parks" real pre-existing `/input` documents
   (stamps and un-stamps `triaged_at`) rather than only touching fixtures; a kill mid-test
   leaves a real capture permanently claimed with no review row. Judged the lesser evil versus
   writing synthetic review rows onto real docs on every local run (Task 9).
8. The append actuator's "returns null below the similarity floor" test depends on ambient
   dev-corpus content rather than a fully controlled fixture — its three siblings are
   deterministic, this one isn't (Task 10).
9. No automated test covers `approveTriage`'s partial-failure tolerance, `rejectTriage`'s
   `triaged_at` re-stamp (the exact mechanism `triage.md`'s sweeper-population correction
   depends on), or the 400-on-unknown-`kind` branch — browser-validated only (Task 11).
10. `TRIAGE_KIND_LABEL`/`TRIAGE_KIND_COLOR` have no runtime fallback for an unexpected `kind`,
    unlike `triageDestination`'s own default case (Task 11).
11. A second courier-consuming action in a multi-action proposal still publishes a
    `document deleted` live event for a delete that actually no-op'd — inert today, since
    nothing beyond a query invalidation currently dispatches on it (Task 11b).
12. `applyAppend`'s degrade-to-note path, when the courier is already consumed *and* no append
    target resolves, is reachable but untested — a one-line delegation to the already-tested
    `applyNote`, fails safe (Task 11b).
13. `/api/memories/count`, `useMemories().count()`, and the `['memory', 'count']` live
    invalidation are dead code (zero callers) after the badge removal in Task 13.
14. Losing the `triaged_at` claim and targeting a nonexistent document id both return the same
    `skipped: 'already-triaged'` from `triageCapture` — a caller can't distinguish "raced" from
    "bad id" (Task 7, inherited from the brief).

## A finding from this documentation pass, not from the build

Writing [`triage.md`](../wiki/triage.md) surfaced one more gap between the spec's stated intent
and shipped behaviour that no task's review caught, because it isn't a bug in any one task —
it's an emergent property of two correct-in-isolation pieces of code. The spec says: "a rejected
or failed document becomes eligible again [for the sweeper] rather than being skipped forever."
In shipped code, `documents.triaged_at` is **only ever set, never cleared**, anywhere in this
codebase. `rejectTriage` (`server/api/review/kinds.ts`) *re-stamps* it (explicitly, with a
comment explaining the intent: keep the sweeper from immediately re-proposing something a human
just rejected) rather than clearing it, and a parse failure leaves the original claim-time stamp
in place (so a document the model can't parse isn't retried every ten minutes forever). The
practical result: a rejected or unparseable proposal is a **terminal state** for that document,
same as an approved one. The real, verified fix is narrower than the spec's wording — every
`/input` document is now guaranteed exactly one triage pass (the old `enrich-input` filter could
skip a document forever without considering it even once, which is the bug this genuinely
fixes) — but "rejected items become eligible again" does not hold today. This is not flagged
anywhere in the ledger; Task 11's deferred-minor #9 above (no test on `rejectTriage`'s re-stamp)
is adjacent but doesn't call out the behavioural gap itself. Worth a look before the thresholds
come down, since it affects how a rejected proposal should be interpreted operationally (final,
not "will come back around").

## MyMind bookkeeping

- MyMind task `f80622b9` ("Investigate enrich-memories dedup under-catching") — confirmed still
  `todo` as of this handover. The Memory threshold stays at `1.1` until this closes; do not
  lower it manually in the interim.
- MyMind task `562b77f5` ("Capture titling — /input inbox can't be browsed") — the Note
  actuator's rename-on-file behaviour is the code-level fix for this, but it does not take
  effect for any given capture until either the Note threshold is lowered below the model's
  confidence or a human approves the note proposal by hand via `/review`. Not closed; annotated
  instead so it isn't mistakenly treated as already resolved for users.
- MyMind task `50717c31` ("check if we are running background organization on the /input dir")
  — directly answered by this cycle: yes, as of `feat/capture-triage`, but queue-only until
  thresholds are lowered. Annotated with the answer and a link to the wiki.
- A new "Cycle 57 follow-ups" task was filed with the 14-item deferred-minors ledger above plus
  the "rejected items don't actually re-queue" finding, mirroring the precedent set by cycles 55
  and 56.

## What to check before merging

- This branch has not been pushed, merged, or deployed. The new migration (`triage_actions` +
  `documents.triaged_at`) has only run against local dev.
- All four thresholds must still read `1.1` in `nuxt.config.ts` at merge time — verify nothing
  crept lower during the build (nothing did, as of this handover; the constraint held at every
  commit per the plan's Global Constraints section).
- The 14 deferred minors above, plus the sweeper re-stamp/reject finding — none block a merge,
  but a whole-branch reviewer should see them named rather than discover them independently.
- `pnpm test:db`'s 93 tests are not wired into any deploy gate (MyMind task `70bcc740`, open
  since cycle 52) — `pnpm test` alone would stay green through a regression in any `*.db.test.ts`
  file, including every actuator/idempotency/sweeper test this cycle added.
