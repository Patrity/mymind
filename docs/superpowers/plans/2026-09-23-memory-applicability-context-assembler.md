# Memory Applicability + Budgeted Context Assembler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give memories an applicability axis and a resident tier, and replace Bridget's ad-hoc context building with one budgeted assembler, so a persistent `/agent` session can run unbounded inside a bounded context window.

**Architecture:** `memories` gains `applicability` (does this fact travel) and `resident` (is this worth tokens every turn) as separate columns, plus retrieval counters that let the resident tier nominate itself from usage. A new `assembleContext()` fills a token budget from ranked tiers — resident facts and live state are fixed, retrieved memories are evicted first, recent turns keep a floor. `/clear` writes an epoch marker rather than deleting rows. Enrichment is extended to read conversations, so facts Bridget learns in conversation can graduate into memories.

**Tech Stack:** Nuxt 4 / Nitro, TypeScript, Drizzle ORM + Postgres (pgvector, `halfvec(2560)`), Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-23-memory-applicability-context-assembler-design.md`](../specs/2026-09-23-memory-applicability-context-assembler-design.md)

## Global Constraints

- **Package manager is `pnpm`.** Never npm or yarn.
- **Gates:** `pnpm test`, `pnpm typecheck`, `pnpm build`. Lint is red repo-wide and is **not** a gate — but do not add new violations in files you author.
- **`pnpm typecheck` does not cover `scripts/` or `test/`.** Files there must be checked with a standalone `tsc` invocation (see Task 9).
- **DB-backed tests are named `*.db.test.ts`** and run via `pnpm test:db`. They are excluded from `pnpm test` because CI has no Postgres. Pure unit tests are `test/<topic>.test.ts`.
- **Every test must be verified to fail when its behaviour is broken on purpose.** Five of cycle 68's findings were tests that could not fail. After a test goes green, break the implementation, watch it go red, restore it.
- **Migrations are additive only.** No `DROP COLUMN`, no destructive rewrite. Prod is live; migration `0045` is the current head, so new files start at `0046`.
- **Existing token estimator:** `estimateTokens` from `server/lib/chunking/chunk-markdown.ts` (`CHARS_PER_TOKEN = 3.8`). Do not add a tokenizer dependency.
- **The salience ranker must not use an LLM value judgment.** Jev's `value` rubric measured AUC 0.55 (chance) at ranking quality. Use observable structure only.
- **Nothing in this cycle deletes or archives a memory without a human.**

---

### Task 1: Memory applicability — schema + retrieval

Memories carry `project` meaning "where this was learned". Retrieval treats it as "where this applies", so a universal preference filed under `3d-rpg` is invisible to a project-scoped query.

**Files:**
- Modify: `server/db/schema/memories.ts`
- Create: `server/db/migrations/0046_*.sql` (via `pnpm db:generate`)
- Modify: `shared/types/memory.ts:21-41` (add `applicability` to `MemoryDTO`)
- Modify: `server/services/memory.ts:55` (`toDTO`), `:411-425` (`searchMemories`), `:512-525` (`listMemories`)
- Test: `test/memory-applicability.db.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `memories.applicability` column (`text`, not null, default `'project'`); `MemoryDTO.applicability: MemoryApplicability`; `export type MemoryApplicability = 'global' | 'project'` from `shared/types/memory`.

- [ ] **Step 1: Write the failing test**

Create `test/memory-applicability.db.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { createMemory, listMemories } from '../server/services/memory'
import { sql } from 'drizzle-orm'

describe('memory applicability', () => {
  beforeEach(async () => {
    await useDb().execute(sql`delete from memories where content like 'APPLIC-TEST%'`)
  })

  it('defaults to project', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST default', project: 'alpha' })
    expect(m.applicability).toBe('project')
  })

  it('hides a project-scoped memory from another project', async () => {
    await createMemory({ scope: 'user', content: 'APPLIC-TEST alpha-only', project: 'alpha' })
    const found = await listMemories({ project: 'beta', limit: 100 })
    expect(found.some(m => m.content === 'APPLIC-TEST alpha-only')).toBe(false)
  })

  it('shows a GLOBAL memory when querying a different project', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST travels', project: 'alpha' })
    await useDb().update(memories).set({ applicability: 'global' }).where(sql`${memories.id} = ${m.id}`)
    const found = await listMemories({ project: 'beta', limit: 100 })
    expect(found.some(x => x.content === 'APPLIC-TEST travels')).toBe(true)
  })

  it('still shows a global memory when querying its own project', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST own', project: 'alpha' })
    await useDb().update(memories).set({ applicability: 'global' }).where(sql`${memories.id} = ${m.id}`)
    const found = await listMemories({ project: 'alpha', limit: 100 })
    expect(found.some(x => x.content === 'APPLIC-TEST own')).toBe(true)
  })

  it('project:null still means "memories with no project", not "global"', async () => {
    const m = await createMemory({ scope: 'user', content: 'APPLIC-TEST nulled', project: 'alpha' })
    await useDb().update(memories).set({ applicability: 'global' }).where(sql`${memories.id} = ${m.id}`)
    const found = await listMemories({ project: null, limit: 100 })
    expect(found.some(x => x.content === 'APPLIC-TEST nulled')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- memory-applicability`
Expected: FAIL — `applicability` does not exist on the type or the table.

- [ ] **Step 3: Add the column to the schema**

In `server/db/schema/memories.ts`, add to the `pgTable` body, immediately after `confidence`:

```ts
  /** Does this fact travel across projects? `project` above records where it was LEARNED
   *  (provenance); this records where it APPLIES. Retrieval ORs them together. */
  applicability: text('applicability').notNull().default('project'),
```

- [ ] **Step 4: Generate and run the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Confirm the generated file is `server/db/migrations/0046_*.sql` and contains only `ALTER TABLE ... ADD COLUMN`. If it contains any `DROP`, stop and fix the schema instead.

- [ ] **Step 5: Add the type**

In `shared/types/memory.ts`, above `MemoryDTO`:

```ts
export type MemoryApplicability = 'global' | 'project'
```

and inside `MemoryDTO`, after `project: string | null`:

```ts
  /** 'global' = this fact travels across projects; 'project' = it is bound to `project`. */
  applicability: MemoryApplicability
```

- [ ] **Step 6: Map it in `toDTO`**

In `server/services/memory.ts`, inside `toDTO` (line ~55), add to the returned object alongside `project`:

```ts
    applicability: (r.applicability === 'global' ? 'global' : 'project') as MemoryApplicability,
```

Add `MemoryApplicability` to the existing `import type { ... } from '../../shared/types/memory'` on line 5.

- [ ] **Step 7: Change the two project filters**

In `server/services/memory.ts`, `searchMemories` (~line 419) currently reads:

```ts
  if (opts.project !== undefined) {
    if (opts.project === null) baseConditions.push(isNull(memories.project))
    else baseConditions.push(eq(memories.project, opts.project))
  }
```

Replace the `else` branch only — a `null` project still means "memories with no project", which is a different question:

```ts
  if (opts.project !== undefined) {
    if (opts.project === null) baseConditions.push(isNull(memories.project))
    // A global memory travels: it is in scope for EVERY project, not just the one it was
    // learned in. Only project-bound memories are filtered by provenance.
    else baseConditions.push(or(eq(memories.applicability, 'global'), eq(memories.project, opts.project))!)
  }
```

Make the identical change in `listMemories` (~line 518). Add `or` to the `drizzle-orm` import at the top of the file.

- [ ] **Step 8: Run the tests**

Run: `pnpm test:db -- memory-applicability`
Expected: PASS (5 tests).

- [ ] **Step 9: Verify the tests can fail**

Temporarily revert the `or(...)` in `listMemories` back to `eq(memories.project, opts.project)`. Run the test again — "shows a GLOBAL memory when querying a different project" must FAIL. Restore it.

- [ ] **Step 10: Run the gates and commit**

```bash
pnpm test && pnpm typecheck
git add server/db/schema/memories.ts server/db/migrations shared/types/memory.ts server/services/memory.ts test/memory-applicability.db.test.ts
git commit -m "feat(memory): applicability axis — a global memory travels across projects

project records where a fact was LEARNED; 69 of 74 user-scope memories carry
one by accident of which session revealed them. applicability records where it
APPLIES. Retrieval ORs them, so a universal preference filed under 3d-rpg is
visible everywhere while a finances memory stays bound to its project."
```

---

### Task 2: Resident tier + retrieval counters

`resident` is a smaller, stricter set than `global`: facts worth tokens on *every* turn. Counters let it nominate itself from usage instead of hand-curation.

**Files:**
- Modify: `server/db/schema/memories.ts`
- Create: `server/db/migrations/0047_*.sql` (via `pnpm db:generate`)
- Modify: `shared/types/memory.ts`, `server/services/memory.ts`
- Test: `test/memory-resident.db.test.ts`

**Interfaces:**
- Consumes: `memories.applicability` (Task 1).
- Produces:
  - `memories.resident` (boolean, not null, default false), `memories.retrieval_count` (integer, not null, default 0), `memories.last_retrieved_at` (timestamptz, null)
  - `MemoryDTO.resident: boolean`
  - `listResidentMemories(): Promise<MemoryDTO[]>` — exported from `server/services/memory.ts`
  - `recordRetrievals(ids: string[]): Promise<void>` — exported from `server/services/memory.ts`, one grouped UPDATE

- [ ] **Step 1: Write the failing test**

Create `test/memory-resident.db.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { createMemory, listResidentMemories, recordRetrievals } from '../server/services/memory'
import { sql, inArray } from 'drizzle-orm'

const mk = (content: string, project = 'alpha') =>
  createMemory({ scope: 'user', content, project })

describe('resident tier', () => {
  beforeEach(async () => {
    await useDb().execute(sql`delete from memories where content like 'RES-TEST%'`)
  })

  it('defaults to non-resident', async () => {
    const m = await mk('RES-TEST plain')
    expect(m.resident).toBe(false)
  })

  it('listResidentMemories returns only resident rows', async () => {
    const a = await mk('RES-TEST pinned')
    await mk('RES-TEST unpinned')
    await useDb().update(memories)
      .set({ resident: true, applicability: 'global' })
      .where(sql`${memories.id} = ${a.id}`)
    const res = await listResidentMemories()
    const contents = res.map(m => m.content)
    expect(contents).toContain('RES-TEST pinned')
    expect(contents).not.toContain('RES-TEST unpinned')
  })

  it('refuses a resident memory that is not global', async () => {
    const m = await mk('RES-TEST bad')
    await expect(
      useDb().update(memories).set({ resident: true }).where(sql`${memories.id} = ${m.id}`)
    ).rejects.toThrow()
  })

  it('recordRetrievals increments every id in ONE statement', async () => {
    const a = await mk('RES-TEST count-a')
    const b = await mk('RES-TEST count-b')
    await recordRetrievals([a.id, b.id])
    await recordRetrievals([a.id])
    const rows = await useDb().select().from(memories).where(inArray(memories.id, [a.id, b.id]))
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(a.id)!.retrievalCount).toBe(2)
    expect(byId.get(b.id)!.retrievalCount).toBe(1)
    expect(byId.get(a.id)!.lastRetrievedAt).not.toBeNull()
  })

  it('recordRetrievals([]) is a no-op and does not throw', async () => {
    await expect(recordRetrievals([])).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- memory-resident`
