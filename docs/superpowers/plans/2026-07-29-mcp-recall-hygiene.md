# MCP Recall Hygiene (cycle 51) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the MCP list/search tools from overflowing an agent's tool-result budget, stop unreviewed memories surfacing as established fact, stop single-session contradictions silently overwriting well-corroborated identity memories, and stop `localPaths` accumulating paths a `pathPrefix` already covers.

**Architecture:** Four independent changes on the recall path, all code-only (no migration). Item 1 adds *new* summary-select service functions beside the existing ones — shared DTOs are untouched because they back the web UI — and wraps agent-tool results in a `{ items, total, hasMore }` envelope. Items 2/3/5 each extract their decision logic into a pure, unit-tested function, following this repo's established pattern (`decideConsentRedirect`, the cycle-50 `session-read` core). Items land as separate commits and can be reverted individually.

**Tech Stack:** Nuxt 4 / Nitro, drizzle-orm (Postgres + pgvector), zod v4 tool schemas, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-mcp-recall-hygiene-design.md`

## Global Constraints

- Package manager is **`pnpm`**, never npm/yarn. Run from repo root.
- Real gates are **`pnpm typecheck`**, **`pnpm test`**, **`pnpm build`**. Lint is red repo-wide and is NOT a gate.
- **Never change `DocumentDTO`, `TaskDTO`, or `ProjectDTO`** (`shared/types/documents.ts`, `shared/types/tasks.ts`). They back the web UI. Add new summary types alongside.
- **Never change the web UI or REST endpoints' view of memories.** `/memories` is the review surface and must keep showing unreviewed rows.
- **No database migration in this cycle.** If a task seems to need one, stop and flag it — the spec asserts all four items are code-only.
- Zod v4 is in use; tool schemas are plain objects of zod validators (see existing entries in `server/lib/agent/tools.ts`), not `z.object({...})`.
- Tests live beside their subject as `<name>.test.ts`. This repo tests **pure functions and services**, not h3 handlers — do not add h3 handler tests.
- `docs/wiki/mcp.md` must be updated in the same cycle as the code (project rule). The wiki describes current behaviour, not intent.
- Tool `description` strings are the agent's only documentation. When a tool's result shape changes, its description MUST say where the omitted data now comes from.

---

## File Structure

**Item 1 — payload shape + limits**
- Create `shared/types/summaries.ts` — `DocumentSummaryDTO`, `TaskSummaryDTO`, `ProjectSummaryDTO`, and the generic `PagedResult<T>` envelope. One place for all four, because they are consumed together by the tool layer.
- Modify `server/services/documents.ts` — add `listDocsSummary`, `countDocs`, `searchDocsPage`.
- Modify `server/services/tasks.ts` — add `listTasksSummary`, `countTasks`.
- Modify `server/services/projects.ts` — add `listProjectsPage`.
- Create `server/lib/agent/paging.ts` — pure `buildPage(items, total, limit, offset)` + `clampPaging(limit, offset)`. Shared by four tools; extracted so the envelope logic is tested once.
- Create `server/lib/agent/paging.test.ts`.
- Modify `server/lib/agent/tools.ts` — the four tool definitions.

**Item 2 — review-gated recall**
- Modify `server/services/memory.ts` — `SearchMemoriesOptions.reviewed` + the `baseConditions` clause.
- Modify `server/lib/agent/tools.ts` — `search_memories`, `get_recent_memories`.

**Item 3 — contradiction gate**
- Modify `server/services/memory-resolve.ts` — `chooseResolution` signature, `review-contradict` action, corroboration query.
- Create `server/services/memory-resolve.test.ts` — first tests for this file.

**Item 5 — path collapse**
- Modify `server/lib/projects/path-routing.ts` — add `shouldRecordLocalPath`, `collapseLocalPaths`.
- Modify `server/lib/projects/path-routing.test.ts` — add cases.
- Modify `server/services/projects.ts` — call the helper at the append site.
- Create `scripts/collapse-local-paths.ts` — one-time idempotent cleanup with `--dry-run`.

**Docs**
- Modify `docs/wiki/mcp.md`, create `docs/handovers/2026-07-29-mcp-recall-hygiene.md`, modify `docs/superpowers/plans/00-roadmap.md`.

---

## Task 1: Summary types and the paging envelope

**Files:**
- Create: `shared/types/summaries.ts`
- Create: `server/lib/agent/paging.ts`
- Test: `server/lib/agent/paging.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `DocumentSummaryDTO`, `TaskSummaryDTO`, `ProjectSummaryDTO`, `PagedResult<T>` from `shared/types/summaries.ts`; `clampPaging(limit?: number, offset?: number): { limit: number, offset: number }` and `buildPage<T>(items: T[], total: number, limit: number, offset: number): PagedResult<T>` from `server/lib/agent/paging.ts`. Tasks 2–5 all import these exact names.

- [ ] **Step 1: Write the summary types**

Create `shared/types/summaries.ts`:

```ts
/**
 * Summary shapes for the MCP/agent read tools.
 *
 * These deliberately OMIT large text fields (`content`, `description`) — a bare
 * `list_documents` over 200 full documents produced 662KB of tool result and blew the
 * consuming agent's budget. Full bodies come from the by-id readers (`get_document`,
 * `read_document`, `grep_document`).
 *
 * Separate from DocumentDTO/TaskDTO/ProjectDTO on purpose: those back the web UI and
 * must keep their full shape.
 */

export interface DocumentSummaryDTO {
  id: string
  path: string
  title: string | null
  project: string | null
  type: string | null
  tags: string[]
  updatedAt: string
}

export interface TaskSummaryDTO {
  id: string
  title: string
  status: string
  priority: string
  project: string | null
  dueDate: string | null
  updatedAt: string
}

export interface ProjectSummaryDTO {
  slug: string
  name: string
  active: boolean
  lastActivityAt: string | null
  documentCount: number
}

/** Envelope for every paged agent tool result. `total` is the count BEFORE limit/offset. */
export interface PagedResult<T> {
  items: T[]
  total: number
  hasMore: boolean
}
```

- [ ] **Step 2: Write the failing test for the paging helpers**

Create `server/lib/agent/paging.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clampPaging, buildPage, DEFAULT_LIMIT, MAX_LIMIT } from './paging'

describe('clampPaging', () => {
  it('defaults limit and offset when both are absent', () => {
    expect(clampPaging()).toEqual({ limit: DEFAULT_LIMIT, offset: 0 })
  })

  it('caps limit at MAX_LIMIT', () => {
    expect(clampPaging(5000).limit).toBe(MAX_LIMIT)
  })

  it('floors limit at 1', () => {
    expect(clampPaging(0).limit).toBe(1)
    expect(clampPaging(-10).limit).toBe(1)
  })

  it('floors offset at 0', () => {
    expect(clampPaging(25, -5).offset).toBe(0)
  })

  it('truncates fractional input', () => {
    expect(clampPaging(10.7, 3.9)).toEqual({ limit: 10, offset: 3 })
  })
})

describe('buildPage', () => {
  it('reports hasMore when more rows remain past this window', () => {
    expect(buildPage(['a', 'b'], 10, 2, 0)).toEqual({ items: ['a', 'b'], total: 10, hasMore: true })
  })

  it('reports hasMore false on the exact boundary', () => {
    expect(buildPage(['a', 'b'], 2, 2, 0).hasMore).toBe(false)
  })

  it('reports hasMore false on the final partial page', () => {
    expect(buildPage(['c'], 3, 2, 2).hasMore).toBe(false)
  })

  it('reports hasMore true mid-way through a large set', () => {
    expect(buildPage(['c', 'd'], 100, 2, 2).hasMore).toBe(true)
  })

  it('handles an empty result set', () => {
    expect(buildPage([], 0, 25, 0)).toEqual({ items: [], total: 0, hasMore: false })
  })

  it('handles an offset past the end', () => {
    expect(buildPage([], 10, 25, 999)).toEqual({ items: [], total: 10, hasMore: false })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run server/lib/agent/paging.test.ts`
