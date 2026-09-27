# Bridget Runtime Implementation Plan (cycle 73)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Bridget's turns out of the browser WebSocket into a server-owned runtime, so a turn survives the tab, runs are serialised per conversation by Postgres, a dedicated main thread exists alongside side threads, history is bounded by summaries, and one headless `wake()` entry point can run Bridget with nobody watching.

**Architecture:** A new module `server/lib/agent/runtime/` owns every turn: `agent_runs` rows are claimed with `FOR UPDATE SKIP LOCKED` (a partial unique index makes two running turns on one conversation impossible), `runner.ts` is `ws.ts`'s turn body moved verbatim, and `stream.ts` fans frames to any number of subscribed sockets with a replay buffer for late joiners. `ws.ts` shrinks to auth + STT + frame routing. Headless runs get a tool gate that turns mutating calls into `/review` proposals, replayed deterministically on approval.

**Tech Stack:** Nuxt 4 / Nitro (crossws WebSocket, scheduled tasks), TypeScript, Drizzle ORM + Postgres, Vercel AI SDK 6 (`streamText`, `prepareStep`), Vitest, `playwright-cli`.

**Spec:** [`docs/superpowers/specs/2026-09-27-bridget-runtime-design.md`](../specs/2026-09-27-bridget-runtime-design.md)

## Global Constraints

- **Package manager is `pnpm`.** Never npm or yarn.
- **Gates:** `pnpm test`, `pnpm test:db`, `pnpm typecheck`, `pnpm build`. Lint is red repo-wide and is **not** a gate — add no new violations in files you author.
- **`pnpm typecheck` does not cover `test/`.** Type errors in tests only show up when vitest runs them.
- **DB-backed tests are `test/*.db.test.ts`**, run by `pnpm test:db`, excluded from `pnpm test`. Harness: `process.loadEnvFile('.env')` + `vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))` **before** importing `server/db` (copy the top of `test/conversation-epoch.db.test.ts`). Every DB test deletes the rows it created in `afterAll`. The dev Postgres is shared with other sessions: **never** `delete` without a `where` on ids you created, and never touch the real `kind='main'` conversation except in the one test that says so.
- **Every new test must be mutation-checked:** after it goes green, break the behaviour it pins, watch it go red, restore. Cycles 70 and 72 each shipped tests that could not fail.
- **Migrations are additive only.** Current head is `0053`; this cycle adds exactly one, `0054`, generated with `pnpm db:generate` then hand-edited for the partial indexes. Apply locally with `pnpm db:migrate`.
- **Timestamps that are compared against `conversation_messages.created_at` are written by Postgres (`now()` / `sql\`now()\``), never `new Date()`.** Cycle 70's `/clear` bug was app-clock vs DB-clock.
- **Move, don't rewrite.** Task 7 moves `ws.ts:271-459` into `runner.ts`. Keep every comment; change only what the move forces (`peer.send` → hub publish, `s.*` → run fields).
- **Constants (verbatim from the spec):** `RUNTIME_CONTEXT_BUDGET = 20000`; summary trigger `12000` tokens; keep last `6` turns verbatim; side-thread idle `30` min; `recent-threads` ≤ `600` tokens over `48` h; `main-state` ≤ `300` tokens; headless wall clock `5` min; `1` headless run in flight; run liveness bump every `10` s, orphan threshold `60` s; `NO_REPLY` residue ≤ `300` chars.
- **Token estimation** is `estimateTokens` (via `tier()` in `server/lib/agent/budget.ts`). No tokenizer dependency.
- **No attribution trailers in commit messages** (no `Co-Authored-By`, no model names) — Tony's global rule.
- **Browser validation is `playwright-cli`, never MCP.** Load `.claude/skills/browser-testing/SKILL.md` before Task 15.

## Review Focus

Inputs the spec implies but no happy-path test exercises — each has a pinning test in its owning task:

1. **Two tabs send a message into the same conversation at the same instant** → exactly one run executes; the other message becomes a steer or the next queued run, never a concurrent turn (Task 2 claim race test + Task 8 steer-while-running test).
2. **The process restarts mid-turn** → the run is marked `interrupted` with an event row, and the user's message is not silently lost (Task 2 recovery test + Task 7 rescue test).
3. **A wake run's reply is `NO_REPLY` with trailing whitespace or a short sign-off** ("NO_REPLY — nothing new") → suppressed; a long reply that merely *mentions* NO_REPLY is not (Task 11 suppression table).
4. **An approved proposal whose tool schema changed since it was proposed** → approval fails visibly, the tool never runs (Task 12 schema-drift test).
5. **A socket opens a thread mid-run** → it sees the reply so far, then the rest, with no duplicated or missing text and no "never-started" stream error (Task 4 replay test + Task 15 scenario 6).

---

### Task 1: Schema — main thread, event rows, `agent_runs`, `agent_inbox`

**Files:**
- Modify: `server/db/schema/conversations.ts`
- Create: `server/db/schema/agent-runs.ts`
- Modify: `server/db/schema/index.ts` (add `export * from './agent-runs'`)
- Modify: `server/db/schema/review-queue.ts` (partial index `where`)
- Create: `server/db/migrations/0054_*.sql` (via `pnpm db:generate`, then hand-edit)
- Test: `test/agent-runtime-schema.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `conversations.kind: 'thread' | 'main'`, `conversations.summarizedThrough: Date | null`, `conversationMessages.origin: string | null`, tables `agentRuns`, `agentInbox`, types `AgentRun = typeof agentRuns.$inferSelect`, `AgentInboxRow = typeof agentInbox.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `test/agent-runtime-schema.db.test.ts`:

```ts
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, agentRuns } from '../server/db/schema'
import { eq, inArray } from 'drizzle-orm'

const violates = (name: string) => (e: unknown) => {
  const err = e as { message?: string; cause?: { message?: string } }
  return new RegExp(name).test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`)
}

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  if (convIds.length) {
    await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
    await db.delete(conversations).where(inArray(conversations.id, convIds))
  }
})