Expected: FAIL — `listResidentMemories` is not exported.

- [ ] **Step 3: Add the columns and the constraint**

In `server/db/schema/memories.ts`, after the `applicability` column:

```ts
  /** In EVERY prompt. A much smaller set than `applicability='global'` — collapsing the two
   *  either starves the global tier or blows the context budget. */
  resident: boolean('resident').notNull().default(false),
  /** How often this memory has entered an assembled context, and when it last did.
   *  Written batched by the assembler; feeds resident self-nomination. */
  retrievalCount: integer('retrieval_count').notNull().default(0),
  lastRetrievedAt: timestamp('last_retrieved_at', { withTimezone: true }),
```

Add `boolean` and `integer` to the `drizzle-orm/pg-core` import.

In the same file's index/constraint array (the `(t) => [ ... ]` block), add:

```ts
  check('memories_resident_implies_global', sql`not ${t.resident} or ${t.applicability} = 'global'`),
  index('memories_resident_idx').on(t.resident).where(sql`${t.resident}`),
```

Add `check` to the `drizzle-orm/pg-core` import.

- [ ] **Step 4: Generate and run the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Confirm `0047_*.sql` contains only `ADD COLUMN`, `ADD CONSTRAINT` and `CREATE INDEX`.

- [ ] **Step 5: Add the DTO field**

In `shared/types/memory.ts`, inside `MemoryDTO` after `applicability`:

```ts
  /** Always injected into the agent's context, not merely retrievable. Implies applicability 'global'. */
  resident: boolean
```

In `server/services/memory.ts` `toDTO`, add: `resident: r.resident,`

- [ ] **Step 6: Implement the two service functions**

Append to `server/services/memory.ts`:

```ts
/**
 * The resident tier: facts injected into EVERY agent turn.
 *
 * Deliberately unfiltered by project — resident implies global (DB check constraint).
 * `reviewed` is not optional here: this lands in every prompt with no agent decision behind
 * it, so unreviewed enrichment output must never reach it.
 */
export async function listResidentMemories(): Promise<MemoryDTO[]> {
  const db = useDb()
  const rows = await db.select().from(memories)
    .where(and(live(), eq(memories.resident, true), isNotNull(memories.reviewedAt)))
    .orderBy(sql`${memories.retrievalCount} desc`, memories.createdAt)
  return rows.map(r => toDTO(r))
}

/**
 * Bump retrieval counters for every memory that entered a context.
 *
 * ONE grouped statement, never N — this fires on every agent turn, and a per-memory update
 * would put a write amplification of `limit` on the hot path.
 */
export async function recordRetrievals(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = useDb()
  await db.update(memories)
    .set({ retrievalCount: sql`${memories.retrievalCount} + 1`, lastRetrievedAt: new Date() })
    .where(inArray(memories.id, ids))
}
```

Ensure `isNotNull` and `inArray` are in the `drizzle-orm` import at the top of the file.

- [ ] **Step 7: Run the tests**

Run: `pnpm test:db -- memory-resident`
Expected: PASS (5 tests).

- [ ] **Step 8: Verify the tests can fail**

Change `recordRetrievals` to increment by `0` instead of `1`. The count test must FAIL. Restore. Then drop `isNotNull(memories.reviewedAt)` from `listResidentMemories` and confirm no test catches it — **if none does, add one**, because an unreviewed memory reaching every prompt is the exact failure this guard exists for.

- [ ] **Step 9: Run the gates and commit**

```bash
pnpm test && pnpm typecheck
git add server/db/schema/memories.ts server/db/migrations shared/types/memory.ts server/services/memory.ts test/memory-resident.db.test.ts
git commit -m "feat(memory): resident tier + retrieval counters

resident is a stricter, smaller set than global — facts worth tokens on every
turn. A DB check constraint enforces resident => global. Counters are written
batched by the assembler so the tier can nominate itself from cross-project
usage rather than hand-curation."
```

---

### Task 3: Budget math (pure, no DB)

The eviction policy is the part most likely to silently truncate Bridget, so it lives alone in a pure module where it can be exhaustively tested.

**Files:**
- Create: `server/lib/agent/budget.ts`
- Test: `test/agent-budget.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` from `server/lib/chunking/chunk-markdown.ts`.
- Produces:
  - `export interface Tier { name: string, text: string, tokens: number }`
  - `export class ResidentOverflowError extends Error`
  - `export function tier(name: string, text: string): Tier`
  - `export function fitBudget(input: { fixed: Tier[], turns: Tier[], retrieved: Tier[], budget: number, turnFloorRatio?: number }): { kept: { fixed: Tier[], turns: Tier[], retrieved: Tier[] }, used: number, droppedTurns: number, droppedRetrieved: number }`
  - `TURN_FLOOR_RATIO = 0.4`

- [ ] **Step 1: Write the failing test**

Create `test/agent-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fitBudget, tier, ResidentOverflowError, TURN_FLOOR_RATIO } from '../server/lib/agent/budget'

// estimateTokens is chars/3.8 rounded up, so 38 chars ≈ 10 tokens.
const chars = (n: number) => 'x'.repeat(n)
const t = (name: string, n: number) => tier(name, chars(n))

describe('fitBudget', () => {
  it('keeps everything when it all fits', () => {
    const r = fitBudget({ fixed: [t('resident', 38)], turns: [t('turn', 38)], retrieved: [t('mem', 38)], budget: 1000 })
    expect(r.kept.fixed).toHaveLength(1)
    expect(r.kept.turns).toHaveLength(1)
    expect(r.kept.retrieved).toHaveLength(1)
    expect(r.droppedTurns).toBe(0)
    expect(r.droppedRetrieved).toBe(0)
  })

  it('evicts retrieved memories before turns', () => {
    const r = fitBudget({
      fixed: [t('resident', 38)],                       // 10
      turns: [t('turn1', 38), t('turn2', 38)],          // 10 + 10
      retrieved: [t('m1', 38), t('m2', 38)],            // 10 + 10
      budget: 40
    })
    expect(r.kept.turns).toHaveLength(2)
    expect(r.droppedRetrieved).toBeGreaterThan(0)
    expect(r.droppedTurns).toBe(0)
  })

  it('never evicts a fixed tier', () => {
    const r = fitBudget({ fixed: [t('resident', 380)], turns: [], retrieved: [t('m', 380)], budget: 110 })
    expect(r.kept.fixed).toHaveLength(1)
    expect(r.kept.retrieved).toHaveLength(0)
  })

  it('reserves a floor for turns that retrieval cannot eat', () => {
    // budget 100 -> turn floor is 40 tokens. Retrieval must not push turns below it.
    const r = fitBudget({
      fixed: [],
      turns: [t('turn1', 76), t('turn2', 76)],   // 20 + 20 = 40, exactly the floor
      retrieved: Array.from({ length: 20 }, (_, i) => t(`m${i}`, 380)),
      budget: 100
    })
    const turnTokens = r.kept.turns.reduce((a, x) => a + x.tokens, 0)
    expect(turnTokens).toBeGreaterThanOrEqual(Math.floor(100 * TURN_FLOOR_RATIO))
  })

  it('keeps the MOST RECENT turns when turns must be trimmed', () => {
    // turns arrive oldest-first; trimming drops from the front.
    const r = fitBudget({
      fixed: [],
      turns: [tier('old', chars(380)), tier('mid', chars(380)), tier('new', chars(380))],
      turnFloorRatio: 1,
      retrieved: [],
      budget: 200
    })
    expect(r.kept.turns.map(x => x.name)).toEqual(['mid', 'new'])
    expect(r.droppedTurns).toBe(1)
  })

  it('throws when the fixed tiers alone exceed the budget', () => {
    expect(() => fitBudget({ fixed: [t('resident', 3800)], turns: [], retrieved: [], budget: 100 }))
      .toThrow(ResidentOverflowError)
  })

  it('reports used tokens as the sum of what it kept', () => {
    const r = fitBudget({ fixed: [t('a', 38)], turns: [t('b', 38)], retrieved: [t('c', 38)], budget: 1000 })
    const sum = [...r.kept.fixed, ...r.kept.turns, ...r.kept.retrieved].reduce((a, x) => a + x.tokens, 0)
    expect(r.used).toBe(sum)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/agent-budget.test.ts`
Expected: FAIL — cannot resolve `../server/lib/agent/budget`.

- [ ] **Step 3: Implement the module**

Create `server/lib/agent/budget.ts`:

```ts
import { estimateTokens } from '../chunking/chunk-markdown'

/** A labelled block of prompt text with its estimated cost. */
export interface Tier { name: string, text: string, tokens: number }

export function tier(name: string, text: string): Tier {
  return { name, text, tokens: estimateTokens(text) }
}

/**
 * Thrown when the never-evicted tiers alone do not fit. This is a configuration error, not a
 * runtime condition to absorb: a self-nominating resident tier CAN grow past its allocation,
 * and silently truncating it would degrade every turn with nothing in the logs.
 */
export class ResidentOverflowError extends Error {
  constructor(public readonly fixedTokens: number, public readonly budget: number) {
    super(`fixed context tiers need ${fixedTokens} tokens but the budget is ${budget}`)
    this.name = 'ResidentOverflowError'
  }
}

/** Share of the total budget that recent turns are guaranteed, whatever retrieval wants. */
export const TURN_FLOOR_RATIO = 0.4

export interface FitInput {
  /** Never evicted: resident facts, live state, working summary. */
  fixed: Tier[]
  /** Oldest-first. Trimmed from the FRONT — the tail is what keeps the session coherent. */
  turns: Tier[]
  /** Best-first. Evicted from the BACK, before any turn is touched. */
  retrieved: Tier[]
  budget: number
  turnFloorRatio?: number
}

export interface FitResult {
  kept: { fixed: Tier[], turns: Tier[], retrieved: Tier[] }
  used: number
  droppedTurns: number
  droppedRetrieved: number
}

export function fitBudget(input: FitInput): FitResult {
  const { fixed, turns, retrieved, budget } = input
  const floorRatio = input.turnFloorRatio ?? TURN_FLOOR_RATIO

  const fixedTokens = fixed.reduce((a, t) => a + t.tokens, 0)
  if (fixedTokens > budget) throw new ResidentOverflowError(fixedTokens, budget)

  const turnFloor = Math.floor(budget * floorRatio)
  let remaining = budget - fixedTokens

  // Turns first, newest-first, up to whatever is left. Keeping the tail is the point.
  const keptTurnsReversed: Tier[] = []
  let turnTokens = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (turnTokens + t.tokens > remaining) break
    keptTurnsReversed.push(t)
    turnTokens += t.tokens
  }
  const keptTurns = keptTurnsReversed.reverse()
  remaining -= turnTokens

  // Retrieval gets what is left, but may never push turns below their floor.
  const retrievalCeiling = Math.max(0, Math.min(remaining, budget - fixedTokens - Math.min(turnFloor, turnTokens)))
  const keptRetrieved: Tier[] = []
  let retrievedTokens = 0
  for (const t of retrieved) {
    if (retrievedTokens + t.tokens > retrievalCeiling) continue
    keptRetrieved.push(t)
    retrievedTokens += t.tokens
  }

  return {
    kept: { fixed, turns: keptTurns, retrieved: keptRetrieved },
    used: fixedTokens + turnTokens + retrievedTokens,
    droppedTurns: turns.length - keptTurns.length,
    droppedRetrieved: retrieved.length - keptRetrieved.length
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/agent-budget.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify the tests can fail**

Change the turn loop to iterate forward (`for (let i = 0; i < turns.length; i++)`) instead of backward. "keeps the MOST RECENT turns" must FAIL. Restore. Then remove the `ResidentOverflowError` throw and confirm that test FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm typecheck
git add server/lib/agent/budget.ts test/agent-budget.test.ts
git commit -m "feat(agent): pure budget fitting for context assembly

Eviction order is the whole policy: fixed tiers never go, retrieval is trimmed
first, and recent turns keep a 40% floor because in a persistent session the
tail is what makes the agent coherent — a ranker that CAN starve it eventually
will. Fixed tiers overflowing throws rather than silently truncating."
```

