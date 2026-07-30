---
title: MCP recall hygiene — payload caps, review-gated recall, corroborated contradictions, path collapse
date: 2026-07-29
status: draft
supersedes: []
related:
  - server/lib/agent/tools.ts
  - server/services/documents.ts
  - server/services/tasks.ts
  - server/services/projects.ts
  - server/services/memory.ts
  - server/services/memory-resolve.ts
  - shared/types/memory.ts
  - docs/handovers/2026-07-28-session-search-mcp.md
  - docs/handovers/2026-07-17-mcp-oauth-connector.md
---

# MCP recall hygiene (cycle 51)

## Problem

An external Claude Code session used the MyMind MCP tools open-ended on 2026-07-29 and filed five
findings (MyMind doc `/input/mymind-mcp-feedback-external-agent-session-2026-07-29.md`). Four are
accepted here; one is rejected as a non-goal (see below).

The findings are independent, small, and all touch the recall path — so they ship as one cycle and
one deployment rather than four.

### 1. List/search tools return payloads that exceed an agent's tool-result budget

`list_documents` (no filter) returned **662,712 chars** and `search_tasks` (no filter) **282,904
chars**, each as a single JSON line. Both blew the consuming agent's tool-result limit and had to be
rescued via saved files. This reproduced independently in a MyMind session the same day:
`search_docs` returned **472,472 chars** and had to be spilled to a scratch file and parsed with a
script.

**The feedback doc frames this as "unbounded list endpoints." That framing is only one-third
right, and acting on it alone would not fix the problem.** Two of the three row counts are already
capped:

| Tool | Row cap today | Real cause of the size |
|---|---|---|
| `list_documents` | `.limit(200)` — `documents.ts:79` | `toDTO` includes `content: r.content` — every full document body |
| `search_docs` | ~50 per lane — `documents.ts:173` | same full-body DTO |
| `search_tasks` | **none** — `tasks.ts:47-51` | unbounded rows *and* every full task description |

Adding a `limit` alone would still overflow: 25 long documents is enough. The load-bearing fix is
the **payload shape** — a summary projection that omits bodies. The limit is secondary.

An audit of the whole `kind:'read'` registry found a fourth tool of the same class not mentioned in
the feedback doc: **`search_projects`** (no limit). By-id readers (`get_document`, `get_project`,
`grep_document`, `read_document`, `read_around_message`, `read_session`) are correctly exempt —
fetching one named thing in full is their purpose, and the cycle-50 readers already page.

### 2. Enrichment admission filter is too loose on the read path

Session-specific trivia is stored as durable memory and recalled as fact — e.g. *"Social slice 1
shipped 16 commits across 11 subagent tasks"* (confidence 0.7, unreviewed). The write-path filter is
a separate open problem; this cycle fixes only **recall**, so low-signal rows stop surfacing as
established fact.

### 3. Contradiction resolution favours recency over corroboration

Memory `5be27cb2` (*"heavily experienced AI developer… e-commerce product research"*, confidence
0.95, from a **single exploratory session**) won a `contradicts` resolution against `c793faae`
(*"Director of IT & Estimating, 15 yrs construction"*) — despite the store overwhelmingly
corroborating the construction identity.

`chooseResolution` (`memory-resolve.ts:29-37`) simply takes the highest-confidence `contradicts`
verdict and archives the incumbent. It has no notion of corroboration, and nothing about an
identity-level claim makes it pause.

This failure mode is self-reinforcing: a wrong identity memory shapes later sessions, which then
corroborate the error.

### 4. Flat sensitivity model — REJECTED, NOT A GAP

The feedback doc recommends per-project or tiered sensitivity scopes on tokens, designed in "before
the connector gets broader exposure."

**Rejected by Tony on 2026-07-29 as an explicit design decision, not an oversight.** The MCP
connector is single-operator: it is only ever connected to his own Claude sessions, and it is
intentionally unscoped so every session sees the whole store. Do not re-file this as a finding.
Any future change here needs a change in that operating assumption first (e.g. sharing the
connector with another person or a shared-drive agent), not a security argument.

### 5. Project `localPaths` bloat

Terawulf carries ~50 `localPaths` including deep subfolders even though `pathPrefixes` already
covers them. `projects.ts:200-201` appends `cwd` unless there is an **exact** string match and never
consults `pathPrefixes`.

## Non-goals

- Tiered/per-project sensitivity scopes (finding 4 above) — rejected, see rationale.
- The enrichment **write**-path admission filter (what gets stored). This cycle changes only what is
  recalled by default. Tightening the writer is a separate concern with its own failure modes.
- Any change to the web UI's view of memories. `/memories` is the review surface and must keep
  showing unreviewed rows — that is its job.
- Re-ranking or changing search *relevance*. Only result shape and volume change.

## Design

### Item 1 — summary projections + limits

Shared DTOs stay as they are: `listDocs` and `listTasks` also back the web UI (`/documents`, the
tasks kanban), so changing `DocumentDTO`/`TaskDTO` would break it. Instead, add **summary-select
service functions** alongside the existing ones:

```
listDocsSummary(opts)    -> DocumentSummaryDTO[]
searchDocsSummary(q, opts) -> DocumentSummaryDTO[]
listTasksSummary(opts)   -> TaskSummaryDTO[]
searchProjectsSummary(q) -> ProjectSummaryDTO[]
```

`DocumentSummaryDTO` = `{ id, path, title, project, type, tags, updatedAt }` — **no `content`**.
`TaskSummaryDTO` = `{ id, title, status, priority, project, dueDate, updatedAt }` — no
`description`.
`ProjectSummaryDTO` = `{ slug, name, status, lastActivityAt, documentCount? }` — no `localPaths` /
`pathPrefixes` / `aliases` arrays.

Honest scoping note on `search_projects`: its payload is not currently a problem (projects number
in the dozens, not hundreds). It is included because it is the same defect class found during the
registry audit and costs almost nothing to fix alongside the others — not because it is causing
overflow today. If it adds friction during implementation, drop it and keep items 1's other three.

These `SELECT` only the needed columns, so Postgres never ships 662KB either — this is a
DB-load fix as much as a context fix.

Agent tools gain `limit` (default **25**, max 100) and `offset` (default 0), and return an
envelope:

```
{ items: [...], total: <int>, hasMore: <bool> }
```

`total` comes from a `count(*)` over the same filter, so an agent can tell "25 of 412" from
"25 of 25" — without which it cannot know whether to page.

**Paging style — a deliberate divergence from the feedback doc.** The doc recommends the
`(createdAt, id)` composite cursor proven in the cycle-50 message tools. That cursor is correct
there because those readers are chronological. It is wrong here:

- `search_docs` is **relevance**-ordered (RRF-fused trigram + vector). A `createdAt` cursor cannot
  express a position in a relevance ranking; adopting it would force these tools to abandon
  relevance ordering, which is the entire value of the tool.
- `list_documents` is `updatedAt desc`, which reorders under concurrent edits.

`limit`/`offset` + `total`/`hasMore` is honest about what these orderings can actually guarantee.
Accepted cost: a row edited mid-page can be seen twice or skipped. For agent recall over a
personal store this is immaterial; correctness of the *first* page is what matters.

Full bodies remain available through the existing by-id readers — `get_document`,
`read_document` (outline/section/window), `grep_document`. The tool descriptions must point at
them explicitly, because the summary shape changes what an agent gets from a bare
`list_documents` and it needs to know where the body went.

**This is a breaking change to the MCP tool contract.** Any consumer reading
`result[].content` from `list_documents`/`search_docs` gets `undefined` after this. That is the
intended fix (those consumers were the ones overflowing), and MyMind is the only consumer, but the
tool `description` strings must state that bodies come from the by-id readers so a fresh agent
does not conclude the documents are empty.

### Item 2 — review-gated recall

`searchMemories` gains a `reviewed?: boolean` option applied in `baseConditions`, mirroring the
filter `listMemories` already has (`memory.ts:492-493`, on `reviewedAt`).

Both agent tools default to reviewed-only and take an explicit opt-out:

- `search_memories({ ..., includeUnreviewed?: boolean })` — default `false`
- `get_recent_memories({ ..., includeUnreviewed?: boolean })` — default `false`

No separate `minConfidence` parameter. `save_memory` already auto-reviews at `confidence >= 0.75`
(`shouldAutoReview`), so `reviewedAt IS NOT NULL` already subsumes the high-confidence case. One
filter, not two overlapping ones.

Web UI and REST endpoints are untouched.

### Item 3 — corroboration-aware contradiction gate

**The corroboration signal already exists and needs no migration.** `MemoryEvidenceEntry` carries
`sessionId` (`shared/types/memory.ts:13-19`), and `mergeEvidence` (`memory-resolve.ts:57-60`)
**appends** an entry to the incumbent's `evidence` jsonb array on every duplicate hit. A memory
re-derived across many sessions therefore already carries one evidence entry per derivation.

Corroboration = **count of distinct `sessionId`s** in a memory's `evidence` array:

```sql
select count(distinct e->>'sessionId')
from jsonb_array_elements(memories.evidence) e
```

`chooseResolution` stays a pure function and gains a second argument:

```
chooseResolution(verdicts, { threshold, scope, incumbentSessions, challengerSessions })

  duplicate / refines branches            -> unchanged
  contradicts:
    scope === 'user'                      -> 'review-contradict'
    incumbentSessions >= 2
      && challengerSessions <= 1          -> 'review-contradict'
    otherwise                             -> 'contradict'   (unchanged)
```

Rationale for the `scope === 'user'` gate: `user`-scope memories are identity and preference
claims — exactly the class that went wrong, and the class where a wrong auto-resolution is most
self-reinforcing. `agent`/`world` contradictions (tooling facts, world facts) keep today's
behaviour unless the incumbent is better corroborated than the challenger.