describe('agent runtime schema', () => {
  it('allows at most one main conversation', async () => {
    const db = useDb()
    const [existing] = await db.select().from(conversations).where(eq(conversations.kind, 'main')).limit(1)
    if (!existing) {
      const [m] = await db.insert(conversations).values({ title: 'RUNTIME-SCHEMA main', kind: 'main' }).returning()
      convIds.push(m!.id)
    }
    await expect(db.insert(conversations).values({ title: 'RUNTIME-SCHEMA second main', kind: 'main' }))
      .rejects.toSatisfy(violates('conversations_one_main'))
  })

  it('defaults kind to thread', async () => {
    const [c] = await useDb().insert(conversations).values({ title: 'RUNTIME-SCHEMA thread' }).returning()
    convIds.push(c!.id)
    expect(c!.kind).toBe('thread')
    expect(c!.summarizedThrough).toBeNull()
  })

  it('allows at most one running run per conversation', async () => {
    const db = useDb()
    const [c] = await db.insert(conversations).values({ title: 'RUNTIME-SCHEMA runs' }).returning()
    convIds.push(c!.id)
    const base = { conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'user', profile: 'interactive', input: { text: 'x', modality: 'text' } }
    await db.insert(agentRuns).values({ ...base, status: 'running' })
    await db.insert(agentRuns).values({ ...base, status: 'queued' }) // queued alongside is fine
    await expect(db.insert(agentRuns).values({ ...base, status: 'running' }))
      .rejects.toSatisfy(violates('agent_runs_one_running'))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:db test/agent-runtime-schema.db.test.ts`
Expected: FAIL — `kind` / `agentRuns` do not exist (TypeScript import error or column error).

- [ ] **Step 3: Add the columns and tables**

In `server/db/schema/conversations.ts`, import `uniqueIndex` alongside the existing imports, and add to `conversations` (after `contextEpochAt`):

```ts
  /** 'main' = Bridget's one permanent home thread (proactive output lands here); 'thread' =
   *  an ordinary side thread. At most one 'main' — enforced by conversations_one_main. */
  kind: text('kind').notNull().default('thread'),
  /** The summary covers every message with created_at <= this. Written with the POSTGRES
   *  clock (it is compared against created_at). Null = no summary yet. */
  summarizedThrough: timestamp('summarized_through', { withTimezone: true }),
```

and to its index list:

```ts
  uniqueIndex('conversations_one_main').on(t.kind).where(sql`kind = 'main'`),
```

Add to `conversationMessages` (after `usage`):

```ts
  /** For role='event' rows and wake-produced assistant rows: what caused them, e.g.
   *  'wake:admin', 'review:approved'. Null for everything Tony typed or said. */
  origin: text('origin'),
```

and update the `role` comment to `// 'user' | 'assistant' | 'event'`.

Create `server/db/schema/agent-runs.ts`:

```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

/** One row per agent turn, whatever started it. The DB claim (runtime/runs.ts) plus
 *  agent_runs_one_running make two concurrent turns on one conversation impossible. */
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull(),
  trigger: text('trigger').notNull(),                 // 'user' | 'wake'
  wakeReason: text('wake_reason'),
  profile: text('profile').notNull(),                 // 'interactive' | 'headless'
  modelDefId: text('model_def_id'),
  status: text('status').notNull().default('queued'), // queued|running|done|failed|interrupted|aborted
  suppressed: boolean('suppressed').notNull().default(false),
  input: jsonb('input').notNull(),                    // RunInput
  originSinkId: text('origin_sink_id'),               // the socket that sent it (audio + approvals)
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  aliveAt: timestamp('alive_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  usage: jsonb('usage'),
  userMessageId: uuid('user_message_id'),
  assistantMessageId: uuid('assistant_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('agent_runs_conv_status_idx').on(t.conversationId, t.status),
  index('agent_runs_status_created_idx').on(t.status, t.createdAt),
  uniqueIndex('agent_runs_one_running').on(t.conversationId).where(sql`status = 'running'`)
])

/** Messages that arrive while a run is busy. 'steer' rows are drained into the running turn
 *  at its next step boundary; consumed_by_run marks them used. */
export const agentInbox = pgTable('agent_inbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),                       // 'steer' | 'followup' (followup unused this cycle)
  content: text('content').notNull(),
  attachments: jsonb('attachments'),
  source: text('source').notNull(),                   // 'user' | 'wake'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true })
}, (t) => [
  index('agent_inbox_run_idx').on(t.runId, t.consumedAt)
])

export type AgentRun = typeof agentRuns.$inferSelect
export type AgentInboxRow = typeof agentInbox.$inferSelect
```

> Note vs spec §4.4: the inbox row carries the `run_id` it steers (and `consumed_at` instead of `consumed_by_run`), because a steer always targets exactly the run that was active when it arrived — that is what makes "abort converts unconsumed steers into a new run" a single query.

In `server/db/schema/review-queue.ts`, change the partial index to exempt `agent-action` (one run may propose several actions):

```ts
  onePendingPerTarget: uniqueIndex('review_queue_one_pending_per_target')
    .on(t.targetKind, t.targetId, t.kind).where(sql`status = 'pending' and kind <> 'agent-action'`)
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`
Then open the new `server/db/migrations/0054_*.sql` and confirm it contains, and only contains: `ALTER TABLE conversations ADD COLUMN kind … DEFAULT 'thread' NOT NULL`, `ADD COLUMN summarized_through`, `ALTER TABLE conversation_messages ADD COLUMN origin`, `CREATE TABLE agent_runs`, `CREATE TABLE agent_inbox`, the indexes, and a `DROP INDEX review_queue_one_pending_per_target` + `CREATE UNIQUE INDEX … WHERE status = 'pending' and kind <> 'agent-action'`. If drizzle emitted the partial `WHERE` clauses without them, add them by hand. Nothing else may be dropped.

Run: `pnpm db:migrate`
Expected: applies `0054` cleanly.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:db test/agent-runtime-schema.db.test.ts`
Expected: PASS (3 tests). (drizzle wraps pg errors — the constraint name is on `err.cause.message`, which is why the tests use `violates()` rather than `toThrow(regex)`.) Mutation check: change the third expectation to `.resolves` and confirm it fails, then restore.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck` — expected clean.

```bash
git add server/db/schema/conversations.ts server/db/schema/agent-runs.ts server/db/schema/index.ts server/db/schema/review-queue.ts server/db/migrations test/agent-runtime-schema.db.test.ts
git commit -m "feat(runtime): schema for main thread, event rows, agent_runs and agent_inbox (0054)"
```

---

### Task 2: Run store — create, claim, finish, recover

**Files:**
- Create: `server/lib/agent/runtime/types.ts`
- Create: `server/lib/agent/runtime/runs.ts`
- Test: `test/agent-runs.db.test.ts`

**Interfaces:**
- Consumes: `agentRuns`, `AgentRun` (Task 1).
- Produces (`types.ts`):
  ```ts
  export type SessionKey = 'main' | `thread:${string}` | `isolated:${string}`
  export type RunTrigger = 'user' | 'wake'
  export type RunProfile = 'interactive' | 'headless'
  export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'aborted'
  export interface RunInput {
    text: string
    modality: 'text' | 'voice'
    attachments?: AttachmentRef[]
    skill?: string
    speak?: boolean
    presetId?: string | null
  }
  export interface RunOutcome {
    status: 'done' | 'failed' | 'aborted'
    suppressed?: boolean
    error?: string
    usage?: Record<string, unknown> | null
    userMessageId?: string
    assistantMessageId?: string
  }
  ```
- Produces (`runs.ts`):
  ```ts
  createRun(i: { conversationId: string; sessionKey: string; trigger: RunTrigger; profile: RunProfile; input: RunInput; wakeReason?: string | null; modelDefId?: string | null; originSinkId?: string | null }): Promise<AgentRun>
  claimNextRun(opts?: { headlessSlots?: number; onlyConversations?: string[] }): Promise<AgentRun | null>
  touchRun(id: string): Promise<void>
  finishRun(id: string, o: RunOutcome): Promise<void>
  activeRunFor(conversationId: string): Promise<AgentRun | null>   // status = 'running'
  recoverOrphans(opts?: { staleMs?: number; onlyConversations?: string[] }): Promise<AgentRun[]>
  listRuns(o: { conversationId?: string; limit?: number }): Promise<AgentRun[]>
  export const HEADLESS_SLOTS = 1
  export const ORPHAN_STALE_MS = 60_000
  ```

- [ ] **Step 1: Write the failing test**

Create `test/agent-runs.db.test.ts` (harness header as in Task 1), then:

```ts
import { conversations, agentRuns } from '../server/db/schema'
import { createRun, claimNextRun, finishRun, activeRunFor, recoverOrphans, touchRun } from '../server/lib/agent/runtime/runs'
import { eq, inArray, sql } from 'drizzle-orm'

const convIds: string[] = []
async function conv(title: string) {
  const [c] = await useDb().insert(conversations).values({ title: `RUNS-TEST ${title}` }).returning()
  convIds.push(c!.id)
  return c!.id
}
const input = { text: 'hello', modality: 'text' as const }
afterAll(async () => {
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('run store', () => {
  it('claims the oldest queued run and marks it running', async () => {
    const c = await conv('claim')
    const a = await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    const got = await claimNextRun({ onlyConversations: [c] })
    expect(got?.id).toBe(a.id)
    expect(got?.status).toBe('running')
    expect(got?.claimedAt).toBeTruthy()
  })

  it('will not claim a second run on a conversation that already has one running', async () => {
    const c = await conv('serial')
    await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    expect(await claimNextRun({ onlyConversations: [c] })).not.toBeNull()
    expect(await claimNextRun({ onlyConversations: [c] })).toBeNull()
  })

  it('two concurrent claimers on one conversation never both win', async () => {
    const c = await conv('race')
    for (let i = 0; i < 4; i++) await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    const results = await Promise.all([1, 2, 3, 4].map(() => claimNextRun({ onlyConversations: [c] })))
    expect(results.filter(Boolean)).toHaveLength(1)
    const running = await useDb().select().from(agentRuns).where(sql`${agentRuns.conversationId} = ${c} and ${agentRuns.status} = 'running'`)
    expect(running).toHaveLength(1)
  })

  it('respects the headless slot cap across conversations', async () => {
    const c1 = await conv('headless-1'); const c2 = await conv('headless-2')
    await createRun({ conversationId: c1, sessionKey: 'isolated:a', trigger: 'wake', profile: 'headless', input })
    await createRun({ conversationId: c2, sessionKey: 'isolated:b', trigger: 'wake', profile: 'headless', input })
    expect(await claimNextRun({ headlessSlots: 1, onlyConversations: [c1, c2] })).not.toBeNull()
    expect(await claimNextRun({ headlessSlots: 1, onlyConversations: [c1, c2] })).toBeNull()
  })

  it('finishRun records the outcome and frees the conversation', async () => {
    const c = await conv('finish')
    const r = await createRun({ conversationId: c, sessionKey: `thread:${c}`, trigger: 'user', profile: 'interactive', input })
    await claimNextRun({ onlyConversations: [c] })
    await finishRun(r.id, { status: 'done', suppressed: true })
    expect(await activeRunFor(c)).toBeNull()
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.id))
    expect(row!.status).toBe('done')
    expect(row!.suppressed).toBe(true)
    expect(row!.finishedAt).toBeTruthy()
  })

  it('recoverOrphans marks stale running rows interrupted and leaves fresh ones alone', async () => {
    const c1 = await conv('stale'); const c2 = await conv('fresh')
    const stale = await createRun({ conversationId: c1, sessionKey: `thread:${c1}`, trigger: 'user', profile: 'interactive', input })
    const fresh = await createRun({ conversationId: c2, sessionKey: `thread:${c2}`, trigger: 'user', profile: 'interactive', input })
    await claimNextRun({ onlyConversations: [c1] }); await claimNextRun({ onlyConversations: [c2] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, stale.id))
    await touchRun(fresh.id)
    const recovered = await recoverOrphans({ onlyConversations: [c1, c2] })
    expect(recovered.map(r => r.id)).toEqual([stale.id])
    const [s] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, stale.id))
    const [f] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, fresh.id))
    expect(s!.status).toBe('interrupted')
    expect(f!.status).toBe('running')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:db test/agent-runs.db.test.ts`
Expected: FAIL — module `runtime/runs` not found.

- [ ] **Step 3: Implement**

Create `server/lib/agent/runtime/types.ts` with exactly the `Produces (types.ts)` block above, importing `import type { AttachmentRef } from '../../../../shared/types/conversation'`.

Create `server/lib/agent/runtime/runs.ts`:

```ts
// server/lib/agent/runtime/runs.ts
// The run store. Serialisation is the DATABASE's job, not a promise chain: a claim takes the
// oldest queued run whose conversation has nothing running, and agent_runs_one_running makes a
// second concurrent claim on the same conversation fail at the index, not merely unlikely.
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns, type AgentRun } from '../../../db/schema'
import type { RunInput, RunOutcome, RunProfile, RunTrigger } from './types'

export const HEADLESS_SLOTS = 1
export const ORPHAN_STALE_MS = 60_000

export async function createRun(i: {
  conversationId: string; sessionKey: string; trigger: RunTrigger; profile: RunProfile; input: RunInput
  wakeReason?: string | null; modelDefId?: string | null; originSinkId?: string | null
}): Promise<AgentRun> {
  const [row] = await useDb().insert(agentRuns).values({
    conversationId: i.conversationId, sessionKey: i.sessionKey, trigger: i.trigger, profile: i.profile,
    input: i.input, wakeReason: i.wakeReason ?? null, modelDefId: i.modelDefId ?? null, originSinkId: i.originSinkId ?? null
  }).returning()
  return row!
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

/**
 * Claim the oldest runnable run, or null.
 *
 * Two claimers can each lock a DIFFERENT queued row of the same conversation (SKIP LOCKED lets
 * them pass each other) and both pass the NOT EXISTS check before either commits. The loser's
 * UPDATE then violates agent_runs_one_running — that is the design, and it returns null here.
 * `onlyConversations` is a test seam: the dev database is shared, so a test must not claim
 * another file's (or a live session's) queued run.
 */
export async function claimNextRun(opts: { headlessSlots?: number; onlyConversations?: string[] } = {}): Promise<AgentRun | null> {
  const slots = opts.headlessSlots ?? HEADLESS_SLOTS
  const scope = opts.onlyConversations?.length
    ? sql`and r.conversation_id in (${sql.join(opts.onlyConversations.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  try {
    return await useDb().transaction(async (tx) => {
      const picked = await tx.execute(sql`
        select r.id from agent_runs r
        where r.status = 'queued'
          and not exists (select 1 from agent_runs x where x.conversation_id = r.conversation_id and x.status = 'running')
          and (r.profile <> 'headless'
               or (select count(*) from agent_runs h where h.status = 'running' and h.profile = 'headless') < ${slots})
          ${scope}
        order by r.created_at, r.id
        limit 1
        for update skip locked`)
      const id = (picked.rows[0] as { id?: string } | undefined)?.id
      if (!id) return null
      const [row] = await tx.update(agentRuns)
        .set({ status: 'running', claimedAt: sql`now()`, aliveAt: sql`now()` })
        .where(eq(agentRuns.id, id)).returning()
      return row ?? null
    })
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
}

export async function touchRun(id: string): Promise<void> {
  await useDb().update(agentRuns).set({ aliveAt: sql`now()` }).where(eq(agentRuns.id, id))
}

export async function finishRun(id: string, o: RunOutcome): Promise<void> {
  await useDb().update(agentRuns).set({
    status: o.status, suppressed: o.suppressed ?? false, error: o.error ?? null, usage: o.usage ?? null,
    userMessageId: o.userMessageId ?? null, assistantMessageId: o.assistantMessageId ?? null,
    finishedAt: sql`now()`
  }).where(eq(agentRuns.id, id))
}

export async function activeRunFor(conversationId: string): Promise<AgentRun | null> {
  const [row] = await useDb().select().from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.status, 'running'))).limit(1)
  return row ?? null
}

export async function recoverOrphans(opts: { staleMs?: number; onlyConversations?: string[] } = {}): Promise<AgentRun[]> {
  const staleSec = Math.round((opts.staleMs ?? ORPHAN_STALE_MS) / 1000)
  const scope = opts.onlyConversations?.length ? inArray(agentRuns.conversationId, opts.onlyConversations) : undefined
  return useDb().update(agentRuns)
    .set({ status: 'interrupted', finishedAt: sql`now()`, error: 'interrupted by a restart' })
    .where(and(
      eq(agentRuns.status, 'running'),
      sql`coalesce(${agentRuns.aliveAt}, ${agentRuns.claimedAt}) < now() - make_interval(secs => ${staleSec})`,
      scope
    ))
    .returning()
}

export async function listRuns(o: { conversationId?: string; limit?: number }): Promise<AgentRun[]> {
  return useDb().select().from(agentRuns)
    .where(o.conversationId ? eq(agentRuns.conversationId, o.conversationId) : undefined)
    .orderBy(desc(agentRuns.createdAt)).limit(Math.min(o.limit ?? 50, 200))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:db test/agent-runs.db.test.ts`
Expected: PASS (6). Mutation checks: (a) delete the `not exists` clause → "will not claim a second" goes red (the unique index would make the second claim return null too — so ALSO remove the `isUniqueViolation` catch and confirm the race test throws); (b) change `< ${slots}` to `<= ${slots}` → headless test red; (c) drop the stale predicate → recovery test red. Restore each.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/runtime/types.ts server/lib/agent/runtime/runs.ts test/agent-runs.db.test.ts
git commit -m "feat(runtime): run store — DB claim with SKIP LOCKED, finish, orphan recovery"
```

---

### Task 3: Sessions, the main thread, and event rows in history and DTOs

**Files:**
- Create: `server/lib/agent/runtime/sessions.ts`
- Create: `server/lib/agent/runtime/event-text.ts`
- Modify: `server/services/conversations.ts` (`NewConvMessage`, `appendMessages` insert, `convToDTO`, `msgToDTO`, `rowToAgentMessage`, `listConversations` ordering, new `appendEvent`)
- Modify: `shared/types/conversation.ts` (`ConversationDTO.kind`, `ConversationMessageDTO.role` + `origin`)
- Modify: `server/services/conversation-path.ts` (`sinceSummary` option)
- Modify: `server/services/conversations.ts` `getAgentHistory` (pass `sinceSummary`)
- Create: `server/api/agent/main.get.ts`
- Test: `test/agent-sessions.db.test.ts`, `test/agent-event-text.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  ```ts
  // sessions.ts
  resolveSession(key: SessionKey | 'thread:new', opts?: { titleHint?: string }): Promise<{ conversationId: string; created: boolean }>
  getOrCreateMain(): Promise<string>                         // conversation id
  // event-text.ts
  eventModelText(origin: string | null, content: string): string
  wakeOrigin(reason: string): string                        // `wake:${reason}`
  // conversations.ts
  appendEvent(conversationId: string, content: string, origin: string): Promise<void>
  NewConvMessage.role: 'user' | 'assistant' | 'event';  NewConvMessage.origin?: string | null
  ConversationDTO.kind: 'thread' | 'main'
  ConversationMessageDTO.role: 'user' | 'assistant' | 'event';  ConversationMessageDTO.origin: string | null
  loadActivePath(id, { sinceEpoch?, sinceSummary? })
  ```

- [ ] **Step 1: Write the failing unit test**

Create `test/agent-event-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eventModelText, wakeOrigin } from '../server/lib/agent/runtime/event-text'
import { rowToAgentMessage } from '../server/services/conversations'

describe('event rows in model history', () => {
  it('renders a wake event as a plain sentence with no bracketed marker', () => {
    const t = eventModelText(wakeOrigin('admin'), 'summarise yesterday')
    expect(t).toBe('Background wake (admin): summarise yesterday')
    expect(t).not.toMatch(/[[\]<>]/)
  })
  it('renders a review event', () => {
    expect(eventModelText('review:approved', 'Approved: edit_task — moved to done')).toBe('Note (review approved): Approved: edit_task — moved to done')
  })
  it('rowToAgentMessage maps an event row to a user-role message', () => {
    const m = rowToAgentMessage({ role: 'event', content: 'check the queue', toolCalls: null, attachments: null, origin: 'wake:admin' })
    expect(m).toEqual({ role: 'user', content: 'Background wake (admin): check the queue' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test test/agent-event-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `event-text.ts` and the row mapping**

Create `server/lib/agent/runtime/event-text.ts`:

```ts
// How an `event` row (role='event') reads to the MODEL. Deliberately a plain sentence with no
// brackets or tags: the model imitates whatever its history looks like (the `[image]` and
// repeated-marker incidents), and a marker here would reappear in its replies.
export function wakeOrigin(reason: string): string { return `wake:${reason}` }

export function eventModelText(origin: string | null, content: string): string {
  const [kind, detail] = (origin ?? '').split(':', 2)
  if (kind === 'wake') return `Background wake (${detail || 'unspecified'}): ${content}`
  if (kind === 'review') return `Note (review ${detail || 'update'}): ${content}`
  if (kind === 'runtime') return `Note (${detail || 'runtime'}): ${content}`
  return `Note: ${content}`
}
```

In `server/services/conversations.ts`:
- Widen `NewConvMessage`: `role: 'user' | 'assistant' | 'event'` and add `origin?: string | null`.
- In `appendMessages`' insert `.values({...})` add `origin: msg.origin ?? null`.
- `rowToAgentMessage` — widen the parameter to `{ role: string; content: string; toolCalls: unknown; attachments: unknown; origin?: string | null }` and add as the first line of the body:
  ```ts
  if (r.role === 'event') return { role: 'user', content: eventModelText(r.origin ?? null, r.content) } as AgentMessage
  ```
  (import `eventModelText` from `../lib/agent/runtime/event-text`).
- `convToDTO`: add `kind: (r.kind === 'main' ? 'main' : 'thread')`.
- `msgToDTO`: pass `role` through as `'user' | 'assistant' | 'event'` and add `origin: r.origin ?? null`.
- Add below `appendMessages`:
  ```ts
  /** One event row on the active path — a wake, an approval note, a restart note. */
  export async function appendEvent(conversationId: string, content: string, origin: string): Promise<void> {
    await appendMessages(conversationId, [{ role: 'event', content, modality: 'text', origin }])
    publishChange({ resource: 'conversation', action: 'updated', id: conversationId })
  }
  ```
  (import `publishChange` from `../utils/live-bus`).
- `listConversations`: order main first — `.orderBy(sql\`(${conversations.kind} = 'main') desc\`, sql\`${conversations.lastMessageAt} desc nulls last\`)`.

In `shared/types/conversation.ts`: add `kind: 'thread' | 'main'` to `ConversationDTO`; widen `ConversationMessageDTO.role` to `'user' | 'assistant' | 'event'` and add `origin: string | null`.

- [ ] **Step 4: Run the unit test**

Run: `pnpm test test/agent-event-text.test.ts`
Expected: PASS. Mutation: return the raw `content` for events → the first and third tests go red.

- [ ] **Step 5: Write the failing DB test for sessions and `sinceSummary`**

Create `test/agent-sessions.db.test.ts` (harness header), then:

```ts
import { conversations, conversationMessages } from '../server/db/schema'
import { resolveSession, getOrCreateMain } from '../server/lib/agent/runtime/sessions'
import { appendMessages, getAgentHistory, getConversation } from '../server/services/conversations'
import { eq, inArray, sql } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('sessions', () => {
  it('thread:new creates a titled thread', async () => {
    const r = await resolveSession('thread:new', { titleHint: 'SESS-TEST plan the week' })
    convIds.push(r.conversationId)
    expect(r.created).toBe(true)
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, r.conversationId))
    expect(c!.title).toBe('SESS-TEST plan the week')
    expect(c!.kind).toBe('thread')
  })

  it('thread:<id> resolves an existing thread and rejects an unknown one', async () => {
    const r = await resolveSession('thread:new', { titleHint: 'SESS-TEST existing' })
    convIds.push(r.conversationId)
    expect(await resolveSession(`thread:${r.conversationId}`)).toEqual({ conversationId: r.conversationId, created: false })
    await expect(resolveSession('thread:00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/)
  })

  it('main is created once and then reused (touches the real main row — read-only if it exists)', async () => {
    const a = await getOrCreateMain()
    const b = await getOrCreateMain()
    expect(a).toBe(b)
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, a))
    expect(c!.kind).toBe('main')
  })

  it('isolated:<slug> always creates a fresh thread', async () => {
    const a = await resolveSession('isolated:SESS-TEST'); convIds.push(a.conversationId)
    const b = await resolveSession('isolated:SESS-TEST'); convIds.push(b.conversationId)
    expect(a.conversationId).not.toBe(b.conversationId)
  })
})

describe('sinceSummary', () => {
  it('the model reads only messages after summarized_through; the UI reads everything', async () => {
    const r = await resolveSession('thread:new', { titleHint: 'SESS-TEST summary' })
    convIds.push(r.conversationId)
    await appendMessages(r.conversationId, [
      { role: 'user', content: 'old question', modality: 'text' },
      { role: 'assistant', content: 'old answer', modality: 'text' }
    ])
    await useDb().update(conversations).set({ summarizedThrough: sql`now()`, summary: 'they discussed the old question' })
      .where(eq(conversations.id, r.conversationId))
    await new Promise(res => setTimeout(res, 20))
    await appendMessages(r.conversationId, [{ role: 'user', content: 'new question', modality: 'text' }])
    const model = await getAgentHistory(r.conversationId)
    expect(model.map(m => m.content)).toEqual(['new question'])
    const ui = await getConversation(r.conversationId)
    expect(ui!.messages.map(m => m.content)).toEqual(['old question', 'old answer', 'new question'])
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm test:db test/agent-sessions.db.test.ts`
Expected: FAIL — `runtime/sessions` not found.

- [ ] **Step 7: Implement sessions and `sinceSummary`**

Create `server/lib/agent/runtime/sessions.ts`:

```ts
// Session key → conversation. `main` is Bridget's one home thread (created lazily, at most one
// by index); `thread:new` starts a side thread; `thread:<id>` continues one; `isolated:<slug>`
// is a fresh thread for a noisy background errand.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations } from '../../../db/schema'
import { createConversation, deriveTitle } from '../../../services/conversations'
import type { SessionKey } from './types'

export async function getOrCreateMain(): Promise<string> {
  const db = useDb()
  const [existing] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.kind, 'main')).limit(1)
  if (existing) return existing.id
  // Two callers can race here; the loser hits conversations_one_main and re-reads.
  const [row] = await db.insert(conversations).values({ title: 'Bridget', kind: 'main' })
    .onConflictDoNothing().returning({ id: conversations.id })
  if (row) return row.id
  const [again] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.kind, 'main')).limit(1)
  return again!.id
}

export async function resolveSession(key: SessionKey | 'thread:new', opts: { titleHint?: string } = {}): Promise<{ conversationId: string; created: boolean }> {
  if (key === 'main') return { conversationId: await getOrCreateMain(), created: false }
  if (key === 'thread:new') {
    const c = await createConversation({ title: deriveTitle(opts.titleHint ?? '') })
    return { conversationId: c.id, created: true }
  }
  if (key.startsWith('isolated:')) {
    const c = await createConversation({ title: `wake: ${key.slice('isolated:'.length)}` })
    return { conversationId: c.id, created: true }
  }
  const id = key.slice('thread:'.length)
  const [row] = await useDb().select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).limit(1)
  if (!row) throw new Error(`conversation ${id} not found`)
  return { conversationId: row.id, created: false }
}
```

In `server/services/conversation-path.ts`, widen `opts` to `{ sinceEpoch?: boolean; sinceSummary?: boolean }`, select `summarizedThrough` alongside `epoch`, and replace the `rows` filter with:

```ts
  const epoch = opts.sinceEpoch ? conv?.epoch ?? null : null
  const through = opts.sinceSummary ? conv?.through ?? null : null
  // `through` is exclusive (the summary covers created_at <= through); `epoch` is inclusive,
  // as before. Both are Postgres-clock values compared against Postgres-clock created_at.
  const rows = allRows.filter(r =>
    (!epoch || r.createdAt.getTime() >= epoch.getTime())
    && (!through || r.createdAt.getTime() > through.getTime()))
```

(the select becomes `{ leaf: conversations.activeLeafId, epoch: conversations.contextEpochAt, through: conversations.summarizedThrough }`), and extend the doc comment with one paragraph: *"`opts.sinceSummary` (cycle 73) drops rows the thread summary already covers. Model-only, like `sinceEpoch`."*

In `getAgentHistory`, change the call to `loadActivePath(id, { sinceEpoch: true, sinceSummary: true })` and add to its comment: *"and `sinceSummary` — rows the summary covers reach the model as the summary tier (assembleContext), not verbatim."* Pass `origin` through in `rows.map(rowToAgentMessage)` (it already passes the full row).

Create `server/api/agent/main.get.ts`:

```ts
import { getOrCreateMain } from '../../lib/agent/runtime/sessions'
import { getConversation } from '../../services/conversations'

/** The main thread, created on first request. The agent page opens this by default. */
export default defineEventHandler(async () => {
  const id = await getOrCreateMain()
  return getConversation(id)
})
```

- [ ] **Step 8: Run all affected tests**

Run: `pnpm test:db test/agent-sessions.db.test.ts test/conversation-epoch.db.test.ts test/conversation-path.db.test.ts`
Expected: PASS. Mutation: flip `>` to `>=` in the `through` filter → the sinceSummary test goes red (the boundary row reappears only if timestamps collide; instead mutate by removing `sinceSummary: true` from `getAgentHistory` → red). Restore.

Run: `pnpm test && pnpm typecheck` — fix any caller the widened `role` union breaks (the client `to-ui-messages.ts` is handled in Task 13; for now make it compile by treating `'event'` like the `user` branch until then — a one-line `if (m.role === 'event')` fallthrough is acceptable and Task 13 replaces it).

- [ ] **Step 9: Commit**

```bash
git add server/lib/agent/runtime/sessions.ts server/lib/agent/runtime/event-text.ts server/services/conversations.ts server/services/conversation-path.ts shared/types/conversation.ts server/api/agent/main.get.ts app/lib/agent/to-ui-messages.ts test/agent-event-text.test.ts test/agent-sessions.db.test.ts
git commit -m "feat(runtime): sessions + main thread, event rows, summary-bounded model history"
```

---

### Task 4: Stream hub — fan-out, targeted audio, replay for late joiners

**Files:**
- Create: `server/lib/agent/runtime/stream.ts`
- Test: `test/agent-stream-hub.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface Sink { id: string; send(data: string | Uint8Array): void }
  export class StreamHub {
    subscribe(conversationId: string, sink: Sink, opts?: { replay?: boolean }): () => void
    beginRun(conversationId: string): void
    publish(conversationId: string, data: string | Uint8Array, opts?: { only?: string }): void
    endRun(conversationId: string): void
    hasSink(sinkId: string): boolean
    replay(conversationId: string, sink: Sink): void
  }
  export const hub: StreamHub
  ```

- [ ] **Step 1: Write the failing test**

Create `test/agent-stream-hub.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { StreamHub, type Sink } from '../server/lib/agent/runtime/stream'

function sink(id: string) {
  const got: (string | Uint8Array)[] = []
  const s: Sink = { id, send: d => got.push(d) }
  return { s, got }
}

describe('StreamHub', () => {
  it('fans JSON frames to every subscriber of the conversation only', () => {
    const h = new StreamHub(); const a = sink('a'); const b = sink('b'); const other = sink('o')
    h.subscribe('c1', a.s); h.subscribe('c1', b.s); h.subscribe('c2', other.s)
    h.beginRun('c1'); h.publish('c1', '{"type":"chunk"}')
    expect(a.got).toEqual(['{"type":"chunk"}']); expect(b.got).toEqual(['{"type":"chunk"}']); expect(other.got).toEqual([])
  })

  it('targeted frames go only to the named sink and are never replayed', () => {
    const h = new StreamHub(); const a = sink('a'); const b = sink('b')
    h.subscribe('c1', a.s); h.subscribe('c1', b.s); h.beginRun('c1')
    h.publish('c1', new Uint8Array([1]), { only: 'a' })
    expect(a.got).toHaveLength(1); expect(b.got).toHaveLength(0)
    const late = sink('late'); h.subscribe('c1', late.s, { replay: true })
    expect(late.got).toHaveLength(0)
  })

  it('a late subscriber with replay gets the running turn so far, in order, then live frames', () => {
    const h = new StreamHub(); h.beginRun('c1')
    h.publish('c1', 'f1'); h.publish('c1', 'f2')
    const late = sink('late'); h.subscribe('c1', late.s, { replay: true })
    h.publish('c1', 'f3')
    expect(late.got).toEqual(['f1', 'f2', 'f3'])
  })

  it('endRun clears the replay buffer', () => {
    const h = new StreamHub(); h.beginRun('c1'); h.publish('c1', 'f1'); h.endRun('c1')
    const late = sink('late'); h.subscribe('c1', late.s, { replay: true })
    expect(late.got).toEqual([])
  })

  it('unsubscribe stops delivery, hasSink tracks attachment, and one throwing sink does not break others', () => {
    const h = new StreamHub(); const bad: Sink = { id: 'bad', send: () => { throw new Error('closed') } }; const ok = sink('ok')
    const off = h.subscribe('c1', ok.s); h.subscribe('c1', bad)
    h.beginRun('c1'); h.publish('c1', 'x')
    expect(ok.got).toEqual(['x'])
    expect(h.hasSink('ok')).toBe(true); off(); expect(h.hasSink('ok')).toBe(false)
    h.publish('c1', 'y'); expect(ok.got).toEqual(['x'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test test/agent-stream-hub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/lib/agent/runtime/stream.ts`:

```ts
// In-process fan-out for a conversation's running turn. A run with ZERO subscribers still
// completes and persists — sockets are viewers, not owners. JSON frames of the active run are
// buffered so a socket that opens the thread mid-run (another tab, a second device, a reload)
// can replay the turn so far: the client's turn-stream rejects a text-delta whose message
// never started, so a late joiner without replay would see a poisoned stream.
export interface Sink { id: string; send(data: string | Uint8Array): void }

export class StreamHub {
  private subs = new Map<string, Map<string, Sink>>()
  private buffers = new Map<string, string[]>()
  private sinkCounts = new Map<string, number>()

  subscribe(conversationId: string, sink: Sink, opts: { replay?: boolean } = {}): () => void {
    let m = this.subs.get(conversationId)
    if (!m) this.subs.set(conversationId, m = new Map())
    if (!m.has(sink.id)) this.sinkCounts.set(sink.id, (this.sinkCounts.get(sink.id) ?? 0) + 1)
    m.set(sink.id, sink)
    if (opts.replay) this.replay(conversationId, sink)
    return () => {
      const cur = this.subs.get(conversationId)
      if (!cur?.delete(sink.id)) return
      const n = (this.sinkCounts.get(sink.id) ?? 1) - 1
      if (n <= 0) this.sinkCounts.delete(sink.id); else this.sinkCounts.set(sink.id, n)
      if (!cur.size) this.subs.delete(conversationId)
    }
  }

  replay(conversationId: string, sink: Sink): void {
    for (const f of this.buffers.get(conversationId) ?? []) this.safeSend(sink, f)
  }

  beginRun(conversationId: string): void { this.buffers.set(conversationId, []) }
  endRun(conversationId: string): void { this.buffers.delete(conversationId) }
  hasSink(sinkId: string): boolean { return (this.sinkCounts.get(sinkId) ?? 0) > 0 }

  publish(conversationId: string, data: string | Uint8Array, opts: { only?: string } = {}): void {
    if (!opts.only && typeof data === 'string') this.buffers.get(conversationId)?.push(data)
    const m = this.subs.get(conversationId)
    if (!m) return
    if (opts.only) { const s = m.get(opts.only); if (s) this.safeSend(s, data); return }
    for (const s of m.values()) this.safeSend(s, data)
  }

  private safeSend(s: Sink, d: string | Uint8Array) {
    try { s.send(d) } catch { /* a closed socket must never break the run or other sinks */ }
  }
}

export const hub = new StreamHub()
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test test/agent-stream-hub.test.ts`
Expected: PASS (5). Mutations: remove the `!opts.only &&` guard → targeted-replay test red; remove `safeSend`'s try/catch → throwing-sink test red.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/runtime/stream.ts test/agent-stream-hub.test.ts
git commit -m "feat(runtime): stream hub — fan-out, targeted audio, replay for late joiners"
```

---

### Task 5: Bounded history — turns into the assembler, recent-threads and main-state tiers

**Files:**
- Create: `server/lib/agent/runtime/history.ts`
- Modify: `server/lib/agent/assemble.ts` (`AssembleInput.conversationKind`, deps `recentThreads` / `mainState`, two new fixed tiers)
- Test: `test/agent-runtime-history.test.ts`, `test/agent-assemble.test.ts` (extend)

**Interfaces:**
- Consumes: `AgentMessage` (`server/lib/agent/run.ts`), `tier`, `Tier` (`budget.ts`), `assembleContext` (existing).
- Produces:
  ```ts
  export const RUNTIME_CONTEXT_BUDGET = 20_000
  export const RECENT_THREADS_MAX_TOKENS = 600
  export const MAIN_STATE_MAX_TOKENS = 300
  groupTurns(messages: AgentMessage[]): AgentMessage[][]      // a turn starts at each user-role message
  turnTier(turn: AgentMessage[], index: number): Tier          // text + tool args/results, for costing only
  keepTrailingTurns(turns: AgentMessage[][], keep: number): AgentMessage[]
  capToTokens(text: string, maxTokens: number): string
  // assemble.ts
  AssembleInput.conversationKind?: 'main' | 'thread'
  AssembleDeps.recentThreads?: (excludeId: string) => Promise<string>   // pre-capped block or ''
  AssembleDeps.mainState?: () => Promise<string>                         // pre-capped block or ''
  ```

- [ ] **Step 1: Write the failing test**

Create `test/agent-runtime-history.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupTurns, turnTier, keepTrailingTurns, capToTokens } from '../server/lib/agent/runtime/history'
import { estimateTokens } from '../server/lib/chunking/chunk-markdown'
import type { AgentMessage } from '../server/lib/agent/run'

const u = (c: string): AgentMessage => ({ role: 'user', content: c })
const a = (c: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ role: 'assistant', content: c, ...extra } as AgentMessage)

describe('runtime history', () => {
  it('starts a turn at every user message (a steer starts its own turn — safe for slicing)', () => {
    const turns = groupTurns([u('q1'), a('a1'), u('q2'), u('steer'), a('a2')])
    expect(turns.map(t => t.map(m => m.content))).toEqual([['q1', 'a1'], ['q2'], ['steer', 'a2']])
  })

  it('a leading assistant message (history starting mid-turn after a summary) forms its own turn', () => {
    expect(groupTurns([a('tail'), u('q'), a('r')]).map(t => t.length)).toEqual([1, 2])
  })

  it('turnTier costs tool payloads, not just text', () => {
    const withTool = a('ok', { toolRecords: [{ callId: 'c', name: 'read_document', kind: 'read', args: { id: 'x' }, result: 'y'.repeat(4000), summary: 's' }] } as never)
    expect(turnTier([u('q'), withTool], 0).tokens).toBeGreaterThan(estimateTokens('q ok') + 500)
  })

  it('keepTrailingTurns keeps the newest N turns, flattened, and 0 keeps nothing', () => {
    const turns = groupTurns([u('q1'), a('a1'), u('q2'), a('a2')])
    expect(keepTrailingTurns(turns, 1).map(m => m.content)).toEqual(['q2', 'a2'])
    expect(keepTrailingTurns(turns, 0)).toEqual([])
    expect(keepTrailingTurns(turns, 9).length).toBe(4)
  })

  it('capToTokens never exceeds the cap', () => {
    const t = capToTokens('word '.repeat(5000), 300)
    expect(estimateTokens(t)).toBeLessThanOrEqual(300)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test test/agent-runtime-history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `history.ts`**

```ts
// server/lib/agent/runtime/history.ts
// History reaches the model as STRUCTURED messages (tool-call/tool-result blocks via
// buildModelMessages), exactly as before. The assembler only decides HOW MANY trailing turns
// survive the budget; these helpers cost the turns and slice the array to match.
import { tier, type Tier } from '../budget'
import { estimateTokens } from '../../chunking/chunk-markdown'
import type { AgentMessage } from '../run'
import { messageText } from '../run'

export const RUNTIME_CONTEXT_BUDGET = 20_000
export const RECENT_THREADS_MAX_TOKENS = 600
export const MAIN_STATE_MAX_TOKENS = 300

export function groupTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = []
  for (const m of messages) {
    const last = turns[turns.length - 1]
    // A turn starts at every user-role message. Slicing at a user boundary can never separate
    // an assistant message from its own tool blocks, which is the only invariant budgeting needs.
    if (m.role === 'user' || !last) turns.push([m])
    else last.push(m)
  }
  return turns
}

export function turnTier(turn: AgentMessage[], index: number): Tier {
  const text = turn.map((m) => {
    const records = (m as { toolRecords?: { args?: unknown; result?: unknown }[] }).toolRecords ?? []
    const tools = records.map(r => JSON.stringify(r.args ?? {}) + JSON.stringify(r.result ?? '')).join(' ')
    return `${messageText(m.content)} ${tools}`
  }).join(' ')
  return tier(`turn:${index}`, text)
}

export function keepTrailingTurns(turns: AgentMessage[][], keep: number): AgentMessage[] {
  if (keep <= 0) return []
  return turns.slice(-keep).flat()
}

export function capToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(text.slice(0, mid) + '…') <= maxTokens) lo = mid; else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}
```

- [ ] **Step 4: Run it**

Run: `pnpm test test/agent-runtime-history.test.ts`
Expected: PASS. Mutation: make `turnTier` ignore `toolRecords` → the tool-cost test goes red.

- [ ] **Step 5: Extend the assembler (failing test first)**

Append to `test/agent-assemble.test.ts` (reuse its existing `deps` helpers; every dep below is injected, no DB):

```ts
describe('cycle 73 tiers', () => {
  const base = { listResident: async () => [], search: async () => [], liveContext: async () => '', summary: async () => null, recordRetrievals: async () => {} }

  it('main gets a recent-threads tier; a side thread does not', async () => {
    const deps = { ...base, recentThreads: async () => 'Recent side threads:\n- cycle-70 planning: decided X', mainState: async () => '' }
    const main = await assembleContext({ userText: 'hi', conversationId: 'm', conversationKind: 'main', deps })
    const side = await assembleContext({ userText: 'hi', conversationId: 't', conversationKind: 'thread', deps })
    expect(main.context).toContain('cycle-70 planning')
    expect(side.context).not.toContain('cycle-70 planning')
  })

  it('a side thread gets a main-state tier; main does not', async () => {
    const deps = { ...base, recentThreads: async () => '', mainState: async () => 'Bridget\'s main thread, lately: triaging captures' }
    const side = await assembleContext({ userText: 'hi', conversationId: 't', conversationKind: 'thread', deps })
    const main = await assembleContext({ userText: 'hi', conversationId: 'm', conversationKind: 'main', deps })
    expect(side.context).toContain('triaging captures')
    expect(main.context).not.toContain('triaging captures')
  })

  it('reports dropped turns against the runtime budget', async () => {
    const turns = Array.from({ length: 40 }, (_, i) => tier(`turn:${i}`, 'x '.repeat(2000)))
    const r = await assembleContext({ userText: 'hi', conversationId: 'm', conversationKind: 'main', turns, budget: 20_000, deps: { ...base, recentThreads: async () => '', mainState: async () => '' } })
    expect(r.droppedTurns).toBeGreaterThan(0)
    expect(r.droppedTurns).toBeLessThan(40)
  })
})
```

(import `tier` from `../server/lib/agent/budget` at the top if the file does not already.)

Run: `pnpm test test/agent-assemble.test.ts` — Expected: the three new tests FAIL.

- [ ] **Step 6: Implement the tiers in `assemble.ts`**

- Add to `AssembleDeps`: `recentThreads?: (excludeId: string) => Promise<string>` and `mainState?: () => Promise<string>`.
- Add to `AssembleInput`: `conversationKind?: 'main' | 'thread'`.
- Add loaders below `loadSummary`:

```ts
/** Main's view of what Tony has been doing elsewhere: summaries of side threads touched in the
 *  last 48h, newest first, capped at the source (an unbounded fixed tier blanks EVERY fixed
 *  tier when it overflows fitBudget — the cycle-71 lesson). */
async function loadRecentThreads(excludeId: string): Promise<string> {
  const rows = await useDb().select({ title: conversations.title, summary: conversations.summary })
    .from(conversations)
    .where(sql`${conversations.id} <> ${excludeId} and ${conversations.kind} = 'thread' and ${conversations.summary} is not null and ${conversations.lastMessageAt} > now() - interval '48 hours'`)
    .orderBy(sql`${conversations.lastMessageAt} desc`).limit(8)
  if (!rows.length) return ''
  const text = ['Recent side threads (summaries):', ...rows.map(r => `- ${r.title ?? 'untitled'}: ${r.summary}`)].join('\n')
  return capToTokens(text, RECENT_THREADS_MAX_TOKENS)
}

/** A side thread's view of main: the first paragraph of main's summary. */
async function loadMainState(): Promise<string> {
  const [row] = await useDb().select({ summary: conversations.summary }).from(conversations)
    .where(eq(conversations.kind, 'main')).limit(1)
  const first = row?.summary?.split(/\n\s*\n/)[0]?.trim()
  return first ? capToTokens(`Bridget's main thread, lately: ${first}`, MAIN_STATE_MAX_TOKENS) : ''
}
```

(imports: `sql` from `drizzle-orm`; `capToTokens, RECENT_THREADS_MAX_TOKENS, MAIN_STATE_MAX_TOKENS` from `./runtime/history`.)

- In `assembleContextInner`, extend the `Promise.all` to five entries:

```ts
  const kind = input.conversationKind
  const [resident, liveState, summary, recentThreads, mainState] = await Promise.all([
    safe(() => listResident(), [] as MemoryDTO[], 'resident'),
    safe(() => liveContext(now), '', 'liveState'),
    input.conversationId ? safe(() => summaryOf(input.conversationId!), null as string | null, 'summary') : Promise.resolve(null),
    kind === 'main' && input.conversationId ? safe(() => (d.recentThreads ?? loadRecentThreads)(input.conversationId!), '', 'recentThreads') : Promise.resolve(''),
    kind === 'thread' ? safe(() => (d.mainState ?? loadMainState)(), '', 'mainState') : Promise.resolve('')
  ])
```

- After `if (summary) fixed.push(...)` add:

```ts
  if (recentThreads) fixed.push(tier('recent-threads', recentThreads))
  if (mainState) fixed.push(tier('main-state', mainState))
```

- [ ] **Step 7: Run and commit**

Run: `pnpm test test/agent-assemble.test.ts test/agent-assemble-skill.test.ts test/agent-runtime-history.test.ts && pnpm typecheck`
Expected: PASS. Mutation: swap the `kind === 'main'` / `kind === 'thread'` guards → the two tier tests go red.

```bash
git add server/lib/agent/runtime/history.ts server/lib/agent/assemble.ts test/agent-runtime-history.test.ts test/agent-assemble.test.ts
git commit -m "feat(runtime): bounded history helpers + recent-threads and main-state context tiers"
```

---

### Task 6: Loop hooks — steer splicing, wake prompt section, suppression

**Files:**
- Create: `server/lib/agent/runtime/steer.ts`
- Create: `server/lib/agent/runtime/suppress.ts`
- Modify: `server/lib/agent/run.ts` (`runAgent` ctx: `drainSteer`, `wake`; `prepareStep` splices steers)
- Modify: `server/lib/agent/prompt.ts` (`composePrompt` / `buildSystemPrompt` accept `wake`)
- Modify: `server/lib/voice/orchestrator.ts` (`TurnDeps.drainSteer`, `TurnDeps.wake` passed through to `run`)
- Test: `test/agent-steer.test.ts`, `test/agent-suppress.test.ts`, `test/agent-prompt.test.ts` (extend)

**Interfaces:**
- Consumes: `runAgent`, `composePrompt`, `handleTurn` (existing).
- Produces:
  ```ts
  // steer.ts
  export interface SteerMark { at: number; text: string }   // at = index in the step's message array
  spliceSteers(messages: unknown[], marks: SteerMark[]): unknown[]
  // suppress.ts
  export const NO_REPLY = 'NO_REPLY'
  isSuppressedReply(text: string): boolean
  // run.ts ctx additions
  drainSteer?: () => Promise<string[]>
  wake?: { reason: string }
  // prompt.ts
  composePrompt(opts & { wake?: { reason: string } }); buildSystemPrompt(opts & { wake?: { reason: string } })
  // orchestrator TurnDeps additions (forwarded verbatim into run(...) ctx)
  drainSteer?: () => Promise<string[]>
  wake?: { reason: string }
  ```

- [ ] **Step 1: Write the failing tests**

`test/agent-steer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spliceSteers } from '../server/lib/agent/runtime/steer'

describe('spliceSteers', () => {
  it('inserts each steer at the position it arrived, and keeps it there on later steps', () => {
    const step2 = ['sys-free-history', 'user:q', 'asst:tool-call', 'tool:result']
    const marks = [{ at: 4, text: 'actually use the other doc' }]
    expect(spliceSteers(step2, marks)).toEqual([...step2, { role: 'user', content: 'actually use the other doc' }])
    const step3 = [...step2, 'asst:tool-call-2', 'tool:result-2']
    expect(spliceSteers(step3, marks)).toEqual([...step2, { role: 'user', content: 'actually use the other doc' }, 'asst:tool-call-2', 'tool:result-2'])
  })
  it('keeps several steers in arrival order', () => {
    const r = spliceSteers(['a', 'b'], [{ at: 1, text: 's1' }, { at: 2, text: 's2' }])
    expect(r).toEqual(['a', { role: 'user', content: 's1' }, 'b', { role: 'user', content: 's2' }])
  })
})
```

`test/agent-suppress.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isSuppressedReply } from '../server/lib/agent/runtime/suppress'

describe('isSuppressedReply', () => {
  it.each([
    ['NO_REPLY', true],
    ['  NO_REPLY \n', true],
    ['NO_REPLY — nothing new since this morning.', true],
    ['Checked the queue. NO_REPLY', true],
    ['', false],
    ['Heads up: the deploy failed.', false],
    [`NO_REPLY ${'x'.repeat(301)}`, false],
    ['I would normally say NO_REPLY here but the build is red — here is why …', false]
  ])('%j → %s', (text, expected) => {
    expect(isSuppressedReply(text)).toBe(expected)
  })
})
```

Append to `test/agent-prompt.test.ts`:

```ts
describe('wake mode', () => {
  const opts = { persona: 'P', speak: false, toneLine: 'T' }
  it('adds the wake section and the NO_REPLY contract', () => {
    const p = composePrompt({ ...opts, wake: { reason: 'admin' } })
    expect(p).toContain('You were woken by: admin')
    expect(p).toContain('reply with exactly NO_REPLY')
  })
  it('drops the confirm-before-editing rule, which cannot be honoured with nobody there', () => {
    expect(composePrompt({ ...opts, wake: { reason: 'x' } })).not.toContain('CONFIRM with Tony first')
    expect(composePrompt(opts)).toContain('CONFIRM with Tony first')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/agent-steer.test.ts test/agent-suppress.test.ts test/agent-prompt.test.ts`
Expected: FAIL (modules missing; wake tests fail).

- [ ] **Step 3: Implement**

`server/lib/agent/runtime/suppress.ts`:

```ts
// The silent-by-default contract for background runs (OpenClaw's NO_REPLY). A wake reply that
// is the sentinel — alone, or opening/closing a short remainder — is dropped: no assistant row.
// A long reply that merely mentions the word is a real reply.
export const NO_REPLY = 'NO_REPLY'
const MAX_RESIDUE = 300

export function isSuppressedReply(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (t === NO_REPLY) return true
  if (!t.startsWith(NO_REPLY) && !t.endsWith(NO_REPLY)) return false
  const residue = t.startsWith(NO_REPLY) ? t.slice(NO_REPLY.length) : t.slice(0, -NO_REPLY.length)
  return residue.trim().length <= MAX_RESIDUE
}
```

`server/lib/agent/runtime/steer.ts`:

```ts
// AI SDK prepareStep may return `messages` for THAT step only; the next step is rebuilt from the
// initial messages plus the model's responses, so an injected message would vanish. Each steer
// is therefore recorded with the index it arrived at and re-spliced on every later step.
export interface SteerMark { at: number; text: string }

export function spliceSteers(messages: unknown[], marks: SteerMark[]): unknown[] {
  const out = [...messages]
  // Later marks first so earlier insertions do not shift the indexes still to apply.
  const sorted = [...marks].map((m, i) => ({ ...m, i })).sort((a, b) => b.at - a.at || b.i - a.i)
  for (const m of sorted) out.splice(Math.min(m.at, out.length), 0, { role: 'user', content: m.text })
  return out
}
```

> The test's "arrival order" case expects `['a', s1, 'b', s2]`: `s2` at index 2 is spliced first (into the original array, after `'b'`), then `s1` at index 1. Verify the test passes before moving on — if it does not, the sort is wrong, not the test.

In `server/lib/agent/run.ts`:
- Add to `runAgent`'s `ctx` type: `drainSteer?: () => Promise<string[]>; wake?: { reason: string }`.
- Pass `wake` into the prompt: `const system = await buildPrompt({ profile, speak: ctx.speak ?? false, context: ctx.context, wake: ctx.wake })` and widen `RunDeps.buildSystemPrompt`'s opts type with `wake?: { reason: string }`.
- Replace the `prepareStep` in the main `streamText` call with:

```ts
        // Final-step guarantee (unchanged) + steering: messages Tony sent while this turn was
        // running are drained at each step boundary and spliced in at the point they arrived.
        prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: unknown[] }) => {
          if (ctx.drainSteer) {
            const fresh = await ctx.drainSteer()
            for (const text of fresh) steerMarks.push({ at: messages.length, text })
          }
          const out: { toolChoice?: 'none'; messages?: never } = {}
          if (stepNumber >= maxSteps - 1) out.toolChoice = 'none'
          if (steerMarks.length) out.messages = spliceSteers(messages, steerMarks) as never
          return Object.keys(out).length ? out : undefined
        },
```

  declaring `const steerMarks: SteerMark[] = []` just before the failover `for` loop, and importing `spliceSteers, type SteerMark` from `./runtime/steer`. `at` is an index into the SDK's RAW step messages (which never contain earlier steers); `spliceSteers` applies marks last-first so raw indexes stay valid, and same-index marks keep arrival order.

  **Verify the SDK assumption before relying on it:** add a test in `test/run-live-events.test.ts` style with a fake `streamText` that invokes `prepareStep` twice (step 0, then step 1 with one extra response message) and asserts the steer appears in both steps' messages at the same position. If AI SDK 6 already carries a returned `messages` array into later steps, `spliceSteers` would double-insert — the test will show it; in that case splice only on the step where the steer is drained.

In `server/lib/agent/prompt.ts`:
- `composePrompt` opts gain `wake?: { reason: string }`. Immediately after `lines.push(toneLine, '')` insert:

```ts
  if (opts.wake) {
    lines.push(
      `BACKGROUND WAKE — You were woken by: ${opts.wake.reason}. Tony is not watching this turn.`,
      'Do what is useful with your tools. If nothing merits his attention, reply with exactly NO_REPLY and nothing else.',
      'Tools that edit or delete existing data do not run in the background: they are queued for Tony\'s approval in /review and return { proposed: true }. That is expected — say briefly what you queued.',
      ''
    )
  }
```

- Guard the confirm rule: replace the unconditional `'- Before ANY change that edits or deletes existing data (edit_task, edit_project), CONFIRM with Tony first and only act after he says yes.',` by pushing it separately: `if (!opts.wake) lines.push('- Before ANY change …')` placed at the same position in the list (split the `lines.push(` call around it).
- `buildSystemPrompt` opts gain `wake?: { reason: string }` and forward it to `composePrompt`.

In `server/lib/voice/orchestrator.ts`:
- `TurnDeps` gains `drainSteer?: () => Promise<string[]>` and `wake?: { reason: string }`; widen `TurnDeps.runAgent`'s ctx type with the same two fields.
- In `handleTurn`'s `run(messages, { … })` call, add `drainSteer: deps.drainSteer, wake: deps.wake`.

- [ ] **Step 4: Run and commit**

Run: `pnpm test test/agent-steer.test.ts test/agent-suppress.test.ts test/agent-prompt.test.ts test/orchestrator.test.ts test/run-history.test.ts test/run-live-events.test.ts && pnpm typecheck`
Expected: PASS. Mutations: change `MAX_RESIDUE` to 0 → the sign-off rows go red; remove the `if (!opts.wake)` guard → the confirm-rule test goes red.

```bash
git add server/lib/agent/runtime/steer.ts server/lib/agent/runtime/suppress.ts server/lib/agent/run.ts server/lib/agent/prompt.ts server/lib/voice/orchestrator.ts test/agent-steer.test.ts test/agent-suppress.test.ts test/agent-prompt.test.ts
git commit -m "feat(runtime): steer splicing in prepareStep, wake prompt section, NO_REPLY suppression"
```

---

### Task 7: The runner — `ws.ts`'s turn body, moved

**Files:**
- Create: `server/lib/agent/runtime/runner.ts`
- Create: `server/lib/agent/runtime/aborts.ts`
- Create: `server/lib/agent/runtime/approvals.ts`
- Create: `server/lib/agent/runtime/inbox.ts`
- Test: `test/agent-runner.db.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6; `handleTurn`, `createTurnStream`, `buildTurnPersistPayload`, `partialTurnMessages`, `appendMessages`, `captureTurnLeaf`, `getAgentHistory`, `assembleContext`, `resolveTurnVoice`, `speakWithPreset`, `recordEvent`, `publishChange`.
- Produces:
  ```ts
  // aborts.ts
  registerAbort(runId: string): AbortController;  abortRun(runId: string): boolean;  releaseAbort(runId: string): void
  // approvals.ts — interactive approval channels, keyed by run
  registerApprovalChannel(runId: string, fn: (req: ApprovalRequest) => Promise<{ approved: boolean }>): void
  unregisterApprovalChannel(runId: string): void
  approvalFor(runId: string): (req: ApprovalRequest) => Promise<{ approved: boolean }>   // denies when no channel
  registerTurnStream(runId: string, ts: TurnStream): void;  turnStreamFor(runId: string): TurnStream | undefined;  releaseTurnStream(runId: string): void
  // inbox.ts
  pushSteer(runId: string, conversationId: string, text: string, source: 'user' | 'wake'): Promise<void>
  drainSteerFor(runId: string): Promise<string[]>                 // marks consumed
  requeueUnconsumed(run: AgentRun): Promise<string | null>          // new queued run id, or null
  // runner.ts
  export interface RunnerDeps { runAgent?: TurnDeps['runAgent']; assemble?: typeof assembleContext; hub?: StreamHub; afterPersist?: (conversationId: string) => void }
  runTurn(run: AgentRun, deps?: RunnerDeps): Promise<RunOutcome>
  nextTurnId(): number
  ```

- [ ] **Step 1: Write the failing DB test**

Create `test/agent-runner.db.test.ts` (harness header). A fake `runAgent` generator stands in for the model (`TurnDeps.runAgent` already exists for exactly this):

```ts
import { conversations, conversationMessages, agentRuns } from '../server/db/schema'
import { createRun, claimNextRun } from '../server/lib/agent/runtime/runs'
import { resolveSession } from '../server/lib/agent/runtime/sessions'
import { runTurn } from '../server/lib/agent/runtime/runner'
import { StreamHub } from '../server/lib/agent/runtime/stream'
import { abortRun } from '../server/lib/agent/runtime/aborts'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
function fakeAgent(reply: string, opts: { delayMs?: number } = {}) {
  return async function* (_m: unknown, ctx: { signal: AbortSignal }) {
    for (const ch of reply.split(' ')) {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (ctx.signal.aborted) return
      yield { type: 'text-delta', text: ch + ' ' } as const
    }
    yield { type: 'done' } as const
  }
}
async function queued(text: string, extra: Partial<Parameters<typeof createRun>[0]> = {}) {
  const s = await resolveSession('thread:new', { titleHint: `RUNNER-TEST ${text}` }); convIds.push(s.conversationId)
  await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive', input: { text, modality: 'text' }, ...extra })
  const run = await claimNextRun({ onlyConversations: [s.conversationId] })
  return { run: run!, conversationId: s.conversationId }
}
const rows = (id: string) => useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, id)).orderBy(conversationMessages.createdAt, conversationMessages.id)

describe('runTurn', () => {
  it('runs with no subscriber at all and persists user + assistant', async () => {
    const { run, conversationId } = await queued('hello')
    const out = await runTurn(run, { runAgent: fakeAgent('hi there') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('done')
    expect((await rows(conversationId)).map(r => [r.role, r.content.trim()])).toEqual([['user', 'hello'], ['assistant', 'hi there']])
    expect(out.userMessageId).toBeTruthy(); expect(out.assistantMessageId).toBeTruthy()
  })

  it('streams frames to a subscriber and ends with a persisted frame', async () => {
    const { run, conversationId } = await queued('stream me')
    const hub = new StreamHub(); const got: string[] = []
    hub.subscribe(conversationId, { id: 's', send: d => { if (typeof d === 'string') got.push(d) } })
    await runTurn(run, { runAgent: fakeAgent('ok') as never, assemble: noAssemble as never, hub })
    const types = got.map(f => JSON.parse(f).type)
    expect(types).toContain('user-message'); expect(types).toContain('chunk')
    expect(types[types.length - 1]).toBe('persisted')
  })

  it('an abort mid-reply rescues what was said and reports aborted', async () => {
    const { run, conversationId } = await queued('long one')
    const p = runTurn(run, { runAgent: fakeAgent('one two three four five six', { delayMs: 30 }) as never, assemble: noAssemble as never, hub: new StreamHub() })
    await new Promise(r => setTimeout(r, 70)); abortRun(run.id)
    const out = await p
    expect(out.status).toBe('aborted')
    const r = await rows(conversationId)
    expect(r[0]!.content).toBe('long one')              // the question survives
  })

  it('a wake run persists an event row (not a user row) and drops a NO_REPLY reply', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake' }); convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId] }))!
    const out = await runTurn(run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.suppressed).toBe(true)
    const r = await rows(s.conversationId)
    expect(r.map(x => [x.role, x.origin])).toEqual([['event', 'wake:admin']])
  })

  it('a thrown agent error marks the run failed and still keeps the question', async () => {
    const { run, conversationId } = await queued('explode')
    const boom = async function* () { yield { type: 'text-delta', text: 'partial ' } as const; throw new Error('model died') }
    const out = await runTurn(run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed'); expect(out.error).toMatch(/model died/)
    expect((await rows(conversationId))[0]!.content).toBe('explode')
  })

  it('a failure before the model ever runs (assembly throws) still keeps the question', async () => {
    const { run, conversationId } = await queued('before-model')
    const boom = async () => { throw new Error('assembler exploded') }
    const out = await runTurn(run, { runAgent: fakeAgent('never') as never, assemble: boom as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect((await rows(conversationId)).map(r => [r.role, r.content])).toEqual([['user', 'before-model']])
  })
})
```

> The rescue must fall back to `input.text` when no user transcript was emitted (the turn failed before `handleTurn` ran) — the question someone asked survives any failure. Because the conversation now exists before the run and always receives at least the question, the legacy "rescue creates a second empty conversation" shape (task b041ed5c) cannot occur.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:db test/agent-runner.db.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the small registries**

`server/lib/agent/runtime/aborts.ts`:

```ts
// runId → AbortController. An abort that arrives before the run registers (Stop pressed while
// the run is still queued/claiming) is remembered and applied on registration.
const controllers = new Map<string, AbortController>()
const preAborted = new Set<string>()

export function registerAbort(runId: string): AbortController {
  const ac = new AbortController()
  controllers.set(runId, ac)
  if (preAborted.delete(runId)) ac.abort()
  return ac
}
export function abortRun(runId: string): boolean {
  const ac = controllers.get(runId)
  if (ac) { ac.abort(); return true }
  preAborted.add(runId)
  return false
}
export function releaseAbort(runId: string): void { controllers.delete(runId); preAborted.delete(runId) }
```

`server/lib/agent/runtime/approvals.ts`:

```ts
// Interactive approval channels, keyed by RUN (not socket): ws.ts registers one for each run it
// originates and removes it on close. A run whose socket is gone gets today's no-channel
// behaviour — an immediate deny — instead of waiting out a 120s timeout nobody can see.
import type { ApprovalRequest } from '../types'
import type { TurnStream } from '../../voice/turn-stream'

type Channel = (req: ApprovalRequest) => Promise<{ approved: boolean }>
const channels = new Map<string, Channel>()
const streams = new Map<string, TurnStream>()

export function registerApprovalChannel(runId: string, fn: Channel): void { channels.set(runId, fn) }
export function unregisterApprovalChannel(runId: string): void { channels.delete(runId) }
export function approvalFor(runId: string): Channel {
  return async (req) => {
    const ch = channels.get(runId)
    return ch ? ch(req) : { approved: false }
  }
}
export function registerTurnStream(runId: string, ts: TurnStream): void { streams.set(runId, ts) }
export function turnStreamFor(runId: string): TurnStream | undefined { return streams.get(runId) }
export function releaseTurnStream(runId: string): void { streams.delete(runId) }
```

`server/lib/agent/runtime/inbox.ts`:

```ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentInbox, type AgentRun } from '../../../db/schema'
import { createRun } from './runs'
import type { RunInput } from './types'

export async function pushSteer(runId: string, conversationId: string, text: string, source: 'user' | 'wake'): Promise<void> {
  await useDb().insert(agentInbox).values({ runId, conversationId, mode: 'steer', content: text, source })
}

/** Unconsumed steers for this run, oldest first, marked consumed in the same statement. */
export async function drainSteerFor(runId: string): Promise<string[]> {
  const rows = await useDb().update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt)))
    .returning({ content: agentInbox.content, createdAt: agentInbox.createdAt })
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(r => r.content)
}

/** After an abort: whatever Tony typed that the run never read becomes the next run. His words
 *  are never silently dropped. */
export async function requeueUnconsumed(run: AgentRun): Promise<string | null> {
  const left = await drainSteerFor(run.id)
  if (!left.length) return null
  const input: RunInput = { text: left.join('\n\n'), modality: 'text' }
  const next = await createRun({ conversationId: run.conversationId, sessionKey: run.sessionKey, trigger: 'user', profile: run.profile as 'interactive' | 'headless', input, originSinkId: run.originSinkId })
  return next.id
}
```

(`asc` import is unused — drop it if lint flags it.)

- [ ] **Step 4: Implement `runner.ts` by MOVING `ws.ts:271-459`**

Open `server/api/voice/ws.ts` next to the new file. Copy the `run` closure body (from `let ts: ReturnType<typeof createTurnStream> | null = null` through the end of its `finally`) into `runTurn`, then apply **only** these substitutions. Keep every comment.

| in ws.ts | in runner.ts |
|---|---|
| `peer.send(x)` | `hub.publish(conversationId, x)` |
| `createTurnStream({ turnId, …, send: d => peer.send(d) })` | `createTurnStream({ turnId, attachments: input.attachments ?? [], send })` where `send` routes audio (below) |
| `s.activeTurn = ts` / cleanup | `registerTurnStream(run.id, ts)` / `releaseTurnStream(run.id)` |
| `s.conversationId` / `turnConversationIdForRescue` | `run.conversationId` (the conversation now exists before the run starts — `resolveSession` created it) |
| `s.history = await exec!(ac.signal, emit, undefined)` | `const result = await handleTurn(userText, history, turnDeps)` |
| `const added = s.history.slice(prevLen)` | `const added = result.slice(history.length)` |
| the `if (!s.conversationId) { createConversation … newThreadFrame }` block | `const created = (await countMessages(run.conversationId)) === 0` computed BEFORE the append; after the append, if `created`, `hub.publish(conversationId, JSON.stringify({ type: 'conversation', conversationId, title }))` with `title` read from the conversations row |
| AbortError `return` | `return { status: 'aborted' }` (after the rescue in `finally` runs) |

New code around the moved body:

```ts
// server/lib/agent/runtime/runner.ts
// ONE turn, server-owned. This is ws.ts's turn body moved (not rewritten): the ordering rules
// in the comments below — persist before the `conversation` frame, rescue on throw/abort,
// capture the leaf before the first await — were each learned from a production bug.
let turnSeq = Date.now()
/** Monotonic across restarts (seeded from the clock): the client drops frames whose turnId is
 *  below the highest it has seen, so a counter that reset to 0 on deploy would silence every
 *  turn until reload. */
export function nextTurnId(): number { return ++turnSeq }

export async function runTurn(run: AgentRun, deps: RunnerDeps = {}): Promise<RunOutcome> {
  const hub = deps.hub ?? defaultHub
  const conversationId = run.conversationId
  const input = run.input as RunInput
  const isWake = run.trigger === 'wake'
  const origin = isWake ? wakeOrigin(run.wakeReason ?? 'unspecified') : null
  const ac = registerAbort(run.id)
  const turnId = nextTurnId()
  hub.beginRun(conversationId)

  // Audio + its bracket frames go ONLY to the socket that asked; everything else fans out.
  const send = (d: string | Uint8Array) => {
    const audio = typeof d !== 'string' || /^\{"type":"audio-(begin|end)"/.test(d)
    hub.publish(conversationId, d, audio ? { only: run.originSinkId ?? '__none__' } : undefined)
  }
  // TTS only while the originating socket is attached: a closed tab degrades the turn to
  // "no audio", never "no turn".
  const speak = !isWake && !!input.speak
  const tts: TtsProvider = {
    synthesize: (text, o) => (run.originSinkId && hub.hasSink(run.originSinkId))
      ? speakWithPreset(text, o.preset, 'agent', o.signal, o.refAudio ?? null)
      : (async function* () {})()
  }

  const [conv] = await useDb().select({ kind: conversations.kind, title: conversations.title })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  const fullHistory = await getAgentHistory(conversationId)
  const turns = groupTurns(fullHistory)
  const userText = isWake ? eventModelText(origin, input.text) : input.text
  const assembled = await (deps.assemble ?? assembleContext)({
    userText, conversationId, skill: input.skill, conversationKind: conv?.kind === 'main' ? 'main' : 'thread',
    turns: turns.map(turnTier), budget: RUNTIME_CONTEXT_BUDGET
  })
  recordEvent({ kind: 'tool', name: 'memory:assemble', severity: 'info', meta: { used: assembled.used, droppedTurns: assembled.droppedTurns, retrievedCount: assembled.usedMemoryIds.length, conversationId, runId: run.id } })
  const history = keepTrailingTurns(turns, turns.length - assembled.droppedTurns)

  const { preset, refAudio } = await resolveTurnVoice(input.presetId ?? null, speak)
  const profile = run.profile === 'headless' ? headlessProfile(run) : undefined
  // ... moved body here; the exec call becomes:
  // const result = await handleTurn(userText, history, {
  //   tts, preset, refAudio, speak, context: assembled.context || undefined, modelDefId: run.modelDefId,
  //   profile, requestApproval: run.profile === 'interactive' ? approvalFor(run.id) : undefined,
  //   attachments: input.attachments ?? [], signal: ac.signal, emit, runAgent: deps.runAgent,
  //   drainSteer: () => drainSteerFor(run.id), wake: isWake ? { reason: run.wakeReason ?? 'unspecified' } : undefined
  // })
}
```

`headlessProfile` does not exist until Task 11. In this task define a placeholder in `runner.ts` that Task 11 replaces: `function headlessProfile(_run: AgentRun): AgentProfile { return { ...bridgetProfile, id: 'headless', tools: bridgetProfile.tools.filter(t => !t.dangerous) } }` — this already excludes `exec`, so no headless run can ever reach it, even before Task 11 lands the gate.

Wake-run specifics, applied inside the moved body:

- In `emit`, for wake runs **skip** the user `transcript` event (`if (isWake && e.type === 'transcript' && e.role === 'user') return` before `ts!.emit(e)`) — the event row renders after persist; a live "Tony said…" bubble would be a lie.
- After `handleTurn` returns: `const reply = messageText(result[result.length - 1]?.content ?? '')`; `const suppressed = isWake && result.length > history.length + 1 && isSuppressedReply(reply)`; if suppressed, `added` drops its last element (the assistant) and no assistant row is written.
- In the persist payload, for wake runs rewrite the first entry: `payload[0] = { ...payload[0]!, role: 'event', origin, content: input.text }`.
- The rescue path gets the same rewrite (the question becomes the event row), and uses `liveUserText || input.text` for the question so a turn that failed before `handleTurn` emitted anything still persists it. Move the history/assemble/voice setup INSIDE the `try` so its failures take the same rescue path.

Success path, after the append:

```ts
        const ids = await lastMessageIds(conversationId, payload.length)   // newest-first ids of what we just wrote
        outcome = { status: 'done', suppressed, usage: finalUsage, userMessageId: ids.at(-1), assistantMessageId: suppressed ? undefined : ids[0] }
        if (created) hub.publish(conversationId, JSON.stringify({ type: 'conversation', conversationId, title: conv?.title ?? null }))
        hub.publish(conversationId, JSON.stringify({ type: 'persisted', conversationId }))
        publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: conversationId })
```

with helpers at the bottom of the file:

```ts
async function countMessages(conversationId: string): Promise<number> {
  const [r] = await useDb().select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
  return r?.n ?? 0
}
async function lastMessageIds(conversationId: string, n: number): Promise<string[]> {
  const rows = await useDb().select({ id: conversationMessages.id }).from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id)).limit(n)
  return rows.map(r => r.id)
}
```

`finally`, after the moved rescue:

```ts
    releaseTurnStream(run.id)
    releaseAbort(run.id)
    hub.endRun(conversationId)
    if (persisted || rescued) deps.afterPersist?.(conversationId)
```

Return value: `outcome` for success; `{ status: 'aborted' }` on `AbortError`; `{ status: 'failed', error: message }` on any other throw. The catch no longer sends raw `error`/`state` frames via `peer`; it calls `ts?.error(msg)` when `ts` exists, else `hub.publish(conversationId, JSON.stringify({ type: 'error', message: msg }))` then `hub.publish(conversationId, JSON.stringify({ type: 'state', state: 'idle' }))` — same two frames, different transport.

- [ ] **Step 5: Run the runner tests**

Run: `pnpm test:db test/agent-runner.db.test.ts`
Expected: PASS (6). Mutations, one at a time: (a) remove the wake `payload[0]` rewrite → wake test red; (b) drop the `|| input.text` fallback → last test red; (c) in `finally`, skip the rescue → abort and throw tests red. Restore each.

Run: `pnpm test && pnpm typecheck` — expected clean (ws.ts is untouched so far).

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent/runtime/runner.ts server/lib/agent/runtime/aborts.ts server/lib/agent/runtime/approvals.ts server/lib/agent/runtime/inbox.ts test/agent-runner.db.test.ts
git commit -m "feat(runtime): runner — ws.ts turn body moved server-side, persistence + rescue intact"
```

---

### Task 8: Queue, worker, boot recovery, steering

**Files:**
- Create: `server/lib/agent/runtime/queue.ts`
- Create: `server/lib/agent/runtime/recover.ts`
- Create: `server/plugins/agent-runtime.ts`
- Create: `server/lib/agent/runtime/flag.ts`
- Modify: `shared/types/live.ts` (add `| 'agentRun'` to `ResourceName`)
- Test: `test/agent-queue.db.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 7.
- Produces:
  ```ts
  // queue.ts
  export interface EnqueueRequest {
    sessionKey: SessionKey | 'thread:new'; input: RunInput; trigger: RunTrigger; profile: RunProfile
    wakeReason?: string; modelDefId?: string | null; originSinkId?: string | null
  }
  export interface EnqueueResult { runId: string; conversationId: string; steered: boolean; created: boolean }
  enqueue(req: EnqueueRequest, deps?: { run?: typeof runTurn; kick?: boolean }): Promise<EnqueueResult>
  abortActive(conversationId: string): Promise<boolean>
  pumpOnce(opts?: { onlyConversations?: string[]; run?: typeof runTurn }): Promise<number>   // runs started
  startWorker(): void;  stopWorker(): void
  export const HEADLESS_WALL_CLOCK_MS = 300_000
  export const ALIVE_BUMP_MS = 10_000
  // recover.ts
  recoverOnBoot(opts?: { onlyConversations?: string[] }): Promise<number>
  // flag.ts
  export const AGENT_RUNTIME_KEY = 'agent_runtime'
  runtimeEnabled(): boolean;  loadRuntimeFlag(): Promise<boolean>
  ```

- [ ] **Step 1: Write the failing DB test**

`test/agent-queue.db.test.ts` (harness header):

```ts
import { conversations, conversationMessages, agentRuns, agentInbox } from '../server/db/schema'
import { enqueue, pumpOnce, abortActive } from '../server/lib/agent/runtime/queue'
import { recoverOnBoot } from '../server/lib/agent/runtime/recover'
import { claimNextRun } from '../server/lib/agent/runtime/runs'
import { eq, inArray, sql } from 'drizzle-orm'
import type { AgentRun } from '../server/db/schema'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('queue', () => {
  it('enqueue on thread:new creates the thread and a queued run', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST hi', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    expect(r.created).toBe(true); expect(r.steered).toBe(false)
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('queued')
  })

  it('a message into a conversation with a RUNNING run becomes a steer, not a second run', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST first', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    const second = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'actually, the other doc', modality: 'text' } }, { kick: false })
    expect(second.steered).toBe(true); expect(second.runId).toBe(first.runId)
    const inbox = await useDb().select().from(agentInbox).where(eq(agentInbox.runId, first.runId))
    expect(inbox.map(i => i.content)).toEqual(['actually, the other doc'])
    const runs = await useDb().select().from(agentRuns).where(eq(agentRuns.conversationId, first.conversationId))
    expect(runs).toHaveLength(1)
  })

  it('a WAKE into a busy conversation queues behind it (never steers)', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST busy', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    const w = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'test', input: { text: 'check in', modality: 'text' } }, { kick: false })
    expect(w.steered).toBe(false); expect(w.runId).not.toBe(first.runId)
  })

  it('pumpOnce runs queued work to completion through the injected runner', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST pump', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    const seen: string[] = []
    const fakeRun = async (run: AgentRun) => { seen.push(run.id); return { status: 'done' as const } }
    expect(await pumpOnce({ onlyConversations: [r.conversationId], run: fakeRun as never, rekick: false })).toBe(1)
    await new Promise(res => setTimeout(res, 50))
    expect(seen).toEqual([r.runId])
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('done')
  })

  it('aborting with an unread steer turns the steer into the next queued run', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST abort', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    const slow = async (run: AgentRun) => { await new Promise(r => setTimeout(r, 200)); return { status: 'aborted' as const, _run: run } }
    await pumpOnce({ onlyConversations: [first.conversationId], run: slow as never, rekick: false })
    await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'never read', modality: 'text' } }, { kick: false })
    await abortActive(first.conversationId)
    await new Promise(r => setTimeout(r, 300))
    const runs = await useDb().select().from(agentRuns).where(eq(agentRuns.conversationId, first.conversationId)).orderBy(agentRuns.createdAt)
    expect(runs.map(x => x.status)).toEqual(['aborted', 'queued'])
    expect((runs[1]!.input as { text: string }).text).toBe('never read')
  })

  it('boot recovery marks a stale running run interrupted and writes an event row', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST crash', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await claimNextRun({ onlyConversations: [r.conversationId] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.runId))
    expect(await recoverOnBoot({ onlyConversations: [r.conversationId] })).toBe(1)
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, r.conversationId))
    expect(msgs.map(m => [m.role, m.origin])).toEqual([['event', 'runtime:restart']])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:db test/agent-queue.db.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`server/lib/agent/runtime/queue.ts`:

```ts
// enqueue → DB row; a pump claims runnable rows and executes them. Serialisation per
// conversation is the claim's job (runs.ts); this file only moves work along.
import { activeRunFor, claimNextRun, createRun, finishRun, touchRun } from './runs'
import { resolveSession } from './sessions'
import { pushSteer, requeueUnconsumed } from './inbox'
import { abortRun } from './aborts'
import { runTurn } from './runner'
import { maybeSummarizeLater } from './summarize-hook'
import { publishChange } from '../../../utils/live-bus'
import type { AgentRun } from '../../../db/schema'
import type { RunInput, RunOutcome, RunProfile, RunTrigger, SessionKey } from './types'

export const HEADLESS_WALL_CLOCK_MS = 300_000
export const ALIVE_BUMP_MS = 10_000

export interface EnqueueRequest {
  sessionKey: SessionKey | 'thread:new'; input: RunInput; trigger: RunTrigger; profile: RunProfile
  wakeReason?: string; modelDefId?: string | null; originSinkId?: string | null
}
export interface EnqueueResult { runId: string; conversationId: string; steered: boolean; created: boolean }

type RunFn = (run: AgentRun) => Promise<RunOutcome>

export async function enqueue(req: EnqueueRequest, deps: { run?: RunFn; kick?: boolean } = {}): Promise<EnqueueResult> {
  const { conversationId, created } = await resolveSession(req.sessionKey, { titleHint: req.input.text })
  if (req.trigger === 'user' && !created) {
    const active = await activeRunFor(conversationId)
    if (active) {
      await pushSteer(active.id, conversationId, req.input.text, 'user')
      return { runId: active.id, conversationId, steered: true, created }
    }
  }
  const run = await createRun({
    conversationId, sessionKey: created && req.sessionKey === 'thread:new' ? `thread:${conversationId}` : req.sessionKey,
    trigger: req.trigger, profile: req.profile, input: req.input,
    wakeReason: req.wakeReason ?? null, modelDefId: req.modelDefId ?? null, originSinkId: req.originSinkId ?? null
  })
  if (deps.kick !== false) kick(deps.run)
  return { runId: run.id, conversationId, steered: false, created }
}

export async function abortActive(conversationId: string): Promise<boolean> {
  const active = await activeRunFor(conversationId)
  return active ? (abortRun(active.id), true) : false
}

async function execute(run: AgentRun, runFn: RunFn, rekick: boolean): Promise<void> {
  const alive = setInterval(() => { touchRun(run.id).catch(() => {}) }, ALIVE_BUMP_MS)
  const wall = run.profile === 'headless' ? setTimeout(() => abortRun(run.id), HEADLESS_WALL_CLOCK_MS) : null
  let outcome: RunOutcome
  try {
    outcome = await runFn(run)
  } catch (err) {
    outcome = { status: 'failed', error: (err as Error).message }
  } finally {
    clearInterval(alive); if (wall) clearTimeout(wall)
  }
  await finishRun(run.id, outcome).catch(err => console.error('[runtime] finishRun failed:', err))
  if (outcome.status === 'aborted') await requeueUnconsumed(run).catch(() => null)
  publishChange({ resource: 'agentRun', action: 'updated', id: run.id })
  if (rekick) kick(runFn)
}

/** Claim and START everything currently runnable; returns how many were started. */
/** `rekick: false` + `onlyConversations` is the test seam: the dev DB is shared, and an unscoped
 *  re-pump after a test run finishes would claim (and fake-execute) other sessions' queued runs. */
export async function pumpOnce(opts: { onlyConversations?: string[]; run?: RunFn; rekick?: boolean } = {}): Promise<number> {
  const runFn = opts.run ?? ((r: AgentRun) => runTurn(r, { afterPersist: maybeSummarizeLater }))
  let started = 0
  for (;;) {
    const run = await claimNextRun({ onlyConversations: opts.onlyConversations })
    if (!run) return started
    started++
    void execute(run, runFn, opts.rekick !== false)
  }
}

let pumping = false
let again = false
function kick(run?: RunFn): void {
  if (pumping) { again = true; return }
  pumping = true
  setImmediate(async () => {
    try { do { again = false; await pumpOnce({ run }) } while (again) }
    catch (err) { console.error('[runtime] pump failed:', err) }
    finally { pumping = false }
  })
}

let timer: ReturnType<typeof setInterval> | null = null
export function startWorker(): void { if (!timer) { timer = setInterval(() => kick(), 5_000); kick() } }
export function stopWorker(): void { if (timer) clearInterval(timer); timer = null }
```

> `maybeSummarizeLater` comes from Task 10. For now create `server/lib/agent/runtime/summarize-hook.ts` exporting `export function maybeSummarizeLater(_conversationId: string): void {}` — Task 10 fills it in.

> In the steer test, the conversation's run is claimed but never executed; `enqueue` must still see it as `running`. That is why `activeRunFor` checks status, not an in-memory set.

`server/lib/agent/runtime/recover.ts`:

```ts
import { recoverOrphans } from './runs'
import { appendEvent } from '../../../services/conversations'

/** On boot: any run still 'running' with a stale liveness stamp died with the old process.
 *  Mark it and say so in its thread. No automatic retry — a half-run tool loop is not safely
 *  repeatable. */
export async function recoverOnBoot(opts: { onlyConversations?: string[] } = {}): Promise<number> {
  const dead = await recoverOrphans({ onlyConversations: opts.onlyConversations })
  for (const r of dead) {
    await appendEvent(r.conversationId, 'A turn was interrupted by a restart and did not finish.', 'runtime:restart')
      .catch(err => console.error('[runtime] recovery note failed:', err))
  }
  return dead.length
}
```

`server/lib/agent/runtime/flag.ts`:

```ts
// Rollback lever for one cycle: agent_runtime=false in settings routes ws.ts to the legacy
// in-socket path. Read ONCE at boot (the WS open hook is synchronous); flipping it needs a
// restart. Cycle 74 deletes the legacy path and this file.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { settings } from '../../../db/schema'

export const AGENT_RUNTIME_KEY = 'agent_runtime'
let enabled = true
export function runtimeEnabled(): boolean { return enabled }
export async function loadRuntimeFlag(): Promise<boolean> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_RUNTIME_KEY)).limit(1)
  const v = row?.value as { enabled?: unknown } | undefined
  enabled = typeof v?.enabled === 'boolean' ? v.enabled : true
  return enabled
}
```

`server/plugins/agent-runtime.ts`:

```ts
import { loadRuntimeFlag } from '../lib/agent/runtime/flag'
import { recoverOnBoot } from '../lib/agent/runtime/recover'
import { startWorker, stopWorker } from '../lib/agent/runtime/queue'

// Boot order: read the flag, recover runs orphaned by the previous process, then start the
// worker. Recovery before the worker so a stale 'running' row cannot block its conversation's
// queue for the 60s it would take to look orphaned.
export default defineNitroPlugin(async (nitro) => {
  if (import.meta.prerender) return
  try {
    if (!(await loadRuntimeFlag())) { console.info('[runtime] agent_runtime=false — legacy WS path'); return }
    const n = await recoverOnBoot()
    if (n) console.warn(`[runtime] recovered ${n} interrupted run(s)`)
    startWorker()
    nitro.hooks.hook('close', () => stopWorker())
  } catch (err) {
    console.error('[runtime] boot failed — agent turns will not run until restart:', err)
  }
})
```

- [ ] **Step 4: Run and commit**

Run: `pnpm test:db test/agent-queue.db.test.ts test/agent-runner.db.test.ts test/agent-runs.db.test.ts && pnpm typecheck`
Expected: PASS. Mutations: (a) make `enqueue` skip the `activeRunFor` check → steer test red; (b) remove `requeueUnconsumed` from `execute` → abort test red; (c) drop `trigger === 'user'` from the steer condition → wake test red.

```bash
git add server/lib/agent/runtime/queue.ts server/lib/agent/runtime/recover.ts server/lib/agent/runtime/flag.ts server/lib/agent/runtime/summarize-hook.ts server/plugins/agent-runtime.ts shared/types/live.ts test/agent-queue.db.test.ts
git commit -m "feat(runtime): queue + worker, steering into running turns, boot recovery, runtime flag"
```

---

### Task 9: `ws.ts` on the runtime (legacy path kept behind the flag)

**Files:**
- Create: `server/lib/voice/ws-legacy.ts` (the current `ws.ts` handler object, unchanged)
- Modify: `server/api/voice/ws.ts` (rewritten onto the runtime; delegates to legacy when the flag is off)
- Create: `server/lib/voice/ws-routing.ts` (pure frame → action mapping)
- Test: `test/voice-ws-routing.test.ts`

**Interfaces:**
- Consumes: `enqueue`, `abortActive` (Task 8), `hub`, `Sink` (Task 4), `registerApprovalChannel`, `unregisterApprovalChannel`, `turnStreamFor` (Task 7), `runtimeEnabled` (Task 8).
- Produces: WS protocol changes (client work is Task 13):
  - `load` → subscribe to that conversation. **No longer aborts.**
  - `attach` (new, client→server) → replay the running turn's frames so far.
  - `new` → unsubscribe; next text starts a new thread. **No longer aborts.**
  - `interrupt` → `abortActive(conversationId)`.
  - `text` while a run is active on the conversation → steer; server replies `{ type: 'steered', text }`.
  - Socket close → unsubscribe + drop approval channels. **No longer aborts.**
  - `routeFrame(msg: Record<string, unknown>): WsAction` (pure; see below)

- [ ] **Step 1: Write the failing routing test**

`test/voice-ws-routing.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { routeFrame } from '../server/lib/voice/ws-routing'

describe('routeFrame', () => {
  it.each([
    [{ type: 'interrupt' }, { kind: 'abort' }],
    [{ type: 'load', conversationId: 'c1' }, { kind: 'load', conversationId: 'c1' }],
    [{ type: 'attach' }, { kind: 'attach' }],
    [{ type: 'new' }, { kind: 'new' }],
    [{ type: 'clear' }, { kind: 'clear' }],
    [{ type: 'text', text: '  hi  ', speak: true, skill: 'db-maintenance' }, { kind: 'text', text: 'hi', speak: true, skill: 'db-maintenance', attachments: [] }],
    [{ type: 'text', text: '   ' }, { kind: 'ignore' }],
    [{ type: 'preset', presetId: '' }, { kind: 'preset', presetId: null }],
    [{ type: 'model', modelDefId: 'm1' }, { kind: 'model', modelDefId: 'm1' }],
    [{ type: 'approve', requestId: 'r1', remember: true, pattern: 'exec ls*' }, { kind: 'approve', requestId: 'r1', remember: true, pattern: 'exec ls*' }],
    [{ type: 'deny', requestId: 'r1' }, { kind: 'deny', requestId: 'r1' }],
    [{ type: 'profile' }, { kind: 'ignore' }],
    [{ type: 'load' }, { kind: 'ignore' }]
  ])('%j', (msg, action) => {
    expect(routeFrame(msg as Record<string, unknown>)).toEqual(action)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test test/voice-ws-routing.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `ws-routing.ts`**

```ts
// Pure mapping from a parsed control frame to what ws.ts should do. Kept out of the handler so
// the protocol is testable without a socket.
import type { AttachmentRef } from '../agent/attachments'

export type WsAction =
  | { kind: 'abort' } | { kind: 'attach' } | { kind: 'new' } | { kind: 'clear' } | { kind: 'ignore' }
  | { kind: 'load'; conversationId: string }
  | { kind: 'text'; text: string; speak: boolean; skill?: string; attachments: AttachmentRef[] }
  | { kind: 'preset'; presetId: string | null }
  | { kind: 'model'; modelDefId: string | null }
  | { kind: 'approve'; requestId: string; remember: boolean; pattern?: string }
  | { kind: 'deny'; requestId: string }

export function routeFrame(msg: Record<string, unknown>): WsAction {
  switch (msg.type) {
    case 'interrupt': return { kind: 'abort' }
    case 'attach': return { kind: 'attach' }
    case 'new': return { kind: 'new' }
    case 'clear': return { kind: 'clear' }
    case 'load': return typeof msg.conversationId === 'string' && msg.conversationId ? { kind: 'load', conversationId: msg.conversationId } : { kind: 'ignore' }
    case 'preset': return { kind: 'preset', presetId: typeof msg.presetId === 'string' && msg.presetId ? msg.presetId : null }
    case 'model': return { kind: 'model', modelDefId: typeof msg.modelDefId === 'string' ? msg.modelDefId : null }
    case 'approve': return { kind: 'approve', requestId: String(msg.requestId ?? ''), remember: !!msg.remember, ...(typeof msg.pattern === 'string' ? { pattern: msg.pattern } : {}) }
    case 'deny': return { kind: 'deny', requestId: String(msg.requestId ?? '') }
    case 'text': {
      const text = typeof msg.text === 'string' ? msg.text.trim() : ''
      if (!text) return { kind: 'ignore' }
      return {
        kind: 'text', text, speak: typeof msg.speak === 'boolean' ? msg.speak : false,
        ...(typeof msg.skill === 'string' && msg.skill ? { skill: msg.skill } : {}),
        attachments: Array.isArray(msg.attachments) ? (msg.attachments as AttachmentRef[]) : []
      }
    }
    default: return { kind: 'ignore' }
  }
}
```

Run: `pnpm test test/voice-ws-routing.test.ts` — Expected: PASS. (The `speak`-less text row expects `speak: false`… the table row passes `speak: true`; add one more row `{ type: 'text', text: 'x' }` → `{ kind: 'text', text: 'x', speak: false, attachments: [] }` and confirm it passes.)

- [ ] **Step 4: Preserve the legacy handler**

Create `server/lib/voice/ws-legacy.ts` by copying the **entire** current `server/api/voice/ws.ts`, then change only: the relative import paths (`../../lib/...` → `../...`, `../../services/...` → `../../services/...`, `../../db` → `../../db`, `../../utils/live-bus` → `../../utils/live-bus`), and `export default defineWebSocketHandler({` → `export const legacyHooks = {` with the closing `})` → `}`. Add at the top: `// Cycle 73 rollback lever: the pre-runtime WS handler, verbatim. Used only when agent_runtime=false. DELETE in cycle 74.`

- [ ] **Step 5: Rewrite `server/api/voice/ws.ts`**

```ts
// server/api/voice/ws.ts
// Thin socket: auth, STT, voice/model choice, approvals UI, and frame routing. Turns do NOT
// live here any more — they are runs in server/lib/agent/runtime, which outlive this socket.
// Closing the tab unsubscribes; it never aborts. Stop ('interrupt') is the only abort.
import { randomUUID } from 'node:crypto'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel } from '../../lib/voice/providers'
import type { SttProvider } from '../../lib/voice/providers/types'
import { withFailover } from '../../lib/ai/registry/resolve'
import { VOICE_TUNING } from '../../lib/voice/tuning'
import { routeFrame } from '../../lib/voice/ws-routing'
import { legacyHooks } from '../../lib/voice/ws-legacy'
import { runtimeEnabled } from '../../lib/agent/runtime/flag'
import { enqueue, abortActive } from '../../lib/agent/runtime/queue'
import { hub, type Sink } from '../../lib/agent/runtime/stream'
import { registerApprovalChannel, unregisterApprovalChannel, turnStreamFor } from '../../lib/agent/runtime/approvals'
import { clearConversationContext } from '../../services/conversation-clear'
import { useDb } from '../../db'
import { conversations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import type { ApprovalRequest } from '../../lib/agent/types'
import { loadApprovals, addApproval, touchApproval, matchesApproval, approvalOutcome } from '../../lib/exec/approvals'
import { recordEvent } from '../../lib/observability/record'
import { denyPendingApprovals } from '../../lib/voice/pending-approvals'

interface ConnState {
  sink: Sink
  presetId: string | null
  model: string | null
  /** The thread this socket is viewing; null = the next message starts a new side thread. */
  conversationId: string | null
  unsubscribe: (() => void) | null
  runs: Set<string>
  pendingApprovals: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout>; req: ApprovalRequest }>
}
const conns = new WeakMap<object, ConnState>()

const stt: SttProvider = { transcribe: (audio, opts) => withFailover('stt', m => sttFromModel(m).transcribe(audio, opts)) }

function view(s: ConnState, conversationId: string | null, replay: boolean) {
  s.unsubscribe?.(); s.unsubscribe = null
  s.conversationId = conversationId
  if (conversationId) s.unsubscribe = hub.subscribe(conversationId, s.sink, { replay })
}

export default defineWebSocketHandler({
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  open(peer) {
    if (!runtimeEnabled()) return legacyHooks.open(peer)
    conns.set(peer, {
      sink: { id: randomUUID(), send: d => peer.send(d) },
      presetId: null, model: null, conversationId: null, unsubscribe: null, runs: new Set(), pendingApprovals: new Map()
    })
  },
  async message(peer, message) {
    if (!runtimeEnabled()) return legacyHooks.message(peer, message)
    const s = conns.get(peer); if (!s) return
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return

    const requestApproval = (runId: string) => async (req: ApprovalRequest): Promise<{ approved: boolean }> => {
      // (body copied from the legacy requestApproval, with `s.activeTurn?.emit(...)` replaced by
      //  `turnStreamFor(runId)?.emit(...)` — nothing else changes)
    }
    const denyAll = () => { for (const id of denyPendingApprovals(s.pendingApprovals)) peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) }

    const submit = async (text: string, o: { speak: boolean; skill?: string; attachments: import('../../lib/agent/attachments').AttachmentRef[]; modality: 'text' | 'voice' }) => {
      try {
        const r = await enqueue({
          sessionKey: s.conversationId ? `thread:${s.conversationId}` : 'thread:new',
          trigger: 'user', profile: 'interactive', modelDefId: s.model, originSinkId: s.sink.id,
          input: { text, modality: o.modality, speak: o.speak, skill: o.skill, attachments: o.attachments, presetId: s.presetId }
        })
        if (r.conversationId !== s.conversationId) view(s, r.conversationId, true)
        if (r.steered) { peer.send(JSON.stringify({ type: 'steered', text })); return }
        s.runs.add(r.runId)
        registerApprovalChannel(r.runId, requestApproval(r.runId))
      } catch (err) {
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'could not start the turn' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
    }

    if (frame.kind !== 'control') {
      // Voice: transcribe HERE, then it is an ordinary run. STT used to happen inside the turn,
      // under the lock; now the run only ever sees text.
      try {
        peer.send(JSON.stringify({ type: 'state', state: 'thinking' }))
        const text = (await stt.transcribe(frame.bytes, { language: VOICE_TUNING.stt.language })).trim()
        if (!text) { peer.send(JSON.stringify({ type: 'state', state: 'idle' })); return }
        await submit(text, { speak: true, attachments: [], modality: 'voice' })
      } catch (err) {
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'transcription failed' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
      return
    }

    const a = routeFrame(frame.msg)
    switch (a.kind) {
      case 'abort': if (s.conversationId) await abortActive(s.conversationId); denyAll(); return
      case 'preset': s.presetId = a.presetId; return
      case 'model': s.model = a.modelDefId; return
      case 'load': view(s, a.conversationId, false); return
      case 'attach': if (s.conversationId) hub.replay(s.conversationId, s.sink); return
      case 'new': view(s, null, false); return
      case 'text': await submit(a.text, { speak: a.speak, skill: a.skill, attachments: a.attachments, modality: 'text' }); return
      case 'approve': case 'deny': {
        // (body copied from the legacy approve/deny branch unchanged, reading a.requestId /
        //  a.remember / a.pattern instead of msg.*)
        return
      }
      case 'clear': {
        const id = s.conversationId
        if (!id) { peer.send(JSON.stringify({ type: 'cleared', epochAt: null })); return }
        await abortActive(id); denyAll()
        try {
          await clearConversationContext(id)
          const [row] = await useDb().select({ at: conversations.contextEpochAt }).from(conversations).where(eq(conversations.id, id)).limit(1)
          peer.send(JSON.stringify({ type: 'cleared', epochAt: row?.at ? row.at.toISOString() : null }))
        } catch (err) {
          console.error('[agent] clear failed:', err)
          peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'failed to clear conversation' }))
        }
        return
      }
      default: return
    }
  },
  close(peer) {
    if (!runtimeEnabled()) return legacyHooks.close(peer)
    const s = conns.get(peer); if (!s) return
    s.unsubscribe?.()
    for (const id of s.runs) unregisterApprovalChannel(id)
    for (const id of denyPendingApprovals(s.pendingApprovals)) {
      try { peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) } catch { /* closing */ }
    }
    conns.delete(peer)
  }
})
```

The two `(body copied …)` markers are **instructions, not placeholders**: paste the legacy code for `requestApproval` and the approve/deny branch verbatim (they are in `ws-legacy.ts` after Step 4) and apply exactly the substitution named. Keep the protocol comment block from the old file's header, updated for `attach`, `steered`, and the no-abort semantics of `load`/`new`/close.

- [ ] **Step 6: Verify**

Run: `pnpm test && pnpm test:db && pnpm typecheck && pnpm build`
Expected: all green. `pnpm build` matters here: the handler's `open`/`close` must stay synchronous for crossws.

Manual smoke (dev): `pnpm dev`, open `/agent`, send "say hi", confirm the reply streams and persists (reload shows it). Close the tab mid-reply to a long prompt ("count slowly to 40, one number per line"), reopen the thread — the full reply is there.

- [ ] **Step 7: Commit**

```bash
git add server/api/voice/ws.ts server/lib/voice/ws-legacy.ts server/lib/voice/ws-routing.ts test/voice-ws-routing.test.ts
git commit -m "feat(runtime): ws.ts becomes a thin subscriber; turns outlive the socket (legacy path behind agent_runtime)"
```

---

### Task 10: Thread summaries — the writer, its triggers, idle sweep

**Files:**
- Create: `server/lib/agent/runtime/summarize.ts`
- Modify: `server/lib/agent/runtime/summarize-hook.ts` (real implementation)
- Create: `server/tasks/summarize-threads.ts`
- Modify: `nuxt.config.ts` (`'*/10 * * * *': ['triage-input', 'summarize-threads']`)
- Test: `test/agent-summarize.db.test.ts`

**Interfaces:**
- Consumes: `loadActivePath` (with `sinceEpoch` + `sinceSummary`), `groupTurns`, `turnTier`, `rowToAgentMessage`, `chat('bulk', …)`, `embedOne`.
- Produces:
  ```ts
  export const SUMMARY_TRIGGER_TOKENS = 12_000
  export const SUMMARY_KEEP_TURNS = 6
  export const SIDE_THREAD_IDLE_MS = 30 * 60_000
  maybeSummarize(conversationId: string, opts?: { force?: boolean; summarizer?: (prev: string | null, transcript: string) => Promise<string>; embed?: (t: string) => Promise<number[] | null> }): Promise<'skipped' | 'summarized'>
  summarizeIdleThreads(): Promise<number>
  maybeSummarizeLater(conversationId: string): void     // fire-and-forget wrapper
  ```

- [ ] **Step 1: Write the failing DB test**

`test/agent-summarize.db.test.ts` (harness header):

```ts
import { conversations, conversationMessages } from '../server/db/schema'
import { maybeSummarize, SUMMARY_KEEP_TURNS } from '../server/lib/agent/runtime/summarize'
import { appendMessages, getAgentHistory, getConversation, createConversation } from '../server/services/conversations'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})
async function threadWith(turns: number, size = 50) {
  const c = await createConversation({ title: 'SUMMARIZE-TEST' }); convIds.push(c.id)
  for (let i = 0; i < turns; i++) {
    await appendMessages(c.id, [
      { role: 'user', content: `q${i} ` + 'w '.repeat(size), modality: 'text' },
      { role: 'assistant', content: `a${i} ` + 'w '.repeat(size), modality: 'text' }
    ])
  }
  return c.id
}
const fakeSummarizer = async (prev: string | null, transcript: string) => `${prev ? prev + ' + ' : ''}summary of ${transcript.match(/q\d+/g)?.join(',')}`

describe('maybeSummarize', () => {
  it('skips a short thread', async () => {
    const id = await threadWith(3)
    expect(await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })).toBe('skipped')
  })

  it('folds everything but the last 6 turns once over the trigger, and the model then reads tail + summary', async () => {
    const id = await threadWith(10, 2500)
    expect(await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })).toBe('summarized')
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summary).toBe('summary of q0,q1,q2,q3')
    expect(c!.summarizedThrough).toBeTruthy()
    const model = await getAgentHistory(id)
    expect(model.filter(m => m.role === 'user')).toHaveLength(SUMMARY_KEEP_TURNS)
    expect((await getConversation(id))!.messages).toHaveLength(20)   // the UI still has everything
  })

  it('is incremental: a second fold extends the previous summary', async () => {
    const id = await threadWith(10, 2500)
    await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
    await appendMessages(id, Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `q${10 + i} ` + 'w '.repeat(2500), modality: 'text' as const })))
    await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summary).toMatch(/^summary of q0,q1,q2,q3 \+ summary of q4,q5/)
  })

  it('force folds a short idle thread down to the kept tail', async () => {
    const id = await threadWith(8)
    expect(await maybeSummarize(id, { force: true, summarizer: fakeSummarizer, embed: async () => null })).toBe('summarized')
  })

  it('a summarizer failure leaves the thread untouched', async () => {
    const id = await threadWith(10, 2500)
    await expect(maybeSummarize(id, { summarizer: async () => { throw new Error('rig down') }, embed: async () => null })).resolves.toBe('skipped')
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summarizedThrough).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:db test/agent-summarize.db.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `summarize.ts`**

```ts
// server/lib/agent/runtime/summarize.ts
// The incremental thread summary writer — conversations.summary's first writer. Off the hot
// path: called after a run persists, and by the */10 idle sweep. Folds everything but the last
// SUMMARY_KEEP_TURNS turns into prose, advances summarized_through to the last folded row's
// created_at (a POSTGRES timestamp, read back from the row — never the app clock).
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations } from '../../../db/schema'
import { loadActivePath } from '../../../services/conversation-path'
import { rowToAgentMessage } from '../../../services/conversations'
import { chat } from '../../ai/chat'
import { embedOne } from '../../ai/embeddings'
import { messageText } from '../run'
import { groupTurns, turnTier } from './history'

export const SUMMARY_TRIGGER_TOKENS = 12_000
export const SUMMARY_KEEP_TURNS = 6
export const SIDE_THREAD_IDLE_MS = 30 * 60_000

const SYSTEM = [
  'You maintain the running summary of a conversation between Tony and his assistant Bridget.',
  'Given the PREVIOUS summary (may be empty) and NEW transcript turns, write the updated summary.',
  'First paragraph: what Tony is working on right now, in 1-3 sentences. Then short paragraphs: decisions made, open questions, things Bridget promised to do.',
  'Plain prose, no headings, no bullet markers, under 250 words. Never invent anything not in the text.'
].join('\n')

async function defaultSummarizer(prev: string | null, transcript: string): Promise<string> {
  return chat('bulk', [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `PREVIOUS SUMMARY:\n${prev ?? '(none)'}\n\nNEW TURNS:\n${transcript}` }
  ], { temperature: 0.2, maxTokens: 700 })
}

export async function maybeSummarize(conversationId: string, opts: {
  force?: boolean
  summarizer?: (prev: string | null, transcript: string) => Promise<string>
  embed?: (t: string) => Promise<number[] | null>
} = {}): Promise<'skipped' | 'summarized'> {
  const { rows } = await loadActivePath(conversationId, { sinceEpoch: true, sinceSummary: true })
  const msgs = rows.map(r => ({ row: r, msg: rowToAgentMessage(r) }))
  const turns = groupTurns(msgs.map(m => m.msg))
  const tokens = turns.reduce((n, t, i) => n + turnTier(t, i).tokens, 0)
  if (turns.length <= SUMMARY_KEEP_TURNS) return 'skipped'
  if (!opts.force && tokens <= SUMMARY_TRIGGER_TOKENS) return 'skipped'

  const foldCount = turns.slice(0, -SUMMARY_KEEP_TURNS).reduce((n, t) => n + t.length, 0)
  const folded = msgs.slice(0, foldCount)
  const transcript = folded.map(({ msg }) => `${msg.role === 'user' ? 'Tony' : 'Bridget'}: ${messageText(msg.content)}`).join('\n\n')
  const [conv] = await useDb().select({ summary: conversations.summary }).from(conversations).where(eq(conversations.id, conversationId)).limit(1)

  let summary: string
  try {
    summary = (await (opts.summarizer ?? defaultSummarizer)(conv?.summary ?? null, transcript)).trim()
  } catch (err) {
    console.warn('[summarize] summarizer failed — tail stays longer, next trigger retries:', err)
    return 'skipped'
  }
  if (!summary) return 'skipped'
  let vec: number[] | null = null
  try { vec = await (opts.embed ?? embedOne)(summary) } catch { /* keep null; next fold re-embeds */ }

  const through = folded[folded.length - 1]!.row.createdAt
  await useDb().update(conversations).set({
    summary, summarizedThrough: through, ...(vec ? { summaryEmbedding: vec as never } : {}), updatedAt: sql`now()`
  }).where(eq(conversations.id, conversationId))
  return 'summarized'
}

export async function summarizeIdleThreads(): Promise<number> {
  const idle = await useDb().select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.kind, 'thread'),
    isNotNull(conversations.lastMessageAt),
    sql`${conversations.lastMessageAt} < now() - make_interval(secs => ${SIDE_THREAD_IDLE_MS / 1000})`,
    sql`(${conversations.summarizedThrough} is null or ${conversations.summarizedThrough} < ${conversations.lastMessageAt})`,
    sql`${conversations.lastMessageAt} > now() - interval '7 days'`
  )).limit(20)
  let n = 0
  for (const c of idle) if (await maybeSummarize(c.id, { force: true }).catch(() => 'skipped') === 'summarized') n++
  return n
}
```

> "force folds a short idle thread": with 8 turns and keep 6, force folds 2. With ≤6 turns there is nothing to fold even when forced — that is intended (the whole thread fits verbatim).

Replace `summarize-hook.ts` with:

```ts
import { maybeSummarize } from './summarize'
/** Fire-and-forget after a run persists. Never throws, never delays the next run. */
export function maybeSummarizeLater(conversationId: string): void {
  setImmediate(() => { maybeSummarize(conversationId).catch(err => console.warn('[summarize] after-run fold failed:', err)) })
}
```

Create `server/tasks/summarize-threads.ts`:

```ts
import { summarizeIdleThreads } from '../lib/agent/runtime/summarize'
import { withSpan } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'summarize-threads', description: 'Fold idle side threads into their running summary (cycle 73)' },
  async run() {
    const summarized = await withSpan({ kind: 'job', name: 'summarize-threads' }, () => summarizeIdleThreads())
    return { result: { summarized } }
  }
})
```

In `nuxt.config.ts` change `'*/10 * * * *': ['triage-input']` to `'*/10 * * * *': ['triage-input', 'summarize-threads']`.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:db test/agent-summarize.db.test.ts && pnpm typecheck`
Expected: PASS. Mutations: (a) set `summarizedThrough: new Date()` instead of `through` → the incremental test's second fold re-reads nothing / wrong rows (red); (b) return `'summarized'` from the catch → failure test red.

```bash
git add server/lib/agent/runtime/summarize.ts server/lib/agent/runtime/summarize-hook.ts server/tasks/summarize-threads.ts nuxt.config.ts test/agent-summarize.db.test.ts
git commit -m "feat(runtime): incremental thread summaries — after-run fold + idle sweep (conversations.summary's first writer)"
```

---

### Task 11: Headless runs — the gate, `wake()`, admin endpoint, `/wake`

**Files:**
- Create: `server/lib/agent/runtime/gate.ts`
- Create: `server/lib/agent/runtime/wake.ts`
- Modify: `server/lib/agent/runtime/runner.ts` (replace the placeholder `headlessProfile`)
- Modify: `server/services/review.ts` (`ReviewTargetKind` gains `'agent_run'`)
- Create: `server/api/admin/agent/wake.post.ts`
- Modify: `shared/types/commands.ts` (client command `wake`)
- Modify: `app/pages/agent/index.vue` (`onComposerCommand` handles `wake`)
- Test: `test/agent-gate.test.ts`, `test/agent-wake.db.test.ts`

**Interfaces:**
- Consumes: `bridgetProfile`, `AgentTool`, `enqueue`, `reviewQueue`.
- Produces:
  ```ts
  // gate.ts
  export type HeadlessClass = 'run' | 'propose' | 'exclude'
  export const APPEND_TOOLS: ReadonlySet<string>
  export const PROPOSE_TOOLS: ReadonlySet<string>
  classifyForHeadless(t: AgentTool): HeadlessClass                // throws on an unclassified tool
  headlessTools(registry: AgentTool[], run: { id: string; conversationId: string }, propose?: ProposeFn): AgentTool[]
  export type ProposeFn = (p: AgentActionProposal) => Promise<string>   // → review id
  export interface AgentActionProposal { runId: string; conversationId: string; tool: string; args: Record<string, unknown> }
  proposeAction(p: AgentActionProposal): Promise<string>
  // wake.ts
  export interface WakeRequest { reason: string; prompt: string; sessionKey?: SessionKey; model?: string | null }
  wake(req: WakeRequest, deps?: { kick?: boolean }): Promise<{ runId: string; conversationId: string }>
  // runner.ts
  headlessProfile(run: AgentRun): AgentProfile
  ```

- [ ] **Step 1: Write the failing gate test**

`test/agent-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyForHeadless, headlessTools } from '../server/lib/agent/runtime/gate'
import { bridgetProfile } from '../server/lib/agent/profile'
import type { AgentTool } from '../server/lib/agent/types'

describe('headless gate', () => {
  it('classifies every tool Bridget has — a new unclassified tool fails this test', () => {
    for (const t of bridgetProfile.tools) expect(() => classifyForHeadless(t)).not.toThrow()
  })
  it('never lets exec (or any dangerous tool) into a headless run', () => {
    const tools = headlessTools(bridgetProfile.tools, { id: 'r', conversationId: 'c' }, async () => 'x')
    expect(tools.find(t => t.name === 'exec')).toBeUndefined()
    expect(tools.some(t => t.dangerous)).toBe(false)
  })
  it.each(['search_memories', 'read_document', 'web_fetch', 'use_skill', 'research_web'])('%s runs', (n) => {
    expect(classifyForHeadless(bridgetProfile.tools.find(t => t.name === n)!)).toBe('run')
  })
  it.each(['save_memory', 'create_task', 'quick_capture', 'save_document'])('%s (append) runs', (n) => {
    expect(classifyForHeadless(bridgetProfile.tools.find(t => t.name === n)!)).toBe('run')
  })
  it.each(['edit_task', 'delete_task', 'forget_memory', 'delete_document', 'edit_document', 'move_document', 'create_skill', 'edit_skill', 'edit_project'])('%s is proposed', (n) => {
    expect(classifyForHeadless(bridgetProfile.tools.find(t => t.name === n)!)).toBe('propose')
  })
  it('a proposed tool does not run its handler and returns the proposal receipt', async () => {
    let ran = false
    const fake: AgentTool = { name: 'edit_task', description: '', schema: {}, kind: 'destructive', handler: async () => { ran = true; return { result: 1, summary: '' } } }
    const [gated] = headlessTools([fake], { id: 'run-1', conversationId: 'c-1' }, async (p) => { expect(p).toMatchObject({ runId: 'run-1', conversationId: 'c-1', tool: 'edit_task', args: { id: 't' } }); return 'rev-1' })
    const out = await gated!.handler({ id: 't' }, { signal: new AbortController().signal })
    expect(ran).toBe(false)
    expect(out.result).toEqual({ proposed: true, reviewId: 'rev-1', note: "Queued for Tony's approval in /review." })
  })
  it('an unknown create-kind tool throws rather than defaulting to run', () => {
    const t: AgentTool = { name: 'brand_new_tool', description: '', schema: {}, kind: 'create', handler: async () => ({ result: 1, summary: '' }) }
    expect(() => classifyForHeadless(t)).toThrow(/unclassified/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test test/agent-gate.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `gate.ts`**

```ts
// server/lib/agent/runtime/gate.ts
// What a background run may do on its own. Interactive Bridget runs edits immediately behind
// undo because Tony is watching; with nobody watching, anything that edits or destroys existing
// data becomes a /review proposal instead (deny → propose → continue). Classification is
// EXPLICIT: a new tool that is neither read, a known append, nor a known mutation throws here,
// so it cannot silently default into running unattended.
import { useDb } from '../../../db'
import { reviewQueue } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import type { AgentTool } from '../types'

export type HeadlessClass = 'run' | 'propose' | 'exclude'
export interface AgentActionProposal { runId: string; conversationId: string; tool: string; args: Record<string, unknown> }
export type ProposeFn = (p: AgentActionProposal) => Promise<string>

export const APPEND_TOOLS: ReadonlySet<string> = new Set(['save_memory', 'create_task', 'create_project', 'quick_capture', 'generate_image', 'save_document'])
export const PROPOSE_TOOLS: ReadonlySet<string> = new Set(['edit_document', 'edit_section', 'update_document', 'move_document', 'sync_document', 'edit_image', 'create_skill', 'edit_skill'])

export function classifyForHeadless(t: AgentTool): HeadlessClass {
  if (t.dangerous) return 'exclude'
  if (t.kind === 'read') return 'run'
  if (APPEND_TOOLS.has(t.name)) return 'run'
  if (t.kind === 'destructive' || PROPOSE_TOOLS.has(t.name)) return 'propose'
  throw new Error(`unclassified tool for headless runs: ${t.name} (kind ${t.kind}) — add it to APPEND_TOOLS or PROPOSE_TOOLS`)
}

export async function proposeAction(p: AgentActionProposal): Promise<string> {
  const [row] = await useDb().insert(reviewQueue).values({
    targetKind: 'agent_run', targetId: p.runId, kind: 'agent-action',
    proposed: { tool: p.tool, args: p.args, conversationId: p.conversationId }
  }).returning({ id: reviewQueue.id })
  publishChange({ resource: 'review', action: 'created', id: row!.id })
  return row!.id
}

export function headlessTools(registry: AgentTool[], run: { id: string; conversationId: string }, propose: ProposeFn = proposeAction): AgentTool[] {
  const out: AgentTool[] = []
  for (const t of registry) {
    const c = classifyForHeadless(t)
    if (c === 'exclude') continue
    if (c === 'run') { out.push(t); continue }
    out.push({
      ...t,
      dangerous: false,
      handler: async (args) => {
        const reviewId = await propose({ runId: run.id, conversationId: run.conversationId, tool: t.name, args })
        return {
          result: { proposed: true, reviewId, note: "Queued for Tony's approval in /review." },
          summary: `proposed ${t.name} for approval`
        }
      }
    })
  }
  return out
}
```

In `server/services/review.ts`: `export type ReviewTargetKind = 'document' | 'memory' | 'agent_run'`.

In `runner.ts`, replace the placeholder with:

```ts
function headlessProfile(run: AgentRun): AgentProfile {
  return { ...bridgetProfile, id: 'headless', tools: headlessTools(bridgetProfile.tools, { id: run.id, conversationId: run.conversationId }) }
}
```

Run: `pnpm test test/agent-gate.test.ts` — Expected: PASS. If the "classifies every tool" test throws for a tool this plan did not list, **stop and ask** which class it belongs to rather than guessing. Mutation: move `edit_task` handling to `'run'` (e.g. check `APPEND_TOOLS` with `edit_task` added) → its row goes red.

- [ ] **Step 4: Write the failing wake test**

`test/agent-wake.db.test.ts` (harness header):

```ts
import { conversations, conversationMessages, agentRuns } from '../server/db/schema'
import { wake } from '../server/lib/agent/runtime/wake'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('wake', () => {
  it('queues a headless wake run on an isolated session', async () => {
    const r = await wake({ reason: 'test', prompt: 'WAKE-TEST anything new?', sessionKey: 'isolated:WAKE-TEST' }, { kick: false })
    convIds.push(r.conversationId)
    const [run] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(run).toMatchObject({ trigger: 'wake', profile: 'headless', wakeReason: 'test', status: 'queued' })
    expect((run!.input as { text: string }).text).toBe('WAKE-TEST anything new?')
  })
  it('rejects an empty prompt or reason', async () => {
    await expect(wake({ reason: '', prompt: 'x' }, { kick: false })).rejects.toThrow(/reason/)
    await expect(wake({ reason: 'x', prompt: '  ' }, { kick: false })).rejects.toThrow(/prompt/)
  })
})
```

Run: `pnpm test:db test/agent-wake.db.test.ts` — Expected: FAIL.

- [ ] **Step 5: Implement `wake.ts`, the endpoint, and `/wake`**

`server/lib/agent/runtime/wake.ts`:

```ts
// The single entry point for anything that is not Tony typing. Heartbeat, cron and event
// triggers (cycle 74) are new CALLERS of this; nothing else may enqueue a headless run.
import { enqueue } from './queue'
import type { SessionKey } from './types'

export interface WakeRequest { reason: string; prompt: string; sessionKey?: SessionKey; model?: string | null }

export async function wake(req: WakeRequest, deps: { kick?: boolean } = {}): Promise<{ runId: string; conversationId: string }> {
  const reason = req.reason.trim(); const prompt = req.prompt.trim()
  if (!reason || !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(reason)) throw new Error('wake: reason must be a short slug')
  if (!prompt) throw new Error('wake: prompt is required')
  const r = await enqueue({
    sessionKey: req.sessionKey ?? 'main', trigger: 'wake', profile: 'headless', wakeReason: reason,
    modelDefId: req.model ?? null, input: { text: prompt, modality: 'text' }
  }, { kick: deps.kick })
  return { runId: r.runId, conversationId: r.conversationId }
}
```

`server/api/admin/agent/wake.post.ts`:

```ts
import { wake } from '../../../lib/agent/runtime/wake'

/** Manual wake (admin, session-authed by server middleware like every /api/admin route). */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ reason?: string; prompt?: string; sessionKey?: string; model?: string }>(event)
  const sessionKey = body.sessionKey === 'main' || body.sessionKey?.startsWith('isolated:') || body.sessionKey?.startsWith('thread:')
    ? body.sessionKey as never : undefined
  try {
    return await wake({ reason: body.reason ?? 'admin', prompt: body.prompt ?? '', sessionKey, model: body.model ?? null })
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
})
```

In `shared/types/commands.ts` add to the client command list: `{ name: 'wake', kind: 'client', description: 'Wake Bridget in the background (main thread)', hint: '/wake <what to look at> — runs with nobody watching; NO_REPLY if nothing matters' }`.

In `app/pages/agent/index.vue` `onComposerCommand` add:

```ts
  else if (name === 'wake') void $fetch('/api/admin/agent/wake', { method: 'POST', body: { reason: 'manual', prompt: args } })
    .then(() => toast.add({ title: 'Bridget woken', description: 'The run lands in her main thread.' }))
    .catch((e: { data?: { statusMessage?: string } }) => toast.add({ color: 'error', title: 'Wake failed', description: e?.data?.statusMessage }))
```

(and change the function signature to destructure `args`).

- [ ] **Step 6: Run and commit**

Run: `pnpm test test/agent-gate.test.ts test/agent-commands-menu.test.ts test/command-merge.test.ts && pnpm test:db test/agent-wake.db.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add server/lib/agent/runtime/gate.ts server/lib/agent/runtime/wake.ts server/lib/agent/runtime/runner.ts server/services/review.ts server/api/admin/agent/wake.post.ts shared/types/commands.ts app/pages/agent/index.vue test/agent-gate.test.ts test/agent-wake.db.test.ts
git commit -m "feat(runtime): headless gate (deny→propose→continue), wake() entry point, admin endpoint and /wake"
```

---

### Task 12: `/review` — approving an agent action replays it

**Files:**
- Create: `server/lib/agent/runtime/replay.ts`
- Modify: `server/api/review/kinds.ts` (register `agent-action` approve/reject)
- Modify: `server/services/review.ts` (`listReviewFeed` includes `agent-action` rows with their proposal)
- Create: `app/components/review/AgentActionCard.vue`
- Modify: the `/review` page component that switches on `kind` (find it with `grep -rn "memory-contradict" app/` — render `AgentActionCard` for `kind === 'agent-action'`)
- Test: `test/agent-replay.db.test.ts`

**Interfaces:**
- Consumes: `agentTools`, `appendEvent`, `reviewQueue`.
- Produces:
  ```ts
  replayAgentAction(p: { tool: string; args: Record<string, unknown> }, deps?: { tools?: AgentTool[] }): Promise<{ ok: true; summary: string } | { ok: false; error: string }>
  approveAgentAction(item: ReviewItem, deps?: { tools?: AgentTool[] }): Promise<void>
  rejectAgentAction(item: ReviewItem): Promise<void>
  ```

- [ ] **Step 1: Write the failing DB test**

`test/agent-replay.db.test.ts` (harness header):

```ts
import { z } from 'zod'
import { conversations, conversationMessages, reviewQueue } from '../server/db/schema'
import { approveAgentAction, rejectAgentAction, replayAgentAction } from '../server/lib/agent/runtime/replay'
import { createConversation } from '../server/services/conversations'
import { eq, inArray } from 'drizzle-orm'
import type { AgentTool } from '../server/lib/agent/types'

const convIds: string[] = []; const reviewIds: string[] = []
afterAll(async () => {
  const db = useDb()
  if (reviewIds.length) await db.delete(reviewQueue).where(inArray(reviewQueue.id, reviewIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})
let calls = 0
const tools: AgentTool[] = [{ name: 'edit_task', description: '', kind: 'destructive', schema: { id: z.string(), status: z.string() }, handler: async (a) => { calls++; return { result: { ok: true }, summary: `moved ${a.id} to ${a.status}` } } }]
async function item(args: Record<string, unknown>) {
  const c = await createConversation({ title: 'REPLAY-TEST' }); convIds.push(c.id)
  const [row] = await useDb().insert(reviewQueue).values({ targetKind: 'agent_run', targetId: c.id, kind: 'agent-action', proposed: { tool: 'edit_task', args, conversationId: c.id } }).returning()
  reviewIds.push(row!.id)
  return { row: row!, conversationId: c.id }
}

describe('agent-action review', () => {
  it('approve runs the stored call exactly once, marks approved, and notes it in the thread', async () => {
    calls = 0
    const { row, conversationId } = await item({ id: 't1', status: 'done' })
    await approveAgentAction(row, { tools })
    expect(calls).toBe(1)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('approved')
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    expect(msgs.map(m => [m.role, m.origin, m.content])).toEqual([['event', 'review:approved', 'Approved: edit_task — moved t1 to done']])
  })
  it('reject runs nothing', async () => {
    calls = 0
    const { row } = await item({ id: 't2', status: 'done' })
    await rejectAgentAction(row)
    expect(calls).toBe(0)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('rejected')
  })
  it('args that no longer fit the tool schema fail visibly and never run', async () => {
    calls = 0
    const { row, conversationId } = await item({ id: 't3' })   // status missing → schema drift
    await approveAgentAction(row, { tools })
    expect(calls).toBe(0)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('failed')
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    expect(msgs[0]!.content).toMatch(/^Could not apply edit_task:/)
  })
  it('refuses to replay a dangerous tool even if one was somehow stored', async () => {
    const r = await replayAgentAction({ tool: 'exec', args: { command: 'ls' } }, { tools: [{ name: 'exec', description: '', kind: 'destructive', dangerous: true, schema: {}, handler: async () => ({ result: 1, summary: '' }) }] })
    expect(r).toEqual({ ok: false, error: 'exec is not replayable' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:db test/agent-replay.db.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `replay.ts` and register the handlers**

```ts
// server/lib/agent/runtime/replay.ts
// Approving a headless proposal runs the STORED call — deterministic, no model turn, nothing
// suspended. Args are re-validated against the tool's CURRENT schema: a proposal that no longer
// fits fails visibly instead of running a stale call.
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue, type ReviewItem } from '../../../db/schema'
import { agentTools } from '../tools'
import { appendEvent } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'
import type { AgentTool } from '../types'

interface Proposed { tool: string; args: Record<string, unknown>; conversationId: string }

export async function replayAgentAction(p: { tool: string; args: Record<string, unknown> }, deps: { tools?: AgentTool[] } = {}): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const t = (deps.tools ?? agentTools).find(x => x.name === p.tool)
  if (!t) return { ok: false, error: `unknown tool ${p.tool}` }
  if (t.dangerous) return { ok: false, error: `${t.name} is not replayable` }
  const parsed = z.object(t.schema).safeParse(p.args)
  if (!parsed.success) return { ok: false, error: `arguments no longer match the tool: ${parsed.error.issues.map(i => i.path.join('.') || i.message).join(', ')}` }
  try {
    const exec = await t.handler(parsed.data as Record<string, unknown>, { signal: AbortSignal.timeout(60_000) })
    return { ok: true, summary: exec.summary }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function settle(item: ReviewItem, status: 'approved' | 'rejected' | 'failed') {
  await useDb().update(reviewQueue).set({ status, resolvedAt: sql`now()` }).where(eq(reviewQueue.id, item.id))
  publishChange({ resource: 'review', action: 'updated', id: item.id })
}

export async function approveAgentAction(item: ReviewItem, deps: { tools?: AgentTool[] } = {}): Promise<void> {
  const p = item.proposed as Proposed
  const r = await replayAgentAction(p, deps)
  await settle(item, r.ok ? 'approved' : 'failed')
  await appendEvent(p.conversationId, r.ok ? `Approved: ${p.tool} — ${r.summary}` : `Could not apply ${p.tool}: ${r.error}`, r.ok ? 'review:approved' : 'review:failed')
}

export async function rejectAgentAction(item: ReviewItem): Promise<void> {
  await settle(item, 'rejected')
}
```

In `server/api/review/kinds.ts`: import `approveAgentAction, rejectAgentAction` from `../../lib/agent/runtime/replay` and add `'agent-action': approveAgentAction` to `approveHandlers`, `'agent-action': rejectAgentAction` to `rejectHandlers`. (`approveAgentAction`'s optional second param is ignored by the `Handler` type — wrap as `'agent-action': item => approveAgentAction(item)` if typecheck objects.)

- [ ] **Step 4: Surface it in the feed and UI**

In `server/services/review.ts` `listReviewFeed`: find where `review_queue` rows are mapped to `ReviewQueueFeedItem`; `agent-action` rows must come through with `kind`, `proposed` and `createdAt` (they have no document, so `docPath` is null — the existing left join already yields that). If the function filters kinds with an allow-list, add `'agent-action'`.

Create `app/components/review/AgentActionCard.vue`:

```vue
<!-- app/components/review/AgentActionCard.vue -->
<script setup lang="ts">
const props = defineProps<{ item: { id: string; createdAt: string; proposed: { tool: string; args: Record<string, unknown>; conversationId: string } } }>()
const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>()
const args = computed(() => JSON.stringify(props.item.proposed.args, null, 2))
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <UIcon name="i-lucide-bot" class="size-4 shrink-0" />
          <span class="font-medium truncate">Bridget wants to run <code>{{ item.proposed.tool }}</code></span>
        </div>
        <NuxtLink :to="`/agent?c=${item.proposed.conversationId}`" class="text-xs text-muted hover:underline shrink-0">from this thread</NuxtLink>
      </div>
    </template>
    <pre class="text-xs whitespace-pre-wrap break-all max-h-64 overflow-auto">{{ args }}</pre>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Reject" @click="emit('reject', item.id)" />
        <UButton color="primary" label="Approve and run" @click="emit('approve', item.id)" />
      </div>
    </template>
  </UCard>
</template>
```

Wire it into the `/review` page's kind switch next to the existing cards, calling the same approve/reject functions the other kinds use (`POST /api/review/:id/approve` / `reject`).

- [ ] **Step 5: Run and commit**

Run: `pnpm test:db test/agent-replay.db.test.ts && pnpm test && pnpm typecheck`
Expected: PASS. Mutation: skip the `safeParse` (pass `p.args` straight through) → the drift test goes red.

```bash
git add server/lib/agent/runtime/replay.ts server/api/review/kinds.ts server/services/review.ts app/components/review/AgentActionCard.vue app/pages/review test/agent-replay.db.test.ts
git commit -m "feat(review): agent-action proposals — deterministic replay on approve, schema-drift guard"
```

(Adjust the `app/pages/review` path to the actual file you edited.)

---

### Task 13: Agent page — main thread first, event rows, attach, steering, runs drawer

**Files:**
- Modify: `app/lib/agent/to-ui-messages.ts` (event → system message)
- Modify: `app/components/agent/Conversation.vue` (render event rows as dividers)
- Modify: `app/components/agent/ThreadRail.vue` (main pinned)
- Modify: `app/composables/useVoice.ts` (`attach` after resume; `steered` frame; `load`/`new` no longer imply abort)
- Modify: `app/components/agent/PromptInput.vue` (submit allowed while busy → steer)
- Modify: `app/pages/agent/index.vue` (default to main; send `attach` after resume; runs drawer)
- Create: `server/api/agent/runs.get.ts`
- Create: `app/components/agent/RunsDrawer.vue`
- Modify: live dispatcher mapping for the `'agentRun'` resource (added in Task 8)
- Test: `test/agent-ui-parity.test.ts` (extend) or `app/lib/agent/to-ui-messages.test.ts` if it exists

**Interfaces:**
- Consumes: `ConversationMessageDTO.role 'event'` + `origin` (Task 3), `/api/agent/main` (Task 3), WS `attach` / `steered` (Task 9), `listRuns` (Task 2).
- Produces: `toUIMessages` maps `role: 'event'` → `{ role: 'system', parts: [{ type: 'text', text }], metadata: { event: { origin } } }`; `AgentMessageMetadata.event?: { origin: string | null }`.

- [ ] **Step 1: Write the failing mapping test**

Add to the existing `toUIMessages` test file (find it with `grep -rln "toUIMessages" test app/lib`):

```ts
it('maps an event row to a system message carrying its origin', () => {
  const [m] = toUIMessages([{ id: 'e1', role: 'event', content: 'check the queue', origin: 'wake:admin', createdAt: '2026-09-27T10:00:00Z' } as never])
  expect(m).toMatchObject({ id: 'e1', role: 'system', parts: [{ type: 'text', text: 'check the queue' }], metadata: { event: { origin: 'wake:admin' } } })
})
```

Run: `pnpm test <that file>` — Expected: FAIL.

- [ ] **Step 2: Implement the mapping and rendering**

- `shared/types/agent-ui.ts`: add `event?: { origin: string | null }` to `AgentMessageMetadata`.
- `to-ui-messages.ts`: widen `ResumeMessage` to include `origin` (`Partial<Pick<ConversationMessageDTO, … | 'origin'>>`); replace Task 3's temporary fallthrough with, before the `user` branch:
  ```ts
  if (m.role === 'event') {
    return { id: m.id, role: 'system', parts: [{ type: 'text', text: m.content }], metadata: { ...metadata, event: { origin: m.origin ?? null } } }
  }
  ```
- `Conversation.vue`: at the top of the `v-for="m in messages"` template body, render event messages as a divider and skip the normal bubble:
  ```vue
  <USeparator
    v-if="m.role === 'system' && m.metadata?.event"
    color="neutral"
    icon="i-lucide-alarm-clock"
    :label="eventLabel(m)"
    class="my-3"
  />
  <div v-else class="group"> … existing message markup … </div>
  ```
  with
  ```ts
  function eventLabel(m: AgentUIMessage): string {
    const origin = m.metadata?.event?.origin ?? ''
    const [kind, detail] = origin.split(':', 2)
    const text = m.parts.find(p => p.type === 'text')?.text ?? ''
    const head = kind === 'wake' ? `woken · ${detail}` : kind === 'review' ? `review · ${detail}` : kind === 'runtime' ? 'runtime' : 'note'
    return `${head}: ${text.length > 80 ? text.slice(0, 79) + '…' : text}`
  }
  ```
  (Wrap the existing per-message markup — the `div.group` and the dividers after it — so the `v-else` applies to the bubble only; keep `dividersAfter(m.id)` rendering for both branches.)

Run the mapping test — Expected: PASS.

- [ ] **Step 3: Main thread by default, pinned in the rail**

- `ThreadRail.vue`: split `conversations` into `main = conversations.find(c => c.kind === 'main')` and `others = conversations.filter(c => c.kind !== 'main')`; render `main` above the groups as a `UButton` with `icon="i-lucide-sparkles"` and label **Bridget**, styled active when `props.activeId === main.id`; `groups` iterates `others`.
- `app/pages/agent/index.vue` `onMounted`: when there is no `?c=`, fetch `/api/agent/main` and `await resume(main.conversation.id)`. `?c=` still wins.

- [ ] **Step 4: Attach, steer, and non-aborting load/new in `useVoice.ts`**

- Add `attach: () => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'attach' })) }` to the returned API. In the page's `resume()`, call `voice.attach()` **after** `voice.messages.value = next` (so replayed frames open a turn on top of the committed transcript, never get discarded by `discardTurn`).
- `loadConversation` and `newConversation`: keep `turns.discard()` (the old thread's live turn must not paint into the new one) but update the two comments that say "the server aborts the running turn for us" → "the server no longer aborts — the old thread's turn keeps running server-side and persists; we only stop rendering it".
- In `mapServerMessage` (find it with `grep -rn "function mapServerMessage" app/`), map `{ type: 'steered', text }` to `fx.steered = text`; in the socket `onmessage`, on `fx.steered` append an optimistic user message to `messages.value`: `{ id: \`steer-${Date.now()}\`, role: 'user', parts: [{ type: 'text', text: fx.steered }], metadata: { createdAt: new Date().toISOString() } }`. The post-turn re-read (armed by `persisted`) replaces it with the real row.
- `PromptInput.vue`: while `busy`, show **both** the Stop button and the Submit button (Submit sends a steer). Change the `v-if="busy"` / `v-else` pair to two independent buttons: Stop `v-if="busy"`, Submit always, `:disabled="!canSubmit"`. Set the textarea placeholder to `busy ? 'Add to what she's doing…' : <existing placeholder>`.

- [ ] **Step 5: Runs drawer**

`server/api/agent/runs.get.ts`:

```ts
import { listRuns } from '../../lib/agent/runtime/runs'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const rows = await listRuns({ conversationId: typeof q.conversationId === 'string' ? q.conversationId : undefined, limit: Number(q.limit ?? 50) })
  return rows.map(r => ({
    id: r.id, trigger: r.trigger, wakeReason: r.wakeReason, profile: r.profile, status: r.status, suppressed: r.suppressed,
    createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
    durationMs: r.claimedAt && r.finishedAt ? r.finishedAt.getTime() - r.claimedAt.getTime() : null,
    assistantMessageId: r.assistantMessageId
  }))
})
```

`shared/types/live.ts`: `'agentRun'` was added to `ResourceName` in Task 8 (queue.ts publishes it on every finish) — confirm the live dispatcher maps it to the `['agentRun', …]` query key.

`app/components/agent/RunsDrawer.vue`: a `USlideover` (title "Runs") taking `conversationId`, fetching `/api/agent/runs?conversationId=…` with `useQuery` keyed `['agentRun', conversationId]` (the live dispatcher invalidates by resource name — confirm how `useLiveUpdates`/`live-dispatch` maps resources to query keys and follow it). Each row: trigger badge (`user` / `wake · <reason>`), status badge (color: done=success, failed=error, interrupted=warning, aborted=neutral, running=info), "silent" chip when `suppressed`, relative time, duration, and the error text when present. In `app/pages/agent/index.vue`, add a toolbar button (`i-lucide-history`) visible when the active conversation is main, opening the drawer.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: green.

```bash
git add app shared/types server/api/agent/runs.get.ts
git commit -m "feat(agent): main thread first, event rows, attach-on-open, steering from the composer, runs drawer"
```

---

### Task 14: UMAP off the event loop's critical path

**Files:**
- Modify: `server/lib/galaxy/layout.ts` (add `computeLayoutAsync`)
- Modify: `server/tasks/compute-graph-layout.ts` (use it)
- Test: `test/galaxy-layout.test.ts` (extend, or create if absent)

**Interfaces:**
- Produces: `computeLayoutAsync(items: LayoutItem[], seed?: number, opts?: { yieldEvery?: number }): Promise<LayoutRow[]>` — identical output to `computeLayout` for the same seed.

- [ ] **Step 1: Measure first**

On dev, with a realistic node count, run the recompute and record the event-loop stall:

```bash
pnpm dev   # in another terminal
curl -s -X POST localhost:3000/api/graph/recompute -b "<session cookie>" >/dev/null &
node -e "const {monitorEventLoopDelay}=require('perf_hooks');" # not in-process — instead:
```

Simpler and accurate: add a temporary `monitorEventLoopDelay({ resolution: 20 })` around `runComputeGraphLayout` in a scratch script under the scratchpad (not committed) that imports the service with the DB stubs used by the DB tests, and print `h.max / 1e6` ms. Record the number in the commit message. If the stall is under 250 ms, **stop**: note it in the handover and skip the rest of this task.

- [ ] **Step 2: Write the failing equivalence test**

```ts
import { describe, it, expect } from 'vitest'
import { computeLayout, computeLayoutAsync } from '../server/lib/galaxy/layout'

describe('computeLayoutAsync', () => {
  it('matches computeLayout exactly for the same seed', async () => {
    let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32)
    const items = Array.from({ length: 60 }, (_, i) => ({ type: 'memory', id: `m${i}`, vector: Array.from({ length: 16 }, rnd) }))
    expect(await computeLayoutAsync(items, 42, { yieldEvery: 5 })).toEqual(computeLayout(items, 42))
  })
})
```

Run: `pnpm test test/galaxy-layout.test.ts` — Expected: FAIL (no export).

- [ ] **Step 3: Implement**

In `layout.ts`, refactor the body of `computeLayout` after the `items.length === 1` guard into two helpers shared by both functions: `makeUmap(items, seed)` (the seeded PRNG + `new UMAP(...)`) and `normalize(items, embedding)` (the unit-cube normalisation + row mapping). Then:

```ts
/** Same result as computeLayout, but yields to the event loop between optimisation epochs so a
 *  streaming agent turn is not frozen for the whole fit. The nearest-neighbour init
 *  (initializeFit) is still one synchronous block — see the measurement in the cycle-73 handover. */
export async function computeLayoutAsync(items: LayoutItem[], seed = 42, opts: { yieldEvery?: number } = {}): Promise<LayoutRow[]> {
  if (items.length === 0) return []
  if (items.length === 1) return computeLayout(items, seed)
  const umap = makeUmap(items, seed)
  const nEpochs = umap.initializeFit(items.map(i => i.vector))
  const every = opts.yieldEvery ?? 10
  for (let i = 0; i < nEpochs; i++) {
    umap.step()
    if (i % every === 0) await new Promise(r => setImmediate(r))
  }
  return normalize(items, umap.getEmbedding())
}
```

In `compute-graph-layout.ts`: `const layoutRows = await computeLayoutAsync(items, SEED)` and update the nuxt.config comment's "blocks the event loop" wording to "yields between epochs; the kNN init still blocks briefly".

- [ ] **Step 4: Verify and commit**

Run: `pnpm test test/galaxy-layout.test.ts && pnpm typecheck`, then re-run the Step 1 measurement and record before/after max stall.

```bash
git add server/lib/galaxy/layout.ts server/tasks/compute-graph-layout.ts nuxt.config.ts test/galaxy-layout.test.ts
git commit -m "perf(galaxy): UMAP yields between epochs (max event-loop stall <before> ms → <after> ms)"
```

---

### Task 15: Browser acceptance, docs, handover

**Files:**
- Create: `docs/wiki/agent-runtime.md`
- Modify: `docs/wiki/voice-agent.md` (correct the "shared by voice + chat + cron" claim; link the runtime page)
- Modify: `docs/wiki/agent-context.md` (turn tier live, summary writer, recent-threads/main-state)
- Modify: `docs/superpowers/plans/00-roadmap.md` (row 73 status)
- Create: `docs/handovers/2026-09-2X-bridget-runtime.md`
- Modify: `.claude/skills/browser-testing/SKILL.md` if any step below needed a workaround

- [ ] **Step 1: Run every gate**

Run: `pnpm test && pnpm test:db && pnpm typecheck && pnpm build`
Expected: all green. Paste the counts into the handover.

- [ ] **Step 2: Browser acceptance with `playwright-cli`**

Load `.claude/skills/browser-testing/SKILL.md` first. Run dev on a spare port. For each scenario, capture a screenshot into the scratchpad and assert on DOM text / fetched JSON, never on the model's wording (the "assert replies, not echoes" lesson).

1. **Turn outlives the tab.** Open `/agent` (lands on main), send "Count from 1 to 40, one number per line." Close the tab after the first numbers stream. Wait 30 s. Reopen `/agent` → the thread shows the complete reply ending in 40. `GET /api/agent/runs?conversationId=<main>` shows the run `done`.
2. **Steer.** Send "List ten fruits slowly, one per line, explaining each." While it streams, type "actually make it vegetables" and send. The composer accepted it while busy, an optimistic user bubble appears, and after completion the persisted transcript contains the steer message between the question and the reply; the runs endpoint shows **one** run for that exchange.
3. **Wake with nobody watching.** Close all `/agent` tabs. `POST /api/admin/agent/wake` `{ "reason": "accept-3", "prompt": "Say exactly: the runtime works." }`. Open `/agent` → main shows a "woken · accept-3" divider and a reply. Then wake with `{ "reason": "accept-3b", "prompt": "Nothing needs attention. Reply NO_REPLY." }` → only the divider appears, and the run row has `suppressed: true`.
4. **Proposal round-trip.** Create a task "ACCEPT-4 test task" via the UI. Wake `{ "reason": "accept-4", "prompt": "Mark the task titled ACCEPT-4 test task as done." }`. `/review` shows an agent-action card for `edit_task`; the task is still open. Approve → the task is done, and main shows "review · approved: Approved: edit_task — …".
5. **Summaries flow up.** Create a side thread with enough content to trigger a fold (or run `maybeSummarize(id, { force: true })` through `POST /api/_nitro/tasks/summarize-threads` after backdating `last_message_at` in SQL). Send any message in main and read the `memory:assemble` activity-log row for that run: `used` rises by roughly the side-thread summary's size, and a debug read of the assembled context (temporary `console.info` behind `NUXT_DEBUG_CONTEXT=1`, not committed) contains the side thread's title.
6. **Two tabs, one turn, late join.** Open main in tab A and send a long prompt. Open main in tab B mid-stream → B shows the reply so far and continues streaming; neither tab shows an error; both end with identical text.

If any scenario fails, fix it in the owning task's files, add a regression test there, and re-run the gates.

- [ ] **Step 3: Write the wiki page and fix the stale ones**

`docs/wiki/agent-runtime.md` — status `shipped (cycle 73)`: the module table from spec §3, the run lifecycle (queued → running → done|failed|aborted|interrupted) with who writes each transition, the WS protocol (including `attach`, `steered`, and that close/load/new never abort), the headless gate table, `wake()` and its callers, suppression, summaries and the two new context tiers, the `agent_runtime` rollback flag (read at boot; restart to flip), operational queries (`select status, count(*) from agent_runs group by 1`, stuck-run check), and known limits (no retry of interrupted runs; one headless slot; UMAP init still blocks briefly).

`docs/wiki/voice-agent.md`: replace the false "shared by voice + chat + cron" sentence with "Voice and text turns run through the runtime (see agent-runtime.md); STT happens in the socket before the run; TTS is per-subscriber and only reaches the socket that asked."

`docs/wiki/agent-context.md`: the turn tier is now wired (budget 20000 for runtime calls), `conversations.summary` has a writer, plus the `recent-threads` / `main-state` tiers.

Mirror each changed wiki page to MyMind with the `wiki-mirror` skill.

- [ ] **Step 4: Handover, roadmap, tasks**

Write `docs/handovers/2026-09-2X-bridget-runtime.md` (same frontmatter shape as the cycle-72 handover): what shipped, the gate numbers, the six scenario results, every deviation from the spec (at minimum: `agent_inbox.run_id`/`consumed_at`, interactive no-channel denies immediately, flag read at boot), and what cycle 74 starts from (delete `ws-legacy.ts` + `flag.ts`; heartbeat/cron call `wake()`).

Update roadmap row 73 to `✅ shipped` (or `🔨 built` if not deployed) with the handover link. In MyMind: mark task `8fdc0fe7` completed; mark `7372f495`, `e7c0b7c7`, `26fc248c`, `1dba07af` completed with a one-line note each; create the cycle-74 task.

```bash
git add docs .claude/skills
git commit -m "docs(cycle-73): agent-runtime wiki page, handover, roadmap"
```