---

### Task 3b: Salience ranking

Spec §4.3. `searchMemories` orders by semantic relevance alone, which knows nothing about contradictions, recency or trust. This is the re-ranking pass the assembler applies to search results before they compete for budget.

**Files:**
- Create: `server/lib/agent/salience.ts`
- Test: `test/agent-salience.test.ts`

**Interfaces:**
- Consumes: `MemoryDTO` (Tasks 1–2, now carrying `applicability` and `resident`).
- Produces:
  - `export interface SalienceFeatures { relevance: number, ageDays: number, projectMatch: boolean, global: boolean, contradicted: boolean, reviewed: boolean }`
  - `export function extractFeatures(m: MemoryDTO, ctx: { projectSlug?: string, now: Date, contradictedIds: Set<string> }): SalienceFeatures`
  - `export function relevanceScore(f: SalienceFeatures): number`
  - `export function rankForContext(memories: MemoryDTO[], ctx: { projectSlug?: string, now: Date, contradictedIds: Set<string> }): MemoryDTO[]`
  - `export const WEIGHTS` — exported so a test can assert each feature's contribution in isolation

- [ ] **Step 1: Write the failing test**

Create `test/agent-salience.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractFeatures, relevanceScore, rankForContext, WEIGHTS } from '../server/lib/agent/salience'
import type { MemoryDTO } from '../shared/types/memory'

const NOW = new Date('2026-09-23T00:00:00.000Z')

const mem = (id: string, over: Partial<MemoryDTO> = {}): MemoryDTO => ({
  id, scope: 'agent', content: `memory ${id}`, tags: [], source: null, confidence: null,
  project: null, applicability: 'project', resident: false, sessionId: null, enrichedAt: null,
  reviewedAt: '2026-09-01T00:00:00.000Z', sourceDate: '2026-09-20T00:00:00.000Z',
  createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
  relevance: 0.5, ...over
})

const ctx = (over: Partial<Parameters<typeof extractFeatures>[1]> = {}) =>
  ({ now: NOW, contradictedIds: new Set<string>(), ...over })

describe('extractFeatures', () => {
  it('reads age in days from sourceDate', () => {
    expect(extractFeatures(mem('a'), ctx()).ageDays).toBe(3)
  })

  it('falls back to createdAt when sourceDate is null', () => {
    expect(extractFeatures(mem('a', { sourceDate: null }), ctx()).ageDays).toBe(3)
  })

  it('marks a project match', () => {
    const f = extractFeatures(mem('a', { project: 'mymind' }), ctx({ projectSlug: 'mymind' }))
    expect(f.projectMatch).toBe(true)
  })

  it('marks an unreviewed memory as untrusted', () => {
    expect(extractFeatures(mem('a', { reviewedAt: null }), ctx()).reviewed).toBe(false)
  })

  it('marks a contradicted memory', () => {
    expect(extractFeatures(mem('a'), ctx({ contradictedIds: new Set(['a']) })).contradicted).toBe(true)
  })
})

describe('relevanceScore — each weight in isolation', () => {
  const base = extractFeatures(mem('a'), ctx())

  it('rises with semantic relevance', () => {
    expect(relevanceScore({ ...base, relevance: 0.9 })).toBeGreaterThan(relevanceScore({ ...base, relevance: 0.1 }))
  })

  it('rewards a contradiction — it is the most important thing to surface', () => {
    expect(relevanceScore({ ...base, contradicted: true })).toBeGreaterThan(relevanceScore(base))
    expect(WEIGHTS.contradicted).toBeGreaterThan(0)
  })

  it('penalises an unreviewed memory', () => {
    expect(relevanceScore({ ...base, reviewed: false })).toBeLessThan(relevanceScore(base))
  })

  it('prefers recent over old, all else equal', () => {
    expect(relevanceScore({ ...base, ageDays: 1 })).toBeGreaterThan(relevanceScore({ ...base, ageDays: 900 }))
  })

  it('rewards a project match', () => {
    expect(relevanceScore({ ...base, projectMatch: true })).toBeGreaterThan(relevanceScore(base))
  })
})

describe('rankForContext', () => {
  it('puts a contradicted memory above a merely relevant one', () => {
    const ranked = rankForContext(
      [mem('plain', { relevance: 0.8 }), mem('bad', { relevance: 0.4 })],
      ctx({ contradictedIds: new Set(['bad']) })
    )
    expect(ranked[0]!.id).toBe('bad')
  })

  it('is stable for equal scores — no arbitrary reordering between turns', () => {
    const input = [mem('a'), mem('b'), mem('c')]
    expect(rankForContext(input, ctx()).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns every input memory, dropping none', () => {
    expect(rankForContext([mem('a'), mem('b')], ctx())).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/agent-salience.test.ts`
Expected: FAIL — cannot resolve `../server/lib/agent/salience`.

- [ ] **Step 3: Implement**

Create `server/lib/agent/salience.ts`:

```ts
import type { MemoryDTO } from '../../../shared/types/memory'

export interface SalienceFeatures {
  relevance: number
  ageDays: number
  projectMatch: boolean
  global: boolean
  contradicted: boolean
  reviewed: boolean
}

/**
 * Explicit constants, NOT a fitted model.
 *
 * There are 45 hand labels in `scripts/data/memory-labels-2026-09-22.jsonl`. A ranker learned
 * from 45 examples would be fitting noise, and weights you can read and argue with beat a model
 * you cannot at this scale. Measured on those labels, an LLM's 4-level value rubric predicted
 * keep-vs-stale at AUC 0.55 — chance — which is why no feature here is a model's opinion of
 * importance. Every one is observable structure.
 */
export const WEIGHTS = {
  relevance: 1.0,
  contradicted: 0.5,
  projectMatch: 0.2,
  global: 0.05,
  unreviewed: -0.3,
  recency: 0.15
} as const

const DAY_MS = 86_400_000

export function extractFeatures(
  m: MemoryDTO,
  ctx: { projectSlug?: string, now: Date, contradictedIds: Set<string> }
): SalienceFeatures {
  const dateStr = m.sourceDate ?? m.createdAt
  const ageDays = Math.max(0, Math.floor((ctx.now.getTime() - new Date(dateStr).getTime()) / DAY_MS))
  return {
    relevance: m.relevance ?? 0,
    ageDays,
    projectMatch: !!ctx.projectSlug && m.project === ctx.projectSlug,
    global: m.applicability === 'global',
    contradicted: ctx.contradictedIds.has(m.id),
    reviewed: m.reviewedAt !== null
  }
}

export function relevanceScore(f: SalienceFeatures): number {
  // Half-life of ~90 days: recent facts win ties, old ones are damped, nothing is excluded
  // on age alone — an old convention can still be exactly right.
  const recency = 1 / (1 + f.ageDays / 90)
  return (
    WEIGHTS.relevance * f.relevance
    + WEIGHTS.recency * recency
    + (f.contradicted ? WEIGHTS.contradicted : 0)
    + (f.projectMatch ? WEIGHTS.projectMatch : 0)
    + (f.global ? WEIGHTS.global : 0)
    + (f.reviewed ? 0 : WEIGHTS.unreviewed)
  )
}

/** Stable sort: equal scores keep input order, so context does not reshuffle between turns. */
export function rankForContext(
  memories: MemoryDTO[],
  ctx: { projectSlug?: string, now: Date, contradictedIds: Set<string> }
): MemoryDTO[] {
  return memories
    .map((m, i) => ({ m, i, score: relevanceScore(extractFeatures(m, ctx)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.m)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/agent-salience.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Verify the tests can fail**

Set `WEIGHTS.contradicted` to `0`. "puts a contradicted memory above a merely relevant one" must FAIL. Restore. Then change the sort tie-break to `a.i - b.i` → `b.i - a.i`; the stability test must FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
pnpm test && pnpm typecheck
git add server/lib/agent/salience.ts test/agent-salience.test.ts
git commit -m "feat(agent): structural salience ranking for context retrieval

Semantic relevance alone knows nothing about contradictions, recency or trust.
Weights are explicit constants rather than fitted — 45 hand labels would fit
noise, and an LLM value rubric measured AUC 0.55 (chance) at exactly this job.
A contradicted memory outranks a merely relevant one: it is the most damaging
thing in the store because agents act on it confidently."
```

---

### Task 4: The assembler

Replaces the `buildLiveContext` + `buildMemoryContext` pair that `server/api/voice/ws.ts` passes into `handleTurn`.

**Files:**
- Create: `server/lib/agent/assemble.ts`
- Modify: `server/api/voice/ws.ts:15` (import), `:184`, `:195` (call sites)
- Test: `test/agent-assemble.test.ts`

**Interfaces:**
- Consumes: `fitBudget`, `tier`, `ResidentOverflowError` (Task 3); `rankForContext` (Task 3b); `listResidentMemories`, `recordRetrievals` (Task 2); `buildLiveContext`, `searchMemories` (existing).
- Produces:
  - `export interface AssembledContext { context: string, usedMemoryIds: string[], used: number, droppedTurns: number }`
  - `export async function assembleContext(input: AssembleInput): Promise<AssembledContext>`
  - `export function synthesiseQuery(summary: string | null, liveState: string): string`
  - `export const DEFAULT_CONTEXT_BUDGET = 6000`

- [ ] **Step 1: Write the failing test**

