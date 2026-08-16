# Capture Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infer what a quick-captured jot actually *was* — a task, a durable memory, a filed note, or an addition to an existing document — and route it there, applying confident results automatically and queueing only genuine uncertainty.

**Architecture:** One entry point, `triageCapture(docId)`, invoked fire-and-forget after capture and swept by a cron backstop. Three stages: `classify()` (one bulk-model call → strict JSON), `route()` (pure policy, no I/O), and four small actuators that each return an undo token and publish a live-bus change. Supersedes `enrich-input` for `/input` rather than running beside it. Lands on `/review` as a fourth `kind` — no new page.

**Tech Stack:** Nuxt 4 (Nitro server routes, `defineTask` scheduled tasks), Drizzle + Postgres/pgvector, vitest, `chat('bulk', …)` via the DB-backed AI registry, `@tanstack/vue-query` + the cycle-21 live bus, Nuxt UI v4.

**Spec:** [`../specs/2026-08-16-capture-triage-design.md`](../specs/2026-08-16-capture-triage-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **`pnpm` only.** Never npm or yarn. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`. DB-backed tests run via `pnpm test:db` (a separate config; they are excluded from `pnpm test`).
- **`TriageKind` is `'task' | 'note' | 'memory' | 'append'`.** It is a *destination*. It is deliberately NOT shared with `documents.type` (`note|reference|meeting|idea|task`), which is a *document classification*. The two overlap on the words "note" and "task" while meaning different things. **Do not unify them.** Cycle 56 set this precedent with its third range vocabulary.
- **`ResourceName` is singular** — `document`, `task`, `memory`, `review`. There is no `home` member. `app/utils/live-dispatch.ts` already maps those four to a debounced `['home']` invalidation. **Do not add a dispatch entry.**
- **The Memory actuator MUST call `createMemory()`** from `server/services/memory.ts` and must NEVER insert into the `memories` table directly. `createMemory` already runs `buildDedupCandidates` + `dedupDecision` (skip/merge/insert) and applies `shouldAutoReview`. A raw insert silently bypasses dedup, and task `f80622b9` (dedup under-catching) is still open. If `createMemory` seems awkward to call, **escalate — do not hand-roll the insert.**
- **The Memory threshold ships at `1.1`** (never auto-applies) and stays there until task `f80622b9` closes. This is a hard dependency from the spec, not a tuning preference.
- **All four thresholds ship at `1.1`.** The rollout lowers them later, by hand, one destination at a time. No task in this plan may ship a threshold below `1.1`.
- **Document mutations go through the service layer** — `updateDoc`, `moveDoc`, `deleteDoc`, `restoreDoc` in `server/services/documents.ts`. Never write `documents.project` / `project_id` directly; they are derived from `path` on every write.
- **Nuxt UI v4 components only** for any UI step, and **invoke the `nuxt-ui-docs` skill before writing component markup**. Cycle 56 shipped a `UButtonGroup` that no longer exists under that name (it is `UFieldGroup`) precisely because a plan skipped this. Semantic color tokens only (`primary`, `success`, `warning`, `error`, `neutral`, `text-muted`, `bg-elevated`, …) — never raw palette classes like `text-gray-500`.
- **Browser-validate UI work with `playwright-cli`, NOT the Playwright MCP.** Invoke the `browser-testing` skill for the login flow, the reka-ui real-click rule, and the CodeMirror/microtask gotchas.
- **Singular/plural in user-facing copy.** Never render "1 items". This bug class has appeared in at least twelve places in this codebase; cycle 56 caught two more. Write explicit singular/plural forms.
- **No re-capping or re-sorting server data in the UI.** The server decides ordering and limits.

---

## File Structure

**New — server:**
- `server/db/schema/triage.ts` — the `triage_actions` table.
- `shared/types/triage.ts` — `TriageKind`, `TriageAction`, `TriageProposal`, `TriageOutcome`. Shared so `/review` can type the `proposed` payload.
- `server/lib/ai/triage.ts` — `buildTriageMessages()` (pure) + `parseTriage()` (pure) + `classify()` (the one model call).
- `server/lib/triage/route.ts` — `route()`, pure policy. No imports from `server/db` or `server/services`.
- `server/services/triage.ts` — `triageCapture()` orchestrator + the four actuators + `revertTriageAction()`.
- `server/tasks/triage-input.ts` — the cron sweeper.
- `server/api/triage/recent.get.ts` — the recently-auto-applied feed.
- `server/api/triage/[id]/revert.post.ts` — durable reversal.
- `server/api/review/kinds.ts` — the per-kind approve/reject handler map extracted out of the endpoints.

**New — tests:**
- `test/triage-parse.test.ts`, `test/triage-route.test.ts`, `test/triage-prompt.test.ts` (pure, run in `pnpm test`).
- `test/triage-actuators.db.test.ts`, `test/triage-idempotency.db.test.ts` (real Postgres, run in `pnpm test:db`).

**Modified:**
- `server/db/schema/documents.ts` — add `triagedAt`.
- `server/db/schema/index.ts` — export the new table.
- `server/api/capture/note.post.ts`, `server/api/capture/transcribe.post.ts` — fire triage.
- `server/api/review/[id]/approve.post.ts`, `reject.post.ts` — replace the if/else chain with the handler map.
- `app/pages/review.vue` — render the `triage` kind + the recently-applied strip.
- `nuxt.config.ts` — `triageThresholds` config, swap the `enrich-input` schedule for `triage-input`.
- `docs/wiki/quick-capture.md`, `docs/wiki/enrichment.md` — reflect shipped behaviour.

**Deleted:** `server/tasks/enrich-input.ts` (superseded — see Task 9).

---

## Task Sequence

| # | Task | Gate |
|---|---|---|
| 1 | Schema + migration (`triaged_at`, `triage_actions`) | `pnpm test` |
| 2 | Shared types + `parseTriage` (pure) | `pnpm test` |
| 3 | `route()` + thresholds config (pure) | `pnpm test` |
| 4 | `buildTriageMessages` + `classify()` | `pnpm test` |
| 5 | Task + Note actuators | `pnpm test:db` |
| 6 | Memory actuator | `pnpm test:db` |
| 7 | `triageCapture()` orchestrator + idempotency | `pnpm test:db` |
| 8 | Wire into capture endpoints | `pnpm test:db` + browser |
| 9 | Cron sweeper + retire `enrich-input` | `pnpm test` |
| 10 | Append actuator (built last, per spec) | `pnpm test:db` |
| 11 | Review kind handler map + `triage` rendering | browser |
| 12 | Recently-applied strip + durable reversal | `pnpm test:db` + browser |
| 13 | Fold memory review into `/review` | browser |
| 14 | Wiki + handover | — |

---

### Task 1: Schema + migration

**Files:**
- Create: `server/db/schema/triage.ts`
- Modify: `server/db/schema/documents.ts` (add `triagedAt`)
- Modify: `server/db/schema/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing.
- Produces: `triageActions` table object; `documents.triagedAt` column.

- [ ] **Step 1: Create the table**

```ts
// server/db/schema/triage.ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, real, timestamp, index } from 'drizzle-orm/pg-core'

// One row per triage action actually EXECUTED (auto-applied or approved).
// This is what makes reversal work past registerUndo's 10-minute TTL, and it is
// the audit trail for "why is this task on my board" — without it an auto-applied
// action is indistinguishable from one created by hand.
export const triageActions = pgTable('triage_actions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  docId: uuid('doc_id').notNull(),
  kind: text('kind').notNull(),                       // TriageKind
  entityType: text('entity_type').notNull(),          // 'task' | 'memory' | 'document'
  entityId: uuid('entity_id'),                        // null if the actuator produced nothing
  confidence: real('confidence').notNull(),
  autoApplied: boolean('auto_applied').notNull(),
  payload: jsonb('payload').notNull(),                // the TriageAction, for reversal + display
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => ({
  createdAtIdx: index('triage_actions_created_at_idx').on(t.createdAt),
  docIdx: index('triage_actions_doc_idx').on(t.docId)
}))

export type TriageActionRow = typeof triageActions.$inferSelect
```

- [ ] **Step 2: Add the idempotency column**

In `server/db/schema/documents.ts`, add to the `documents` table definition, next to the other timestamps:

```ts
  triagedAt: timestamp('triaged_at', { withTimezone: true }),
```

and add to the index block in the same file:

```ts
  triagedAtIdx: index('documents_triaged_at_idx').on(t.triagedAt),
```

- [ ] **Step 3: Export from the barrel**

Append to `server/db/schema/index.ts`:

```ts
export * from './triage'
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: one new file under `server/db/migrations/` (or the configured `out` dir) adding `triage_actions`, `documents.triaged_at`, and the two indexes.

- [ ] **Step 5: Read the generated SQL and verify it contains ONLY those changes**

Open the generated `.sql`. It must contain exactly: `CREATE TABLE "triage_actions"`, `ALTER TABLE "documents" ADD COLUMN "triaged_at"`, and the three `CREATE INDEX` statements. **If it contains any other `ALTER`/`DROP`, stop and escalate** — that is pre-existing schema drift and it must not ride along in this migration. (Cycle 56's Task 3 reviewer caught exactly this class of thing by diffing the snapshot table-by-table.)

- [ ] **Step 6: Apply locally**

Run: `pnpm db:migrate`
Expected: exits 0.

- [ ] **Step 7: Verify gates**

Run: `pnpm typecheck && pnpm test`
Expected: 0 type errors; the full suite passes unchanged.

- [ ] **Step 8: Commit**

```bash
git add server/db/schema/ server/db/migrations/
git commit -m "feat(triage): add triage_actions table and documents.triaged_at"
```

---

### Task 2: Shared types + `parseTriage`

**Files:**
- Create: `shared/types/triage.ts`
- Create: `server/lib/ai/triage.ts` (the parse half; `classify` lands in Task 4)
- Test: `test/triage-parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TriageKind`, `TriageAction`, `TriageProposal`, `TriageOutcome`; `parseTriage(raw: string): TriageProposal | null`.

**Context:** `server/lib/ai/enrich.ts` already has `parseProposal`, which strips ``` fences and brace-matches the first `{…}`. It is unit-tested and handles real-world messy model output. Follow it closely — same structure, same defensive posture. Read it before writing this.

- [ ] **Step 1: Define the shared types**

```ts
// shared/types/triage.ts

// A DESTINATION, not a document classification. Deliberately NOT shared with
// documents.type ('note'|'reference'|'meeting'|'idea'|'task') — the two overlap
// on two words while meaning different things. Do not unify them.
export type TriageKind = 'task' | 'note' | 'memory' | 'append'

export interface TriageAction {
  kind: TriageKind
  confidence: number                      // 0..1, clamped
  title?: string
  project?: string | null
  priority?: 'low' | 'medium' | 'high'    // task only
  dueDate?: string | null                 // task only, ISO date
  scope?: 'user' | 'agent' | 'world'      // memory only
  content?: string                        // memory text / append block text
  targetDocId?: string                    // append only — resolved by the actuator, never the model
  tags?: string[]
  path?: string                           // note only — destination path INCLUDING the new filename
}

export interface TriageProposal {
  primary: TriageAction
  secondary: TriageAction[]               // 0..2 (truncated, not rejected)
  reasoning: string
}

export interface TriageOutcome {
  docId: string
  applied: TriageAction[]
  queued: boolean                         // true if a review_queue row was created
  skipped?: 'already-triaged' | 'parse-failed'
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/triage-parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseTriage } from '../server/lib/ai/triage'

const ok = JSON.stringify({
  primary: { kind: 'task', confidence: 0.9, title: 'Fix the loan link', project: 'finances' },
  secondary: [],
  reasoning: 'Imperative phrasing with a clear action.'
})

describe('parseTriage', () => {
  it('parses a bare JSON proposal', () => {
    const p = parseTriage(ok)
    expect(p?.primary.kind).toBe('task')
    expect(p?.primary.title).toBe('Fix the loan link')
    expect(p?.secondary).toEqual([])
  })

  it('strips markdown fences', () => {
    expect(parseTriage('```json\n' + ok + '\n```')?.primary.kind).toBe('task')
  })

  it('ignores prose wrapped around the JSON', () => {
    expect(parseTriage('Sure! Here you go:\n' + ok + '\nHope that helps.')?.primary.kind).toBe('task')
  })

  // Truncating beats rejecting: an over-eager list shouldn't throw away a good primary.
  it('truncates secondary beyond two entries instead of rejecting the proposal', () => {
    const many = JSON.stringify({
      primary: { kind: 'note', confidence: 0.8 },
      secondary: [
        { kind: 'task', confidence: 0.7 },
        { kind: 'memory', confidence: 0.6 },
        { kind: 'append', confidence: 0.5 },
        { kind: 'task', confidence: 0.4 }
      ],
      reasoning: 'x'
    })
    const p = parseTriage(many)
    expect(p?.secondary).toHaveLength(2)
    expect(p?.secondary.map(a => a.kind)).toEqual(['task', 'memory'])
  })

  it('clamps confidence into 0..1', () => {
    const p = parseTriage(JSON.stringify({
      primary: { kind: 'task', confidence: 4.2 }, secondary: [], reasoning: 'x'
    }))
    expect(p?.primary.confidence).toBe(1)
  })

  // Missing confidence must route to review, never auto-apply.
  it('treats a missing or non-numeric confidence as 0', () => {
    expect(parseTriage(JSON.stringify({
      primary: { kind: 'task' }, secondary: [], reasoning: 'x'
    }))?.primary.confidence).toBe(0)
    expect(parseTriage(JSON.stringify({
      primary: { kind: 'task', confidence: 'high' }, secondary: [], reasoning: 'x'
    }))?.primary.confidence).toBe(0)
  })

  it('returns null for an unknown kind', () => {
    expect(parseTriage(JSON.stringify({
      primary: { kind: 'archive', confidence: 0.9 }, secondary: [], reasoning: 'x'
    }))).toBeNull()
  })

  it('returns null for junk, empty input, and a missing primary', () => {
    expect(parseTriage('')).toBeNull()
    expect(parseTriage('no json here')).toBeNull()
    expect(parseTriage('{"secondary":[],"reasoning":"x"}')).toBeNull()
  })

  it('drops a malformed secondary entry but keeps a valid primary', () => {
    const p = parseTriage(JSON.stringify({
      primary: { kind: 'note', confidence: 0.8 },
      secondary: [{ kind: 'nonsense', confidence: 0.7 }, { kind: 'task', confidence: 0.6 }],
      reasoning: 'x'
    }))
    expect(p?.secondary.map(a => a.kind)).toEqual(['task'])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run test/triage-parse.test.ts`
Expected: FAIL — `parseTriage` is not exported from `server/lib/ai/triage` (module not found).

- [ ] **Step 4: Implement**

```ts
// server/lib/ai/triage.ts
import type { TriageAction, TriageKind, TriageProposal } from '../../../shared/types/triage'

const KINDS = new Set<TriageKind>(['task', 'note', 'memory', 'append'])
const MAX_SECONDARY = 2

function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

function parseAction(v: unknown): TriageAction | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind as TriageKind)) return null
  const str = (k: string) => (typeof o[k] === 'string' ? o[k] as string : undefined)
  return {
    kind: o.kind as TriageKind,
    confidence: clamp01(o.confidence),
    title: str('title'),
    project: (typeof o.project === 'string' || o.project === null) ? o.project as string | null : undefined,
    priority: (o.priority === 'low' || o.priority === 'medium' || o.priority === 'high') ? o.priority : undefined,
    dueDate: (typeof o.dueDate === 'string' || o.dueDate === null) ? o.dueDate as string | null : undefined,
    scope: (o.scope === 'user' || o.scope === 'agent' || o.scope === 'world') ? o.scope : undefined,
    content: str('content'),
    tags: Array.isArray(o.tags) && o.tags.every(t => typeof t === 'string') ? o.tags as string[] : undefined,
    path: str('path')
    // targetDocId is intentionally NOT read from the model — the actuator resolves it.
  }
}

/** Mirrors parseProposal in ./enrich.ts: strip fences, brace-match, validate, null on failure. */
export function parseTriage(raw: string): TriageProposal | null {
  if (!raw || !raw.trim()) return null
  try {
    const text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
    const start = text.indexOf('{')
    if (start === -1) return null
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) return null

    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>

    const primary = parseAction(obj.primary)
    if (!primary) return null

    const secondary = (Array.isArray(obj.secondary) ? obj.secondary : [])
      .map(parseAction)
      .filter((a): a is TriageAction => a !== null)
      .slice(0, MAX_SECONDARY)

    return {
      primary,
      secondary,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : ''
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/triage-parse.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Prove the tests are not vacuous**

Temporarily change `MAX_SECONDARY` to `99` and re-run. Expected: the truncation test FAILS. Restore it and re-run. Expected: PASS.
Then temporarily make `clamp01` return `1` unconditionally and re-run. Expected: the missing-confidence test FAILS. Restore.
**A test you have not watched fail proves nothing.** Do not skip this step.

- [ ] **Step 7: Commit**

```bash
git add shared/types/triage.ts server/lib/ai/triage.ts test/triage-parse.test.ts
git commit -m "feat(triage): shared types and parseTriage"
```

---

### Task 3: `route()` + thresholds config

**Files:**
- Create: `server/lib/triage/route.ts`
- Modify: `nuxt.config.ts` (runtimeConfig)
- Test: `test/triage-route.test.ts`

**Interfaces:**
- Consumes: `TriageAction`, `TriageProposal` from `shared/types/triage`.
- Produces: `route(proposal: TriageProposal, thresholds: TriageThresholds): RoutedAction[]` where `RoutedAction = { action: TriageAction, autoApply: boolean }`; and `type TriageThresholds = Record<TriageKind, number>`.

**Context:** This file is **pure**. It must not import from `server/db`, `server/services`, or anything with I/O. All policy lives here so it is testable without a model or a database.

- [ ] **Step 1: Add the config**

In `nuxt.config.ts`, inside `runtimeConfig` (server-side, NOT under `public`):

```ts
    // Capture triage confidence bars, per destination. ALL ship at 1.1 (= never
    // auto-apply) so the pipeline can be calibrated against real captures before it
    // is allowed to write. Lower by hand, one destination at a time, per the spec's
    // rollout. The memory bar is GATED on task f80622b9 (dedup under-catching).
    triageThresholds: {
      task: 1.1,
      note: 1.1,
      memory: 1.1,
      append: 1.1
    },
    triageAppendSimilarityFloor: 0.75,
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/triage-route.test.ts
import { describe, it, expect } from 'vitest'
import { route } from '../server/lib/triage/route'
import type { TriageProposal, TriageAction } from '../shared/types/triage'

const T = { task: 0.7, note: 0.7, memory: 0.8, append: 0.85 }
const act = (o: Partial<TriageAction> = {}): TriageAction => ({ kind: 'task', confidence: 0.9, ...o })
const prop = (primary: TriageAction, secondary: TriageAction[] = []): TriageProposal =>
  ({ primary, secondary, reasoning: 'x' })

describe('route', () => {
  it('auto-applies an action above its bar', () => {
    const r = route(prop(act({ kind: 'task', confidence: 0.71 })), T)
    expect(r).toEqual([{ action: expect.objectContaining({ kind: 'task' }), autoApply: true }])
  })

  it('holds an action below its bar for review', () => {
    expect(route(prop(act({ kind: 'task', confidence: 0.69 })), T)[0]!.autoApply).toBe(false)
  })

  // A bar is a floor, not a strict threshold — exactly-at must apply, or a 0.70 bar
  // silently behaves as 0.7000…1 and the config value lies about itself.
  it('auto-applies an action exactly at its bar', () => {
    expect(route(prop(act({ kind: 'task', confidence: 0.7 })), T)[0]!.autoApply).toBe(true)
  })

  it('applies each destination against its OWN bar', () => {
    // 0.82 clears task/note (0.7) and memory (0.8) but not append (0.85)
    const r = route(prop(act({ kind: 'memory', confidence: 0.82 }), [act({ kind: 'append', confidence: 0.82 })]), T)
    expect(r[0]!.autoApply).toBe(true)
    expect(r[1]!.autoApply).toBe(false)
  })

  // The rule the spec is emphatic about: no destination categorically requires review.
  it('does not force secondaries to review when they clear their bar', () => {
    const r = route(prop(act({ kind: 'task', confidence: 0.95 }), [act({ kind: 'memory', confidence: 0.9 })]), T)
    expect(r.every(x => x.autoApply)).toBe(true)
  })

  it('mixes: confident primary applies while an uncertain secondary waits', () => {
    const r = route(prop(act({ kind: 'task', confidence: 0.95 }), [act({ kind: 'memory', confidence: 0.5 })]), T)
    expect(r[0]!.autoApply).toBe(true)
    expect(r[1]!.autoApply).toBe(false)
  })

  it('returns the primary first, then secondaries in order', () => {
    const r = route(prop(act({ kind: 'note' }), [act({ kind: 'task' }), act({ kind: 'memory' })]), T)
    expect(r.map(x => x.action.kind)).toEqual(['note', 'task', 'memory'])
  })

  // The shipped config. Nothing may auto-apply at 1.1, including a perfect 1.0.
  it('auto-applies nothing when every bar is 1.1', () => {
    const ship = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
    const r = route(prop(act({ confidence: 1 }), [act({ kind: 'memory', confidence: 1 })]), ship)
    expect(r.every(x => x.autoApply === false)).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run test/triage-route.test.ts`
Expected: FAIL — module `server/lib/triage/route` not found.

- [ ] **Step 4: Implement**

```ts
// server/lib/triage/route.ts
//
// PURE. No I/O, no db, no services — all triage policy lives here so it can be
// tested without a model or a database.
import type { TriageAction, TriageKind, TriageProposal } from '../../../shared/types/triage'

export type TriageThresholds = Record<TriageKind, number>

export interface RoutedAction {
  action: TriageAction
  autoApply: boolean
}

/**
 * Decide, per action, whether it applies now or waits for review.
 * Confidence alone decides. No destination categorically requires approval —
 * destinations differ only in where their bar sits.
 */
export function route(proposal: TriageProposal, thresholds: TriageThresholds): RoutedAction[] {
  const decide = (action: TriageAction): RoutedAction => ({
    action,
    // >= so a bar is a floor: an action exactly at 0.7 applies against a 0.7 bar.
    autoApply: action.confidence >= thresholds[action.kind]
  })
  return [proposal.primary, ...proposal.secondary].map(decide)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/triage-route.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the tests are not vacuous**

Change `>=` to `>` and re-run. Expected: the "exactly at its bar" test FAILS. Restore, re-run, PASS.

- [ ] **Step 7: Verify gates and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add server/lib/triage/route.ts test/triage-route.test.ts nuxt.config.ts
git commit -m "feat(triage): pure routing policy and per-destination thresholds"
```

---

### Task 4: `buildTriageMessages` + `classify()`

**Files:**
- Modify: `server/lib/ai/triage.ts`
- Test: `test/triage-prompt.test.ts`

**Interfaces:**
- Consumes: `ProjectCandidate` from `server/lib/ai/enrich.ts`; `chat` from `server/lib/ai/chat`.
- Produces: `buildTriageMessages(doc, projects): Array<{role, content}>`; `classify(doc, projects): Promise<TriageProposal | null>`.

**Context:** Read `buildEnrichMessages` in `server/lib/ai/enrich.ts` first — this mirrors its shape (system prompt + injected project list + a `Path:`/`Content:` user message, content sliced to 6000 chars). Use `chat('bulk', …)` at `temperature: 0.1`. **Do not use the `reasoning` alias** — the existing code documents why: it emits `<think>`/`reasoning_content` and returns null content under the token cap, which `chat()` throws on.

- [ ] **Step 1: Write the failing tests**

```ts
// test/triage-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildTriageMessages } from '../server/lib/ai/triage'

const doc = { path: '/input/abc123.md', content: 'remind me to fix the yukon loan link' }
const projects = [
  { slug: 'finances', name: 'Finances', description: 'money' },
  { slug: '2d-rpg', name: '2D RPG', description: 'game' }
]

describe('buildTriageMessages', () => {
  it('emits a system message then a user message', () => {
    const m = buildTriageMessages(doc, projects)
    expect(m).toHaveLength(2)
    expect(m[0]!.role).toBe('system')
    expect(m[1]!.role).toBe('user')
  })

  it('names all four destinations in the system prompt', () => {
    const s = buildTriageMessages(doc, projects)[0]!.content
    for (const k of ['task', 'note', 'memory', 'append']) expect(s).toContain(k)
  })

  it('injects the available project slugs', () => {
    const s = buildTriageMessages(doc, projects)[0]!.content
    expect(s).toContain('finances')
    expect(s).toContain('2d-rpg')
  })

  it('instructs the model to use null when no project fits', () => {
    expect(buildTriageMessages(doc, projects)[0]!.content).toContain('null')
  })

  it('tells the model to set project null when there are no projects', () => {
    const s = buildTriageMessages(doc, [])[0]!.content
    expect(s).toContain('No projects')
  })

  it('puts the path and content in the user message', () => {
    const u = buildTriageMessages(doc, projects)[1]!.content
    expect(u).toContain('/input/abc123.md')
    expect(u).toContain('yukon loan link')
  })

  it('truncates long content to 6000 characters', () => {
    const u = buildTriageMessages({ path: '/input/x.md', content: 'y'.repeat(9000) }, projects)[1]!.content
    expect(u).toContain('y'.repeat(6000))
    expect(u).not.toContain('y'.repeat(6001))
  })

  // The filename is the whole point of the Note destination — the old enrichment
  // prompt said "keep the existing filename", which is why /input stayed unbrowsable.
  it('tells the model that a note path must include a NEW filename', () => {
    const s = buildTriageMessages(doc, projects)[0]!.content
    expect(s.toLowerCase()).toContain('filename')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/triage-prompt.test.ts`
Expected: FAIL — `buildTriageMessages` is not exported.

- [ ] **Step 3: Implement**

Append to `server/lib/ai/triage.ts`:

```ts
import { chat } from './chat'
import type { ProjectCandidate } from './enrich'

const TRIAGE_SYSTEM_PROMPT = `You triage a single captured note in a personal knowledge base and decide WHERE it belongs. Reply with STRICT JSON only, no prose.

Choose a "kind" for the primary action:
- "task"   — the note asks for something to be DONE. Set title (imperative, concise), priority (low|medium|high), and dueDate (ISO date) only if the note states one.
- "note"   — the note is reference material worth keeping as a document. Set title, and set path to a NEW destination path that moves it out of /input. The path MUST include a new, human-readable filename (kebab-case, .md) — never reuse the incoming random filename.
- "memory" — a durable fact, preference, or gotcha worth recalling in future sessions. Set content to one self-contained sentence and scope to user|agent|world.
- "append" — the note adds to a topic an existing document already covers. Set content to the text to append. Do NOT guess a target document; it is resolved separately.

Also set "confidence" (0..1) on every action: how sure you are that this is the right destination. Be honest — a low score routes to a human instead of acting.

If the note carries a second, genuinely distinct intent (for example an action AND a durable fact), add it to "secondary" (at most 2). If it does not, return an empty array.

Shape:
{"primary":{"kind":"...","confidence":0.0,...},"secondary":[],"reasoning":"one sentence"}`

export function buildTriageMessages(
  doc: { path: string, content: string },
  projects: ProjectCandidate[]
): Array<{ role: 'system' | 'user', content: string }> {
  let system = TRIAGE_SYSTEM_PROMPT

  if (projects.length > 0) {
    const list = projects.map(p => `  ${p.slug} — ${p.name} — ${p.description}`).join('\n')
    system += `\n\nAvailable projects (slug — name — description):\n${list}\n\nSet "project" to the single best-matching SLUG from this list, or null if none clearly fits. For a "note", if you chose a project, path must be /projects/<slug>/<new-filename>.md.`
  } else {
    system += `\n\nNo projects are available. Set project to null.`
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Path: ${doc.path}\n\nContent:\n${doc.content.slice(0, 6000)}` }
  ]
}

/** One bulk-model call. Returns null on any AI or parse failure — the caller decides what that means. */
export async function classify(
  doc: { path: string, content: string },
  projects: ProjectCandidate[]
): Promise<TriageProposal | null> {
  try {
    // 'bulk' = the no-think model. The reasoning alias emits <think>/reasoning_content
    // and returns null content under the token cap, which chat() throws on.
    const raw = await chat('bulk', buildTriageMessages(doc, projects), { temperature: 0.1 })
    return parseTriage(raw)
  } catch (err) {
    console.warn('[triage] classify failed:', err)
    return null
  }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm vitest run test/triage-prompt.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify gates and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add server/lib/ai/triage.ts test/triage-prompt.test.ts
git commit -m "feat(triage): classifier prompt and classify()"
```

---

### Task 5: Task + Note actuators

**Files:**
- Create: `server/services/triage.ts`
- Test: `test/triage-actuators.db.test.ts`

**Interfaces:**
- Consumes: `createTask` (`server/services/tasks.ts`), `getDoc`/`moveDoc`/`updateDoc`/`deleteDoc`/`restoreDoc` (`server/services/documents.ts`), `registerUndo` (`server/lib/agent/undo.ts`), `publishChange` (`server/utils/live-bus.ts`), `triageActions` schema.
- Produces:
  - `applyTask(docId, action): Promise<AppliedAction>`
  - `applyNote(docId, action): Promise<AppliedAction>`
  - `type AppliedAction = { actionRowId: string, entityType: 'task'|'memory'|'document', entityId: string | null, undoToken: string }`

**Exact signatures to code against** (verified — do not guess):
- `createTask(input: { title: string, description?: string, status?: TaskStatus, priority?: TaskPriority, dueDate?: Date | null, project?: string | null, order?: number }): Promise<TaskDTO>`
- `moveDoc(id: string, newPath: string)` — thin wrapper over `updateDoc(id, { path })`. **Use this for the rename**; `project`/`project_id` derive from `path` on write, so never set them directly.
- `deleteDoc(id: string): Promise<boolean>` — soft (sets `deleted_at`). `restoreDoc(id: string): Promise<boolean>` — clears it.
- `publishChange({ resource, action, id })` with `resource` **singular**: `'task' | 'document' | 'memory' | 'review'`.

- [ ] **Step 1: Write the failing DB tests**

```ts
// test/triage-actuators.db.test.ts
import { describe, it, expect } from 'vitest'
import { applyTask, applyNote } from '../server/services/triage'
import { createDoc, getDoc } from '../server/services/documents'
import { useDb } from '../server/db'
import { tasks, triageActions } from '../server/db/schema'
import { eq } from 'drizzle-orm'
import { runUndo } from '../server/lib/agent/undo'

const jot = (content: string) =>
  createDoc({ path: `/input/t-${Math.random().toString(36).slice(2, 10)}.md`, content })

describe('applyTask', () => {
  it('creates a task carrying the raw jot as its description', async () => {
    const doc = await jot('remind me to fix the yukon loan link')
    const r = await applyTask(doc.id, {
      kind: 'task', confidence: 0.9, title: 'Fix the Yukon loan link',
      project: 'finances', priority: 'medium'
    })
    const [t] = await useDb().select().from(tasks).where(eq(tasks.id, r.entityId!))
    expect(t!.title).toBe('Fix the Yukon loan link')
    expect(t!.description).toContain('remind me to fix the yukon loan link')
    expect(t!.project).toBe('finances')
    expect(t!.priority).toBe('medium')
    expect(t!.status).toBe('todo')
  })

  it('soft-deletes the courier document', async () => {
    const doc = await jot('do the thing')
    await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Do the thing' })
    expect(await getDoc(doc.id)).toBeNull()          // getDoc filters deleted_at
  })

  it('records a triage_actions row', async () => {
    const doc = await jot('another thing')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.91, title: 'Another thing' })
    const [row] = await useDb().select().from(triageActions).where(eq(triageActions.id, r.actionRowId))
    expect(row!.kind).toBe('task')
    expect(row!.entityType).toBe('task')
    expect(row!.confidence).toBeCloseTo(0.91)
  })

  it('undo removes the task and restores the document', async () => {
    const doc = await jot('undo me')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Undo me' })
    expect((await runUndo(r.undoToken)).ok).toBe(true)
    expect(await useDb().select().from(tasks).where(eq(tasks.id, r.entityId!))).toHaveLength(0)
    expect(await getDoc(doc.id)).not.toBeNull()
  })
})

describe('applyNote', () => {
  it('renames the file and moves it out of /input', async () => {
    const doc = await jot('# Postgres HNSW notes\nef_search matters.')
    const r = await applyNote(doc.id, {
      kind: 'note', confidence: 0.9, title: 'Postgres HNSW notes',
      project: 'mymind', path: '/projects/mymind/postgres-hnsw-notes.md'
    })
    const moved = await getDoc(r.entityId!)
    expect(moved!.path).toBe('/projects/mymind/postgres-hnsw-notes.md')
    expect(moved!.title).toBe('Postgres HNSW notes')
    expect(moved!.path.startsWith('/input/')).toBe(false)
  })

  // The document IS the artifact for a note — it must survive, unlike the courier case.
  it('does NOT delete the document', async () => {
    const doc = await jot('keep me')
    const r = await applyNote(doc.id, {
      kind: 'note', confidence: 0.9, title: 'Keep me', path: '/notes/keep-me.md'
    })
    expect(await getDoc(r.entityId!)).not.toBeNull()
  })

  it('derives the project from the destination path', async () => {
    const doc = await jot('project note')
    const r = await applyNote(doc.id, {
      kind: 'note', confidence: 0.9, title: 'Project note', path: '/projects/mymind/project-note.md'
    })
    expect((await getDoc(r.entityId!))!.project).toBe('mymind')
  })

  it('undo moves the document back to its original path', async () => {
    const doc = await jot('move me back')
    const original = doc.path
    const r = await applyNote(doc.id, {
      kind: 'note', confidence: 0.9, title: 'Move me back', path: '/notes/move-me-back.md'
    })
    expect((await runUndo(r.undoToken)).ok).toBe(true)
    expect((await getDoc(doc.id))!.path).toBe(original)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:db -- test/triage-actuators.db.test.ts`
Expected: FAIL — `server/services/triage` does not export `applyTask`.

- [ ] **Step 3: Implement both actuators**

```ts
// server/services/triage.ts
import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { triageActions, documents } from '../db/schema'
import { createTask } from './tasks'
import { getDoc, moveDoc, updateDoc, deleteDoc, restoreDoc } from './documents'
import { registerUndo } from '../lib/agent/undo'
import { publishChange } from '../utils/live-bus'
import { deleteTask } from './tasks'
import type { TriageAction } from '../../shared/types/triage'

export interface AppliedAction {
  actionRowId: string
  entityType: 'task' | 'memory' | 'document'
  entityId: string | null
  undoToken: string
}

async function recordAction(input: {
  docId: string, action: TriageAction, entityType: AppliedAction['entityType'],
  entityId: string | null, autoApplied: boolean
}): Promise<string> {
  const [row] = await useDb().insert(triageActions).values({
    docId: input.docId,
    kind: input.action.kind,
    entityType: input.entityType,
    entityId: input.entityId,
    confidence: input.action.confidence,
    autoApplied: input.autoApplied,
    payload: input.action as unknown as Record<string, unknown>
  }).returning({ id: triageActions.id })
  return row!.id
}

/** The jot becomes a task; the document was only a courier, so it is soft-deleted. */
export async function applyTask(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)

  const task = await createTask({
    title: action.title ?? doc.title ?? 'Untitled task',
    description: doc.content,                      // the raw jot, verbatim
    project: action.project ?? null,
    priority: action.priority ?? 'low',
    dueDate: action.dueDate ? new Date(action.dueDate) : null
  })

  await deleteDoc(docId)

  const actionRowId = await recordAction({ docId, action, entityType: 'task', entityId: task.id, autoApplied })

  publishChange({ resource: 'task', action: 'created', id: task.id })
  publishChange({ resource: 'document', action: 'deleted', id: docId })

  const undoToken = registerUndo(async () => {
    await deleteTask(task.id)
    await restoreDoc(docId)
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'task', action: 'deleted', id: task.id })
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'task', entityId: task.id, undoToken }
}

/** The document IS the artifact: retitle, rename, and move it out of /input. */
export async function applyNote(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)
  const originalPath = doc.path

  if (action.title) await updateDoc(docId, { title: action.title })
  // moveDoc, not a direct column write — project/project_id derive from path.
  if (action.path && action.path !== originalPath) await moveDoc(docId, action.path)

  // originalPath rides in the payload because the DURABLE reversal path (Task 12) has no
  // access to this closure — registerUndo's state dies with the process, and its token
  // expires after 10 minutes. Without this, an undo the next day cannot restore the path.
  const actionRowId = await recordAction({
    docId, action: { ...action, originalPath } as TriageAction, entityType: 'document',
    entityId: docId, autoApplied
  })

  publishChange({ resource: 'document', action: 'updated', id: docId })

  const undoToken = registerUndo(async () => {
    await moveDoc(docId, originalPath)
    await updateDoc(docId, { title: doc.title })
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'document', entityId: docId, undoToken }
}
```

> `deleteTask(id: string): Promise<boolean>` is verified to exist at `server/services/tasks.ts:177`. Use it. Do **not** write a raw `db.delete(tasks)` in `triage.ts` — task deletion carries side effects (audit log) that a direct delete would skip.

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test:db -- test/triage-actuators.db.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the tests are not vacuous**

Comment out the `await deleteDoc(docId)` line in `applyTask` and re-run. Expected: "soft-deletes the courier document" FAILS. Restore.
Change `moveDoc(docId, action.path)` to a no-op and re-run. Expected: the rename tests FAIL. Restore.

- [ ] **Step 6: Verify gates and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add server/services/triage.ts test/triage-actuators.db.test.ts
git commit -m "feat(triage): task and note actuators"
```

---

### Task 6: Memory actuator

**Files:**
- Modify: `server/services/triage.ts`
- Modify: `test/triage-actuators.db.test.ts`

**Interfaces:**
- Consumes: `createMemory` (`server/services/memory.ts`).
- Produces: `applyMemory(docId, action, autoApplied?): Promise<AppliedAction>`.

**BINDING CONSTRAINT — read before writing code.** `applyMemory` **must** call `createMemory()`. It must **never** insert into the `memories` table directly. `createMemory` already runs `buildDedupCandidates` + `dedupDecision` (returning skip / merge / insert) and applies `shouldAutoReview` against `memoryAutoReviewThreshold`. Calling it is what buys dedup; a raw insert is exactly how dedup gets bypassed, and task `f80622b9` (dedup under-catching) is open. If `createMemory` seems awkward here, **escalate — do not hand-roll the insert.**

`CreateMemoryInput` (verified): `{ content: string, scope?: MemoryScope, tags?: string[], source?: string, project?: string | null, sessionId?: string | null, confidence?: number | null, evidence?: unknown[], reviewed?: boolean }`.

Note that `createMemory` may return an **existing** memory when dedup decides skip/merge. That is correct behaviour, and the actuator must handle it — see the test below.

- [ ] **Step 1: Write the failing tests**

Append to `test/triage-actuators.db.test.ts`:

```ts
import { applyMemory } from '../server/services/triage'
import { memories } from '../server/db/schema'

describe('applyMemory', () => {
  it('creates a memory with the triage source and confidence', async () => {
    const doc = await jot('Pangolin drops websocket upgrades over 60s idle')
    const r = await applyMemory(doc.id, {
      kind: 'memory', confidence: 0.88, scope: 'agent', project: 'homelab',
      content: 'Pangolin drops websocket upgrades after 60s idle.'
    })
    const [m] = await useDb().select().from(memories).where(eq(memories.id, r.entityId!))
    expect(m!.content).toContain('Pangolin')
    expect(m!.project).toBe('homelab')
    expect(m!.source).toBe(`triage:${doc.id}`)
    expect(Number(m!.confidence)).toBeCloseTo(0.88)
  })

  it('soft-deletes the courier document', async () => {
    const doc = await jot('a durable fact')
    await applyMemory(doc.id, { kind: 'memory', confidence: 0.9, content: 'A durable fact.' })
    expect(await getDoc(doc.id)).toBeNull()
  })

  // createMemory returns the EXISTING row when dedup decides skip/merge. The actuator
  // must not crash, must not double-insert, and must still record its action row.
  it('handles the dedup skip path without creating a second memory', async () => {
    const content = `dedup probe ${Math.random()}`
    const d1 = await jot('first')
    const r1 = await applyMemory(d1.id, { kind: 'memory', confidence: 0.9, content })
    const d2 = await jot('second')
    const r2 = await applyMemory(d2.id, { kind: 'memory', confidence: 0.9, content })
    expect(r2.entityId).toBe(r1.entityId)                        // same memory, deduped
    const rows = await useDb().select().from(memories).where(eq(memories.id, r1.entityId!))
    expect(rows).toHaveLength(1)
    expect(r2.actionRowId).not.toBe(r1.actionRowId)              // but both actions recorded
  })

  it('undo archives the memory and restores the document', async () => {
    const doc = await jot('undo the memory')
    const r = await applyMemory(doc.id, {
      kind: 'memory', confidence: 0.9, content: `undo probe ${Math.random()}`
    })
    expect((await runUndo(r.undoToken)).ok).toBe(true)
    const [m] = await useDb().select().from(memories).where(eq(memories.id, r.entityId!))
    expect(m!.archivedAt).not.toBeNull()
    expect(await getDoc(doc.id)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:db -- test/triage-actuators.db.test.ts`
Expected: FAIL — `applyMemory` is not exported.

- [ ] **Step 3: Implement**

Append to `server/services/triage.ts`:

```ts
import { createMemory } from './memory'
import { memories } from '../db/schema'

/**
 * The jot becomes a durable memory; the document was a courier, so it is soft-deleted.
 *
 * MUST go through createMemory() — it owns dedup (buildDedupCandidates + dedupDecision:
 * skip | merge | insert) and shouldAutoReview. A direct insert here would silently
 * bypass dedup, and enrich-memories dedup under-catching (task f80622b9) is still open.
 * createMemory may return an EXISTING memory on the skip/merge paths; that is correct.
 */
export async function applyMemory(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)

  const memory = await createMemory({
    content: action.content ?? doc.content,
    scope: action.scope ?? 'user',
    project: action.project ?? null,
    tags: action.tags ?? [],
    confidence: action.confidence,
    source: `triage:${docId}`
  })

  await deleteDoc(docId)

  const actionRowId = await recordAction({ docId, action, entityType: 'memory', entityId: memory.id, autoApplied })

  publishChange({ resource: 'memory', action: 'created', id: memory.id })
  publishChange({ resource: 'document', action: 'deleted', id: docId })

  const undoToken = registerUndo(async () => {
    // Archive rather than hard-delete: dedup may have MERGED into a pre-existing
    // memory, and destroying that row would take unrelated evidence with it.
    await useDb().update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, memory.id))
    await restoreDoc(docId)
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'memory', action: 'updated', id: memory.id })
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'memory', entityId: memory.id, undoToken }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test:db -- test/triage-actuators.db.test.ts`
Expected: PASS, 12 tests total in the file.

- [ ] **Step 5: Verify gates and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add server/services/triage.ts test/triage-actuators.db.test.ts
git commit -m "feat(triage): memory actuator via createMemory (dedup-preserving)"
```

---

### Task 7: `triageCapture()` orchestrator + idempotency

**Files:**
- Modify: `server/services/triage.ts`
- Test: `test/triage-idempotency.db.test.ts`

**Interfaces:**
- Consumes: `classify` (`server/lib/ai/triage`), `route` (`server/lib/triage/route`), the three actuators, `reviewQueue` schema.
- Produces: `triageCapture(docId: string): Promise<TriageOutcome>`.

**Context:** Two callers can race — the immediate fire-and-forget path and the cron sweeper. The claim is a conditional UPDATE (`where triaged_at is null`) taken **before** the model call; losing it returns `{ skipped: 'already-triaged' }` rather than throwing. Note the existing partial unique index `review_queue_one_pending_per_doc` on `doc_id where status = 'pending'` — a proposal is **one row containing all queued actions**, never one row per action.

- [ ] **Step 1: Write the failing tests**

```ts
// test/triage-idempotency.db.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDoc } from '../server/services/documents'
import { useDb } from '../server/db'
import { reviewQueue, triageActions, documents } from '../server/db/schema'
import { eq } from 'drizzle-orm'

// Stub the model — this test is about orchestration, not classification quality.
vi.mock('../server/lib/ai/triage', async (orig) => ({
  ...(await orig<typeof import('../server/lib/ai/triage')>()),
  classify: vi.fn(async () => ({
    primary: { kind: 'task' as const, confidence: 0.95, title: 'Stubbed task' },
    secondary: [], reasoning: 'stub'
  }))
}))

const { triageCapture } = await import('../server/services/triage')
const { classify } = await import('../server/lib/ai/triage')

const jot = () => createDoc({ path: `/input/i-${Math.random().toString(36).slice(2, 10)}.md`, content: 'do a thing' })

beforeEach(() => vi.clearAllMocks())

describe('triageCapture idempotency', () => {
  it('claims the document by stamping triaged_at', async () => {
    const doc = await jot()
    await triageCapture(doc.id)
    const [row] = await useDb().select().from(documents).where(eq(documents.id, doc.id))
    expect(row!.triagedAt).not.toBeNull()
  })

  // The immediate path and the sweeper CAN both fire for the same doc.
  it('runs the model exactly once across two concurrent invocations', async () => {
    const doc = await jot()
    const [a, b] = await Promise.all([triageCapture(doc.id), triageCapture(doc.id)])
    expect(vi.mocked(classify)).toHaveBeenCalledTimes(1)
    const skipped = [a, b].filter(r => r.skipped === 'already-triaged')
    expect(skipped).toHaveLength(1)
  })

  it('produces exactly one set of actions for a double invocation', async () => {
    const doc = await jot()
    await triageCapture(doc.id)
    await triageCapture(doc.id)
    const rows = await useDb().select().from(triageActions).where(eq(triageActions.docId, doc.id))
    expect(rows).toHaveLength(1)
  })

  it('returns already-triaged for a second sequential call', async () => {
    const doc = await jot()
    await triageCapture(doc.id)
    expect((await triageCapture(doc.id)).skipped).toBe('already-triaged')
  })
})

describe('triageCapture queueing', () => {
  it('queues ONE review row holding every below-bar action', async () => {
    vi.mocked(classify).mockResolvedValueOnce({
      primary: { kind: 'task', confidence: 0.1, title: 'Unsure' },
      secondary: [{ kind: 'memory', confidence: 0.1, content: 'also unsure' }],
      reasoning: 'stub'
    })
    const doc = await jot()
    const out = await triageCapture(doc.id)
    expect(out.queued).toBe(true)
    const rows = await useDb().select().from(reviewQueue).where(eq(reviewQueue.docId, doc.id))
    expect(rows).toHaveLength(1)                 // one pending row per doc — enforced by a unique index
    expect(rows[0]!.kind).toBe('triage')
  })

  it('still stamps triaged_at when the model fails, so it is not retried forever', async () => {
    vi.mocked(classify).mockResolvedValueOnce(null)
    const doc = await jot()
    expect((await triageCapture(doc.id)).skipped).toBe('parse-failed')
    const [row] = await useDb().select().from(documents).where(eq(documents.id, doc.id))
    expect(row!.triagedAt).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:db -- test/triage-idempotency.db.test.ts`
Expected: FAIL — `triageCapture` is not exported.

- [ ] **Step 3: Implement**

Append to `server/services/triage.ts`:

```ts
import { and, isNull } from 'drizzle-orm'
import { reviewQueue, projects as projectsTable } from '../db/schema'
import { classify } from '../lib/ai/triage'
import { route } from '../lib/triage/route'
import type { TriageOutcome, TriageAction } from '../../shared/types/triage'

/** Conditional claim. Returns false if another caller already owns this document. */
async function claim(docId: string): Promise<boolean> {
  const rows = await useDb().update(documents)
    .set({ triagedAt: new Date() })
    .where(and(eq(documents.id, docId), isNull(documents.triagedAt)))
    .returning({ id: documents.id })
  return rows.length > 0
}

const APPLY: Record<TriageAction['kind'], (docId: string, a: TriageAction) => Promise<AppliedAction>> = {
  task: applyTask,
  note: applyNote,
  memory: applyMemory,
  append: applyNote   // replaced by applyAppend in Task 10
}

export async function triageCapture(docId: string): Promise<TriageOutcome> {
  // Claim BEFORE the model call so a racing caller cannot also pay for one.
  if (!await claim(docId)) return { docId, applied: [], queued: false, skipped: 'already-triaged' }

  const doc = await getDoc(docId)
  if (!doc) return { docId, applied: [], queued: false, skipped: 'already-triaged' }

  const activeProjects = (await useDb()
    .select({ slug: projectsTable.slug, name: projectsTable.name, description: projectsTable.description })
    .from(projectsTable)
    .where(eq(projectsTable.active, true)))
    .filter(p => p.slug !== 'uncategorized')

  const proposal = await classify({ path: doc.path, content: doc.content }, activeProjects)
  // triaged_at STAYS stamped on failure: retrying a doc the model cannot parse on every
  // sweep would burn tokens forever. The sweeper's job is coverage, not retry-until-success.
  if (!proposal) return { docId, applied: [], queued: false, skipped: 'parse-failed' }

  const thresholds = useRuntimeConfig().triageThresholds as Record<TriageAction['kind'], number>
  const routed = route(proposal, thresholds)

  const applied: TriageAction[] = []
  const queued: TriageAction[] = []

  for (const { action, autoApply } of routed) {
    if (!autoApply) { queued.push(action); continue }
    // A note/append rewrites or removes the source document, so once one of those has
    // applied, later actions in the same proposal have no courier left to consume.
    try {
      await APPLY[action.kind](docId, action)
      applied.push(action)
    } catch (err) {
      console.warn(`[triage] actuator ${action.kind} failed for ${docId}:`, err)
      queued.push(action)
    }
  }

  if (queued.length > 0) {
    // ONE row per document — review_queue_one_pending_per_doc is a partial unique index.
    await useDb().insert(reviewQueue).values({
      docId,
      kind: 'triage',
      proposed: { primary: proposal.primary, secondary: proposal.secondary,
                  reasoning: proposal.reasoning, queued, applied } as unknown as Record<string, unknown>
    }).onConflictDoNothing()
    publishChange({ resource: 'review', action: 'created', id: docId })
  }

  return { docId, applied, queued: queued.length > 0 }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test:db -- test/triage-idempotency.db.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the idempotency test is not vacuous**

Change `claim()` to `return true` unconditionally and re-run. Expected: "runs the model exactly once" FAILS with 2 calls. Restore, re-run, PASS. **This is the single most important vacuity check in the plan** — an idempotency test that passes against a broken claim is worse than no test.

- [ ] **Step 6: Verify gates and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add server/services/triage.ts test/triage-idempotency.db.test.ts
git commit -m "feat(triage): triageCapture orchestrator with a conditional claim"
```

---

### Task 8: Wire triage into the capture endpoints

**Files:**
- Modify: `server/api/capture/note.post.ts`
- Modify: `server/api/capture/transcribe.post.ts`

**Interfaces:**
- Consumes: `triageCapture` from `server/services/triage`.
- Produces: no new exports. Capture responses are unchanged.

**Context:** Capture must keep returning at write speed — the spec's first locked decision is that capture never blocks. Fire and forget; never `await` triage in the request path. A triage failure must never fail the capture, so the promise needs a `.catch`.

- [ ] **Step 1: Fire triage after the document is created**

In `server/api/capture/note.post.ts`, after `createDoc(...)` returns and **before** the handler returns its response:

```ts
  // Fire-and-forget: capture must return at write speed (spec: capture never blocks).
  // A triage failure must never fail the capture, hence the catch. The cron sweeper
  // (server/tasks/triage-input.ts) is the backstop if this never runs.
  void triageCapture(doc.id).catch(err => console.warn('[capture] triage failed:', err))
```

with `import { triageCapture } from '../../services/triage'` at the top.

- [ ] **Step 2: Do the same in the transcribe endpoint**

Apply the identical two lines in `server/api/capture/transcribe.post.ts`, after its `createDoc` call.

- [ ] **Step 3: Verify capture is still synchronous**

Run: `pnpm typecheck && pnpm test`
Then start the dev server and time the endpoint:

```bash
pnpm dev   # in a background shell
```

- [ ] **Step 4: Browser-validate the full path**

**Invoke the `browser-testing` skill first** for the login flow and the authenticated-fetch pattern. Then, with thresholds at the shipped `1.1`, every proposal must queue rather than apply:

```bash
playwright-cli eval "async () => {
  const t0 = performance.now()
  const r = await fetch('/api/capture/note', { method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ text: 'remind me to renew the domain in March' }) }).then(r=>r.json())
  return { ms: Math.round(performance.now() - t0), id: r.id }
}"
```

Expected: `ms` in the low hundreds — capture did not wait on a model call. Then, after ~10s, confirm a pending `triage` review row exists for that doc id via `/api/review`.

- [ ] **Step 5: Commit**

```bash
git add server/api/capture/
git commit -m "feat(triage): fire triage after note and transcribe capture"
```

---

### Task 9: Cron sweeper + retire `enrich-input`

**Files:**
- Create: `server/tasks/triage-input.ts`
- Delete: `server/tasks/enrich-input.ts`
- Modify: `nuxt.config.ts` (`scheduledTasks`)
- Modify: `server/services/triage.ts` (add `sweepUntriaged`)

**Interfaces:**
- Consumes: `triageCapture`.
- Produces: `sweepUntriaged({ limit }): Promise<{ triaged: number, skipped: number }>`.

**Context:** This is the fix for the drain problem. The old candidate query required `project IS NULL`, empty `tags`, **and** no `review_queue` row in *any* status — so a document was eligible exactly once, ever. The new one is simply: live, under `/input/`, `triaged_at IS NULL`.

`enrich-input`'s population (`path LIKE '/input/%'`) is exactly the population triage now owns, and the Note actuator subsumes what it proposed. Two pipelines writing frontmatter to the same documents under different rules is a bug waiting to happen, so it goes. The `enrichment` kind stays readable in `/review` for historical rows — do **not** delete `proposeFrontmatter`, `buildEnrichMessages`, or `parseProposal` from `server/lib/ai/enrich.ts`; `ProjectCandidate` is imported from there by `server/lib/ai/triage.ts`, and the existing tests still cover it.

- [ ] **Step 1: Add the sweeper**

Append to `server/services/triage.ts`:

```ts
import { sql } from 'drizzle-orm'

/**
 * Backstop for anything the immediate post-capture path missed: server restart
 * mid-flight, model timeout, MCP quick_capture, direct POST /api/documents.
 *
 * Candidates are simply "live /input docs not yet triaged" — deliberately NOT the
 * old enrich-input filter (project IS NULL AND tags = '{}' AND no review_queue row),
 * which made a document eligible exactly once ever and left /input unable to drain.
 */
export async function sweepUntriaged({ limit = 20 }: { limit?: number } = {}) {
  const candidates = await useDb().select({ id: documents.id })
    .from(documents)
    .where(and(
      isNull(documents.deletedAt),
      isNull(documents.triagedAt),
      sql`${documents.path} LIKE '/input/%'`
    ))
    .limit(limit)

  let triaged = 0
  let skipped = 0
  for (const c of candidates) {
    const out = await triageCapture(c.id)
    if (out.skipped) skipped++
    else triaged++
  }
  return { triaged, skipped }
}
```

- [ ] **Step 2: Add the task**

```ts
// server/tasks/triage-input.ts
import { sweepUntriaged } from '../services/triage'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'triage-input', description: 'Triage untriaged /input captures (backstop for the immediate path)' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'triage-input' }, async () => {
      const r = await sweepUntriaged({ limit: 20 })
      recordJobSummary('triage-input', r as unknown as Record<string, unknown>)
      return r
    })
    return { result }
  }
})
```

- [ ] **Step 3: Swap the schedule**

In `nuxt.config.ts`, replace the `enrich-input` entry:

```ts
      '*/10 * * * *': ['triage-input'],
```

Verify no other schedule entry still references `enrich-input`.

- [ ] **Step 4: Delete the retired task**

```bash
git rm server/tasks/enrich-input.ts
```

Then confirm nothing else imports it:

```bash
grep -rn "enrich-input" --include=*.ts --include=*.vue . | grep -v node_modules | grep -v docs/
```

Expected: no source hits (`runEnrichInput` in `server/services/enrichment.ts` may remain unreferenced; leave it and its tests alone — removing it is out of scope for this task).

- [ ] **Step 5: Verify gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all clean. The build is the gate that catches a `scheduledTasks` entry pointing at a task file that no longer exists.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(triage): sweeper replaces enrich-input; /input can finally drain"
```

---

### Task 10: Append actuator

**Files:**
- Modify: `server/services/triage.ts`
- Modify: `test/triage-actuators.db.test.ts`

**Interfaces:**
- Consumes: `searchDocs` (`server/services/search.ts` or `server/services/documents.ts` — check which exports it), `embedOne`, `updateDoc`.
- Produces: `applyAppend(docId, action, autoApplied?): Promise<AppliedAction>`.

**Context:** Built last deliberately — it is the only actuator needing retrieval, and the only one that touches an existing document. Guardrails, all binding:

- **Append-only.** It appends a delimited block. It never rewrites, reorders, or deletes existing content.
- The block carries the capture date and source doc id.
- If no candidate clears `triageAppendSimilarityFloor` (default `0.75`), the action **degrades to a Note** rather than guessing a target.
- The model never picks the target; `targetDocId` is resolved here.

- [ ] **Step 1: Write the failing tests**

Append to `test/triage-actuators.db.test.ts`:

```ts
import { applyAppend } from '../server/services/triage'

describe('applyAppend', () => {
  it('appends a delimited block without touching existing content', async () => {
    const target = await createDoc({
      path: `/projects/mymind/append-target-${Math.random().toString(36).slice(2, 8)}.md`,
      content: '# Existing\n\nOriginal body that must survive.'
    })
    const doc = await jot('also: the reranker needs ef_search raised')
    const r = await applyAppend(doc.id, {
      kind: 'append', confidence: 0.9, content: 'The reranker needs ef_search raised.',
      targetDocId: target.id
    })
    const after = await getDoc(target.id)
    expect(after!.content).toContain('Original body that must survive.')   // untouched
    expect(after!.content).toContain('The reranker needs ef_search raised.')
    expect(after!.content.indexOf('Original body')).toBeLessThan(after!.content.indexOf('ef_search raised'))
    expect(r.entityId).toBe(target.id)
  })

  it('stamps the appended block with the source doc id', async () => {
    const target = await createDoc({
      path: `/projects/mymind/append-src-${Math.random().toString(36).slice(2, 8)}.md`, content: '# T'
    })
    const doc = await jot('a fact')
    await applyAppend(doc.id, { kind: 'append', confidence: 0.9, content: 'A fact.', targetDocId: target.id })
    expect((await getDoc(target.id))!.content).toContain(doc.id)
  })

  it('soft-deletes the courier document', async () => {
    const target = await createDoc({
      path: `/projects/mymind/append-del-${Math.random().toString(36).slice(2, 8)}.md`, content: '# T'
    })
    const doc = await jot('courier')
    await applyAppend(doc.id, { kind: 'append', confidence: 0.9, content: 'x', targetDocId: target.id })
    expect(await getDoc(doc.id)).toBeNull()
  })

  // The degrade path: no target means file it as a note rather than guess.
  it('degrades to a note when no target document is resolved', async () => {
    const doc = await jot('orphan thought with no home')
    const r = await applyAppend(doc.id, {
      kind: 'append', confidence: 0.9, content: 'Orphan thought.', title: 'Orphan thought'
    })
    expect(r.entityType).toBe('document')
    expect(r.entityId).toBe(doc.id)                       // the doc survived as the artifact
    expect(await getDoc(doc.id)).not.toBeNull()
  })

  it('undo removes the appended block and leaves the original content intact', async () => {
    const original = '# Existing\n\nUntouched.'
    const target = await createDoc({
      path: `/projects/mymind/append-undo-${Math.random().toString(36).slice(2, 8)}.md`, content: original
    })
    const doc = await jot('revert me')
    const r = await applyAppend(doc.id, {
      kind: 'append', confidence: 0.9, content: 'Revert me.', targetDocId: target.id
    })
    expect((await runUndo(r.undoToken)).ok).toBe(true)
    expect((await getDoc(target.id))!.content).toBe(original)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:db -- test/triage-actuators.db.test.ts`
Expected: FAIL — `applyAppend` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * The jot is added to a document that already covers the topic.
 *
 * APPEND-ONLY, and that is a hard constraint: it concatenates a delimited block and
 * never rewrites, reorders, or removes existing content. If no target is resolved it
 * DEGRADES TO A NOTE rather than guessing — a wrong append edits a document the user
 * never opened, which is the most expensive mistake this pipeline can make.
 */
export async function applyAppend(docId: string, action: TriageAction, autoApplied = true): Promise<AppliedAction> {
  const doc = await getDoc(docId)
  if (!doc) throw new Error(`triage: document ${docId} not found`)

  const targetId = action.targetDocId ?? await resolveAppendTarget(doc.content)
  if (!targetId) return applyNote(docId, { ...action, kind: 'note' }, autoApplied)

  const target = await getDoc(targetId)
  if (!target) return applyNote(docId, { ...action, kind: 'note' }, autoApplied)

  const previousContent = target.content
  const stamp = new Date().toISOString().slice(0, 10)
  const block = `\n\n<!-- triage:${docId} ${stamp} -->\n${action.content ?? doc.content}\n`
  await updateDoc(targetId, { content: previousContent + block })

  await deleteDoc(docId)

  // priorContent + appendedBlock ride in the payload so the DURABLE reversal path
  // (Task 12) can verify the target is byte-identical before restoring. The closure
  // below cannot help it: registerUndo's state dies with the process.
  const actionRowId = await recordAction({
    docId, action: { ...action, priorContent: previousContent, appendedBlock: block } as TriageAction,
    entityType: 'document', entityId: targetId, autoApplied
  })

  publishChange({ resource: 'document', action: 'updated', id: targetId })
  publishChange({ resource: 'document', action: 'deleted', id: docId })

  const undoToken = registerUndo(async () => {
    // Restore the exact prior body rather than string-subtracting the block —
    // the document may have been edited since, and a blind slice would corrupt it.
    const current = await getDoc(targetId)
    if (current && current.content === previousContent + block) {
      await updateDoc(targetId, { content: previousContent })
    }
    await restoreDoc(docId)
    await useDb().update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
    publishChange({ resource: 'document', action: 'updated', id: targetId })
    publishChange({ resource: 'document', action: 'updated', id: docId })
  })

  return { actionRowId, entityType: 'document', entityId: targetId, undoToken }
}
```

Then add `resolveAppendTarget` to the same file:

```ts
/**
 * Pick the document this jot belongs to, or null.
 *
 * This is the ONE place in triage that runs its own vector query, and that is
 * deliberate: searchDocs() fuses a trigram lane and a vector lane with RRF and returns
 * DocumentDTO[] ordered by fused RANK — it exposes no cosine score, so it cannot answer
 * "is the best match actually similar enough". The floor guardrail needs a real
 * similarity number, so we ask for one directly. Do NOT "simplify" this back to
 * searchDocs; that silently removes the guardrail.
 */
async function resolveAppendTarget(content: string): Promise<string | null> {
  const floor = useRuntimeConfig().triageAppendSimilarityFloor as number
  const vec = await embedOne(content)
  const [best] = await useDb()
    .select({
      id: documents.id,
      sim: sql<number>`1 - (${documents.embedding} <=> ${JSON.stringify(vec)}::halfvec)`
    })
    .from(documents)
    .where(and(
      isNull(documents.deletedAt),
      isNotNull(documents.embedding),
      sql`${documents.path} NOT LIKE '/input/%'`     // never append into the inbox itself
    ))
    .orderBy(sql`${documents.embedding} <=> ${JSON.stringify(vec)}::halfvec`)
    .limit(1)

  return best && best.sim >= floor ? best.id : null
}
```

`embedOne` comes from `server/services/embedding.ts` (it is what `searchDocs` uses); import
`isNotNull` from `drizzle-orm`. If the halfvec cast or the embedding column name differs from
what you find in `server/services/documents.ts`'s vector lane, copy that file's exact
expression rather than this one — it is the working reference.

- [ ] **Step 4: Wire it into the dispatch map**

In `triageCapture`, replace the placeholder:

```ts
  append: applyAppend
```

- [ ] **Step 5: Run to verify the tests pass**

Run: `pnpm test:db -- test/triage-actuators.db.test.ts`
Expected: PASS, 17 tests total.

- [ ] **Step 6: Prove the append-only guarantee is real**

Change the append line to `updateDoc(targetId, { content: block })` (a rewrite instead of an append) and re-run. Expected: "appends a delimited block without touching existing content" FAILS. Restore, re-run, PASS.

- [ ] **Step 7: Verify gates and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add server/services/triage.ts test/triage-actuators.db.test.ts
git commit -m "feat(triage): append-only actuator with note degradation"
```

---

### Task 11: Review kind handler map + `triage` rendering

**Files:**
- Create: `server/api/review/kinds.ts`
- Modify: `server/api/review/[id]/approve.post.ts`, `server/api/review/[id]/reject.post.ts`
- Modify: `app/pages/review.vue`

**Interfaces:**
- Consumes: `TriageProposal`; the three actuators.
- Produces: `approveHandlers: Record<string, (item: ReviewItem) => Promise<void>>` and `rejectHandlers` likewise.

**Context:** `approve.post.ts` is currently an `if (MEMORY_CONFLICT_KINDS.has(item.kind)) { … } else { …enrichment… }` chain. Adding a fourth kind to it as-is makes it worse. Extract a per-kind map first, move the existing branches into it **byte-for-byte**, prove the suite is still green, and only then add the `triage` handler. Refactor and feature in separate commits.

- [ ] **Step 1: Extract the existing branches into a handler map, changing no behaviour**

Create `server/api/review/kinds.ts` exporting `approveHandlers` / `rejectHandlers` keyed by `kind` (`'enrichment'`, `'memory-supersede'`, `'memory-contradict'`). Move the existing bodies across verbatim. Rewrite both endpoints to look up `handlers[item.kind]`, returning 400 for an unknown kind.

- [ ] **Step 2: Verify the refactor changed nothing**

Run: `pnpm typecheck && pnpm test`
Expected: the full suite passes with no test edits. **If any existing test needed changing, the refactor was not behaviour-preserving — revert and redo it.**

- [ ] **Step 3: Commit the refactor on its own**

```bash
git add server/api/review/
git commit -m "refactor(review): per-kind approve/reject handler map"
```

- [ ] **Step 4: Add the triage handlers**

Add a `'triage'` entry to both maps. Approve runs each queued action through its actuator (`applyTask` / `applyNote` / `applyMemory` / `applyAppend`, `autoApplied = false`) and marks the row approved. Reject marks it rejected and stamps `documents.triaged_at` so the sweeper does not immediately re-propose it. Both publish `{ resource: 'review', action: 'updated', id }`.

- [ ] **Step 5: Render the triage kind**

**Invoke the `nuxt-ui-docs` skill before writing any component markup.** In `app/pages/review.vue`, add a branch for `kind === 'triage'` alongside the existing `isMemoryConflict` branch, showing: the proposed destination per action, its confidence, the reasoning sentence, any already-auto-applied actions as read-only context, and Approve/Reject. Semantic tokens only. **Singular/plural must be explicit** — "1 action", "2 actions", never "1 actions".

- [ ] **Step 6: Browser-validate**

Invoke the `browser-testing` skill. Create a capture, wait for the pending `triage` row, load `/review`, and confirm: the row renders with its destination and confidence; Approve creates the entity (assert via authenticated fetch, not by eyeballing); the row leaves the queue; the sidebar Review badge decrements. Screenshot and read it.

- [ ] **Step 7: Commit**

```bash
git add server/api/review/ app/pages/review.vue
git commit -m "feat(review): render and resolve the triage kind"
```

---

### Task 12: Recently-applied strip + durable reversal

**Files:**
- Create: `server/api/triage/recent.get.ts`, `server/api/triage/[id]/revert.post.ts`
- Modify: `server/services/triage.ts` (add `revertTriageAction`)
- Modify: `app/pages/review.vue`
- Test: `test/triage-actuators.db.test.ts`

**Interfaces:**
- Produces: `revertTriageAction(actionRowId: string): Promise<{ ok: boolean, reason?: string }>`; `GET /api/triage/recent`; `POST /api/triage/[id]/revert`.

**Context:** With auto-apply as the norm, the undo toast is the main safety net — and `registerUndo`'s TTL is **10 minutes**, so a toast is useless an hour later. This reverses from the `triage_actions` row instead of a live token, so it still works the next day. It is a **feed, not a queue** — nothing here is waiting on the user, and it must not add to the Review badge.

- [ ] **Step 1: Write the failing test**

```ts
import { revertTriageAction } from '../server/services/triage'
import { restoreDoc } from '../server/services/documents'

describe('revertTriageAction (durable, post-TTL)', () => {
  it('reverses an applied task without a live undo token', async () => {
    const doc = await jot('durable revert')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Durable revert' })
    // Consume the token so only the durable path can possibly work.
    await runUndo(r.undoToken)
    await restoreDoc(doc.id)                       // undo the undo, back to applied-ish state
    const again = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Durable revert 2' })

    expect((await revertTriageAction(again.actionRowId)).ok).toBe(true)
    expect(await useDb().select().from(tasks).where(eq(tasks.id, again.entityId!))).toHaveLength(0)
    expect(await getDoc(doc.id)).not.toBeNull()
    const [row] = await useDb().select().from(triageActions).where(eq(triageActions.id, again.actionRowId))
    expect(row!.revertedAt).not.toBeNull()
  })

  it('is idempotent — a second revert is a no-op, not a crash', async () => {
    const doc = await jot('twice')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Twice' })
    expect((await revertTriageAction(r.actionRowId)).ok).toBe(true)
    const second = await revertTriageAction(r.actionRowId)
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('already')
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

```ts
/**
 * Reverse an applied action WITHOUT a live undo token.
 *
 * registerUndo's TTL is 10 minutes; with auto-apply as the norm, the user needs to be
 * able to reverse something they noticed the next day. This reverses from the persisted
 * triage_actions row instead.
 */
export async function revertTriageAction(actionRowId: string): Promise<{ ok: boolean, reason?: string }> {
  const db = useDb()
  const [row] = await db.select().from(triageActions).where(eq(triageActions.id, actionRowId)).limit(1)
  if (!row) return { ok: false, reason: 'that action no longer exists' }
  if (row.revertedAt) return { ok: false, reason: 'that action was already reverted' }

  const payload = row.payload as unknown as TriageAction

  try {
    if (row.entityType === 'task' && row.entityId) {
      await deleteTask(row.entityId)
      await restoreDoc(row.docId)
      publishChange({ resource: 'task', action: 'deleted', id: row.entityId })
    } else if (row.entityType === 'memory' && row.entityId) {
      // Archive, never hard-delete: dedup may have merged into a pre-existing memory.
      await db.update(memories).set({ archivedAt: new Date() }).where(eq(memories.id, row.entityId))
      await restoreDoc(row.docId)
      publishChange({ resource: 'memory', action: 'updated', id: row.entityId })
    } else if (row.entityType === 'document' && row.entityId) {
      if (row.kind === 'note') {
        // The doc IS the artifact — move it back to where it was captured.
        const original = (payload as TriageAction & { originalPath?: string }).originalPath
        if (original) await moveDoc(row.entityId, original)
      } else {
        // append — only revert if the target is byte-identical to what we wrote.
        const applied = (payload as TriageAction & { appendedBlock?: string, priorContent?: string })
        const current = await getDoc(row.entityId)
        if (current && applied.priorContent !== undefined && applied.appendedBlock !== undefined
            && current.content === applied.priorContent + applied.appendedBlock) {
          await updateDoc(row.entityId, { content: applied.priorContent })
        }
        await restoreDoc(row.docId)
      }
      publishChange({ resource: 'document', action: 'updated', id: row.entityId })
    }
  } catch (err) {
    // The reason is USER-FACING. Never interpolate a caught error into it: runUndo
    // leaked entire prior document bodies exactly that way, because a DrizzleQueryError
    // embeds its bound params in `message` (fixed 2026-08-16, commit 4a3792f).
    console.error('[triage] revert failed:', err)
    return { ok: false, reason: 'the reversal failed — check the item and undo it manually' }
  }

  await db.update(triageActions).set({ revertedAt: new Date() }).where(eq(triageActions.id, actionRowId))
  return { ok: true }
}
```

This depends on the payload fields Tasks 5 and 10 already record — `originalPath` on a note, `priorContent` + `appendedBlock` on an append. **Verify they are actually present** before implementing this step: `select payload from triage_actions limit 5` after running the Task 5/10 tests. If they are missing, fix the actuator rather than reconstructing them here — the durable path has no other source for them.

- [ ] **Step 3: Add the endpoints**

`GET /api/triage/recent` returns the 20 most recent non-reverted `triage_actions` rows from the last 7 days, newest first, each with its kind, entity type, title/summary, confidence, and timestamp. `POST /api/triage/[id]/revert` calls `revertTriageAction`.

- [ ] **Step 4: Render the strip**

**Invoke `nuxt-ui-docs` first.** Add a "Recently applied" section to `app/pages/review.vue`, visually distinct from the pending queue so it does not read as work. Each row: what happened, where it went, a relative timestamp, and an Undo button. Empty state: "Nothing applied automatically yet." Explicit singular/plural throughout.

- [ ] **Step 5: Browser-validate + commit**

Invoke `browser-testing`. Temporarily set the task threshold to `0.1` in `nuxt.config.ts` so an auto-apply actually happens, capture a jot, confirm the task appears on `/tasks` and the action appears in the strip, click Undo, confirm the task is gone and the document is back. **Restore the threshold to `1.1` before committing** and re-run `pnpm typecheck && pnpm test`.

```bash
git add server/api/triage/ server/services/triage.ts app/pages/review.vue test/
git commit -m "feat(triage): recently-applied feed with durable post-TTL reversal"
```

---

### Task 13: Fold memory review into `/review`

**Files:**
- Modify: `app/pages/review.vue`
- Modify: `app/pages/memories.vue`
- Modify: `server/api/review/index.get.ts`, `server/api/review/count.get.ts`

**Context:** `/memories` currently carries a parallel approval path — an "Unreviewed only" toggle and a "Mark reviewed" button keyed off `memories.reviewed_at`, separate from `review_queue`. That is why the sidebar shows both a Review badge (`reviewCount.pending`) and a Memory badge (`memoryCount.unreviewed`). Surface unreviewed memories in `/review` so there is one place to check. Keep the `/memories` **filter** as a view; move the **approval action**.

- [ ] **Step 1: Include unreviewed memories in the review feed**

Extend `/api/review` to return unreviewed memories as synthetic items of kind `memory-unreviewed` (they are not `review_queue` rows), and include them in `/api/review/count`'s `pending`. Keep the shapes discriminated so the page can render each kind.

- [ ] **Step 2: Render them and wire Mark-reviewed**

**Invoke `nuxt-ui-docs` first.** Add a `memory-unreviewed` branch reusing the existing `reviewMemory(id)` composable action.

- [ ] **Step 3: Remove the duplicate approval affordance from `/memories`**

Remove the "Mark reviewed" button. **Keep** the "Unreviewed only" filter — it is a useful view.

- [ ] **Step 4: Retire the duplicate sidebar badge**

In `app/layouts/default.vue`, remove the Memory badge (`memoryCount.unreviewed`) now that the Review badge covers it. Confirm the Review badge count rises by the unreviewed-memory count.

- [ ] **Step 5: Browser-validate**

Invoke `browser-testing`. Confirm: unreviewed memories appear on `/review`; Mark reviewed removes the row and decrements the badge; `/memories` still filters but no longer approves; exactly one badge remains.

- [ ] **Step 6: Commit**

```bash
git add app/ server/api/review/
git commit -m "feat(review): fold unreviewed memories into the single review surface"
```

---

### Task 14: Wiki + handover

**Files:**
- Modify: `docs/wiki/quick-capture.md`, `docs/wiki/enrichment.md`
- Create: `docs/wiki/triage.md`
- Create: `docs/handovers/2026-08-XX-capture-triage.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (cycle 57 row)

- [ ] **Step 1: Write `docs/wiki/triage.md`** — the pipeline, the classifier contract, the routing table with **the thresholds as actually shipped**, the four actuators, source-doc disposition, and the review/reversal surfaces. Status ladder: `shipped`.

- [ ] **Step 2: Update `quick-capture.md`** — it currently ends with "Why /input", describing frontmatter proposals into the review queue. Replace with what triage does now.

- [ ] **Step 3: Update `enrichment.md`** — record that `enrich-input` is retired and triage owns `/input`. Do not delete the historical description; mark it superseded with the date.

- [ ] **Step 4: Mirror every changed wiki page to MyMind** under `/projects/mymind/wiki/<name>.md` via `sync_document`, and write the returned `mymind_id` + `mymind_hash` back into each file's frontmatter so the next sync fails closed instead of forking a second copy.

- [ ] **Step 5: Write the handover** with accurate frontmatter (status, branch, spec, plan, task ids), the measured gate numbers, what the review loop caught, and every deferred item.

- [ ] **Step 6: Add the cycle 57 row to the roadmap.**

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(cycle-57): wiki, handover, and roadmap for capture triage"
```

---

## Post-implementation: calibration (NOT part of the build)

Per the spec's rollout, and deliberately excluded from the tasks above:

1. Ship with all four thresholds at `1.1`. Everything queues; nothing auto-applies.
2. Let real captures accumulate for a few days. Read `/review` and compare each proposal against what you would have done.
3. Lower bars by hand, one destination at a time, starting with Task. **The Memory bar stays at `1.1` until task `f80622b9` (enrich-memories dedup under-catching) closes** — hard dependency.
4. Once trusted, let the sweeper backfill the existing `/input` backlog.