Expected: FAIL — `Failed to resolve import "./paging"`.

- [ ] **Step 4: Implement the paging helpers**

Create `server/lib/agent/paging.ts`:

```ts
import type { PagedResult } from '../../../shared/types/summaries'

/** Default page size for agent read tools — small enough that 25 rows never overflow a tool result. */
export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100

/** Normalise caller-supplied paging into safe integers. */
export function clampPaging(limit?: number, offset?: number): { limit: number, offset: number } {
  const l = Math.trunc(limit ?? DEFAULT_LIMIT)
  const o = Math.trunc(offset ?? 0)
  return {
    limit: Math.min(MAX_LIMIT, Math.max(1, l)),
    offset: Math.max(0, o)
  }
}

/**
 * Wrap a window of rows in the standard envelope.
 *
 * `hasMore` is computed from `total` rather than from `items.length === limit`, so a full
 * final page correctly reports `hasMore: false` instead of luring the agent into fetching
 * an empty page.
 */
export function buildPage<T>(items: T[], total: number, limit: number, offset: number): PagedResult<T> {
  return { items, total, hasMore: offset + items.length < total }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run server/lib/agent/paging.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add shared/types/summaries.ts server/lib/agent/paging.ts server/lib/agent/paging.test.ts
git commit -m "feat(agent): summary DTOs + paging envelope for read tools"
```

---

## Task 2: Document summary service functions

**Files:**
- Modify: `server/services/documents.ts` (add beside `listDocs` at :73 and `searchDocs` at :162)
- Test: `server/services/documents.test.ts` (create if absent)

**Interfaces:**
- Consumes: `DocumentSummaryDTO` from `shared/types/summaries.ts` (Task 1).
- Produces:
  - `listDocsSummary(opts: { project?: string, limit: number, offset: number }): Promise<DocumentSummaryDTO[]>`
  - `countDocs(opts: { project?: string }): Promise<number>`
  - `searchDocsPage(q: string, opts: { project?: string, limit: number, offset: number }): Promise<{ items: DocumentSummaryDTO[], total: number }>`
  - `toSummaryDTO(row): DocumentSummaryDTO` (exported for its unit test)

  Task 5 calls all of these. Note the asymmetry and keep it: the *list* path is a cheap
  `count(*)` so it gets a separate `countDocs`; the *search* path embeds the query, so it
  returns items and total together from one call. There is no `countSearchDocs`.

- [ ] **Step 1: Read the existing implementations you are mirroring**

Read `server/services/documents.ts:60-81` (`toDTO`, `listDocs`) and `:162-200` (`searchDocs`). Note three things:
- `toDTO` includes `content: r.content` — the field this task exists to omit.
- `listDocs` has a hardcoded `.limit(200)`; the new function takes limit/offset instead.
- `searchDocs` fuses two lanes (trigram + vector) and applies `notSkill()`. You must reuse its existing id-resolution logic and only change the final hydration + windowing — do NOT reimplement the search.

- [ ] **Step 2: Write the failing test for the summary mapper**

Create `server/services/documents.test.ts` (or append if it exists):

```ts
import { describe, it, expect } from 'vitest'
import { toSummaryDTO } from './documents'

const row = {
  id: 'd1',
  path: '/projects/mymind/x.md',
  title: 'X',
  content: 'a'.repeat(50_000),
  language: 'markdown',
  frontmatter: {},
  project: 'mymind',
  domain: null,
  type: null,
  tags: ['a'],
  topic: null,
  isPublic: false,
  publicSlug: null,
  ocrId: null,
  updatedAt: new Date('2026-07-29T00:00:00Z')
}

describe('toSummaryDTO', () => {
  it('omits the document body entirely', () => {
    const s = toSummaryDTO(row as never)
    expect('content' in s).toBe(false)
    expect(JSON.stringify(s)).not.toContain('aaaa')
  })

  it('keeps the fields an agent needs to decide what to open', () => {
    expect(toSummaryDTO(row as never)).toEqual({
      id: 'd1',
      path: '/projects/mymind/x.md',
      title: 'X',
      project: 'mymind',
      type: null,
      tags: ['a'],
      updatedAt: '2026-07-29T00:00:00.000Z'
    })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run server/services/documents.test.ts`
Expected: FAIL — `toSummaryDTO` is not exported.

- [ ] **Step 4: Add the mapper and the two summary functions**

In `server/services/documents.ts`, add after `toDTO` (around :71):

```ts
const SUMMARY_COLUMNS = {
  id: documents.id,
  path: documents.path,
  title: documents.title,
  project: documents.project,
  type: documents.type,
  tags: documents.tags,
  updatedAt: documents.updatedAt
}

/**
 * Body-free projection for the agent read tools. Exported for unit testing.
 * Deliberately NOT `toDTO` minus a field — selecting fewer columns means Postgres never
 * ships the bodies either.
 */
export function toSummaryDTO(r: {
  id: string, path: string, title: string | null, project: string | null,
  type: string | null, tags: string[], updatedAt: Date
}): DocumentSummaryDTO {
  return {
    id: r.id, path: r.path, title: r.title, project: r.project,
    type: r.type, tags: r.tags ?? [], updatedAt: r.updatedAt.toISOString()
  }
}

export async function listDocsSummary(
  opts: { project?: string, limit: number, offset: number }
): Promise<DocumentSummaryDTO[]> {
  const rows = await useDb()
    .select(SUMMARY_COLUMNS)
    .from(documents)
    .where(and(live(), notSkill(), opts.project ? eq(documents.project, opts.project) : undefined))
    .orderBy(desc(documents.updatedAt))
    .limit(opts.limit)
    .offset(opts.offset)
  return rows.map(toSummaryDTO)
}

export async function countDocs(opts: { project?: string } = {}): Promise<number> {
  const [row] = await useDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(live(), notSkill(), opts.project ? eq(documents.project, opts.project) : undefined))
  return row?.n ?? 0
}
```

Add the `DocumentSummaryDTO` import at the top of the file.

**Note the `notSkill()` in both:** the old `list_documents` tool handler filtered skills in JS *after* fetching them (see the comment at `tools.ts:118-122` — skills sort near the top by recency, each body up to 20k chars, and the JS filter bypassed the `agentSkillsEnabled` kill-switch). Pushing `notSkill()` into SQL is strictly better and keeps `total` honest. **`notSkill()` is load-bearing and subtle** — see `server/services/documents.ts`; it must handle `type IS NULL` because `ne(NULL, 'skill')` is NULL in SQL and a naive `ne()` would hide every document.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run server/services/documents.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Add `searchDocsPage`**

In `server/services/documents.ts`, refactor `searchDocs` so the id-fusion is reusable, then add:

```ts
/**
 * One page of search results PLUS the total, from a SINGLE search.
 *
 * Deliberately returns both rather than exposing a separate count function: the search
 * runs `embedOne(q)` (documents.ts:180), a network call to the embedding rig. Two
 * functions would mean two embeddings per `search_docs` invocation.
 */
export async function searchDocsPage(
  q: string,
  opts: { project?: string, limit: number, offset: number }
): Promise<{ items: DocumentSummaryDTO[], total: number }> {
  if (!q.trim()) return { items: [], total: 0 }

  const ids = await searchDocIds(q, { project: opts.project })   // extracted from searchDocs
  const total = ids.length
  const window = ids.slice(opts.offset, opts.offset + opts.limit)
  if (!window.length) return { items: [], total }

  const rows = await useDb().select(SUMMARY_COLUMNS).from(documents).where(inArray(documents.id, window))
  const byId = new Map(rows.map(r => [r.id, toSummaryDTO(r)]))
  // Preserve relevance order — the SQL `in` clause does not.
  const items = window.map(id => byId.get(id)).filter((d): d is DocumentSummaryDTO => !!d)
  return { items, total }
}
```

Extract the existing lane-fusion body of `searchDocs` into `async function searchDocIds(q, opts): Promise<string[]>` and have the original `searchDocs` call it, so both paths share one implementation and the web UI's behaviour is unchanged.

**Do NOT add a `countSearchDocs` function.** An earlier draft of this plan had one, called alongside `searchDocsSummary` via `Promise.all` — which issued two concurrent embedding requests for a single tool call. `searchDocsPage` returning both values is the fix; keep it that way.

`total` is the count of fused candidate ids, itself capped by the lanes (~50/lane). That is the honest number — "matches we will consider", not "matches in the corpus". State this in the tool description in Task 5.

- [ ] **Step 7: Run the full suite and commit**

```bash
pnpm vitest run server/services/documents.test.ts
pnpm typecheck
pnpm test
git add shared/types/summaries.ts server/services/documents.ts server/services/documents.test.ts
git commit -m "feat(documents): body-free summary list/search + counts for agent tools"
```

Expected: typecheck clean; full suite green (existing `searchDocs` callers unaffected).

---

## Task 3: Task and project summary service functions

**Files:**
- Modify: `server/services/tasks.ts` (`listTasks` at :41)
- Modify: `server/services/projects.ts` (`listProjects` at :58, and `searchProjects`)
- Test: `server/services/tasks.test.ts` (create if absent)

**Interfaces:**
- Consumes: `TaskSummaryDTO`, `ProjectSummaryDTO` from Task 1.
- Produces:
  - `listTasksSummary(opts: { status?: string, project?: string, limit: number, offset: number }): Promise<TaskSummaryDTO[]>`
  - `countTasks(opts: { status?: string, project?: string }): Promise<number>`
  - `toTaskSummaryDTO(row): TaskSummaryDTO`
  - `listProjectsPage(opts: { activeOnly?: boolean, limit: number, offset: number }): Promise<{ items: ProjectSummaryDTO[], total: number }>`

**Correction (made mid-execution, 2026-07-30).** Earlier drafts of this plan specified
`searchProjectsPage(q, …)` "reusing the existing `searchProjects(q)`". **No such function
exists.** The `search_projects` tool is a misnomer: its schema is `{ activeOnly?: boolean }`
and its handler calls `listProjects({ activeOnly })` — there is no query parameter and no
text matching anywhere in the projects service.

Do **not** invent one. Adding substring matching would ship an unrequested capability and,
worse, would break the tool: agents call `search_projects` with **no arguments** to list
everything, and a query-required implementation returns zero rows for that call. The payload
fix (summary shape + limit/offset) is the whole point here; the tool keeps its existing
list semantics and its `activeOnly` flag.

- [ ] **Step 1: Write the failing test for the task summary mapper**

Create `server/services/tasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toTaskSummaryDTO } from './tasks'

const row = {
  id: 't1',
  title: 'Do the thing',
  description: 'x'.repeat(20_000),
  status: 'todo',
  priority: 'high',
  dueDate: null,
  project: 'mymind',
  order: 0,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-29T00:00:00Z'),
  completedAt: null
}

describe('toTaskSummaryDTO', () => {
  it('omits the task description', () => {
    const s = toTaskSummaryDTO(row as never)
    expect('description' in s).toBe(false)
    expect(JSON.stringify(s)).not.toContain('xxxx')
  })

  it('keeps triage fields', () => {
    expect(toTaskSummaryDTO(row as never)).toEqual({
      id: 't1',
      title: 'Do the thing',
      status: 'todo',
      priority: 'high',
      project: 'mymind',
      dueDate: null,
      updatedAt: '2026-07-29T00:00:00.000Z'
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/services/tasks.test.ts`
Expected: FAIL — `toTaskSummaryDTO` is not exported.

- [ ] **Step 3: Implement the task summary functions**

In `server/services/tasks.ts`, mirroring `listTasks` at :41 (keep its `orderBy(asc(tasks.order), asc(tasks.createdAt))`):

```ts
const TASK_SUMMARY_COLUMNS = {
  id: tasks.id, title: tasks.title, status: tasks.status, priority: tasks.priority,
  project: tasks.project, dueDate: tasks.dueDate, updatedAt: tasks.updatedAt
}

export function toTaskSummaryDTO(r: {
  id: string, title: string, status: string, priority: string,
  project: string | null, dueDate: Date | null, updatedAt: Date
}): TaskSummaryDTO {
  return {
    id: r.id, title: r.title, status: r.status, priority: r.priority,
    project: r.project,
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    updatedAt: r.updatedAt.toISOString()
  }
}

export async function listTasksSummary(
  opts: { status?: string, project?: string, limit: number, offset: number }
): Promise<TaskSummaryDTO[]> {
  const conditions = [live()]
  if (opts.status) conditions.push(eq(tasks.status, opts.status))
  if (opts.project) conditions.push(eq(tasks.project, opts.project))
  const rows = await useDb().select(TASK_SUMMARY_COLUMNS).from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.order), asc(tasks.createdAt))
    .limit(opts.limit).offset(opts.offset)
  return rows.map(toTaskSummaryDTO)
}

export async function countTasks(opts: { status?: string, project?: string } = {}): Promise<number> {
  const conditions = [live()]
  if (opts.status) conditions.push(eq(tasks.status, opts.status))
  if (opts.project) conditions.push(eq(tasks.project, opts.project))
  const [row] = await useDb().select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(...conditions))
  return row?.n ?? 0
}
```

Check `tasks.dueDate`'s column type in `server/db/schema/tasks.ts` before writing the `dueDate` conversion — if it is `text` rather than `timestamp`, pass it through unchanged instead of calling `.toISOString()`, and adjust the test's fixture accordingly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run server/services/tasks.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Add the project summary function**

In `server/services/projects.ts`, add beside `listProjects` (:58). `ProjectSummaryDTO` drops the `aliases`/`localPaths`/`pathPrefixes` arrays (item 5 shows those can hold ~50 entries) and keeps only `documentCount` from `COUNT_COLUMNS`:

```ts
export async function listProjectsPage(
  opts: { activeOnly?: boolean, limit: number, offset: number }
): Promise<{ items: ProjectSummaryDTO[], total: number }> {
  const all = await listProjects({ activeOnly: opts.activeOnly ?? false })
  const items = all.slice(opts.offset, opts.offset + opts.limit).map(p => ({
    slug: p.slug, name: p.name, active: p.active,
    lastActivityAt: p.lastActivityAt, documentCount: p.documentCount
  }))
  return { items, total: all.length }
}
```