Create `test/agent-assemble.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { assembleContext, synthesiseQuery } from '../server/lib/agent/assemble'
import type { MemoryDTO } from '../shared/types/memory'

const mem = (id: string, content: string, over: Partial<MemoryDTO> = {}): MemoryDTO => ({
  id, scope: 'user', content, tags: [], source: null, confidence: null, project: null,
  applicability: 'global', resident: false, sessionId: null, enrichedAt: null,
  reviewedAt: '2026-09-01T00:00:00.000Z', sourceDate: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...over
})

const deps = (over: Partial<Parameters<typeof assembleContext>[0]['deps']> = {}) => ({
  listResident: async () => [] as MemoryDTO[],
  search: async () => [] as MemoryDTO[],
  liveContext: async () => '',
  summary: async () => null as string | null,
  recordRetrievals: vi.fn(async () => {}),
  ...over
})

describe('assembleContext', () => {
  it('always includes resident memories, even with no user text', async () => {
    const r = await assembleContext({
      userText: '', budget: 4000,
      deps: deps({ listResident: async () => [mem('r1', 'Tony rejects time-based estimates', { resident: true })] })
    })
    expect(r.context).toContain('Tony rejects time-based estimates')
  })

  it('searches with the user text when there is one', async () => {
    const search = vi.fn(async () => [mem('m1', 'a retrieved fact')])
    await assembleContext({ userText: 'how long will this take', budget: 4000, deps: deps({ search }) })
    expect(search.mock.calls[0]![0]).toBe('how long will this take')
  })

  it('synthesises a query from state on a proactive turn', async () => {
    const search = vi.fn(async () => [] as MemoryDTO[])
    await assembleContext({
      userText: '', budget: 4000,
      deps: deps({ search, summary: async () => 'Tony is debugging the deploy', liveContext: async () => 'Active projects: mymind.' })
    })
    expect(search).toHaveBeenCalled()
    expect(search.mock.calls[0]![0]).toContain('Tony is debugging the deploy')
  })

  it('does not search at all when there is neither user text nor state', async () => {
    const search = vi.fn(async () => [] as MemoryDTO[])
    await assembleContext({ userText: '', budget: 4000, deps: deps({ search }) })
    expect(search).not.toHaveBeenCalled()
  })

  it('records retrievals for the memories it actually kept, batched once', async () => {
    const recordRetrievals = vi.fn(async () => {})
    const r = await assembleContext({
      userText: 'q', budget: 4000,
      deps: deps({ search: async () => [mem('m1', 'kept one'), mem('m2', 'kept two')], recordRetrievals })
    })
    expect(recordRetrievals).toHaveBeenCalledTimes(1)
    expect(recordRetrievals.mock.calls[0]![0].sort()).toEqual(['m1', 'm2'])
    expect(r.usedMemoryIds.sort()).toEqual(['m1', 'm2'])
  })

  it('does not record a retrieval for a memory the budget evicted', async () => {
    const recordRetrievals = vi.fn(async () => {})
    const big = 'y'.repeat(40000)
    const r = await assembleContext({
      userText: 'q', budget: 200,
      deps: deps({ search: async () => [mem('m1', big)], recordRetrievals })
    })
    expect(r.usedMemoryIds).toEqual([])
    expect(recordRetrievals).not.toHaveBeenCalled()
  })

  it('never throws — a failing dependency degrades to whatever else assembled', async () => {
    const r = await assembleContext({
      userText: 'q', budget: 4000,
      deps: deps({
        search: async () => { throw new Error('pgvector down') },
        listResident: async () => [mem('r1', 'resident survives', { resident: true })]
      })
    })
    expect(r.context).toContain('resident survives')
  })
})

describe('synthesiseQuery', () => {
  it('combines summary and live state', () => {
    expect(synthesiseQuery('debugging deploy', 'Active projects: mymind.')).toContain('debugging deploy')
    expect(synthesiseQuery('debugging deploy', 'Active projects: mymind.')).toContain('mymind')
  })

  it('returns empty when there is no state at all', () => {
    expect(synthesiseQuery(null, '')).toBe('')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/agent-assemble.test.ts`
Expected: FAIL — cannot resolve `../server/lib/agent/assemble`.

- [ ] **Step 3: Implement the assembler**

Create `server/lib/agent/assemble.ts`:

```ts
import { fitBudget, tier, ResidentOverflowError, type Tier } from './budget'
import { rankForContext } from './salience'
import { buildLiveContext } from './context'
import { listResidentMemories, recordRetrievals as realRecordRetrievals, searchMemories } from '../../services/memory'
import { useDb } from '../../db'
import { conversations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import type { MemoryDTO } from '../../../shared/types/memory'

export const DEFAULT_CONTEXT_BUDGET = 6000

export interface AssembleDeps {
  listResident?: () => Promise<MemoryDTO[]>
  search?: (q: string) => Promise<MemoryDTO[]>
  liveContext?: (now: Date) => Promise<string>
  summary?: (conversationId: string) => Promise<string | null>
  recordRetrievals?: (ids: string[]) => Promise<void>
}

export interface AssembleInput {
  /** The user's message. EMPTY on a proactive turn — see synthesiseQuery. */
  userText: string
  conversationId?: string
  /** Project SLUG, not id — `memories.project` stores the slug, and that is what ranking compares. */
  projectSlug?: string
  /** Oldest-first prompt-ready turn blocks, if the caller is managing history text. */
  turns?: Tier[]
  budget?: number
  now?: Date
  deps?: AssembleDeps
}

export interface AssembledContext {
  context: string
  usedMemoryIds: string[]
  used: number
  droppedTurns: number
}

/**
 * A proactive turn has no user message, so there is nothing to embed against — that is the
 * core problem with bolting proactivity onto query-driven retrieval. The session's own rolling
 * summary is a running description of what Tony is doing, which is exactly the query a
 * proactive agent needs and never has. Live state fills in when there is no summary yet.
 */
export function synthesiseQuery(summary: string | null, liveState: string): string {
  return [summary?.trim(), liveState.trim()].filter(Boolean).join('\n').trim()
}

async function loadSummary(conversationId: string): Promise<string | null> {
  const [row] = await useDb().select({ summary: conversations.summary })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  return row?.summary ?? null
}

/** Best-effort: a failing tier degrades to empty rather than losing the whole context. */
async function safe<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn(`[assembleContext] ${label} failed:`, err)
    return fallback
  }
}

export async function assembleContext(input: AssembleInput): Promise<AssembledContext> {
  const d = input.deps ?? {}
  const now = input.now ?? new Date()
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET

  const listResident = d.listResident ?? listResidentMemories
  const search = d.search ?? ((q: string) => searchMemories(q, { limit: 12, reviewed: true }))
  const liveContext = d.liveContext ?? buildLiveContext
  const summaryOf = d.summary ?? loadSummary
  const record = d.recordRetrievals ?? realRecordRetrievals

  const [resident, liveState, summary] = await Promise.all([
    safe(() => listResident(), [] as MemoryDTO[], 'resident'),
    safe(() => liveContext(now), '', 'liveState'),
    input.conversationId
      ? safe(() => summaryOf(input.conversationId!), null as string | null, 'summary')
      : Promise.resolve(null)
  ])

  const query = input.userText.trim() || synthesiseQuery(summary, liveState)
  const found = query ? await safe(() => search(query), [] as MemoryDTO[], 'search') : []

  // Resident memories are already in the fixed tier; never pay for them twice.
  const residentIds = new Set(resident.map(m => m.id))
  const deduped = found.filter(m => !residentIds.has(m.id))

  // Re-rank on structure before they compete for budget. Semantic relevance alone does not
  // know that one of these contradicts another memory, which is the thing most worth surfacing.
  const contradictedIds = new Set(
    deduped.flatMap(m => (m.relations ?? []).filter(r => r.type === 'contradicts' && r.status === 'active').map(() => m.id))
  )
  const retrieved = rankForContext(deduped, { projectSlug: input.projectSlug, now, contradictedIds })

  const fixed: Tier[] = []
  if (resident.length) {
    fixed.push(tier('resident', ['What you know about Tony:', ...resident.map(m => `- ${m.content}`)].join('\n')))
  }
  if (liveState) fixed.push(tier('live', liveState))
  if (summary) fixed.push(tier('summary', `Earlier in this conversation:\n${summary}`))

  const retrievedTiers = retrieved.map(m => tier(`mem:${m.id}`, `- ${m.content}`))

  let fit
  try {
    fit = fitBudget({ fixed, turns: input.turns ?? [], retrieved: retrievedTiers, budget })
  } catch (err) {
    if (!(err instanceof ResidentOverflowError)) throw err
    // The resident tier outgrew its allocation. Loud, but do not take the turn down with it:
    // drop retrieval entirely and let the caller's history stand.
    console.error('[assembleContext] resident tier overflow:', err.message)
    fit = fitBudget({ fixed: [], turns: input.turns ?? [], retrieved: [], budget })
  }

  const usedMemoryIds = fit.kept.retrieved.map(t => t.name.slice('mem:'.length))
  if (usedMemoryIds.length) await safe(() => record(usedMemoryIds), undefined, 'recordRetrievals')

  const blocks = [...fit.kept.fixed.map(t => t.text)]
  if (fit.kept.retrieved.length) {
    blocks.push([
      'Possibly relevant memories (background — may be stale or off-target; verify before relying on them):',
      ...fit.kept.retrieved.map(t => t.text)
    ].join('\n'))
  }

  return {
    context: blocks.filter(Boolean).join('\n\n'),
    usedMemoryIds,
    used: fit.used,
    droppedTurns: fit.droppedTurns
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/agent-assemble.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Wire it into the WebSocket turn path**

In `server/api/voice/ws.ts`, replace the line-15 import:

```ts
import { buildLiveContext } from '../../lib/agent/context'
import { assembleContext } from '../../lib/agent/assemble'
```

At both call sites (~line 184 and ~line 195), replace the `buildMemoryContext` dependency with an assembler-backed one. The existing `handleTurn`/`handleUtterance` options take `buildMemoryContext?: (userText: string) => Promise<string>`, so adapt rather than changing that interface:

```ts
const buildMemoryContext = async (userText: string) =>
  (await assembleContext({ userText, conversationId: s.conversationId })).context
```

Define it once alongside the existing `context` value in the handler scope, before the two call sites, and leave both call sites otherwise untouched.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Existing agent/voice tests must still pass — if any assert on the old `buildMemoryContext` output shape, update the assertion, not the assembler.

- [ ] **Step 7: Assert the budget estimate against reality (spec §4.4, §7.2)**

`estimateTokens` is `chars / 3.8`, a heuristic. If it drifts low, the assembler silently overfills and the model truncates Bridget mid-thought with nothing in the logs. Add to `test/agent-assemble.test.ts`:

```ts
describe('budget estimate fidelity', () => {
  // Guards the heuristic against real usage. `MessageUsage.contextTokens` (cycle 65) records
  // what a turn ACTUALLY cost; if this drifts, the assembler overfills and the model truncates
  // with nothing in the logs. Update the fixture from a real turn, never the tolerance.
  const SAMPLES: Array<{ text: string, actualTokens: number }> = [
    { text: 'Tony rejects time-based implementation estimates; prefers scoping by concrete work items.', actualTokens: 17 }
  ]

  it('estimates within 25% of measured usage', () => {
    for (const s of SAMPLES) {
      const est = tier('sample', s.text).tokens
      const ratio = est / s.actualTokens
      expect(ratio).toBeGreaterThan(0.75)
      expect(ratio).toBeLessThan(1.25)
    }
  })
})
```

Import `tier` from `../server/lib/agent/budget` at the top of the file. Populate `actualTokens` by running one real turn against the live model and reading `contextTokens` off the emitted usage event — **do not guess the number**; if you cannot measure it, say so in the handover rather than inventing a fixture.

- [ ] **Step 8: Verify the tests can fail**

Remove the `residentIds` de-duplication filter. Add a test asserting a resident memory returned by `search` appears only once in `context`; confirm it fails without the filter and passes with it.

- [ ] **Step 9: Commit**

```bash
git add server/lib/agent/assemble.ts server/api/voice/ws.ts test/agent-assemble.test.ts
git commit -m "feat(agent): one budgeted context assembler

