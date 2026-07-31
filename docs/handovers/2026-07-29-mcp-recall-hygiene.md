---
title: MCP recall hygiene — payload caps, review-gated recall, corroborated contradictions, path collapse (cycle 51)
cycle: 51
date: 2026-07-29
status: ✅ SHIPPED — merged to master (fast-forward, `e4f5a9e..dc06f1e`), pushed, and DEPLOYED via CD run 30573162535 (green, exit 0). Prod verified independently: LXC 114 `hostname` → `mymind`, `systemctl is-active mymind` → active, DB-touching `/api/health` → 200. Live prod MCP round-trip confirms the fix at production scale (see "Prod acceptance" below). Gates at merge: typecheck 0 / test 934 across 133 files / build clean. ⚠️ ONE STEP OUTSTANDING: `scripts/collapse-local-paths.ts --apply` has NOT been run on prod — the dry run is reviewed and a snapshot is saved, but the write is still pending Tony's go-ahead (see "Task 10 residual risk").
branch: feat/mcp-recall-hygiene (built subagent-driven in worktree `.claude/worktrees/mcp-recall-hygiene`, 8 plan tasks + 2 mid-flight plan-defect resolutions + per-task fix rounds + a final whole-branch-review fix wave; per-task briefs/reports, the execution ledger, and `final-fix-report.md` live in `.superpowers/sdd/2026-07-29-mcp-recall-hygiene/`)
docs:
  - ../wiki/mcp.md (living reference — tool table rows for `list_documents`/`search_docs`/`search_tasks`/`search_projects`/`search_memories`/`get_recent_memories` updated with `limit`/`offset`/`includeUnreviewed` + result shape; new "Recall defaults (cycle 51)" subsection; cycle bumped 48→51, updated 2026-07-29)
  - ../wiki/memory.md (living reference — new "resolution ladder" table naming `supersede` as the ONLY archiving action, the shared scope+corroboration gate on BOTH the refines and contradicts branches, and the reviewed-only defaults on all three agent recall paths incl. the automatic voice-turn injection; corrects the old ladder line that omitted `review-contradict`; cycle bumped 5→51, updated 2026-06-16→2026-07-29)
  - ../wiki/projects.md (living reference — `local_paths` no longer accumulates paths covered by a `path_prefixes` entry or a shorter sibling (`shouldRecordLocalPath`), plus the `scripts/collapse-local-paths.ts` runbook incl. `--project` and the no-undo snapshot command; cycle bumped 46→51, updated 2026-07-15→2026-07-29)
  - ../superpowers/specs/2026-07-29-mcp-recall-hygiene-design.md (spec)
  - ../superpowers/plans/2026-07-29-mcp-recall-hygiene.md (plan; amended mid-build at commit `0e11312` when the `searchProjects(q)` defect was found)
  - ../superpowers/plans/00-roadmap.md (cycle-51 row added by this handover)
