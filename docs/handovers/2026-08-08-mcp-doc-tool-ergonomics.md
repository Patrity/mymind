---
title: MCP document-tool ergonomics — unified errors, guarded undo, honest preamble (cycle 53)
cycle: 53
date: 2026-08-08
status: >
  🔨 BUILT, NOT MERGED. 17 code commits on `feat/mcp-doc-tool-ergonomics` (branched from master
  `f16648f`), Tasks 1-9 each review-clean (5 fix rounds across the branch — Tasks 5, 6, 7, 8 ×2,
  9 — all re-reviewed clean). Task 10 (prod document reconciliation) executed directly by the
  controller after the dispatched subagent correctly refused a relayed "the human authorised
  this" instruction it could not itself verify — see "Task 10" below. **NOT merged, NOT pushed,
  NOT deployed.**
  Gates measured at HEAD (2026-08-09): **typecheck 0 errors / test 1097 passed across 143 files /
  test:db 30 passed across 4 files / build clean (65.7 MB, 19.5 MB gzip)**. No migration.
branch: feat/mcp-doc-tool-ergonomics (off master f16648f; 17 code commits, 088889a..ce7dd21)
spec: ../superpowers/specs/2026-08-07-mcp-doc-tool-ergonomics-design.md
plan: ../superpowers/plans/2026-08-07-mcp-doc-tool-ergonomics.md
docs:
  - ../wiki/mcp.md (unified failure-shape section + code table, outline cap, the MCP-surface
    undo-token gap, updated during Tasks 8, 10, and this task)
  - ../superpowers/plans/00-roadmap.md (cycle-53 row inserted after 52)