Replaces the ad-hoc buildLiveContext + buildMemoryContext pair. Resident facts
and live state are fixed tiers; retrieval flexes. On a proactive turn there is
no user message to embed against, so the query is synthesised from the rolling
summary plus live state — that is the machinery proactivity needs and never has.
Retrieval counters are recorded only for memories that survived the budget."
```

---

### Task 5: Conversation epoch + `/clear`

`/clear` must make Bridget forget without deleting rows — cycle 68 established that a conversation is a tree and nothing is ever deleted.

**Files:**
- Modify: `server/db/schema/conversations.ts`
- Create: `server/db/migrations/0048_*.sql` (via `pnpm db:generate`)
- Modify: `server/services/conversation-path.ts:28` (`loadActivePath`)
- Create: `server/services/conversation-clear.ts`
- Test: `test/conversation-epoch.db.test.ts`

**Interfaces:**
- Consumes: `loadActivePath(conversationId)` (existing, returns `{ rows, branches }`).
- Produces:
  - `conversations.context_epoch_at` (timestamptz, null)
  - `loadActivePath(conversationId, opts?: { sinceEpoch?: boolean })` — `sinceEpoch: true` filters to messages at or after the epoch
  - `clearConversationContext(conversationId: string): Promise<void>` from `server/services/conversation-clear.ts`

- [ ] **Step 1: Write the failing test**

Create `test/conversation-epoch.db.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { loadActivePath } from '../server/services/conversation-path'
import { clearConversationContext } from '../server/services/conversation-clear'
import { eq } from 'drizzle-orm'

async function seed() {
  const db = useDb()
  const [c] = await db.insert(conversations)
    .values({ title: 'EPOCH-TEST', summary: 'a summary that must not survive /clear' })
    .returning()
  const [a] = await db.insert(conversationMessages)
    .values({ conversationId: c!.id, role: 'user', content: 'before clear', modality: 'text' }).returning()
  await db.update(conversations).set({ activeLeafId: a!.id }).where(eq(conversations.id, c!.id))
  return c!.id
}