related:
  - ../handovers/2026-07-28-session-search-mcp.md (cycle 50 — the `limit`/`offset` + `{items,total,hasMore}` envelope here deliberately diverges from that cycle's `(createdAt,id)` cursor; see "Paging divergence" below)
  - ../handovers/2026-07-17-mcp-oauth-connector.md (the single-operator, unscoped connector whose design finding 4 reaffirms)
problem: >
  An external Claude Code session used the MyMind MCP tools open-ended on 2026-07-29 and filed
  five findings (MyMind doc `mymind-mcp-feedback-external-agent-session-2026-07-29.md`, filed
  under `/input`). Two were reproduced independently the same day: `list_documents` (no filter)
  returned 662,712 chars and `search_tasks` (no filter) 282,904 chars, each as a single JSON
  tool-result line, blowing the consuming agent's tool-result budget and requiring a rescue to a
  scratch file; a MyMind session separately saw `search_docs` return 472,472 chars. A registry
  audit found a fourth tool of the same class the feedback doc missed entirely: `search_projects`
  (no limit at all). Independently: session-specific trivia was surfacing as durable fact via
  unreviewed low-confidence memories; a single-session memory could win a resolution against a
  well-corroborated incumbent purely on recency/confidence, with no notion of corroboration
  (**note:** the feedback doc and this cycle's spec both blamed the `contradicts` path; the path
  that actually archives is `refines`→`supersede` — see item 3 and planning defect 5 below); and
  one project (Terawulf) had accumulated ~50 `localPaths` entries already
  redundant with its registered `pathPrefixes`. Four of the five findings are fixed by this
  cycle; the fifth (tiered/per-project sensitivity scopes on MCP tokens) is REJECTED as a
  non-goal, not an oversight — see keydecision.
keydecision: >
  Item 1's real fix is payload SHAPE, not a row limit: two of the three overflowing tools
  (`list_documents`, `search_tasks`) already had a row cap or none that mattered, but every DTO
  still carried a full document body or task description — 25 long documents alone would still
  overflow a tool-result budget. The load-bearing change is new summary-select service functions
  (`listDocsSummary`/`searchDocsPage`/`listTasksSummary`/`listProjectsPage`, all body-free SQL
  `SELECT`s, not JS-side stripping after a full fetch) plus a shared `{ items, total, hasMore }`
  envelope (`limit` default 25 / max 100, `offset`); the `limit` is secondary. Paging
  deliberately uses `limit`/`offset` rather than the `(createdAt, id)` composite cursor the
  feedback doc recommended (and cycle 50's session tools use): `search_docs` is
  relevance-ordered (RRF-fused trigram + vector), and a date cursor cannot express a position in
  a relevance ranking; `list_documents` orders by `updatedAt desc`, which is not a stable cursor
  key under concurrent edits either. This is a breaking MCP contract change — any consumer still
  reading `result[].content` off `list_documents`/`search_docs` now gets `undefined`, which is
  intended (those were the overflowing consumers), but every affected tool's description now
  states explicitly where the body went (`get_document`/`read_document`/`grep_document`).
  Separately, Tony explicitly REJECTED finding 4 (tiered/per-project sensitivity scopes on MCP
  tokens) as a deliberate non-goal, not an oversight: the connector is single-operator and
  intentionally unscoped, and this should not be re-filed as a gap without a prior change to
  that operating assumption (e.g. sharing the connector with another person or agent).
---

# MCP recall hygiene (cycle 51)

## What shipped (branch `feat/mcp-recall-hygiene`, `e4f5a9e..HEAD`, **15 commits**)

> The header previously read `e4f5a9e..ca9d7a5` / 12 commits. That was wrong twice over: it
> excluded the handover's own docs commit (`b7dd984`, the branch tip at the time it was
> written), and it predates the two final-fix-wave commits (`a37909b` + this docs commit) that
> followed the whole-branch review. Verify with
> `git rev-list --count e4f5a9e..feat/mcp-recall-hygiene`.

Four independent items from the spec, each landed as its own commit (or commit + fix-round) so
any one is independently revertable, plus a final fix wave against the whole-branch review.
**No migration, no UI changes.**

- **Item 1 — summary projections + limits.** New `shared/types/summaries.ts`
  (`DocumentSummaryDTO`, `TaskSummaryDTO`, `ProjectSummaryDTO`, `PagedResult<T>`) and
  `server/lib/agent/paging.ts` (`clampPaging`, `buildPage` — default limit 25, max 100). New
  body-free service functions: `listDocsSummary`/`countDocs`/`searchDocsPage`
  (`server/services/documents.ts`), `listTasksSummary`/`countTasks`
  (`server/services/tasks.ts`), `listProjectsPage` (`server/services/projects.ts`). Six agent
  tools rewired in `server/lib/agent/tools.ts`: `list_documents`, `search_docs`,
  `search_tasks`, `search_projects` now take `limit`/`offset` and return
  `{ items, total, hasMore }`; the shared `DocumentDTO`/`TaskDTO`/`ProjectDTO` (which back the
  web UI) are untouched.
- **Item 2 — review-gated recall.** `reviewedCondition()` in `server/services/memory.ts`
  (shared by `searchMemories` and `listMemories`, replacing a duplicated pair of `if` branches
  in the latter). `search_memories`/`get_recent_memories` gained `includeUnreviewed?: boolean`
  (default `false` → `reviewed: true`; `true` → `reviewed: undefined`, no filter). Web
  `/memories` REST/UI untouched. **Final fix wave:** `buildMemoryContext`
  (`server/lib/agent/context.ts`) now also passes `reviewed: true`. It had been missed — an
  `includeUnreviewed` default only covers tools an agent *chooses* to call, and this path
  bypasses them: it fires on **every** voice turn (`server/api/voice/ws.ts:154,162`) and was
  injecting unreviewed enrichment output as "Possibly relevant memories" regardless. It has no
  opt-out by design.
- **Item 3 — corroboration gate on the branch that actually archives.** See "Item 3: the
  spec's premise was wrong" below — read that before touching this code. `chooseResolution`
  (`server/services/memory-resolve.ts`) gained a second argument
  (`{ threshold, scope, challengerSessions, sessionsFor }`, source-breaking from the old
  `(verdicts, threshold)` signature) and a new `review-contradict` action. A shared
  `gatedByCorroboration(existingId)` guards **both** the `refines` and `contradicts`
  branches: when `scope === 'user'`, or when `sessionsFor(existingId) >= 2 &&
  challengerSessions < sessionsFor(existingId)`, the plan routes to `review-supersede` /
  `review-contradict` instead of `supersede` / `contradict`. On the `refines` path the gate is
  evaluated **before** the confidence comparison, so a user-scope or out-corroborated
  refinement routes to review even at confidence 1.0 — that ordering is the load-bearing part
  and is mutation-tested (moving the gate after the comparison kills 7 tests). `supersede` is
  the only action in the whole ladder that archives; `review-supersede`/`contradict`/
  `review-contradict` all insert a relation + a `reviewQueue` row and leave both memories live.
  `sessionsFor` is a lookup by id, not a pre-computed count, because the refines target and
  the top contradiction are routinely different rows — the caller cannot know which one the
  gate will judge, so it hands over a `Map<id, count>` built from the near-neighbour rows it
  already selected (this also deleted a duplicated selection-rule coupling between
  `chooseResolution` and its caller). `countEvidenceSessions()` counts distinct `sessionId`s in
  a memory's `evidence` jsonb array.
- **Item 5 — path collapse + cleanup.** `shouldRecordLocalPath`/`collapseLocalPaths` added to
  `server/lib/projects/path-routing.ts`, built on the existing `normalizePrefix`/
  `isUnderPrefix` (cycle 46). Wired into `findOrCreateProject`'s `touch` closure
  (`server/services/projects.ts`) in place of the old exact-match-only check. One-time,
  idempotent, dry-run-by-default script `scripts/collapse-local-paths.ts` for existing bloat
  (see "Task 10 residual risk" below — **not yet run against prod**).

## Acceptance measurement (Task 6) — same-corpus, with caveat

The spec's acceptance criterion is a before/after payload-size measurement against the **same**
corpus. A first attempt compared dev "after" numbers (2 docs / 8 tasks) against prod "before"
numbers (662,712 / 472,472 / 282,904 chars) — an invalid comparison across different corpora,
caught before it was recorded as evidence. The corrected measurement seeded a realistic 62-document
/ 68-task dev corpus, measured both the old full-DTO code path and the new tool against the
identical rows, then deleted the seed data (dev corpus verified restored to its original 2
docs / 8 tasks afterward):

| Tool | Before (chars, same rows, old full-DTO code) | After (chars, paged + enveloped) | Naive reduction |
|---|---:|---:|---:|
| `list_documents` (no filter, 68 rows) | 394,334 | 5,532 | -98.6% |
| `search_docs` (query "mcp", 50-row trigram lane) | 300,780 | 5,528 | -98.2% |
| `search_tasks` (no filter, 68 rows) | 117,270 | 4,616 | -96.1% |

**Caveat that must not be dropped:** `list_documents`'s "before" (68 rows) includes **6
live `type='skill'` documents** (bodies up to ~20k chars each) that the OLD tool fetched in full
from Postgres and only filtered out **in JavaScript, after fetching** — i.e. those 6 bodies were
never actually part of the old tool's rendered JSON output, so counting their full byte weight in
the "before" total *overstates* the true reduction. The new tool excludes skills in SQL
(`notSkill()`), which is a real, intentional part of the fix, not a measurement artifact — but the
honest headline figure for `list_documents` is **"~97-98%"**, never a flat **98.6%**.

The prod baselines (662,712 / 472,472 / 282,904 chars) are a **different corpus** (a real,
much larger production document/task set) recorded in a live MCP session before this cycle. They
are historical context establishing that the problem was real and severe — they must **never**
be blended into, or compared directly against, the same-corpus percentages above.

Disjoint-pages check (does `offset` actually page, or silently re-serve page 1?) against the real
~62-document corpus: `offset:0,limit:5` and `offset:5,limit:5` returned 5 items each with **zero
overlap** — conclusive evidence `offset` is honoured (a first attempt against the pre-seed
2-document corpus was inconclusive by construction — too few rows to prove anything).

## Item 1 was a payload-shape problem, not an unbounded-rows problem

The feedback doc framed this as "unbounded list endpoints." That framing is only partly right.
Two of the three overflowing tools already had a row cap (or one close enough to be moot):

| Tool | Row cap before this cycle | Real cause of the size |
|---|---|---|
| `list_documents` | `.limit(200)` | `toDTO` includes `content: r.content` — every full document body |
| `search_docs` | ~50 rows per lane (RRF candidate pool) | same full-body DTO |
| `search_tasks` | **none** | unbounded rows *and* every full task description |

Adding a bare `limit` alone would not have fixed this: 25 sufficiently long documents is already
enough to overflow a tool-result budget. The load-bearing fix is the summary DTO shape (no
`content`/`description`/`aliases`/`localPaths`/`pathPrefixes`); the `limit`/`offset` envelope is
the secondary, necessary-but-not-sufficient part.

## Item 3: the spec's premise was wrong, and the first gate shipped inert

**Read this before changing `memory-resolve.ts`.** The spec, the plan, and the first two
commits of this cycle (`716b363`, `e8473db`) all rested on the belief that a `contradicts`
verdict could silently archive a well-corroborated memory. **It could not, and never could.**
Verified directly against the pre-cycle code (`git show
e4f5a9e:server/services/memory-resolve.ts`): the `contradict` branch does a `memoryRelations`
insert, a `reviewQueue` insert, and a `publishChange` — and nothing else. There is no
`archivedAt`/`supersededBy` write anywhere on it.

Consequences, stated plainly because they are easy to misread from the commit log alone:

- **`review-contradict` is byte-identical in effect to the old `contradict`.** Both insert the
  same relation and the same review row and archive nothing. The new action is a *label* that
  distinguishes "auto-resolved" from "human-gated" in the enrichment tally; it changed no
  database write. The comment on that branch about "deliberately NO archivedAt" describes a
  property `contradict` already had, not one this cycle introduced.
- **The gate as first shipped was therefore inert** — it guarded the one branch that had no
  destructive behaviour to guard.
- **The branch that archives is `supersede`**, reached from a `refines` verdict and gated only
  by `refines.confidence >= threshold`. A single exploratory session producing one confident
  refinement could archive a memory corroborated across a dozen sessions. That is the hole the
  spec meant to close and did not.

The final fix wave extends the same gate to `supersede` (see item 3 above): the corroboration
check now runs on the `refines` branch too, **before** the confidence comparison, and
`ChooseResolutionOpts` takes a `sessionsFor(existingId)` lookup instead of one pre-computed
`incumbentSessions` — because the refines target and the top contradiction are frequently
different rows, and a count computed for the contradiction would have mis-gated the refinement.
No new execution branch was needed: `review-supersede` already existed and already did the safe
thing.

## Item 3 needed no migration

`MemoryEvidenceEntry` already carries `sessionId` (`shared/types/memory.ts`), and
`mergeEvidence` already **appends** an entry to the incumbent's `evidence` jsonb array on every
duplicate hit (pre-existing code, unmodified by this cycle). A memory re-derived across many
sessions therefore already carried one evidence entry per derivation before this cycle started —
corroboration was already being recorded, just never consulted at resolution time. This cycle
adds `countEvidenceSessions()` (a `count(distinct sessionId)` over that array) and wires it into
`chooseResolution`; no schema change, no backfill, no new column.

## Item 4 (tiered sensitivity scopes) — REJECTED by Tony, not a gap

The feedback doc recommended per-project or tiered sensitivity scopes on MCP tokens "before the
connector gets broader exposure." **Tony rejected this on 2026-07-29 as an explicit design
decision, not an oversight.** The MCP connector is single-operator — it is only ever connected to
his own Claude sessions — and is intentionally unscoped so every session sees the whole store.
This should **not** be re-filed as a finding or gap in a future cycle. Any future change here
requires a prior change to that operating assumption (sharing the connector with another person,
or with a shared-drive agent), not a security argument on its own.

## Paging divergence from the feedback doc

The feedback doc recommended the `(createdAt, id)` composite cursor proven correct in cycle 50's
session-search/read tools. That cursor is right there because those readers are strictly
chronological. It is wrong here: `search_docs` is **relevance**-ordered (RRF-fused trigram +
vector) — a `createdAt` cursor cannot express a position in a relevance ranking, and forcing one
would mean abandoning relevance ordering, which is the entire value of the tool. `list_documents`
orders by `updatedAt desc`, which also reorders under concurrent edits and isn't a stable cursor
key. `limit`/`offset` + `total`/`hasMore` is honest about what these orderings can actually
guarantee: a row edited mid-page can in principle be seen twice or skipped, which is an accepted
cost for agent recall over a personal store — correctness of the *first* page is what matters.

## The breaking MCP contract change

Before this cycle, `list_documents` and `search_docs` results carried each document's full body
inline (`result[].content`). Any consumer still reading that field off those two tools now gets
`undefined` — this is the intended fix (those were exactly the consumers overflowing their tool-
result budget), and MyMind's own agent is the only consumer, but every affected tool's
`description` string was updated to say explicitly where the body now comes from
(`get_document`, `read_document`, `grep_document`) so a fresh agent doesn't conclude a listed
document is empty.

## `search_projects` is a misnomer

Both the spec and the plan asserted a `searchProjects(q)` function existed and instructed reusing
it for `search_projects`'s query matching. **It never existed anywhere in this repository.** The
`search_projects` MCP tool has only ever been `listProjects({ activeOnly })` with no query
parameter at all — confirmed by grep (zero hits for `searchProjects` before this cycle) and by
the wiki's own pre-cycle-51 tool-table entry.

Task 3's implementer caught this, flagged it loudly (not silently), and — because dropping the
function outright would have blocked Task 5 from having anything to wire — built a stopgap
`searchProjectsPage(q, opts)` doing in-memory substring matching on `name`/`slug`/`alias` over the
existing unmodified `listProjects()`. Tony's ruling on review: **drop the invented search
entirely.** The empty-query guard in that stopgap (`if (!q.trim()) return { items: [], total: 0
}`) was a latent breaking change waiting to happen — Task 5's `search_projects` tool is called
with **no arguments** to list all projects, mirroring today's `listProjects({ activeOnly })`
usage; a query-required implementation would have silently returned **zero rows** the moment it
was wired up. The stopgap was replaced with `listProjectsPage(opts: { activeOnly?, limit,
offset })` — a straight paging/summary wrapper around the existing, unmodified `listProjects()`,
no query matching, no new SQL. `search_projects` ships this cycle as exactly what its
implementation has always been: a lister with an `activeOnly` filter, now paged and body-free. It
does **not** do text matching, and should not gain a `query` parameter in a future cycle without a
deliberate product decision to add that capability — that would be new user-facing scope, not a
bug fix.

## Planning defects found during execution (candid)

Five defects were found while building and reviewing this cycle. **All five were in the
spec/plan, none in the implementations that followed them** — a future session reading only the
commit log would see clean fix rounds and miss why they happened, so recording this plainly.
Defect 5 is the most consequential and was only caught by the whole-branch review, after the
"fix" had already shipped:

1. **The nonexistent `searchProjects(q)`.** The spec's design section and the plan's Task 3 both
   instructed reusing an existing project search function that was never built (see above).
2. **An acceptance criterion written without checking the dev corpus.** The spec/plan's Task 6
   instructed "measure against the dev corpus" without verifying the dev corpus had only **2**
   documents — far too small to produce a meaningful before/after, and initially producing an
   invalid cross-corpus comparison (see "Acceptance measurement" above) before the fix round
   caught it.
3. **A false claim that `chooseResolution` had no test file and exactly one caller.** Task 7's
   brief asserted both; `test/memory-resolve.test.ts` had 6 pre-existing tests on the old
   `(verdicts, threshold)` signature since 2026-06-16. The implementer correctly refused to edit
   outside its allow-listed files and stopped with `NEEDS_CONTEXT` rather than silently expanding
   scope; the coordinator confirmed the gap and extended scope by exactly the one file needed.
4. **A test file named at a path that doesn't exist.** Task 8's brief named
   `server/lib/projects/path-routing.test.ts`; the real (only) test file for that module is the
   root-level `test/path-routing.test.ts`.
5. **The false premise that `contradict` archived a memory — the most consequential of the
   five.** The spec's entire item-3 rationale ("a single-session memory silently archives a
   corroborated incumbent via a `contradicts` resolution") described behaviour that did not
   exist in the code. Nobody checked the `contradict` branch's actual writes before writing the
   spec. Item 3 as originally shipped was therefore a correct implementation of a gate on the
   wrong branch: **inert**, while the real archiving branch (`refines`→`supersede`) stayed
   ungated. Caught by the whole-branch review, fixed in the final fix wave; see "Item 3: the
   spec's premise was wrong" above. **Lesson:** when a spec asserts that some code path is
   destructive, open that path and read its writes before designing a guard for it — the guard
   is worthless if it is on the wrong branch, and it *looks* shipped in every gate and review.

**Root cause for #3 and #4, and it's the same one both times:** the pre-flight brief-writing scan
grepped only `server/` for existing tests/callers. This repo also has a root-level `test/`
directory (mirroring `server/`) that holds tests for exactly the modules affected here
(`memory-resolve.ts`, `path-routing.ts`). Any future brief-writing pass over this repo should grep
both `server/**` and `test/**` before asserting "no existing test" or "exactly N callers."

## Verification

- **Gates (as of the final fix wave):** `pnpm typecheck` (clean — the only output is the two
  expected "Nuxt Icon" info lines) · `pnpm test` (**934 passed, 133 files, 0 failed**, up from
  the 873-test baseline at `e4f5a9e`; 924 before the final fix wave added 10) · `pnpm build`
  (clean).
- **Mutation check on the new supersede gate:** moving `gatedByCorroboration` to *after* the
  `refines.confidence >= threshold` comparison makes **7 tests fail** across both
  `memory-resolve` test files (including "user-scope refines at 0.95 → review-supersede"), then
  all pass again on revert. The gate's *ordering*, not just its presence, is pinned.
- **Per-task:** 8 plan tasks, most independently spec+quality reviewed (sonnet), with fix rounds
  where the reviewer found Important issues (Task 3's invented search dropped; Task 7's 4
  findings — non-array-jsonb guard, deduplicated `topContradiction`, 3 mutation-killing tests,
  `memory-enrich.ts` tally fix; Task 8's 2 findings + 1 improvement — value-not-length skip
  check, a parent-of-registered-prefix test, dry-run now lists dropped paths). Per-task
  briefs/reports and the ledger live in `.superpowers/sdd/2026-07-29-mcp-recall-hygiene/`.
## Prod acceptance (post-deploy, 2026-07-30)

The Task 6 measurement above is same-corpus but dev-scale. After deploy, the same two tools were
called through the **live prod MCP endpoint** (`POST /api/mcp`, `mm_` bearer) against the real
production corpus — the one that actually overflowed and produced the original baselines. This is
the apples-to-apples comparison the dev measurement could not be:

| Tool | Before (prod, pre-cycle) | After (prod, live) | Reduction |
|---|---:|---:|---:|
| `list_documents` (no filter) | 662,712 | **6,187** | **-99.1%** |
| `search_tasks` (no filter) | 282,904 | **5,935** | **-97.9%** |

Both returned `items: 25` with `hasMore: true` (`total` 85 documents / 157 tasks), and a
programmatic check confirmed **no `content` or `description` key on any item**. The envelope, the
default page size, the body-free shape, and the reviewed-only defaults are all live in production.

Note this supersedes the earlier caveat's concern in one direction: the prod "before" figure is a
genuine pre-cycle measurement of the same store, so the -99.1% here does not carry the
skill-document overstatement that applies to the dev same-corpus table (which compared 68 rows
including 6 skill bodies). The dev table's "~97-98%" caveat still stands for *that* table.

## Deferred minors and residuals (from the ledger — none block this cycle)

- `searchDocsPage`'s hydration step (`server/services/documents.ts`) omits the `live()`/
  `notSkill()` filters its sibling `searchDocs` applies at hydration time — a narrow race where a
  document soft-deleted between the id-fetch and the hydrate step could leak into `items`. This
  was plan-mandated (the brief's own sample code) and is a 1-line fix if picked up later.
- Repeated verdicts against a still-live incumbent have their `reviewQueue` insert silently
  dropped by `onConflictDoNothing()` — a pre-existing pattern (predates this cycle) that the new
  `review-contradict`/gated-`review-supersede` routes newly exercise more often. Deliberately
  left untouched per the coordinator's review-round triage.
- No live-DB integration test proves the "incumbent stays live" guarantee for
  `review-supersede`/`review-contradict` at the database layer; it is confirmed by code
  inspection only (no `archivedAt`/`supersededBy` write exists on either branch — `supersede` is
  the sole writer of those columns) — a live DB test harness for `resolveEnrichedMemory` doesn't
  exist in this repo and was out of scope to add.
- Corroboration is now resolved lazily inside `chooseResolution` via `sessionsFor`, so the
  earlier "`incumbentSessions` computed on paths that never use it" dead work is gone; the caller
  instead builds a small `Map` over the (max 8) near-neighbour rows it already fetched.
- Smaller/cosmetic, all explicitly deferred during the ledger review and not expected to matter:
  Task 1's report has line counts off by 1-2 vs. actual file contents (cosmetic only); a stale
  JSDoc line reference in `documents.ts` (`embedOne` moved after an extraction); `searchDocIds`'s
  `opts = {}` default is never exercised by either caller; the `tasks.test.ts` fixture's
  `dueDate: null` never exercises the `.toISOString()` branch (inherited from the brief, coverage
  gap only); no DB-backed test exists for `listTasksSummary`/`countTasks` (only the pure mapper is
  tested, matching this task's declared scope); one redundant assertion in `memory.test.ts`; and
  pre-existing `a.scope as undefined` casts in `tools.ts` retained per file convention.

## Task 10 residual risk — read before running `--apply` on prod

**Dev has no project with any registered `path_prefixes`.** The one dev row that changed under
`scripts/collapse-local-paths.ts` (`bridget-services`, 3→1 `localPaths` entries) exercised only
the sibling-collapse branch of `collapseLocalPaths`; the prefix-collapse branch (dropping a
`localPaths` entry already covered by a `pathPrefixes` entry) has been exercised **only by unit
tests**, never against a real row. Terawulf — the project this cycle was written to clean up — is
the only project with real `pathPrefixes` registered, and it lives only on prod.

**Before running `--apply` on prod:** there is **no undo** — snapshot first:

```
\copy (select id, slug, local_paths from projects) to '/tmp/local_paths.bak.csv' csv
```

Then run the script in its default dry-run mode, read the per-project dropped-path list it
prints (each pruned entry, indented, cap **200** — raised from 10 in the final fix wave so a
~50-entry project like Terawulf prints in full rather than "…and 40 more", which made the review
this section asks for impossible), and confirm the drops look right for Terawulf specifically —
that will be this branch's first live exercise of the prefix-collapse path. `--project <slug>`
restricts both the dry run and `--apply` to a single project, so Terawulf can be inspected and
applied on its own before anything else is touched.

## Next steps

**Done (2026-07-30):**

1. ~~Go-ahead~~ — approved by Tony.
2. ~~Merge + push~~ — fast-forward `e4f5a9e..dc06f1e`; local `master` synced afterwards.
3. ~~Deploy~~ — CD run 30573162535 green; prod health 200, verified in-container.
4. ~~Prod acceptance~~ — live MCP round-trip recorded above.
5. **Cleanup script dry-run on prod — done and reviewed.** `18/34` projects would change.
   Snapshot saved at **`/root/local_paths.bak.csv` on LXC 114** (34 rows, taken before any
   write). Notable drops: `terawulf 62 → 0` (larger than the ~50 the feedback doc reported),
   `2d-rpg 26 → 1`, `3d-rpg 21 → 0`, `mymind 17 → 2`; seven projects collapse to zero.
   Verified before approving: `local_paths` is **written-only** apart from a single read in
   `shouldRecordLocalPath` (append-or-skip). Routing uses `pathPrefixes`/`gitRemoteKey`/aliases
   and never `local_paths`, and no UI renders it — so a project reaching zero loses no function,
   and the entries cannot re-accumulate because the same prefix check now blocks the append.

**Outstanding:**

6. **`scripts/collapse-local-paths.ts --apply` on prod** — the only unfinished step of this
   cycle. Dry run reviewed, snapshot in place, blast radius understood. `--project terawulf`
   applies to that project alone if a smoke test is wanted first. Invocation on prod (tsx is not
   in `node_modules/.bin` there — see the follow-up below):
   `cd /opt/mymind && set -a && . ./.env && . ./.env.native; set +a; node node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs scripts/collapse-local-paths.ts`

## Follow-up filed

**`tsx` is not a declared dependency.** `scripts/collapse-local-paths.ts` is TypeScript and its
header documents `node_modules/.bin/tsx`, but `tsx` appears in neither `dependencies` nor
`devDependencies` — it resolves today only as a transitive package (prod has `tsx@4.22.4` in the
pnpm store; a dev machine may have a stale shim). A clean `pnpm install` could therefore break the
documented invocation. A Task 8 subagent had installed `tsx` as a devDependency locally to run the
script, but that change (plus a 172-line lockfile churn) was never committed, never reviewed, and
was **discarded** rather than slipped in unreviewed after the deploy. Tracked as its own task so it
can be added deliberately with a real CI run.