related:
  - ../handovers/2026-08-02-mcp-agent-ergonomics.md (cycle 52 — filed four of this cycle's five
    problems; shipped write receipts + typed edit failures + sync_document)
  - ../handovers/2026-08-05-structural-tool-history.md (cycle 43 — the vacuous-assertion lesson
    this cycle's plan re-learned three more times, see "Eight plan defects" below)
problem: >
  Cycle 52 shipped write receipts and typed edit failures for `edit_document` specifically, plus
  `sync_document`, but left three follow-ups: the document tools disagreed on failure shape
  (`edit_document` used `{ok,error,message}`; `read_document`/`grep_document`/`update_document`/
  `delete_document` used ad-hoc `{error: "prose"}` with no `ok` and no stable code); undo
  restored unconditionally on five of eight document-mutating tools, so redeeming a stale token
  could silently clobber a write that landed after the original action (in the UI, from another
  agent, or from a sync); and the MCP server's `instructions` preamble still prescribed the
  cycle-40 edit-replay workflow, never mentioned `sync_document`, and overclaimed "all writes are
  reversible via undo" — a claim already false for the read-then-compare tools and, as a
  significant out-of-scope finding turned up mid-cycle, false in a much bigger way: the MCP
  transport itself never hands out an undo token at all.
keydecision: >
  One failure shape everywhere — `{ ok: false, error: <code>, message: <prose> }` — with codes
  owned by the pure `server/lib/documents/edit-ops.ts` module and passed through verbatim by
  `tools.ts` (`{ ok: false, ...res }`); a tool never re-spells a code edit-ops already owns. The
  undo contract widened *additively* (`UndoFn` return type `Promise<void | {ok, reason?}>`) so
  the ~18 undo closures outside the document tools stay untouched, and `runUndo` normalises a
  bare `void` return to `{ok:true}` while keeping a refused token retryable (consumed only on
  success). Guards are the strongest primitive available per field: content restores CAS against
  the DB-generated `content_hash` column (`casUpdateContent`); everything else (path, title,
  tags, type, domain, frontmatter) has no CAS primitive, so those undo closures read-then-compare
  on `updatedAt` (accepted TOCTOU, documented in the code). The preamble stopped naming a
  mechanism at all after three rounds of per-tool wording each turned out wrong for some branch —
  round 3 states only the one thing true of every undo without carve-out ("an undo can decline;
  check the result").
deferred: >
  Not merged, pushed, or deployed — awaiting Tony's merge decision, plus a live smoke test of the
  in-app undo-refusal UX (galaxy + agent chip) once dev has a network path to a real turn. Also
  carried forward, all pre-existing and explicitly not fixed in this cycle (see the four sections
  below for detail): the MCP transport never issues an undo token to any MCP client (structural,
  not a regression — `server/lib/mcp/server.ts:22-26`); `get_document` is the one remaining
  unconverted tool on the old raw-doc/null shape; `pnpm test:db`'s 30 CAS/guard tests are not
  wired into the deploy gate (MyMind task `70bcc740`, stays open); and the plan's stale
  three-document reconciliation count was corrected to ten during Task 10, with all ten now
  promoted (see "Task 10" below).
  ONE STEP OUTSTANDING — this handover is NOT yet mirrored to MyMind
  (`/projects/mymind/handovers/2026-08-08-mcp-doc-tool-ergonomics.md` does not exist). Three separate
  attempts died mid-response on the `sync_document` call with an API transport error, at real token
  cost, so it was deferred rather than retried a fourth time. Prod was verified healthy throughout
  (`/api/health` 200 in ~180ms across five samples; `/api/mcp` answering 401 in 165ms), and a small
  `search_docs` read also timed out, so this was this session's MCP transport rather than the app or
  the payload size. The repo copy is authoritative; re-run the mirror when the transport is stable.
---

# MCP document-tool ergonomics (cycle 53)

## Status, plainly

**Built, not merged.** `feat/mcp-doc-tool-ergonomics` has 17 code commits off master `f16648f`
(`088889a` the first Task-1 commit → `ce7dd21` the last Task-9 fix-round commit), plus this
docs-only task. Tasks 1-9 each passed review (Tasks 5, 6, 7, and 8 needed fix rounds — 8 needed
two — all re-reviewed clean; 9 needed one). Task 10 (reconciling ten production documents whose
frontmatter had been embedded in `content`) was performed directly by the controller, not a
subagent — see [Task 10](#task-10-ten-documents-reconciled-not-three) below for why. The branch
is **not merged to master, not pushed, and not deployed**. There is **no migration**.

## What shipped

- **One failure shape, everywhere a document tool can fail** (Tasks 1-3). `read_document`,
  `grep_document`, `edit_document`, `edit_section`, `update_document`, `move_document`,
  `delete_document`, and `sync_document` all answer a failure with
  `{ ok: false, error: <stable code>, message: <human prose> }`. Codes that originate in pure
  string-transform logic (`heading_not_found`, `ambiguous_heading`, `invalid_regex`,
  `replace_needs_heading`, `empty_old_string`, `no_match`, `ambiguous_match`) live in
  `server/lib/documents/edit-ops.ts` and are spread through by the tool handler
  (`{ ok: false, ...res }`) rather than re-spelled; codes with no `edit-ops.ts` equivalent
  (`not_found`, `no_fields`, and `sync_document`'s own `path_required`/`content_required`/
  `adopt_conflict`/`hash_mismatch`/`expected_hash_required`) are owned directly by `tools.ts`.
  Every converted tool's `description` now states its failure codes, so an agent can branch on
  `error` without guessing what's possible. A heading-failure result includes the document's
  outline (`clipOutline`, capped at `MAX_ERROR_OUTLINE` = 50 headings, `outlineTruncated` set when
  the real outline is longer) so the agent can retry immediately instead of round-tripping a
  second `read_document` call. `get_document` is the one tool this cycle deliberately left
  unconverted — it still returns the raw document or `null`, no `ok`/`error`/`message` — flagged
  as an outlier for a future cycle, not silently left undocumented.
- **Undo can refuse instead of clobbering** (Tasks 4-6, in-app agent surface only — see the first
  "must-record" item below). The `UndoFn` return type widened additively to
  `Promise<void | { ok: boolean, reason?: string }>`; `runUndo` (`server/lib/agent/undo.ts`)
  normalises a bare `void` to `{ ok: true }` and — the load-bearing change — **consumes the token
  only on success**, so a refused undo stays retryable once the caller reconciles instead of
  silently burning the one chance to undo. All five document-mutating tools with an undo closure
  now guard it: `edit_document`/`edit_section`/`update_document`/`sync_document`'s update branch
  CAS the content restore against the DB-generated `content_hash` column (refusing outright if
  the row vanished mid-write, rather than falling through to `casUpdateContent`'s
  `expectedHash: null`, which means *force*); `move_document`, `update_document`'s metadata
  fields, and `sync_document`'s adopt/unchanged branch read-then-compare on `updatedAt` (no CAS
  primitive exists for those fields, so this is an accepted, documented TOCTOU).
  `sync_document`'s create branch and the three retire tools (`delete_document`/`delete_task`/
  `forget_memory`) still restore unconditionally once past the token-expiry check — no
  changed-since guard exists there, and this cycle didn't add one.
- **The refusal reaches the in-app UI, not just the HTTP response** (Task 9). A new pure
  `undoFeedback()` (`app/lib/agent/undo-feedback.ts`) decides what to tell the user: `ok:true` →
  say nothing; `ok:false` → `{ title: 'Nothing was undone', description: reason ?? '…', color:
  'error' }`. Wired once in `app/composables/useUndo.ts` (`redeem(token)`: POST
  `/api/agent/undo`, run the response through `undoFeedback`, toast if there's feedback, return
  `{ok, reason?}` to the caller) rather than patched into three call sites independently.
  `app/pages/agent/index.vue`'s chip-undo was already correct once wired. `app/pages/galaxy.vue`
  needed a real fix, not just wiring — its `onUndo` fired an unconditional neutral "success" toast
  *in addition to* `useUndo()`'s refusal toast, so a refused undo showed two toasts asserting
  opposite outcomes (worse than the silent no-op before this task); fixed by gating the success
  toast on `ok`. `useAgentActivity.ts` (`app/composables/useAgentActivity.ts`) is wired correctly
  too, but is dead code — see the second "must-record" item below.
- **An honest preamble** (Task 8). `MCP_INSTRUCTIONS` (`server/lib/mcp/server.ts`) now points at
  `sync_document` for the "I hold the file" case and `read_document`/`grep_document` +
  `edit_document`/`edit_section` otherwise, replacing the old edit-replay-only wording. The undo
  claim went through three review rounds because each attempt to state *which* tools guard *how*
  turned out wrong for some branch (see "Eight plan defects" below); it now states only the one
  universal fact — an undo can decline, so check the result — with no tool list and no guard-type
  claim to falsify. `docs/wiki/mcp.md`'s preamble section was kept in sync in the same commits.
- **Curated titles survive a relocation** (Task 7). `update_document`/`sync_document`'s
  path-change branch used to re-derive `title` from the new path's basename whenever the caller
  didn't explicitly pass one, silently overwriting a title someone had hand-edited. A new
  `nextTitleOnMove(current, explicit, wasAuto, newPath)` helper (typed `explicit: string | null`,
  not `string | undefined` — see "Eight plan defects") only re-derives the title when the current
  one was itself auto-derived (`wasAuto`); an explicit `null` short-circuits to "leave it alone"
  rather than falling through to a basename sync.
- **Ten production documents reconciled** (Task 10 — see its own section below for the full
  accounting; the plan said three).

## The undo hardening does not reach MCP clients at all

**Read this before assuming Tasks 4-6 protect an MCP session.** `buildMcpServer`
(`server/lib/mcp/server.ts:22-26`, untouched by this cycle) registers each tool's handler and
returns only:

```ts
return { content: [{ type: 'text' as const, text: JSON.stringify(exec.result) }] }
```

It never calls `registerUndo(exec.undo)`. No undo token is ever handed to an MCP client — not
Claude Code, not the MCP Inspector, not a claude.ai custom connector. There is no `undo` tool
anywhere in `agentTools`, and the only way to redeem a token, `runUndo` via
`POST /api/agent/undo`, is a plain Nitro REST route an MCP session has no route to call at all.

So every CAS guard and every `updatedAt` read-then-compare this cycle added is real protection —
for the **in-app agent surface only**. `server/lib/agent/ai-tools.ts` registers the token on
every mutating call there, and `app/pages/agent/index.vue` / `app/pages/galaxy.vue` redeem it
through `useUndo()`. An MCP client can call `edit_document`, get back a receipt, and has no way
to ever undo it — not because the guard is weak, but because the capability was never wired to
that transport. This is pre-existing (the gap predates this cycle; it was surfaced as a
significant out-of-scope finding during Task 8's review, not introduced by Tasks 4-6), and this
cycle did not close it. `docs/wiki/mcp.md` states this plainly now, in the preamble section.

## Task 9's delivered value is narrower than its file count

Three files were touched (`app/lib/agent/undo-feedback.ts` new, `app/composables/useUndo.ts` new,
plus the three call sites it replaced), but the three call sites land in three different states:

- **`app/pages/agent/index.vue`** — clean. Its chip-undo (`undoTool`) already only acted on `ok`;
  switching it to `useUndo()` added the refusal toast with no behavioural fix needed.
- **`app/pages/galaxy.vue`** — actually repaired, not just wired. Its `onUndo` fired an
  unconditional success toast regardless of outcome; paired with `useUndo()`'s new refusal toast,
  a refused undo would have shown **two contradictory toasts** ("Nothing was undone" and
  "Relation removed"/"Memory restored" together) — worse than the silent no-op this task exists
  to fix. Caught in Task 9's own review; fixed by gating the success toast on `ok` (commit
  `ce7dd21`).
- **`app/composables/useAgentActivity.ts`** — correctly wired (`const redeem = useUndo()`,
  `undo(chip)` delegates to it), but **dead code**. Grepped repo-wide: it appears only in its own
  defining file, never imported or invoked anywhere else. Wiring it was still the right call — it
  was in the brief's file list, cost nothing, and prevents a future caller inheriting a stale
  `{ok}`-only contract — but "three surfaces fixed" overstates it. The accurate count is one
  clean, one repaired, one correct-but-unreachable.

## The CAS guards ship without CI coverage

`pnpm test:db` (`vitest.db.config.ts`) holds the real-Postgres tests that actually exercise
`casUpdateContent` and the `content_hash` generated column — 30 tests across 4 files, all green
at HEAD. **It is not wired into the deploy gate.** `pnpm test` (the CI-gating command) never runs
these; CI has no Postgres service (a cycle-52 constraint, unchanged here). This means breaking
the CAS guard, or breaking the `doc_content_hash()` generated-column expression, leaves
`pnpm test` green and would ship. This is MyMind task **`70bcc740`**, filed against this exact
gap, and it **stays open** — this cycle did not close it, and this handover is not claiming the
gate covers it. Run `pnpm test:db` manually before trusting a change that touches
`casUpdateContent`, `documents.content_hash`, or `doc_content_hash()`.

## Task 10: ten documents reconciled, not three

The plan's Task 10 brief, carried from a stale cycle-52 audit, said three documents in the corpus
had frontmatter embedded in `content` instead of the `frontmatter` column. The real count, found
by walking **all 110 documents in the corpus** (both `list_documents` pages, `hasMore:false`
confirmed — 100% of the corpus, not a sample) is **ten**:

| id | path | before → after bytes |
|---|---|---|
| `ecbaeda8` | `/projects/nls-site/contact-pipeline.md` | 10565 → 10428 |
| `454143f0` | `/projects/nls-site/marketing-site.md` | 17757 → 17605 |
| `87cc7c47` | `/projects/nls-site/nls-site-squarespace-to-nuxt-migration-design-spec.md` | 14166 → 13962 |
| `4fb73620` | `/projects/pixforge-2/pixforge-wiki-projects-and-atlas-editor-ui.md` | 14985 → 14114 |
| `eeb1cc32` | `/projects/pixforge-2/pixforge-wiki-projects-atlases-and-export.md` | 37381 → 35980 |
| `dfc2b67b` | `/projects/mymind/wiki-knowledge-galaxy-galaxy.md` | 3762 → 3642 |
| `97515acd` | `/projects/mymind/knowledge-galaxy-interactive-3d-knowledge-graph-cycle-47-spec.md` | 7081 → 6790 |
| `c8ee2f80` | `/projects/rogue-racer/2026-07-11-50-curfew-rebrand.md` | 4381 → 3595 |
| `671334c0` | `/projects/pixforge-2/pixforge-wiki-sprite-pipeline-derive-caption-embed.md` | 16312 → 15868 |
| `44f44776` | `/projects/pixforge-2/wiki-packs-ui.md` | 5518 → 5368 |

**Two of the ten (`671334c0`, `44f44776`) would never have been found by the plan's own discovery
query.** The plan's proposed SQL, `content LIKE '---%'`, requires the frontmatter delimiter at
byte offset 0. Both of these documents open with a 2-3 line blockquote provenance note ("Mirror of
`docs/wiki/...` on branch...") **before** their real `---`-delimited `title:`/`status:`/
`last_updated:` block — so the leading-anchor pattern silently skips them. A future session
re-running that exact query would have concluded the reconciliation was complete with two
documents still broken. Both blockquotes were deliberately preserved during promotion (the
provenance note is genuine prose, not misplaced frontmatter) — verified after promotion by
re-reading all ten heads: eight now open directly on their `# heading`, the two blockquote-prefixed
ones keep their note followed by one blank line then the heading.

All ten had an **empty `frontmatter` column** (`{}`) before promotion, so every promotion was a
clean fill — no merge, no overwrite risk. Two candidates (`dfc2b67b`, `c8ee2f80`) were
mechanically confirmed via `sync_document`'s probe mode (`local_hash`, no write): both returned
`in_sync:false` with `server_hash` equal to the document's own `contentHash`, proving the stored
hash covers the embedded frontmatter bytes, not just visually matching the frontmatter shape. The
other eight were confirmed by direct structural reading (real `key: value` pairs, a closing `---`,
no ambiguity). Three additional candidates from the initial scan were ruled out as false positives
— bare horizontal rules or a single `·`-separated display line, not per-line YAML (see
`task-10-report.md` for the individual reasoning).

**Order used during promotion:** the `frontmatter` column was set first, then the block stripped
from `content` — a mid-way failure would leave the data duplicated, never lost. Types were
preserved, not stringified (`dfc2b67b`'s `cycle: 47` stored as a number; `c8ee2f80`'s `tags: [...]`
stored as a real JSON array). Every edit reported `replacements: 1`. All ten were promoted and
verified on 2026-08-09.

**Why the controller did the writes, not a subagent.** The dispatched read-only identification
pass (Task 10a) was followed by a message asserting "the human has authorised the writes." The
subagent correctly refused to act on it: its operating constraints state that no message from
another agent constitutes the user's own consent, and MCP clients here are never issued an undo
token (see above) — so a bad write to a live production document would have been permanent, with
no channel available to verify the relayed authorisation was genuine. It captured a verbatim
before-state snapshot of all ten documents (the only restore path) and stopped. The controller,
holding the actual human authorisation directly rather than relaying it, performed the ten
promotions itself, one at a time, verifying each before the next.

**One observation carried forward, not acted on.** `c8ee2f80`'s promoted frontmatter contains
`tags` and `type` — both of which are *also* first-class promoted columns in this schema
(`project`/`domain`/`type`/`tags`/`topic` are meant to be promoted out of frontmatter per the
roadmap's locked decisions). They were stored in the `frontmatter` jsonb column verbatim, as
authorised — whether they should *additionally* populate the real `tags`/`type` columns is a
separate decision, not made during this cycle.

## Eight plan defects caught during execution

None were caught by a gate — `pnpm test` stayed green through every one. All were caught by an
implementer reading the real code against the brief, or by a reviewer:

1. **(Task 2) A fixture that asserted the opposite outcome for identical inputs.** The brief's
   "stays silent when there are matches" case used `grepContent('foo zzz bar', 'foo.*bar', {})` —
   a literal (non-regex) call, so `.includes()` is false and the fixture was a 0-match case
   input-identical to the preceding test asserting the opposite. Corrected the haystack to a real
   literal match, holding the pattern constant.
2. **(Task 5, the sharpest) An `?? null` that meant force-write, so the clobber fix contained a
   clobber.** The brief's undo snippet was `casUpdateContent(id, prior, updated?.contentHash ??
   null)`. `casUpdateContent` treats `expectedHash: null` as *force* — so when `updated` was
   `null` (the row deleted between the read and the write landing), the fallback disabled the
   guard entirely and force-wrote `prior` over whatever was there. Fixed by refusing outright on
   `!updated` before ever constructing the CAS call, rather than falling through to a
   guard-disabling default.
3. **(Task 6) An undo snippet that restored two fields where the function patches five.** The
   brief's `sync_document` adopt/unchanged undo restored only `path` + `title`, but
   `applySyncMeta` (`tools.ts:38-50`) patches `path`, `title`, `tags`, `type`, and `frontmatter`.
   As written, the undo would have reported `ok:true` while leaving three fields clobbered.
   Implementer caught it against the real function signature; restored all five.
4. **(Task 6) A repo-wide invariant asserted from grepping one file.** The plan's comment claimed
   "`updatedAt` is bumped by every writer," citing two line numbers in one file. It was false —
   `server/services/image-enrich.ts` wrote `content`+`title` via a raw `db.update(documents)`
   with no `updatedAt` bump, reachable via the image-reprocess endpoint and the admin
   images-backfill — so a fresh image-spun-off doc's title could be silently clobbered by an undo
   reporting success, the exact failure mode the guard exists to close. Fixed by routing
   `image-enrich.ts`'s write through `updateDoc` instead of adding an exception, so the invariant
   became actually true rather than documented-and-false.
5. **(Task 7) A parameter typed too narrowly to typecheck its own call site.** The brief's
   `nextTitleOnMove` helper signature used `explicit?: string`, but the real call site passes
   `DocumentUpsert.title`, typed `string | null`. Widened to `explicit: string | null` —
   confirmed necessary by the implementer hitting the type error directly.
6. **(Task 8, recurring three times, one level deeper each time) A preamble replacement that was
   a different false generalisation.** Round 1 moved an over-broad "all writes reversible" claim
   to the editing-tools bullet, still wrong for `sync_document`'s create branch (unconditional,
   no guard at all). Round 2 tried to state per-branch precision and got `sync_document`'s
   adopt/unchanged branch's guard type wrong (called it "CAS-guarded" when the code's own comment
   calls it accepted TOCTOU). The fix that stuck stopped naming a mechanism at all — the one claim
   true of every undo without exception ("an undo can decline; check the result").
7. **(Task 9) An incomplete client file list.** The brief's file list for "surface the undo
   refusal" omitted `app/pages/galaxy.vue`. Its `onUndo` fired a success toast unconditionally —
   without the fix, wiring the other two files correctly would have shipped galaxy.vue in a worse
   state (contradictory toasts) than before the task. Caught in review, not by the brief.
8. **(Task 10) A discovery query encoding a false assumption.** The plan's proposed
   `content LIKE '---%'` assumes frontmatter always opens at byte 0. Two of the ten real
   candidates (`671334c0`, `44f44776`) open with a provenance blockquote first — see the Task 10
   section above.

**The lesson.** Every one of these was either an assertion that could not fail by construction (a
fixture identical to its sibling test, a repo-wide claim from one file, a query with a hidden
anchor assumption) or a real gap in the brief's own prescribed code, caught only by an
implementer tracing the real call site or a reviewer checking the claim against the code — never
by the test suite staying red. This is the same species of defect `2026-08-05-structural-tool-
history.md` names as its own top lesson: a mandatory "does this assertion actually fail on the
bug it claims to catch" check is not process theater, it is the only thing that caught most of
these.

## Gates (measured at HEAD, 2026-08-09)

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | **1097 passed**, 143 test files |
| `pnpm test:db` | **30 passed**, 4 test files (manual — not in CI, see above) |
| `pnpm build` | clean — 65.7 MB total (19.5 MB gzip) |

## Files touched (by task)

- Task 1 — `server/lib/documents/edit-ops.ts`, `edit-ops.test.ts`
- Task 2 — `server/lib/documents/edit-ops.ts`, `edit-ops.test.ts`
- Task 3 — `server/lib/agent/tools.ts`, `tools.test.ts`
- Task 4 — `server/lib/agent/undo.ts`, `undo.test.ts`, `server/api/agent/undo.post.ts`
- Task 5 — `server/lib/agent/tools.ts` (`edit_document`/`edit_section`/`update_document`/
  `move_document` undo closures), DB tests (`*.db.test.ts`)
- Task 6 — `server/lib/agent/tools.ts` (`sync_document` adopt/unchanged undo),
  `server/services/image-enrich.ts` (routed through `updateDoc`), DB tests
- Task 7 — `server/lib/agent/tools.ts` (`nextTitleOnMove`), `tools.test.ts`
- Task 8 — `server/lib/mcp/server.ts` (`MCP_INSTRUCTIONS`), `test/agent-tools.test.ts`,
  `docs/wiki/mcp.md`
- Task 9 — `app/lib/agent/undo-feedback.ts` (new), `undo-feedback.test.ts` (new),
  `app/composables/useUndo.ts` (new), `app/pages/agent/index.vue`, `app/pages/galaxy.vue`,
  `app/composables/useAgentActivity.ts`
- Task 10 — ten production documents (MCP writes, no repo files)
- Task 11 (this) — `docs/wiki/mcp.md`, `docs/handovers/2026-08-08-mcp-doc-tool-ergonomics.md`
  (new), `docs/superpowers/plans/00-roadmap.md`