describe('conversation epoch', () => {
  it('hides pre-epoch messages from the model path', async () => {
    const id = await seed()
    await clearConversationContext(id)
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows).toHaveLength(0)
  })

  it('KEEPS pre-epoch messages on the default (UI) path', async () => {
    const id = await seed()
    await clearConversationContext(id)
    const { rows } = await loadActivePath(id)
    expect(rows.map(r => r.content)).toContain('before clear')
  })

  it('resets the rolling summary — a clear that leaves it is a lie', async () => {
    const id = await seed()
    await clearConversationContext(id)
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id)).limit(1)
    expect(c!.summary).toBeNull()
    expect(c!.summaryEmbedding).toBeNull()
  })

  it('shows messages written AFTER the clear', async () => {
    const id = await seed()
    await clearConversationContext(id)
    await useDb().insert(conversationMessages)
      .values({ conversationId: id, role: 'user', content: 'after clear', modality: 'text' })
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows.map(r => r.content)).toEqual(['after clear'])
  })

  it('is a no-op on a conversation that was never cleared', async () => {
    const id = await seed()
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows.map(r => r.content)).toContain('before clear')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- conversation-epoch`
Expected: FAIL — `server/services/conversation-clear` does not exist.

- [ ] **Step 3: Add the column**

In `server/db/schema/conversations.ts`, after `activeLeafId`:

```ts
  /** `/clear` boundary. The MODEL reads only messages at or after this; the UI still shows
   *  everything and renders a divider here, so the two readers differ VISIBLY rather than
   *  silently (cycle 68's invariant is that they must never disagree unnoticed). */
  contextEpochAt: timestamp('context_epoch_at', { withTimezone: true }),
```

- [ ] **Step 4: Generate and run the migration**

```bash
pnpm db:generate && pnpm db:migrate
```

Confirm `0048_*.sql` is a single `ADD COLUMN`.

- [ ] **Step 5: Add the epoch filter to `loadActivePath`**

In `server/services/conversation-path.ts`, change the signature and the message query:

```ts
export async function loadActivePath(
  conversationId: string,
  opts: { sinceEpoch?: boolean } = {}
): Promise<{
  rows: Array<typeof conversationMessages.$inferSelect>
  branches: Map<string, BranchInfo>
}> {
  const db = useDb()

  const [conv] = await db.select({ leaf: conversations.activeLeafId, epoch: conversations.contextEpochAt })
    .from(conversations).where(sql`${conversations.id} = ${conversationId}`).limit(1)

  const epoch = opts.sinceEpoch ? conv?.epoch ?? null : null

  const rows = await db.select().from(conversationMessages)
    .where(epoch
      ? sql`${conversationMessages.conversationId} = ${conversationId} and ${conversationMessages.createdAt} >= ${epoch}`
      : sql`${conversationMessages.conversationId} = ${conversationId}`)
    .orderBy(conversationMessages.createdAt, conversationMessages.id)
```

Delete the now-duplicated second `const [conv] = ...` query further down the function, and replace its later uses of `conv.leaf` with the hoisted `conv?.leaf`. Leave the branch-index logic below untouched — it must still index the whole thread.

- [ ] **Step 6: Implement the clear**

Create `server/services/conversation-clear.ts`:

```ts
import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { conversations } from '../db/schema'

/**
 * `/clear` — make Bridget forget the transcript without deleting it.
 *
 * Rows are NOT deleted: cycle 68 established that a conversation is a tree and nothing is ever
 * removed (retry branches rather than truncates). An epoch keeps the transcript searchable via
 * cycle-13 session/message search and makes an accidental clear recoverable.
 *
 * The summary reset is not optional. The summary is DERIVED from the transcript, so wiping the
 * turns while leaving it means Bridget still remembers everything just cleared, compressed. A
 * /clear that does not reset the summary is a lie.
 *
 * Memories already graduated out of this conversation are untouched — that is the forgetting
 * ladder working as designed, not a leak.
 */
export async function clearConversationContext(conversationId: string): Promise<void> {
  await useDb().update(conversations)
    .set({ contextEpochAt: new Date(), summary: null, summaryEmbedding: null, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm test:db -- conversation-epoch`
Expected: PASS (5 tests).

- [ ] **Step 8: Verify the tests can fail**

Remove `summary: null` from the update. "resets the rolling summary" must FAIL. Restore. Then make the default path also filter by epoch; "KEEPS pre-epoch messages on the default (UI) path" must FAIL. Restore.

- [ ] **Step 9: Commit**

```bash
pnpm test && pnpm typecheck
git add server/db/schema/conversations.ts server/db/migrations server/services/conversation-path.ts server/services/conversation-clear.ts test/conversation-epoch.db.test.ts
git commit -m "feat(agent): /clear writes an epoch, and resets the summary with it

Rows are not deleted — cycle 68's tree invariant holds and the transcript stays
searchable. The model path filters by epoch; the UI path does not, so the two
readers differ visibly rather than silently. Resetting the summary is required:
it is derived from the transcript, so a clear that leaves it standing is a lie."
```

---

### Task 6: Enrichment over conversations

Enrichment reads `sessions` + `messages` only, so **talking to Bridget currently produces zero memories**. Without this, a persistent session accumulates forever and graduates nothing.

**Files:**
- Modify: `server/db/schema/mem-enrichment-state.ts`
- Create: `server/db/migrations/0049_*.sql` (via `pnpm db:generate`)
- Modify: `server/services/memory-enrich.ts`
- Test: `test/enrich-conversations.db.test.ts`

**Interfaces:**
- Consumes: `memories.applicability` (Task 1).
- Produces:
  - `mem_enrichment_state` primary key `(source_kind, source_id)`; `source_kind` is `'session' | 'conversation'`
  - `enrichConversations(opts?: { limit?: number }): Promise<{ conversationsProcessed: number, memoriesCreated: number }>` from `server/services/memory-enrich.ts`

- [ ] **Step 1: Write the failing test**

Create `test/enrich-conversations.db.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { useDb } from '../server/db'
import { conversations, conversationMessages, memEnrichmentState } from '../server/db/schema'
import { enrichConversations } from '../server/services/memory-enrich'
import { and, eq, inArray } from 'drizzle-orm'

async function seedConversation(content: string) {
  const db = useDb()
  const [c] = await db.insert(conversations).values({ title: 'ENRICH-TEST', messageCount: 2 }).returning()
  await db.insert(conversationMessages).values([
    { conversationId: c!.id, role: 'user', content, modality: 'text' },
    { conversationId: c!.id, role: 'assistant', content: 'noted', modality: 'text' }
  ])
  return c!.id
}

describe('enrichConversations', () => {
  it('extracts a memory from a conversation', async () => {
    const id = await seedConversation('Remember I always deploy on Fridays')
    const extract = vi.fn(async () => [{ scope: 'user' as const, content: 'Tony deploys on Fridays', confidence: 0.9 }])
    const res = await enrichConversations({ limit: 5, deps: { extract } })
    expect(res.conversationsProcessed).toBeGreaterThan(0)
    expect(res.memoriesCreated).toBeGreaterThan(0)
    expect(extract).toHaveBeenCalled()
    void id
  })

  it('records state under source_kind=conversation', async () => {
    const id = await seedConversation('another thing worth remembering')
    await enrichConversations({ limit: 5, deps: { extract: async () => [] } })
    const [row] = await useDb().select().from(memEnrichmentState)
      .where(and(eq(memEnrichmentState.sourceKind, 'conversation'), eq(memEnrichmentState.sourceId, id))).limit(1)
    expect(row).toBeTruthy()
  })

  it('does not reprocess a conversation with no new messages', async () => {
    await seedConversation('processed once')
    const extract = vi.fn(async () => [])
    await enrichConversations({ limit: 5, deps: { extract } })
    const firstCalls = extract.mock.calls.length
    await enrichConversations({ limit: 5, deps: { extract } })
    expect(extract.mock.calls.length).toBe(firstCalls)
  })

  it('leaves session enrichment state untouched', async () => {
    const db = useDb()
    const sessionId = crypto.randomUUID()
    await db.insert(memEnrichmentState)
      .values({ sourceKind: 'session', sourceId: sessionId, lastEnrichedMessageCount: 7 })
    await seedConversation('unrelated')
    await enrichConversations({ limit: 5, deps: { extract: async () => [] } })
    const [row] = await db.select().from(memEnrichmentState)
      .where(and(eq(memEnrichmentState.sourceKind, 'session'), eq(memEnrichmentState.sourceId, sessionId))).limit(1)
    expect(row!.lastEnrichedMessageCount).toBe(7)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- enrich-conversations`
Expected: FAIL — `enrichConversations` is not exported; `sourceKind` is not a column.

- [ ] **Step 3: Generalise the state table**

Rewrite `server/db/schema/mem-enrichment-state.ts`:

```ts
import { pgTable, uuid, integer, text, timestamp, primaryKey } from 'drizzle-orm/pg-core'

export const memEnrichmentState = pgTable('mem_enrichment_state', {
  /** 'session' = a Claude Code transcript; 'conversation' = a Bridget thread. */
  sourceKind: text('source_kind').notNull().default('session'),
  sourceId: uuid('source_id').notNull(),
  lastEnrichedMessageCount: integer('last_enriched_message_count').notNull().default(0),
  lastRun: timestamp('last_run', { withTimezone: true }),
  status: text('status'),
  error: text('error')
}, t => [primaryKey({ columns: [t.sourceKind, t.sourceId] })])
```

- [ ] **Step 4: Write the migration by hand**

`pnpm db:generate` will propose dropping and recreating the table, which would lose enrichment state and re-enrich every session. Generate it, then **replace the generated body** of `0049_*.sql` with:

```sql
ALTER TABLE "mem_enrichment_state" RENAME COLUMN "session_id" TO "source_id";
ALTER TABLE "mem_enrichment_state" ADD COLUMN "source_kind" text DEFAULT 'session' NOT NULL;
ALTER TABLE "mem_enrichment_state" DROP CONSTRAINT "mem_enrichment_state_pkey";
ALTER TABLE "mem_enrichment_state" ADD PRIMARY KEY ("source_kind", "source_id");
```

Run `pnpm db:migrate` and confirm existing rows survive with `source_kind = 'session'`:

```bash
psql "$DATABASE_URL" -c "select source_kind, count(*) from mem_enrichment_state group by 1;"
```

- [ ] **Step 5: Update existing session enrichment references**

In `server/services/memory-enrich.ts`, every read/write of `memEnrichmentState.sessionId` becomes `memEnrichmentState.sourceId`, and every `where` gains `eq(memEnrichmentState.sourceKind, 'session')`. Every insert sets `sourceKind: 'session'`.

- [ ] **Step 6: Implement `enrichConversations`**

Append to `server/services/memory-enrich.ts`. Reuse the existing extraction path — take it as an injectable dep so the test does not call a model:

```ts
export interface EnrichConversationsOptions {
  limit?: number
  deps?: { extract?: (transcript: string) => Promise<Array<{ scope: 'user' | 'agent' | 'world', content: string, confidence: number }>> }
}

/**
 * Enrich Bridget conversations, not just Claude Code sessions.
 *
 * Before this, every memory in the store came from a session transcript and talking to Bridget
 * produced nothing — which makes a persistent session accumulate forever and graduate nothing.
 *
 * Output is review-gated exactly like session enrichment: Bridget talks more loosely than a work
 * transcript and the extraction prompt is tuned for the latter, so yield should be measured
 * before this is trusted.
 */
export async function enrichConversations(
  opts: EnrichConversationsOptions = {}
): Promise<{ conversationsProcessed: number, memoriesCreated: number }> {
  const db = useDb()
  const limit = opts.limit ?? 10
  const extract = opts.deps?.extract ?? extractMemoriesFromTranscript

  const candidates = await db.select({ id: conversations.id, messageCount: conversations.messageCount })
    .from(conversations)
    .leftJoin(memEnrichmentState, and(
      eq(memEnrichmentState.sourceKind, 'conversation'),
      eq(memEnrichmentState.sourceId, conversations.id)
    ))
    .where(sql`${conversations.messageCount} > coalesce(${memEnrichmentState.lastEnrichedMessageCount}, 0)`)
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit)

  let memoriesCreated = 0
  for (const c of candidates) {
    const rows = await db.select().from(conversationMessages)
      .where(eq(conversationMessages.conversationId, c.id))
      .orderBy(conversationMessages.createdAt, conversationMessages.id)
    const transcript = rows.map(r => `${r.role}: ${r.content}`).join('\n')

    try {
      const extracted = await extract(transcript)
      for (const e of extracted) {
        await createMemory({ scope: e.scope, content: e.content, confidence: e.confidence, source: `conversation:${c.id}` })
        memoriesCreated++
      }
      await db.insert(memEnrichmentState)
        .values({ sourceKind: 'conversation', sourceId: c.id, lastEnrichedMessageCount: rows.length, lastRun: new Date(), status: 'ok' })
        .onConflictDoUpdate({
          target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
          set: { lastEnrichedMessageCount: rows.length, lastRun: new Date(), status: 'ok', error: null }
        })
    } catch (err) {
      await db.insert(memEnrichmentState)
        .values({ sourceKind: 'conversation', sourceId: c.id, lastRun: new Date(), status: 'error', error: String(err) })
        .onConflictDoUpdate({
          target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
          set: { lastRun: new Date(), status: 'error', error: String(err) }
        })
    }
  }

  return { conversationsProcessed: candidates.length, memoriesCreated }
}
```

First, extract the existing session-enrichment model call in this file into a named export `export async function extractMemoriesFromTranscript(transcript: string)` with the same prompt and return shape it already uses, and have the session path call it. Then `defaultExtract = extractMemoriesFromTranscript`. Do NOT write a second prompt: a divergent extraction prompt is how the two sources start producing incompatible memories. Add `conversations` and `conversationMessages` to the schema import at the top of the file.

- [ ] **Step 7: Schedule it**

In `server/tasks/enrich-memories.ts`, call `enrichConversations()` after the existing session pass and include its counts in the task's returned result.

- [ ] **Step 8: Run the tests**

Run: `pnpm test:db -- enrich-conversations`
Expected: PASS (6 tests).

- [ ] **Step 9: Verify the tests can fail**

Remove the `messageCount > coalesce(...)` predicate. "does not reprocess a conversation with no new messages" must FAIL. Restore.

- [ ] **Step 10: Commit**

```bash
pnpm test && pnpm typecheck
git add server/db/schema/mem-enrichment-state.ts server/db/migrations server/services/memory-enrich.ts server/tasks/enrich-memories.ts test/enrich-conversations.db.test.ts
git commit -m "feat(memory): enrich conversations, not just sessions

Talking to Bridget produced zero memories — enrichment read sessions/messages
only and mem_enrichment_state was keyed on session_id. That is fatal for a
persistent session: it would accumulate forever and graduate nothing. The state
key is now (source_kind, source_id); existing rows migrate to ('session', id)
via a hand-written ALTER rather than drizzle's proposed drop-and-recreate."
```

---

### Task 7: Polymorphic review queue

**Read this before anything else — the framing in the spec's first draft was wrong, and the truth changes the migration.**

`review_queue.doc_id` is **already polymorphic, dishonestly**. `server/services/memory-resolve.ts:198,202,206` insert `docId: plan.targetId` — a `memories.id` — under kinds `memory-supersede` and `memory-contradict`, into a column named and documented as a document reference. Verified against prod on 2026-09-23:

| kind | rows | `doc_id` matches a document | matches a memory |
|---|---|---|---|
| `memory-contradict` | 41 | 0 | **41** |
| `memory-supersede` | 20 | 0 | **20** |
| `enrichment` | 6 | 6 | 0 |
| `triage` | 2 | 2 | 0 |

So this task is a **correctness fix to an existing latent defect**, not a new capability. Two consequences follow, and both are requirements here:

1. **The backfill must branch on `kind`.** A blanket `target_kind = 'document'` would mislabel all 61 existing memory rows.
2. **`memory-resolve.ts` must be updated in this task.** If it keeps writing `docId` while the column default is `'document'`, every new memory conflict row is mislabelled from the moment this ships.

Note in passing: `listReviewFeed`'s `leftJoin(documents, eq(documents.id, reviewQueue.docId))` has never matched for memory rows — harmless because it is a left join, but it is a join that cannot succeed.

**Files:**
- Modify: `server/db/schema/review-queue.ts`
- Create: `server/db/migrations/0050_*.sql`
- Modify: `server/services/review.ts`
- Test: `test/review-queue-targets.db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `review_queue.target_kind` (text, not null, default `'document'`), `review_queue.target_id` (uuid, nullable until backfilled then not null)
  - `doc_id` made **nullable and no longer written** — expand/contract, the drop deferred
  - `export type ReviewTargetKind = 'document' | 'memory'`
  - `enqueueReview(input: { targetKind: ReviewTargetKind, targetId: string, kind: string, proposed: unknown }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/review-queue-targets.db.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { useDb } from '../server/db'
import { reviewQueue } from '../server/db/schema'
import { enqueueReview } from '../server/services/review'
import { and, eq, inArray } from 'drizzle-orm'

describe('polymorphic review queue', () => {
  it('accepts a memory target', async () => {
    const targetId = crypto.randomUUID()
    await enqueueReview({ targetKind: 'memory', targetId, kind: 'applicability', proposed: { applicability: 'global' } })
    const [row] = await useDb().select().from(reviewQueue)
      .where(and(eq(reviewQueue.targetKind, 'memory'), eq(reviewQueue.targetId, targetId))).limit(1)
    expect(row).toBeTruthy()
    expect(row!.status).toBe('pending')
  })

  it('accepts a document target', async () => {
    const targetId = crypto.randomUUID()
    await enqueueReview({ targetKind: 'document', targetId, kind: 'enrichment', proposed: { tags: ['x'] } })
    const [row] = await useDb().select().from(reviewQueue)
      .where(and(eq(reviewQueue.targetKind, 'document'), eq(reviewQueue.targetId, targetId))).limit(1)
    expect(row).toBeTruthy()
  })

  it('allows one pending item per (kind, id) but not two', async () => {
    const targetId = crypto.randomUUID()
    await enqueueReview({ targetKind: 'memory', targetId, kind: 'stale', proposed: { a: 1 } })
    await enqueueReview({ targetKind: 'memory', targetId, kind: 'stale', proposed: { a: 2 } })
    const rows = await useDb().select().from(reviewQueue)
      .where(and(eq(reviewQueue.targetKind, 'memory'), eq(reviewQueue.targetId, targetId), eq(reviewQueue.status, 'pending')))
    expect(rows).toHaveLength(1)
  })

  it('does not collide a memory and a document that share an id', async () => {
    const shared = crypto.randomUUID()
    await enqueueReview({ targetKind: 'memory', targetId: shared, kind: 'stale', proposed: {} })
    await enqueueReview({ targetKind: 'document', targetId: shared, kind: 'enrichment', proposed: {} })
    const rows = await useDb().select().from(reviewQueue).where(eq(reviewQueue.targetId, shared))
    expect(rows).toHaveLength(2)
  })

  it('backfilled every pre-existing memory conflict row as a memory, not a document', async () => {
    // Guards the kind-dependent backfill. doc_id has always held a memories.id for these two
    // kinds; a blanket target_kind='document' would flatten two id namespaces into one label.
    const rows = await useDb().select({ kind: reviewQueue.kind, targetKind: reviewQueue.targetKind })
      .from(reviewQueue)
      .where(inArray(reviewQueue.kind, ['memory-supersede', 'memory-contradict']))
    for (const r of rows) expect(r.targetKind).toBe('memory')
  })

  it('memory-resolve writes memory conflicts as targetKind memory', async () => {
    // The column default is 'document'; a writer that still passes docId would land there
    // silently. Assert the writer, not just the schema.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../server/services/memory-resolve.ts', import.meta.url), 'utf8'))
    expect(src).not.toMatch(/insert\(reviewQueue\)\.values\(\{\s*docId:/)
    expect(src).toMatch(/targetKind:\s*'memory'/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- review-queue-targets`
Expected: FAIL — `targetKind` does not exist.

- [ ] **Step 3: Update the schema**

Rewrite the table body in `server/db/schema/review-queue.ts`:

```ts
export const reviewQueue = pgTable('review_queue', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /** @deprecated superseded by (target_kind, target_id). Nullable, no longer written;
   *  the DROP is deferred to a later cycle — prod is live and it is the only
   *  irreversible step this migration could take. */
  docId: uuid('doc_id'),
  targetKind: text('target_kind').notNull().default('document'),
  targetId: uuid('target_id').notNull(),
  kind: text('kind').notNull().default('enrichment'),
  proposed: jsonb('proposed').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true })
}, (t) => ({
  statusIdx: index('review_queue_status_idx').on(t.status),
  onePendingPerTarget: uniqueIndex('review_queue_one_pending_per_target')
    .on(t.targetKind, t.targetId).where(sql`status = 'pending'`)
}))
```

- [ ] **Step 4: Write the migration by hand**

Generate, then replace the body of `0050_*.sql` so the backfill runs before `NOT NULL` is applied:

```sql
ALTER TABLE "review_queue" ADD COLUMN "target_kind" text DEFAULT 'document' NOT NULL;
ALTER TABLE "review_queue" ADD COLUMN "target_id" uuid;

-- KIND-DEPENDENT, not a blanket 'document'. memory-supersede / memory-contradict rows have
-- always held a memories.id in doc_id (41 + 20 of them in prod); labelling those 'document'
-- would make the id namespace wrong in a column that finally claims to be honest about it.
UPDATE "review_queue" SET
  "target_id"   = "doc_id",
  "target_kind" = CASE WHEN "kind" IN ('memory-supersede','memory-contradict')
                       THEN 'memory' ELSE 'document' END
WHERE "target_id" IS NULL;

ALTER TABLE "review_queue" ALTER COLUMN "target_id" SET NOT NULL;
ALTER TABLE "review_queue" ALTER COLUMN "doc_id" DROP NOT NULL;
DROP INDEX IF EXISTS "review_queue_one_pending_per_doc";
CREATE UNIQUE INDEX "review_queue_one_pending_per_target"
  ON "review_queue" ("target_kind", "target_id") WHERE status = 'pending';
```

Run `pnpm db:migrate`, then confirm nothing was stranded **and that the split landed on the right side** — a `0` in the `memory` row means the backfill silently flattened the namespace:

```bash
psql "$DATABASE_URL" -c "select target_kind, kind, count(*) from review_queue group by 1,2 order by 3 desc;"
psql "$DATABASE_URL" -c "select count(*) from review_queue where target_id is null;"   -- expect 0
```

Expect `memory` for every `memory-supersede` / `memory-contradict` row and `document` for `enrichment` / `triage`.

- [ ] **Step 5: Implement `enqueueReview` and update callers**

In `server/services/review.ts`:

```ts
export type ReviewTargetKind = 'document' | 'memory'

/** Idempotent per (targetKind, targetId): the partial unique index makes a second pending
 *  item for the same target a no-op rather than a duplicate the human has to dismiss twice. */
export async function enqueueReview(input: {
  targetKind: ReviewTargetKind
  targetId: string
  kind: string
  proposed: unknown
}): Promise<void> {
  await useDb().insert(reviewQueue)
    .values({ targetKind: input.targetKind, targetId: input.targetId, kind: input.kind, proposed: input.proposed as never })
    .onConflictDoNothing()
}
```

Update every existing read in `server/services/review.ts` that selects or filters on `docId` to use `targetId` (plus `targetKind: 'document'` where it means documents specifically). Stop writing `docId` on insert.

**Then fix the three writers in `server/services/memory-resolve.ts` (lines ~198, ~202, ~206).** Each currently reads:

```ts
await db.insert(reviewQueue).values({ docId: plan.targetId!, kind: 'memory-supersede', proposed: proposed as unknown as string }).onConflictDoNothing()
```

Replace the `docId:` key with the honest pair, in all three (the `kind` differs per site — keep each one's existing `kind`):

```ts
await db.insert(reviewQueue).values({ targetKind: 'memory', targetId: plan.targetId!, kind: 'memory-supersede', proposed: proposed as unknown as string }).onConflictDoNothing()
```

Leaving these writing `docId` would silently label every new memory conflict `'document'` via the column default — the exact defect this task exists to end.

Also fix `listReviewFeed`'s `leftJoin(documents, eq(documents.id, reviewQueue.docId))` to join on `reviewQueue.targetId` **and** `reviewQueue.targetKind = 'document'`, so it stops attempting a match that cannot succeed for memory rows.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:db -- review-queue-targets`
Expected: PASS (6 tests).

- [ ] **Step 7: Verify the tests can fail**

Change the unique index to `.on(t.targetId)` only. "does not collide a memory and a document that share an id" must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
pnpm test && pnpm typecheck
git add server/db/schema/review-queue.ts server/db/migrations server/services/review.ts test/review-queue-targets.db.test.ts
git commit -m "feat(review): polymorphic review targets

review_queue could only hold documents. Memory review items need the same
queue — two queues with two UIs is what makes people stop reading either.
doc_id goes nullable and stops being written; the DROP is deferred, since it
is the only irreversible step this migration could take against a live prod."
```

---

### Task 8: Review item producers

Four item kinds. **None uses an LLM value rubric** — Jev's `value` measured AUC 0.55 at ranking quality.

**Files:**
- Create: `server/services/memory-concerns.ts`
- Modify: `server/tasks/enrich-memories.ts`
- Test: `test/memory-concerns.db.test.ts`

**Interfaces:**
- Consumes: `enqueueReview` (Task 7); `memories.resident`/`retrievalCount` (Task 2); `memoryRelations` (existing).
- Produces: `sweepMemoryConcerns(opts?: SweepOptions): Promise<{ contradictions: number, residentPromotions: number, staleCandidates: number }>`

- [ ] **Step 1: Write the failing test**

Create `test/memory-concerns.db.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useDb } from '../server/db'
import { memories, memoryRelations, reviewQueue } from '../server/db/schema'
import { createMemory } from '../server/services/memory'
import { sweepMemoryConcerns } from '../server/services/memory-concerns'
import { and, eq, sql } from 'drizzle-orm'

const pending = async (targetId: string, kind: string) => {
  const rows = await useDb().select().from(reviewQueue)
    .where(and(eq(reviewQueue.targetId, targetId), eq(reviewQueue.kind, kind), eq(reviewQueue.status, 'pending')))
  return rows.length
}

describe('sweepMemoryConcerns', () => {
  beforeEach(async () => {
    await useDb().execute(sql`delete from memories where content like 'CONCERN-TEST%'`)
  })

  it('files an active contradiction for review', async () => {
    const a = await createMemory({ scope: 'agent', content: 'CONCERN-TEST new fact', project: 'p' })
    const b = await createMemory({ scope: 'agent', content: 'CONCERN-TEST old fact', project: 'p' })
    await useDb().insert(memoryRelations)
      .values({ fromId: a.id, toId: b.id, type: 'contradicts', confidence: 0.9, status: 'active' })
    const res = await sweepMemoryConcerns()
    expect(res.contradictions).toBeGreaterThan(0)
    expect(await pending(a.id, 'contradiction')).toBe(1)
  })

  it('ignores a RESOLVED contradiction', async () => {
    const a = await createMemory({ scope: 'agent', content: 'CONCERN-TEST resolved-a', project: 'p' })
    const b = await createMemory({ scope: 'agent', content: 'CONCERN-TEST resolved-b', project: 'p' })
    await useDb().insert(memoryRelations)
      .values({ fromId: a.id, toId: b.id, type: 'contradicts', confidence: 0.9, status: 'resolved' })
    await sweepMemoryConcerns()
    expect(await pending(a.id, 'contradiction')).toBe(0)
  })

  it('nominates a memory retrieved often across projects for the resident tier', async () => {
    const m = await createMemory({ scope: 'user', content: 'CONCERN-TEST travels a lot', project: 'p' })
    await useDb().update(memories)
      .set({ applicability: 'global', retrievalCount: 25 }).where(eq(memories.id, m.id))
    const res = await sweepMemoryConcerns({ residentMinRetrievals: 10 })
    expect(res.residentPromotions).toBeGreaterThan(0)
    expect(await pending(m.id, 'resident-promotion')).toBe(1)
  })

  it('does not nominate a project-bound memory however often it is retrieved', async () => {
    const m = await createMemory({ scope: 'user', content: 'CONCERN-TEST local favourite', project: 'p' })
    await useDb().update(memories).set({ retrievalCount: 99 }).where(eq(memories.id, m.id))
    await sweepMemoryConcerns({ residentMinRetrievals: 10 })
    expect(await pending(m.id, 'resident-promotion')).toBe(0)
  })

  it('does not re-nominate a memory that is already resident', async () => {
    const m = await createMemory({ scope: 'user', content: 'CONCERN-TEST already pinned', project: 'p' })
    await useDb().update(memories)
      .set({ applicability: 'global', resident: true, retrievalCount: 50 }).where(eq(memories.id, m.id))
    await sweepMemoryConcerns({ residentMinRetrievals: 10 })
    expect(await pending(m.id, 'resident-promotion')).toBe(0)
  })

  it('files a stale candidate when durability is low', async () => {
    const m = await createMemory({ scope: 'agent', content: 'CONCERN-TEST on branch feat/x right now', project: 'p' })
    await useDb().update(memories).set({ reviewedAt: new Date() }).where(eq(memories.id, m.id))
    const res = await sweepMemoryConcerns({
      scoreDurable: async rows => new Map(rows.map(r => [r.id, r.id === m.id ? 0.1 : 0.9]))
    })
    expect(res.staleCandidates).toBeGreaterThan(0)
    expect(await pending(m.id, 'stale')).toBe(1)
  })

  it('does not file a stale candidate for a durable memory', async () => {
    const m = await createMemory({ scope: 'agent', content: 'CONCERN-TEST durable convention', project: 'p' })
    await useDb().update(memories).set({ reviewedAt: new Date() }).where(eq(memories.id, m.id))
    await sweepMemoryConcerns({ scoreDurable: async rows => new Map(rows.map(r => [r.id, 0.95])) })
    expect(await pending(m.id, 'stale')).toBe(0)
  })

  it('skips stale scoring entirely when no scorer is configured', async () => {
    const res = await sweepMemoryConcerns()
    expect(res.staleCandidates).toBe(0)
  })

  it('never archives or deletes anything', async () => {
    const before = await useDb().select({ n: sql<number>`count(*)` }).from(memories)
    await sweepMemoryConcerns()
    const after = await useDb().select({ n: sql<number>`count(*)` }).from(memories)
    expect(after[0]!.n).toBe(before[0]!.n)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test:db -- memory-concerns`
Expected: FAIL — `server/services/memory-concerns` does not exist.

- [ ] **Step 3: Implement the sweep**

Create `server/services/memory-concerns.ts`:

```ts
import { and, eq, gte, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { memories, memoryRelations } from '../db/schema'
import { enqueueReview } from './review'

export interface SweepOptions {
  /** How many retrievals before a global memory is worth pinning into every prompt. */
  residentMinRetrievals?: number
  /** Optional `durable` scorer (spec §5.2). Omitted in tests and when no key is configured. */
  scoreDurable?: (contents: { id: string, content: string }[]) => Promise<Map<string, number>>
  /** Below this durability, a memory is a stale CANDIDATE — surfaced, never auto-archived. */
  staleBelow?: number
}

/**
 * File memory concerns into the review queue. NOTHING here archives or deletes — every item is
 * a proposal for a human.
 *
 * Deliberately excludes anything driven by an LLM value rubric: measured on 45 hand labels,
 * Jev's 4-level `value` predicted keep-vs-stale at AUC 0.55, which is chance. These signals are
 * structural instead — a contradiction edge is a fact about the graph, and a retrieval count is
 * measured behaviour.
 */
export async function sweepMemoryConcerns(
  opts: SweepOptions = {}
): Promise<{ contradictions: number, residentPromotions: number }> {
  const db = useDb()
  const minRetrievals = opts.residentMinRetrievals ?? 10

  // 1. Contradictions. Cycle 13 built this graph and the judge that populates it; nothing has
  //    ever read those edges at turn time. A contradiction is the most damaging thing in the
  //    store, because agents act on it confidently.
  const contradictions = await db.select({ fromId: memoryRelations.fromId, toId: memoryRelations.toId })
    .from(memoryRelations)
    .where(and(eq(memoryRelations.type, 'contradicts'), eq(memoryRelations.status, 'active')))

  for (const c of contradictions) {
    await enqueueReview({
      targetKind: 'memory', targetId: c.fromId, kind: 'contradiction',
      proposed: { contradicts: c.toId }
    })
  }

  // 2. Resident promotions. Rather than asking a model whether a fact deserves to live in every
  //    prompt, watch what is actually retrieved: a global memory pulled repeatedly is
  //    demonstrating that it matters. Measured behaviour, not an opinion.
  const promotable = await db.select({ id: memories.id, retrievalCount: memories.retrievalCount })
    .from(memories)
    .where(and(
      sql`${memories.archivedAt} is null`,
      eq(memories.applicability, 'global'),
      eq(memories.resident, false),
      sql`${memories.reviewedAt} is not null`,
      gte(memories.retrievalCount, minRetrievals)
    ))

  for (const m of promotable) {
    await enqueueReview({
      targetKind: 'memory', targetId: m.id, kind: 'resident-promotion',
      proposed: { resident: true, retrievalCount: m.retrievalCount }
    })
  }

  // 3. Stale candidates (spec §5.2). `durable` is the ONE facet that survived its confidence
  //    interval on the hand labels (AUC 0.73-0.74 on both the unbiased 28 and the full 45).
  //    Surfaced, NEVER auto-archived — precision is roughly 30-50% and there is no undo.
  let staleCandidates = 0
  if (opts.scoreDurable) {
    const rows = await db.select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(and(sql`${memories.archivedAt} is null`, sql`${memories.reviewedAt} is not null`))
      .orderBy(sql`${memories.retrievalCount} desc`)
      .limit(200)
    const scores = await opts.scoreDurable(rows)
    for (const [id, durable] of scores) {
      if (durable >= (opts.staleBelow ?? 0.4)) continue
      await enqueueReview({ targetKind: 'memory', targetId: id, kind: 'stale', proposed: { durable } })
      staleCandidates++
    }
  }

  return { contradictions: contradictions.length, residentPromotions: promotable.length, staleCandidates }
}
```

- [ ] **Step 4: Schedule it**

In `server/tasks/enrich-memories.ts`, call `sweepMemoryConcerns()` after the enrichment passes and include its counts in the result.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:db -- memory-concerns`
Expected: PASS (9 tests).

- [ ] **Step 6: Verify the tests can fail**

Remove `eq(memoryRelations.status, 'active')`. "ignores a RESOLVED contradiction" must FAIL. Restore. Then remove `eq(memories.applicability, 'global')`; "does not nominate a project-bound memory" must FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
pnpm test && pnpm typecheck
git add server/services/memory-concerns.ts server/tasks/enrich-memories.ts test/memory-concerns.db.test.ts
git commit -m "feat(review): surface contradictions and resident nominations

Contradiction edges have existed since cycle 13 and nothing has ever read them.
Resident promotion is driven by measured retrieval rather than a model's opinion
of importance — Jev's value rubric predicted keep-vs-stale at AUC 0.55 on 45
hand labels, which is chance. Nothing here archives or deletes."
```

---

### Task 9: Applicability backfill

One-time classification of 2,117 existing memories. The narrow observable yes/no, not a rubric.

**Files:**
- Create: `scripts/backfill-applicability.ts`
- Create: `scripts/lib/applicability.ts`
- Test: `test/applicability-gate.test.ts`

**Interfaces:**
- Consumes: `memories.applicability` (Task 1); `enqueueReview` (Task 7).
- Produces: `decideApplicability(noul: number, opts?: { high?: number, low?: number }): 'global' | 'project' | 'review'`

- [ ] **Step 1: Write the failing test**

Create `test/applicability-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideApplicability } from '../scripts/lib/applicability'

describe('decideApplicability', () => {
  it('writes global only above the high gate', () => {
    expect(decideApplicability(0.95)).toBe('global')
  })

  it('writes project only below the low gate', () => {
    expect(decideApplicability(0.05)).toBe('project')
  })

  it('sends the uncertain middle to review rather than guessing', () => {
    expect(decideApplicability(0.5)).toBe('review')
    expect(decideApplicability(0.7)).toBe('review')
  })

  it('treats the gates as inclusive bounds', () => {
    expect(decideApplicability(0.9, { high: 0.9, low: 0.1 })).toBe('global')
    expect(decideApplicability(0.1, { high: 0.9, low: 0.1 })).toBe('project')
  })

  it('defaults an out-of-range or NaN score to review, never to global', () => {
    expect(decideApplicability(Number.NaN)).toBe('review')
    expect(decideApplicability(1.5)).toBe('review')
    expect(decideApplicability(-1)).toBe('review')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/applicability-gate.test.ts`
Expected: FAIL — cannot resolve `../scripts/lib/applicability`.

- [ ] **Step 3: Implement the gate**

Create `scripts/lib/applicability.ts`:

```ts
/**
 * Confidence gate for the one-time applicability backfill.
 *
 * `project` is the pre-existing behaviour, so a wrong 'project' costs nothing new while a wrong
 * 'global' leaks a project-bound fact into every other project's context. The gate is therefore
 * deliberately asymmetric in its consequences, and anything malformed lands in review rather
 * than defaulting to the permissive answer.
 */
export function decideApplicability(
  noul: number,
  opts: { high?: number, low?: number } = {}
): 'global' | 'project' | 'review' {
  const high = opts.high ?? 0.9
  const low = opts.low ?? 0.1
  if (!Number.isFinite(noul) || noul < 0 || noul > 1) return 'review'
  if (noul >= high) return 'global'
  if (noul <= low) return 'project'
  return 'review'
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/applicability-gate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the backfill script**

Create `scripts/backfill-applicability.ts`. It must:

1. Read `JEV_KEY` from env and exit 1 with a clear message if absent.
2. Select all live memories (`archived_at is null`) where `applicability = 'project'`.
3. For each, call `https://api.typesafe.ai/v1/systemone` with model pinned to `jev-1.13.0` and a single Noul:
   `"This fact is specific to one named project or codebase, rather than being true across all of Tony's work"`
   — note the polarity: a **high** score means project-bound, so pass `1 - noul` to `decideApplicability`.
4. Concurrency 6, retry 429 with backoff honouring `retry-after` (mirror `scripts/jev-score.ts`).
5. Apply `decideApplicability`: `global` → update the row; `project` → no-op; `review` → `enqueueReview({ targetKind: 'memory', targetId, kind: 'applicability', proposed: { applicability: 'global', noul } })`.
6. Support `--dry-run` that prints the three bucket counts and writes nothing. **Run this first.**
7. Print totals, the token cost, and the output path.

- [ ] **Step 6: Dry-run, then commit to the write**

```bash
set -a; . /Users/tony/Documents/GitHub/homelab/.env; set +a
node_modules/.bin/tsx scripts/backfill-applicability.ts --dry-run
```

Sanity-check the split before writing anything. **If `global` comes back above ~25% of the store, stop** — the question is mis-worded and firing too broadly, exactly the failure mode that put `needs_verification` on 248 of 276 memories. Reword and re-dry-run rather than accepting it.

Then run for real without `--dry-run`.

- [ ] **Step 7: Typecheck the script (not covered by `pnpm typecheck`)**

```bash
cat > /tmp/tsconfig.backfill.json <<'EOF'
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext",
    "moduleResolution": "bundler", "skipLibCheck": true, "types": ["node"],
    "typeRoots": ["./node_modules/.pnpm/@types+node@25.9.1/node_modules/@types"]
  },
  "include": ["scripts/backfill-applicability.ts", "scripts/lib/applicability.ts"]
}
EOF
node_modules/.bin/tsc -p /tmp/tsconfig.backfill.json
```

Expected: no output. Verify the config bites by planting a type error and re-running.

- [ ] **Step 8: Commit**

```bash
pnpm test && pnpm typecheck
git add scripts/backfill-applicability.ts scripts/lib/applicability.ts test/applicability-gate.test.ts
git commit -m "feat(memory): one-time applicability backfill, gated on confidence

Classifies 2,117 memories on the narrow observable question — does this fact
depend on a specific project — not a value rubric. The gate is asymmetric on
purpose: 'project' is today's behaviour so a wrong one costs nothing new, while
a wrong 'global' leaks a project-bound fact everywhere. The uncertain middle
goes to review rather than guessing, and malformed scores never reach 'global'."
```

---

## Wrap-up

- [ ] **Update the wiki.** `docs/wiki/memory.md` gets the applicability/resident model and the assembler's tier table; add `docs/wiki/agent-context.md` if no page covers turn assembly. The wiki describes how the system works **today** — a stale page has misled past sessions.
- [ ] **Update the roadmap.** Add cycle 70 to the status table in `docs/superpowers/plans/00-roadmap.md`.
- [ ] **Write the handover** in `docs/handovers/` with accurate frontmatter, including which migrations have and have not been run on prod.
- [ ] **Mirror the wiki pages to MyMind** using the `wiki-mirror` skill.
- [ ] **Update MyMind task `e6a18a43`** to completed, and file follow-ups for the `c-users-tonyc` project-resolution bug and the `memory-judge.ts` → Jev `Choice` migration (spec §8 items 1 and 4).
- [ ] **Browser-validate** with `playwright-cli`, not MCP: confirm `/review` renders memory items alongside document items, and that `/clear` on `/agent` empties the visible thread boundary while the conversation remains findable in search.