One function, one `listProjects` call, items and total together. Do not add a separate count
function that lists again.

No query parameter, and no filtering by text — see the correction note above. A no-argument
call must still return the first page of ALL projects, exactly as the tool does today.

In-memory slicing is acceptable here and *only* here: projects number in the dozens, and the
spec flags `search_projects` as included for consistency rather than because it overflows. Do
not copy this pattern to documents or tasks.

- [ ] **Step 6: Run gates and commit**

```bash
pnpm typecheck && pnpm test
git add server/services/tasks.ts server/services/tasks.test.ts server/services/projects.ts
git commit -m "feat(tasks,projects): summary list/search + counts for agent tools"
```

---

## Task 4: Review-gated memory recall (item 2)

**Files:**
- Modify: `server/services/memory.ts:382-387` (`SearchMemoriesOptions`) and `:395-404` (`baseConditions`)
- Test: `server/services/memory.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SearchMemoriesOptions.reviewed?: boolean`, with the same semantics `ListMemoriesOptions.reviewed` already has (`true` → `reviewedAt IS NOT NULL`, `false` → `IS NULL`, absent → no filter). Task 5 passes it.

- [ ] **Step 1: Add `reviewed` to the options interface and the filter**

In `server/services/memory.ts`, extend the interface at :382:

```ts
export interface SearchMemoriesOptions {
  scope?: MemoryScope
  project?: string | null
  tags?: string[]
  limit?: number
  /**
   * true  -> only reviewed memories (reviewedAt IS NOT NULL)
   * false -> only unreviewed
   * undefined -> no filter (previous behaviour)
   *
   * Mirrors ListMemoriesOptions.reviewed. The agent tools default this to `true` so
   * unreviewed enrichment output stops surfacing as established fact.
   */
  reviewed?: boolean
}
```

And in `baseConditions` (after the `tags` clause at :402), matching `listMemories:492-493` exactly:

```ts
if (opts.reviewed === true) baseConditions.push(isNotNull(memories.reviewedAt))
if (opts.reviewed === false) baseConditions.push(isNull(memories.reviewedAt))
```

`isNotNull` may need adding to the drizzle import at the top of the file — check before assuming.

**Both search lanes must get this filter.** `baseWhere` is used by the trigram lane at :407 and the vector lane below it; confirm both compose `baseWhere` and that neither builds its own `where` from scratch. A filter applied to only one lane would leak unreviewed rows through the other.

- [ ] **Step 2: Write the test proving the filter is the right way round**

Extract a pure helper `reviewedCondition(reviewed?: boolean)` and use it in **both**
`searchMemories` and `listMemories`, replacing the duplicated pair of `if` statements in each —
this removes the existing duplication rather than adding a third copy.

The test must distinguish `IS NOT NULL` from `IS NULL`. An assertion that the value is merely
defined would pass with the two branches swapped, which is the one bug that actually matters
here — so inspect the generated SQL:

```ts
import { describe, it, expect } from 'vitest'
import { reviewedCondition } from './memory'

/** Render a drizzle SQL fragment to inspectable text. */
const sqlText = (cond: unknown): string => {
  // drizzle conditions expose a queryChunks/sql structure; JSON round-trip is the
  // simplest stable way to assert on which operator was chosen.
  return JSON.stringify(cond)
}

describe('reviewedCondition', () => {
  it('builds an IS NOT NULL check for reviewed: true', () => {
    const s = sqlText(reviewedCondition(true))
    expect(s).toMatch(/is not null/i)
    expect(s).not.toMatch(/is null(?! not)/i)
  })

  it('builds an IS NULL check for reviewed: false', () => {
    const s = sqlText(reviewedCondition(false))
    expect(s).toMatch(/is null/i)
    expect(s).not.toMatch(/is not null/i)
  })

  it('applies no filter when unset', () => {
    expect(reviewedCondition(undefined)).toBeUndefined()
  })

  it('references the reviewed_at column, not some other timestamp', () => {
    expect(sqlText(reviewedCondition(true))).toMatch(/reviewed_at/i)
  })
})
```

**If `JSON.stringify` does not expose the operator** for this drizzle version, do not weaken the
assertions to `toBeDefined()`. Instead prove the behaviour end-to-end: use the real dev DB
(`DATABASE_URL` from `.env`) to insert two memories — one with `reviewedAt` set, one `null` —
then assert `listMemories({ reviewed: true })` returns only the first and
`{ reviewed: false }` only the second, and delete both rows afterwards. A behavioural test
against real SQL is strictly better than a shape assertion; only the mechanism is negotiable,
never the discrimination between the two branches.

- [ ] **Step 3: Run the test and gates**

```bash
pnpm vitest run server/services/memory.test.ts
pnpm typecheck && pnpm test
```

Expected: new tests pass; the full suite stays green because `reviewed` is optional and absent means no filter — every existing caller is unaffected.

- [ ] **Step 4: Commit**

```bash
git add server/services/memory.ts server/services/memory.test.ts
git commit -m "feat(memory): reviewed filter on searchMemories, shared with listMemories"
```

---

## Task 5: Rewire the six agent tools (items 1 + 2)

**Files:**
- Modify: `server/lib/agent/tools.ts` — `search_memories` (:24), `get_recent_memories` (:41), `search_docs` (:94), `list_documents` (:114), `search_projects` (:345), `search_tasks` (:422)

**Interfaces:**
- Consumes: everything produced by Tasks 1–4.
- Produces: the changed MCP tool contract. No later task consumes it.

- [ ] **Step 1: Rewire `list_documents`**

Replace the definition at `tools.ts:114-128`:

```ts
{
  name: 'list_documents',
  description: 'List documents (summaries only: id, path, title, project, type, tags, updatedAt — NOT the body), newest first. Pass `project` (a slug) to filter. Returns { items, total, hasMore } — page with `offset`. To read a document body use get_document, or read_document/grep_document for a long one. Use search_docs when you know what you are looking for.',
  kind: 'read',
  schema: {
    project: z.string().optional().describe('Project slug to filter by'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)'),
    offset: z.number().int().min(0).optional().describe('Rows to skip (default 0)')
  },
  handler: async (a) => {
    const { limit, offset } = clampPaging(a.limit as number | undefined, a.offset as number | undefined)
    const project = a.project as string | undefined
    const [items, total] = await Promise.all([
      listDocsSummary({ project, limit, offset }),
      countDocs({ project })
    ])
    const page = buildPage(items, total, limit, offset)
    return { result: page, summary: `listed documents (${items.length} of ${total})` }
  }
}
```

The old handler's JS-side `.filter(d => d.type !== 'skill')` is gone because `notSkill()` now runs in SQL (Task 2). Delete the stale comment block that explained the JS filter — keep the *reason* by noting skills are excluded in SQL.

- [ ] **Step 2: Rewire `search_docs`, `search_tasks`, `search_projects`**

Apply the same shape. For `search_docs` (:94):