**`challengerSessions` is normally 1, and that is expected.** On the enrichment path the challenger
is a brand-new memory carrying evidence from exactly one session (`memory-enrich.ts:188-195` builds
a single-entry array). So in practice the second rule reduces to *"the incumbent is corroborated by
2+ sessions and the challenger is new."* It is still expressed as a comparison rather than
hard-coded to 1, because `resolveMemory` is also reachable from `save_memory` and from
re-enrichment, where a challenger can arrive with merged evidence. Do not "simplify" it to
`incumbentSessions >= 2` — that would silently change behaviour on those paths.

Note this signature change is source-breaking: `chooseResolution(verdicts, threshold)` becomes
`chooseResolution(verdicts, opts)`. There is exactly **one** caller (`memory-resolve.ts:93`) and
**no existing test file** for it — this cycle adds the first, so the pure-function tests below are
net-new coverage on previously untested resolution logic, not a rewrite of existing tests.

New `review-contradict` action mirrors the existing `review-supersede` precedent:

- insert the `contradicts` relation into `memoryRelations` (as today), **and**
- insert a `reviewQueue` row (`kind: 'memory-contradict'`), **and**
- **do not** archive the incumbent — both memories stay live until a human decides.

The incumbent staying live is the whole point: an unresolved contradiction is preferable to a
silently wrong resolution. Both rows surfacing in recall is acceptable and self-announcing.

### Item 5 — path collapse + one-time cleanup

Pure helper beside the existing path-routing helpers:

```
shouldRecordLocalPath(cwd, localPaths, pathPrefixes): boolean
  false if cwd exactly matches an existing localPath   (today's only check)
  false if cwd is under any existing pathPrefixes entry
  false if cwd is under any existing localPaths entry
  true otherwise
```

Reuses `isUnderPrefix` / `normalizePrefix` from `server/lib/projects/path-routing.ts` (cycle 46)
rather than reimplementing prefix logic. Called at `projects.ts:200-201` in place of the current
`!localPaths.includes(cwd)` test.

Write-path only would leave existing bloat forever, so this also ships a **one-time idempotent
cleanup** (`scripts/collapse-local-paths.ts`): for each project, drop any `localPaths` entry
already covered by a `pathPrefixes` entry or by a shorter `localPaths` entry. Idempotent and
re-runnable; dry-run first, and report per-project before/after counts.

## Testing

Every item's decision logic is extracted as a pure function and unit-tested, following the
precedent set by `decideConsentRedirect` (cycle 48) and the cycle-50 `session-read` pure core.
This repo does not test h3 handlers; it tests the logic they call.

| Unit | Cases |
|---|---|
| `chooseResolution` | user-scope always reviews; corroborated incumbent (2+ vs 1) reviews; equal corroboration auto-resolves; agent/world uncorroborated auto-resolves; duplicate/refines branches unchanged (regression) |
| corroboration counter | 0/1/N distinct sessions; repeated sessionId counts once; null/absent `sessionId`; empty evidence array |
| `shouldRecordLocalPath` | exact match; under a prefix; under a longer localPath; sibling dir not collapsed; trailing-slash normalisation; empty arrays |
| summary DTO mappers | no `content`/`description` key present on the output object |
| envelope | `hasMore` true/false boundary at exactly `limit`; `total` independent of `limit` |

Integration proof (not unit): drive the **local dev** `/api/mcp` with a minted `mm_` token and the
real MCP client SDK (per the `browser-testing` skill's MCP section) and assert the tool-result
payload size drops — the actual acceptance criterion. Measure `list_documents` and `search_docs`
before/after against the dev corpus and record both numbers in the handover.

No UI changes, so no `playwright-cli` run is required for items 1/2/3/5 — with one exception: if
the review queue surfaces `memory-contradict` rows in an existing UI, that rendering must be
browser-verified.

## Migration

**None.** All four items are code-only:

- Item 1 — new service functions, no schema change.
- Item 2 — `reviewedAt` already exists and is already indexed for the web filter.
- Item 3 — `evidence` jsonb and `reviewQueue` already exist; `review-contradict` is a new value in
  an existing action union, not a new column.
- Item 5 — a data cleanup script, not a schema migration.

## Rollout

One branch, one deployment. Items are independent, so they land as separate commits and can be
reviewed and reverted individually.

1. Item 1 (largest, highest value — actively breaking agent sessions today)
2. Item 2 (smallest, mostly wiring an existing filter)
3. Item 3 (pure-function change + new review action)
4. Item 5 (helper + cleanup script)
5. Gates: `pnpm typecheck` / `pnpm test` / `pnpm build`
6. Local MCP payload-size measurement, before/after
7. Wiki (`docs/wiki/mcp.md` tool table + a recall-defaults note) + handover
8. Deploy per the `prod-deploy` skill; run the cleanup script against prod with a dry-run first

## Open questions

None. Both forks raised during design were decided:

- paging style → `limit`/`offset` with `total`/`hasMore` (diverging from the doc's cursor
  recommendation, for the relevance-ordering reason above)
- item 5 scope → fix the write path **and** clean up existing rows