```ts
{
  name: 'search_docs',
  description: 'Semantic + keyword search over documents, best match first. Returns summaries only (no body) as { items, total, hasMore } — read a hit with get_document or read_document. `total` is how many candidate matches were considered, not the corpus size. Pass `project` (a slug) to scope. Search here before creating a document to avoid duplicates.',
  kind: 'read',
  schema: {
    query: z.string().describe('Search query'),
    project: z.string().optional().describe('Project slug to scope to'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)'),
    offset: z.number().int().min(0).optional().describe('Rows to skip (default 0)')
  },
  handler: async (a) => {
    const { limit, offset } = clampPaging(a.limit as number | undefined, a.offset as number | undefined)
    const { items, total } = await searchDocsPage(a.query as string, {
      project: a.project as string | undefined, limit, offset
    })
    return { result: buildPage(items, total, limit, offset), summary: `searched docs (${items.length} of ${total})` }
  }
}
```

**One call, not a `Promise.all` of two.** The search embeds the query; two calls would issue two
embedding requests per tool invocation.

For `search_tasks` (:422) use `listTasksSummary` + `countTasks` in a `Promise.all` — those are
two cheap SQL queries with no embedding, so concurrency is free and correct there. Keep the
existing `status` enum. For `search_projects` (:345) use `listProjectsPage` as a single call. Keep its `activeOnly` schema param and ADD `limit`/`offset`; do NOT add a `query` param. A no-argument call must still return the first page of all projects.

- [ ] **Step 3: Add `includeUnreviewed` to the two memory tools**

`search_memories` (:24) — add to the schema and pass through:

```ts
includeUnreviewed: z.boolean().optional()
  .describe('Include memories not yet reviewed (default false — unreviewed memories are low-signal enrichment output and are hidden by default)')
```

```ts
const res = await searchMemories(a.query as string, {
  scope: a.scope as undefined,
  project: a.project as undefined,
  limit: a.limit as undefined,
  reviewed: (a.includeUnreviewed as boolean | undefined) ? undefined : true
})
```

Note the mapping: `includeUnreviewed: true` → `reviewed: undefined` (**no filter**, i.e. reviewed *and* unreviewed), not `reviewed: false` (which would return *only* unreviewed). Getting this backwards would silently invert the tool. Apply the identical mapping to `get_recent_memories` (:41) via `listMemories`.

Also update both tools' `description` strings to state that unreviewed memories are excluded by default — an agent that cannot see a memory it just saved will otherwise assume the save failed.

- [ ] **Step 4: Add the imports and typecheck**

Add `clampPaging`, `buildPage` from `./paging` and the new service functions to the imports at the top of `tools.ts`.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Verify the MCP tool count guard still matches**

`mcpToolNames()` (`server/lib/mcp/server.ts:4`) derives the exposed list from `agentTools`. No tools are added or removed here, so the count stays at 37 (cycle 50's number).

Run: `pnpm test`
Expected: green — including any test asserting the tool count/name list. If a test asserts tool *schemas*, update it to match the new params.

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent/tools.ts
git commit -m "feat(agent): page list/search tools + default memory recall to reviewed-only"
```

---

## Task 6: Measure the payload reduction

**Files:**
- Create then delete: `_e2e.mjs` at repo root (per the `browser-testing` skill — it must live at the repo root so node resolves `@modelcontextprotocol/sdk` from `<repo>/node_modules`)

**Interfaces:** none. This task produces the acceptance evidence the spec requires.

- [ ] **Step 1: Start the local dev stack**

```bash
docker start mymind-db && sleep 3
pnpm dev > /tmp/dev.log 2>&1 &
sleep 25
curl -s -o /dev/null -w "health:%{http_code}\n" http://localhost:3000/api/health
```

Expected: `health:200`. A 500 means the DB is not up — check `docker ps` for `mymind-db`. `/login` returning 200 does **not** prove the DB is up.

- [ ] **Step 2: Mint an API token directly into the dev DB**

The stored hash is `sha256("mm_" + base64url)`:

```bash
node -e "
const c=require('crypto'); const {Client}=require('pg');
const token='mm_'+c.randomBytes(24).toString('base64url');
const hash=c.createHash('sha256').update(token).digest('hex');
(async()=>{
  const db=new Client({connectionString:process.argv[1]}); await db.connect();
  await db.query('insert into api_tokens (name, token_hash, last_four) values (\$1,\$2,\$3)',
    ['cycle51-measure', hash, token.slice(-4)]);
  await db.end(); console.log(token);
})()" "$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
```

Save the printed token. Note `.env` also contains `BRIDGET_DATABASE_URL` — `grep -m1 '^DATABASE_URL='` is anchored to avoid picking it up.

- [ ] **Step 3: Measure both tools**

Create `_e2e.mjs` at the repo root:

The script both measures and asserts, exiting non-zero on any violation — so this step cannot
"pass" by being eyeballed:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = process.argv[2]
if (!token) { console.error('usage: node _e2e.mjs <mm_token>'); process.exit(2) }

// Pre-fix baselines, recorded from the sessions that overflowed.
const BASELINE = { list_documents: 662712, search_docs: 472472, search_tasks: 282904 }
const BUDGET = 60_000        // a tool result above this is a regression of the whole cycle
const BANNED = ['content', 'description']

const t = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), {
  requestInit: { headers: { Authorization: 'Bearer ' + token } }
})
const c = new Client({ name: 'measure', version: '1.0' })
await c.connect(t)

const failures = []
for (const [name, args] of [
  ['list_documents', {}],
  ['search_docs', { query: 'mcp' }],
  ['search_tasks', {}]
]) {
  const res = await c.callTool({ name, arguments: args })
  const text = res.content[0].text
  const parsed = JSON.parse(text)

  const before = BASELINE[name]
  const pct = before ? ((1 - text.length / before) * 100).toFixed(1) : 'n/a'
  console.log(`${name}: ${text.length} chars (was ${before ?? '?'}, -${pct}%) items=${parsed.items?.length} total=${parsed.total} hasMore=${parsed.hasMore}`)

  if (!Array.isArray(parsed.items)) failures.push(`${name}: no items[] — envelope missing`)
  if (typeof parsed.total !== 'number') failures.push(`${name}: total is not a number`)
  if (typeof parsed.hasMore !== 'boolean') failures.push(`${name}: hasMore is not a boolean`)
  if (text.length > BUDGET) failures.push(`${name}: ${text.length} chars exceeds ${BUDGET} budget`)
  if ((parsed.items ?? []).length > 25) failures.push(`${name}: returned more than the default 25`)

  for (const key of BANNED) {
    if ((parsed.items ?? []).some(i => key in i)) failures.push(`${name}: items[] still carries "${key}"`)
  }
}
await c.close()

if (failures.length) { console.error('\nFAILURES:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1) }
console.log('\nOK: all three tools paged, enveloped, and body-free')
```

Run: `node _e2e.mjs <token>`

Expected: exit 0, each result a few KB with a large negative percentage against its baseline.
A non-zero exit lists exactly which invariant broke. **Copy the printed before/after lines into
the handover verbatim** — they are this cycle's acceptance evidence.

- [ ] **Step 4: Sanity-check paging actually pages**

The envelope can be well-formed while `offset` is ignored. Confirm the second page differs from
the first:

```bash
node -e "
import('@modelcontextprotocol/sdk/client/index.js').then(async ({Client}) => {
  const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const t = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'),
    { requestInit: { headers: { Authorization: 'Bearer ' + process.argv[1] } } })
  const c = new Client({name:'page',version:'1.0'}); await c.connect(t)
  const call = async (offset) => JSON.parse((await c.callTool({
    name:'list_documents', arguments:{ limit:5, offset }})).content[0].text).items.map(i=>i.id)
  const p1 = await call(0), p2 = await call(5)
  await c.close()
  const overlap = p1.filter(id => p2.includes(id))
  if (overlap.length) { console.error('FAIL: pages overlap — offset ignored?', overlap); process.exit(1) }
  console.log('OK: page 1 and page 2 are disjoint', p1.length, p2.length)
})" "<token>"
```

Expected: `OK` with two disjoint 5-item pages. Overlap means `offset` is not reaching the query.
Skip only if the dev corpus holds fewer than 10 documents — in which case say so explicitly in
the report rather than silently passing.

- [ ] **Step 5: Clean up**

```bash
rm _e2e.mjs
node -e "const {Client}=require('pg');(async()=>{const d=new Client({connectionString:process.argv[1]});await d.connect();
  console.log((await d.query(\"delete from api_tokens where name='cycle51-measure' returning id\")).rowCount+' token(s) deleted');
  await d.end()})()" "$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)"
lsof -ti tcp:3000 | xargs kill -9 2>/dev/null; echo done
```

Leave no test token behind — it is a live credential against the dev DB.

---

## Task 7: Corroboration-aware contradiction gate (item 3)

**Files:**
- Modify: `server/services/memory-resolve.ts` (`chooseResolution` :29-37, `ResolveAction` :23, the action dispatch :100-115)
- Create: `server/services/memory-resolve.test.ts` (first test file for this module)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ResolveAction` gains `'review-contradict'`
  - `chooseResolution(verdicts: Verdict[], opts: { threshold: number, scope: MemoryScope, incumbentSessions: number, challengerSessions: number }): ResolvePlan`
  - `countEvidenceSessions(evidence: unknown[]): number`

- [ ] **Step 1: Write the failing tests for the pure decision function**

Create `server/services/memory-resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { chooseResolution, countEvidenceSessions } from './memory-resolve'

const v = (relation: string, confidence: number, existingId = 'x1') =>
  ({ relation, confidence, existingId, reasoning: 'r' }) as never

const base = { threshold: 0.8, scope: 'agent' as const, incumbentSessions: 1, challengerSessions: 1 }

describe('chooseResolution — unchanged branches', () => {
  it('still prefers a duplicate above the dup floor', () => {
    expect(chooseResolution([v('duplicate', 0.9)], base).action).toBe('duplicate')
  })

  it('still supersedes on a confident refines', () => {
    expect(chooseResolution([v('refines', 0.9)], base).action).toBe('supersede')
  })

  it('still routes a low-confidence refines to review', () => {
    expect(chooseResolution([v('refines', 0.5)], base).action).toBe('review-supersede')
  })

  it('still inserts when nothing matches', () => {
    expect(chooseResolution([], base).action).toBe('insert')
  })
})

describe('chooseResolution — contradiction gate', () => {
  it('never silently resolves a user-scope contradiction', () => {
    const plan = chooseResolution([v('contradicts', 0.95)], { ...base, scope: 'user' })
    expect(plan.action).toBe('review-contradict')
    expect(plan.targetId).toBe('x1')
  })

  it('routes to review when the incumbent is better corroborated than the challenger', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, incumbentSessions: 5, challengerSessions: 1 }).action).toBe('review-contradict')
  })

  it('auto-resolves agent-scope when corroboration is equal', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, incumbentSessions: 1, challengerSessions: 1 }).action).toBe('contradict')
  })

  it('auto-resolves when the challenger is itself well corroborated', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, incumbentSessions: 3, challengerSessions: 3 }).action).toBe('contradict')
  })

  it('auto-resolves world-scope with an uncorroborated incumbent', () => {
    expect(chooseResolution([v('contradicts', 0.9)],
      { ...base, scope: 'world', incumbentSessions: 1, challengerSessions: 1 }).action).toBe('contradict')
  })

  it('picks the highest-confidence contradiction as the target', () => {
    const plan = chooseResolution(
      [v('contradicts', 0.6, 'lo'), v('contradicts', 0.9, 'hi')], { ...base, scope: 'user' })
    expect(plan.targetId).toBe('hi')
  })
})

describe('countEvidenceSessions', () => {
  it('counts distinct sessionIds', () => {
    expect(countEvidenceSessions([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'a' }])).toBe(2)
  })
  it('ignores entries with a null or missing sessionId', () => {
    expect(countEvidenceSessions([{ sessionId: null }, {}, { sessionId: 'a' }])).toBe(1)
  })
  it('returns 0 for an empty array', () => {
    expect(countEvidenceSessions([])).toBe(0)
  })
  it('tolerates non-object entries without throwing', () => {
    expect(countEvidenceSessions(['nope', 42, null])).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/memory-resolve.test.ts`
Expected: FAIL — `countEvidenceSessions` is not exported and `chooseResolution` does not accept an options object.

- [ ] **Step 3: Implement**

In `server/services/memory-resolve.ts`, extend the action union at :23 and replace `chooseResolution`:

```ts
export type ResolveAction =
  'duplicate' | 'insert' | 'supersede' | 'review-supersede' | 'contradict' | 'review-contradict'

export interface ChooseResolutionOpts {
  threshold: number
  scope: MemoryScope
  /** Distinct sessions corroborating the EXISTING memory (from its evidence chain). */
  incumbentSessions: number
  /** Distinct sessions behind the INCOMING memory — normally 1 on the enrichment path. */
  challengerSessions: number
}

/** Distinct `sessionId`s in a memory's evidence array. Defensive against malformed entries. */
export function countEvidenceSessions(evidence: unknown[]): number {
  const ids = new Set<string>()
  for (const e of evidence ?? []) {
    if (!e || typeof e !== 'object') continue
    const id = (e as { sessionId?: unknown }).sessionId
    if (typeof id === 'string' && id) ids.add(id)
  }
  return ids.size
}

/** Pure: pick the resolution from judge verdicts. */
export function chooseResolution(verdicts: Verdict[], opts: ChooseResolutionOpts): ResolvePlan {
  const dup = verdicts.filter(v => v.relation === 'duplicate' && v.confidence >= DUP_MIN)
    .sort((a, b) => b.confidence - a.confidence)[0]
  if (dup) return { action: 'duplicate', targetId: dup.existingId, confidence: dup.confidence, reasoning: dup.reasoning }

  const refines = verdicts.filter(v => v.relation === 'refines').sort((a, b) => b.confidence - a.confidence)[0]
  if (refines) return {
    action: refines.confidence >= opts.threshold ? 'supersede' : 'review-supersede',
    targetId: refines.existingId, confidence: refines.confidence, reasoning: refines.reasoning
  }

  const contra = verdicts.filter(v => v.relation === 'contradicts').sort((a, b) => b.confidence - a.confidence)[0]
  if (contra) {
    // Identity/preference claims are never auto-resolved: a wrong resolution here is
    // self-reinforcing (the bad memory shapes later sessions, which then corroborate it).
    // Otherwise, defer to a human when the incumbent is corroborated across more sessions
    // than the challenger — high confidence from ONE exploratory session is not evidence.
    const outnumbered = opts.incumbentSessions >= 2 && opts.challengerSessions < opts.incumbentSessions
    const action: ResolveAction = (opts.scope === 'user' || outnumbered) ? 'review-contradict' : 'contradict'
    return { action, targetId: contra.existingId, confidence: contra.confidence, reasoning: contra.reasoning }
  }

  return { action: 'insert' }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm vitest run server/services/memory-resolve.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Wire the caller and add the new action's effect**

At `memory-resolve.ts:93`, fetch the incumbent's evidence and pass the new options. The near-neighbour select at :87 currently fetches only `{ id, content }` — add `evidence: memories.evidence` so no second query is needed:

```ts
const near = await db.select({ id: memories.id, content: memories.content, evidence: memories.evidence })
  .from(memories)
  .where(and(live, eq(memories.scope, scope), projectFilter, isNotNull(memories.embedding)))
  .orderBy(sql`${memories.embedding} <=> ${lit}::halfvec`).limit(8)

const verdicts = await judgeRelations(input.content, near.map(n => ({ id: n.id, content: n.content })))
const challengerSessions = countEvidenceSessions((input.evidence ?? []) as unknown[])
const preliminary = verdicts.filter(v => v.relation === 'contradicts')
  .sort((a, b) => b.confidence - a.confidence)[0]
const incumbent = preliminary ? near.find(n => n.id === preliminary.existingId) : undefined
const incumbentSessions = countEvidenceSessions((incumbent?.evidence ?? []) as unknown[])

const plan = chooseResolution(verdicts, { threshold, scope, incumbentSessions, challengerSessions })
```

Check `judgeRelations`' parameter type before mapping — if it accepts extra properties, pass `near` directly.

Then add the `review-contradict` branch beside the existing ones at :100-115, mirroring `review-supersede` (:106) but **without** the `memories` update that archives the incumbent:

```ts
} else if (plan.action === 'review-contradict') {
  await db.insert(memoryRelations).values({
    fromId: newId, toId: plan.targetId!, type: 'contradicts',
    confidence: plan.confidence ?? null, status: 'active', reason: plan.reasoning ?? null
  }).onConflictDoNothing()
  await db.insert(reviewQueue).values({
    docId: plan.targetId!, kind: 'memory-contradict', proposed: proposed as unknown as string
  }).onConflictDoNothing()
  // Deliberately NO archivedAt/supersededBy update: both memories stay live until a human
  // decides. An unresolved contradiction is preferable to a silently wrong resolution.
}
```

`review_queue` has a unique index `review_queue_one_pending_per_doc` on `doc_id WHERE status = 'pending'`, so a memory that already has a pending review row will hit `onConflictDoNothing` and no second row appears. That matches `review-supersede`'s existing behaviour and is correct — the memory is already flagged.

- [ ] **Step 6: Run gates and commit**

```bash
pnpm typecheck && pnpm test
git add server/services/memory-resolve.ts server/services/memory-resolve.test.ts
git commit -m "feat(memory): gate contradictions on scope + cross-session corroboration"
```

---

## Task 8: Path collapse + cleanup script (item 5)

**Files:**
- Modify: `server/lib/projects/path-routing.ts`
- Modify: `server/lib/projects/path-routing.test.ts`
- Modify: `server/services/projects.ts:200-204`
- Create: `scripts/collapse-local-paths.ts`

**Interfaces:**
- Consumes: existing `normalizePrefix`, `isUnderPrefix` from `path-routing.ts`.
- Produces: `shouldRecordLocalPath(cwd, localPaths, pathPrefixes): boolean`, `collapseLocalPaths(localPaths, pathPrefixes): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `server/lib/projects/path-routing.test.ts`:

```ts
import { shouldRecordLocalPath, collapseLocalPaths } from './path-routing'

describe('shouldRecordLocalPath', () => {
  const PREFIX = ['/Users/tony/x/terawulf']

  it('records a genuinely new path', () => {
    expect(shouldRecordLocalPath('/Users/tony/other', [], [])).toBe(true)
  })
  it('skips an exact duplicate (existing behaviour)', () => {
    expect(shouldRecordLocalPath('/a/b', ['/a/b'], [])).toBe(false)
  })
  it('skips a path already covered by a pathPrefix', () => {
    expect(shouldRecordLocalPath('/Users/tony/x/terawulf/apps/web', [], PREFIX)).toBe(false)
  })
  it('skips a path under an existing localPath', () => {
    expect(shouldRecordLocalPath('/a/b/c', ['/a/b'], [])).toBe(false)
  })
  it('records a sibling that no prefix covers', () => {
    expect(shouldRecordLocalPath('/Users/tony/x/terawulf-old', [], PREFIX)).toBe(true)
  })
  it('normalises trailing slashes on both sides', () => {
    expect(shouldRecordLocalPath('/a/b/', ['/a/b'], [])).toBe(false)
    expect(shouldRecordLocalPath('/a/b/c', ['/a/b/'], [])).toBe(false)
  })
  it('records when cwd is a PARENT of an existing path', () => {
    expect(shouldRecordLocalPath('/a', ['/a/b'], [])).toBe(true)
  })
})

describe('collapseLocalPaths', () => {
  it('drops entries covered by a prefix', () => {
    expect(collapseLocalPaths(
      ['/t', '/t/apps', '/t/apps/web'], ['/t']
    )).toEqual([])
  })
  it('keeps the shortest ancestor when there is no prefix', () => {
    expect(collapseLocalPaths(['/t', '/t/apps', '/t/apps/web'], [])).toEqual(['/t'])
  })
  it('keeps unrelated siblings', () => {
    expect(collapseLocalPaths(['/a', '/b'], [])).toEqual(['/a', '/b'])
  })
  it('is idempotent', () => {
    const once = collapseLocalPaths(['/t', '/t/apps'], [])
    expect(collapseLocalPaths(once, [])).toEqual(once)
  })
  it('returns an empty array unchanged', () => {
    expect(collapseLocalPaths([], [])).toEqual([])
  })
})
```

Note the "cwd is a PARENT" case: `/a` must still be recorded when `/a/b` exists, because `/a` is broader coverage. Only *narrower* paths are redundant.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/projects/path-routing.test.ts`
Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Implement**

Append to `server/lib/projects/path-routing.ts`:

```ts
/**
 * Should `cwd` be appended to a project's localPaths?
 *
 * Previously this was a bare `!localPaths.includes(cwd)`, which appended every subfolder a
 * session ran in even when pathPrefixes already covered the tree — Terawulf accumulated ~50
 * entries that way. A path is redundant if a prefix or a shorter localPath already covers it.
 */
export function shouldRecordLocalPath(
  cwd: string, localPaths: string[], pathPrefixes: string[]
): boolean {
  if (!cwd) return false
  const c = normalizePrefix(cwd)
  if (pathPrefixes.some(p => isUnderPrefix(c, normalizePrefix(p)))) return false
  if (localPaths.some(p => isUnderPrefix(c, normalizePrefix(p)))) return false
  return true
}

/** Idempotent: drop localPaths already covered by a prefix or by a shorter sibling entry. */
export function collapseLocalPaths(localPaths: string[], pathPrefixes: string[]): string[] {
  const norm = [...new Set(localPaths.map(normalizePrefix))].sort((a, b) => a.length - b.length)
  const kept: string[] = []
  for (const p of norm) {
    if (pathPrefixes.some(x => isUnderPrefix(p, normalizePrefix(x)))) continue
    if (kept.some(k => isUnderPrefix(p, k))) continue
    kept.push(p)
  }
  return kept
}
```

`isUnderPrefix(cwd, prefix)` already treats an exact match as "under" (`path-routing.ts:22-28` has an explicit `if (c === p) return true`), so the exact-duplicate case is covered without an extra equality check, and `collapseLocalPaths`' self-comparison is safe because entries are de-duplicated and sorted shortest-first before the `kept.some(...)` test.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/lib/projects/path-routing.test.ts`
Expected: PASS — all new cases plus the existing cycle-46 cases.

- [ ] **Step 5: Use it at the append site**

At `server/services/projects.ts:200-201`, replace:

```ts
const localPaths = (proj.localPaths ?? [])
const nextPaths = cwd && !localPaths.includes(cwd) ? [...localPaths, cwd] : localPaths
```

with:

```ts
const localPaths = (proj.localPaths ?? [])
const nextPaths = cwd && shouldRecordLocalPath(cwd, localPaths, proj.pathPrefixes ?? [])
  ? [...localPaths, cwd]
  : localPaths
```

Add the import. Verify `proj` carries `pathPrefixes` at this point — if the surrounding select does not fetch it, add it.

- [ ] **Step 6: Write the cleanup script**

Create `scripts/collapse-local-paths.ts`, following the conventions of an existing script (read `scripts/reresolve-uncategorized.ts` first — it is the closest analogue and already handles dry-run and DB wiring):

- default to **dry-run**; require `--apply` to write
- for each project: `collapseLocalPaths(localPaths, pathPrefixes)`; skip when unchanged
- print `slug: 50 -> 1` per changed project and a total
- idempotent: a second `--apply` run must report zero changes

- [ ] **Step 7: Dry-run against dev, then gates and commit**

```bash
pnpm tsx scripts/collapse-local-paths.ts          # dry-run, expect a report
pnpm typecheck && pnpm test
git add server/lib/projects/path-routing.ts server/lib/projects/path-routing.test.ts \
        server/services/projects.ts scripts/collapse-local-paths.ts
git commit -m "fix(projects): collapse localPaths covered by a pathPrefix + cleanup script"
```

Check whether this repo runs scripts via `tsx`, `bun`, or a `package.json` script before assuming `pnpm tsx`.

---

## Task 9: Docs, gates, and handover

**Files:**
- Modify: `docs/wiki/mcp.md`
- Create: `docs/handovers/2026-07-29-mcp-recall-hygiene.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`

- [ ] **Step 1: Update the wiki**

In `docs/wiki/mcp.md`, update the tool table so `list_documents`, `search_docs`, `search_tasks`, `search_projects` show their `limit`/`offset` params and the `{ items, total, hasMore }` result, and add a short "Recall defaults" subsection stating that (a) list/search tools return summaries and bodies come from the by-id readers, and (b) `search_memories`/`get_recent_memories` exclude unreviewed memories unless `includeUnreviewed: true`. Bump the cycle marker to 51.

The wiki describes **current** behaviour — do not describe any of this as planned.

- [ ] **Step 2: Write the handover**

Create `docs/handovers/2026-07-29-mcp-recall-hygiene.md` with accurate frontmatter (`title`, `cycle: 51`, `date`, `status`, `branch`, `docs`, `related`, `problem`, `keydecision`) matching the style of `docs/handovers/2026-07-28-session-search-mcp.md`. Must record:

- the before/after payload numbers from Task 6 — the acceptance criterion
- that item 1 was a payload-shape problem, not an unbounded-rows problem
- the paging divergence from the feedback doc, and why (relevance ordering)
- that item 4 was **rejected** by Tony as an explicit design decision
- that item 3 needed no migration because evidence already carries `sessionId`
- the breaking MCP contract change, and that tool descriptions now point at the by-id readers

- [ ] **Step 3: Add the roadmap row**

Add a cycle-51 row to `docs/superpowers/plans/00-roadmap.md` following the existing column format, linking spec, plan, and handover.

- [ ] **Step 4: Full gates**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: typecheck clean; test count ≥ 873 + roughly 45 new; build clean.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(cycle-51): wiki recall defaults, handover, roadmap row"
```

---

## Task 10: Deploy

- [ ] **Step 1: Merge and push**

Confirm with Tony before merging — he has consistently made the merge/deploy call himself.

- [ ] **Step 2: Deploy and verify**

Follow the `prod-deploy` skill. Use the **quoted** invocation form or the `lxc()` helper — the unquoted `--` chain silently targets the Proxmox host instead of LXC 114.

```bash
lxc 'hostname'                                                                    # expect "mymind"
lxc 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health'   # expect 200
```

- [ ] **Step 3: Run the path cleanup against prod**

Dry-run first, review the report with Tony, then apply. No migration is needed for this cycle, so `pnpm db:migrate` has nothing to do — do not skip verifying that.

- [ ] **Step 4: Prove it on the real connector**

Call `list_documents` and `search_memories` through the live prod MCP and confirm the paged envelope and reviewed-only default. Record the result in the handover.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Summary projections, no bodies | 1 (types), 2 (docs), 3 (tasks/projects) |
| `limit`/`offset` + `total`/`hasMore` envelope | 1 (helpers), 5 (wiring) |
| Bodies via by-id readers, stated in descriptions | 5 |
| `search_projects` included from the audit | 3, 5 |
| `reviewed` filter on `searchMemories` | 4 |
| Agent tools default reviewed-only + `includeUnreviewed` | 5 |
| Scope gate + corroboration tiebreak | 7 |
| Corroboration from `evidence` sessionIds, no migration | 7 |
| `review-contradict` does not archive the incumbent | 7 |
| `shouldRecordLocalPath` reusing cycle-46 helpers | 8 |
| One-time idempotent cleanup script | 8, 10 |
| Payload measurement as acceptance | 6 |
| Wiki + handover in the same cycle | 9 |
| No migration | asserted in Global Constraints; verified in 10 |
| Item 4 rejected, recorded | 9 (handover) |

No gaps.

**Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N". Some steps deliberately say "read the existing implementation first" (2.1, 8.6) or "confirm before assuming" (3.3 `dueDate` column type, 4.1 drizzle `isNotNull` import, 7.5 `judgeRelations` parameter type, 8.7 script runner) — these are verification instructions against real uncertainty in code not fully read while planning, not placeholders for content.

Two such uncertainties were resolved during this review rather than left to the implementer:
- `notSkill()` exists at `documents.ts:64` as `or(ne(type,'skill'), isNull(type))` — it already handles the `NULL` trap, so Task 2 can use it directly. Note it is module-private and NOT currently applied by `listDocs`, which is why the *web* `/documents` page shows skills; Task 2 adds it only to the new summary functions and leaves `listDocs` alone.
- `isUnderPrefix` handles exact matches (Task 8 Step 3, above).

**Type consistency:** `DocumentSummaryDTO`/`TaskSummaryDTO`/`ProjectSummaryDTO`/`PagedResult<T>` defined in Task 1, used with identical field names in 2/3/5. `clampPaging`/`buildPage` signatures match between 1 and 5. `countEvidenceSessions`/`chooseResolution` signatures match between 7's tests and implementation. `shouldRecordLocalPath`/`collapseLocalPaths` match between 8's tests, implementation, and call site. `ResolveAction`'s new `'review-contradict'` is used consistently in the union, the tests, and the dispatch branch.

**One risk worth flagging to the implementer:** Task 2 Step 6 refactors `searchDocs` to extract `searchDocIds`. That function backs the **web** document search, so a mistake there is user-visible. Run the full suite after that step, and if any web search test exists, confirm it still passes before moving on.
