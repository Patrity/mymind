# Agent Chat Affordances — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/agent` a complete chat surface — branchable threads (fork, edit, non-destructive regenerate), per-message speed metrics, an action row you can actually see, and a Persona with presence.

**Architecture:** `conversations.active_leaf_id` plus the already-present `conversation_messages.parent_id` turn a thread into a tree; both read paths walk the active path with one recursive CTE instead of `ORDER BY created_at`. Fork, edit and regenerate are one primitive — append a child to a chosen parent, re-point the leaf. Timing rides the existing `usage` jsonb; the UI reuses the vendored AI Elements branch controls as presentation only.

**Tech Stack:** Nuxt 4 (SPA, `ssr: false`), Drizzle + Postgres (`WITH RECURSIVE`), `@tanstack/vue-query`, vendored AI Elements under `app/components/ai-elements/`, Nuxt UI v4, Vitest, `playwright-cli`.

**Spec:** [`docs/superpowers/specs/2026-09-21-agent-chat-affordances-design.md`](../specs/2026-09-21-agent-chat-affordances-design.md)

## Global Constraints

- **pnpm only** — never npm or yarn. `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`.
- **No co-author trailer and no model names in any commit message.** Hard user rule; violated twice in cycle 66 and caught both times. Check the message *before* committing.
- **Validate UI work with `playwright-cli`, never the Playwright MCP.** Invoke the project's `browser-testing` skill.
- **Nuxt UI v4 + semantic design tokens** (`text-muted`, `text-dimmed`, `bg-elevated`, `border-default`, `color="primary"`). Never raw Tailwind palette classes. Invoke `nuxt-ui-docs` before using a `U*` component.
- **Live-data rule:** reads go through `@tanstack/vue-query`; query `data` is read-only; every successful server mutation calls `publishChange({ resource, action, id })`.
- **`getAgentHistory` and `getConversation` MUST return the same path** for the same conversation. Divergence means the model answers a different conversation than the one on screen, invisibly.
- **Nothing is ever deleted or overwritten.** Fork, edit and regenerate all append.
- **`:unmount-on-hide="false"` must be BOUND if you touch a `UTabs`** — the static string is truthy (cycle 67).
- Production builds at 4096 MB: `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. Success is `.output/server/index.mjs` plus "Build complete!" — not an exit code.
- DB tests are `*.db.test.ts`, run only by `pnpm test:db`. Scope every fixture to a per-run unique tag and clean up in `afterAll`.
- Run every command in the **foreground**.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/utils/conversation-path.ts` (new) | Pure: given rows + a leaf, return the active path; index siblings for the pager. |
| `shared/types/conversation.ts` (modify) | `MessageUsage` gains timing; `ConversationMessageDTO` gains `parentId` + `branch`. |
| `server/db/schema/conversations.ts` (modify) | `active_leaf_id`; update the stale `parent_id` comment. |
| `server/db/migrations/00NN_*.sql` (generated) | The column + backfill. |
| `server/services/conversation-path.ts` (new) | The recursive CTE; the single walk both read paths call. |
| `server/services/conversations.ts` (modify) | `appendMessages` chains from the leaf; both reads walk; `branchFrom`. |
| `server/api/conversations/[id]/leaf.patch.ts` (new) | Switch the active branch. |
| `app/lib/agent/metrics.ts` (new) | Pure: tok/s + duration formatting. |
| `app/components/agent/ReplyActions.vue` (modify) | Always visible; copy, regenerate, edit, fork, metrics. |
| `app/components/agent/BranchPager.vue` (new) | The `‹ 2/3 ›` control, driven by our state. |
| `app/components/agent/Conversation.vue` (modify) | Render the pager and the new actions. |
| `app/components/agent/Persona.client.vue` (modify) | Hero size. |
| `app/pages/agent/index.vue` (modify) | Wire edit/fork/branch-switch; retry becomes a branch. |
| `server/api/voice/ws.ts` (modify) | Capture timing; chain writes from the leaf. |

---

### Task 1: The pure path walk

**Files:**
- Create: `shared/utils/conversation-path.ts`
- Test: `shared/utils/conversation-path.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PathRow { id: string; parentId: string | null }
  /** Root→leaf order. Returns [] when the leaf is absent. */
  export function activePath<T extends PathRow>(rows: T[], leafId: string | null): T[]
  /** For each row, its 1-based index among its parent's children and that sibling count. */
  export function branchIndex(rows: PathRow[]): Map<string, { index: number; total: number }>
  ```
  Tasks 3 and 8 consume both.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { activePath, branchIndex } from './conversation-path'

// a → b → c   and   a → b → d   (c and d are siblings; two branches)
const rows = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'b' },
  { id: 'd', parentId: 'b' }
]

describe('activePath', () => {
  it('walks from the leaf to the root and returns root-first', () => {
    expect(activePath(rows, 'c').map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(activePath(rows, 'd').map(r => r.id)).toEqual(['a', 'b', 'd'])
  })

  it('excludes the sibling that is not on the active path', () => {
    expect(activePath(rows, 'c').map(r => r.id)).not.toContain('d')
  })

  it('returns [] for a null leaf — the caller falls back, it does not guess', () => {
    expect(activePath(rows, null)).toEqual([])
  })

  it('returns [] for a leaf that is not present rather than a partial path', () => {
    expect(activePath(rows, 'zzz')).toEqual([])
  })

  it('does not hang on a cycle — a corrupt parent chain must terminate', () => {
    const cyclic = [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }]
    expect(activePath(cyclic, 'x').length).toBeLessThanOrEqual(2)
  })

  it('handles a single-message thread', () => {
    expect(activePath([{ id: 'only', parentId: null }], 'only').map(r => r.id)).toEqual(['only'])
  })
})

describe('branchIndex', () => {
  it('numbers siblings 1-based with their total', () => {
    const ix = branchIndex(rows)
    expect(ix.get('c')).toEqual({ index: 1, total: 2 })
    expect(ix.get('d')).toEqual({ index: 2, total: 2 })
  })

  it('reports total 1 for a message with no siblings, so the pager can hide', () => {
    expect(branchIndex(rows).get('b')).toEqual({ index: 1, total: 1 })
  })

  it('treats roots as siblings of each other', () => {
    const twoRoots = [{ id: 'r1', parentId: null }, { id: 'r2', parentId: null }]
    expect(branchIndex(twoRoots).get('r2')).toEqual({ index: 2, total: 2 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run shared/utils/conversation-path.test.ts`
Expected: FAIL — "Failed to resolve import ./conversation-path".

- [ ] **Step 3: Implement**

```ts
export interface PathRow { id: string; parentId: string | null }

/**
 * The active path, root-first. A thread is a tree; what the user is reading (and what the
 * model must be given) is one path through it, named by its leaf.
 *
 * Returns [] rather than a partial path when the leaf is unknown: the caller falls back to
 * the flat read, and a half-path would be worse than an obvious empty.
 */
export function activePath<T extends PathRow>(rows: T[], leafId: string | null): T[] {
  if (!leafId) return []
  const byId = new Map(rows.map(r => [r.id, r]))
  if (!byId.has(leafId)) return []
  const out: T[] = []
  const seen = new Set<string>()
  let cur: string | null = leafId
  // `seen` is the cycle guard: a corrupt parent chain must terminate, not spin.
  while (cur && !seen.has(cur)) {
    const row = byId.get(cur)
    if (!row) break
    seen.add(cur)
    out.push(row)
    cur = row.parentId
  }
  return out.reverse()
}

/** 1-based position among siblings plus the sibling count — what the ‹ n/N › pager renders. */
export function branchIndex(rows: PathRow[]): Map<string, { index: number; total: number }> {
  const byParent = new Map<string, PathRow[]>()
  for (const r of rows) {
    const key = r.parentId ?? '\x00root'
    const list = byParent.get(key)
    if (list) list.push(r)
    else byParent.set(key, [r])
  }
  const out = new Map<string, { index: number; total: number }>()
  for (const siblings of byParent.values()) {
    siblings.forEach((r, i) => out.set(r.id, { index: i + 1, total: siblings.length }))
  }
  return out
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run shared/utils/conversation-path.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/utils/conversation-path.ts shared/utils/conversation-path.test.ts
git commit -m "feat(agent): walk a conversation tree to its active path"
```

---

### Task 2: Schema, migration and types

**Files:**
- Modify: `server/db/schema/conversations.ts`
- Modify: `shared/types/conversation.ts`
- Create: `server/db/migrations/00NN_*.sql` (generated — do not hand-write)

**Interfaces:**
- Produces: `conversations.activeLeafId`; `MessageUsage` gains `startedAt?: string`, `ttftMs?: number`, `durationMs?: number`; `ConversationMessageDTO` gains `parentId: string | null` and `branch: { index: number; total: number }`.

- [ ] **Step 1: Add the column and fix the stale comment**

In `server/db/schema/conversations.ts`, add to the `conversations` table:

```ts
  /** Leaf of the branch currently displayed. A thread is a tree (see parent_id); this names
   *  which path through it is active. Nullable only as a fallback: null → flat read. */
  activeLeafId: uuid('active_leaf_id'),
```

and replace the `parentId` comment on `conversationMessages` (which says branching is deferred) with:

```ts
  // Tree edge. Branching is LIVE as of cycle 68: fork/edit/regenerate append a child to a
  // chosen parent, and conversations.active_leaf_id names the path being read.
  parentId: uuid('parent_id'),
```

- [ ] **Step 2: Extend the types**

In `shared/types/conversation.ts`, add to `MessageUsage`:

```ts
  /** When the turn started, ISO. Timing is stored here rather than in its own column
   *  because usage is already the per-message jsonb for model/token facts. */
  startedAt?: string
  /** Start → first assistant token. */
  ttftMs?: number
  /** Start → turn finish. */
  durationMs?: number
```

and to `ConversationMessageDTO`:

```ts
  parentId: string | null
  /** 1-based position among siblings and the sibling count; total 1 means no pager. */
  branch: { index: number; total: number }
```

- [ ] **Step 3: Generate the migration**

```bash
pnpm db:generate
```

Read the generated `.sql`. It must contain exactly one `ALTER TABLE ... ADD COLUMN "active_leaf_id"` and nothing else. If it contains a `DROP` or touches another table, STOP and report — the schema has drifted.

- [ ] **Step 4: Add the backfill to the SAME migration file**

Append to the generated `.sql`:

```sql
--> statement-breakpoint
-- Every pre-existing thread is already a valid linear path: appendMessages has always chained
-- each new message from the conversation's newest row, across turns. So pointing the leaf at
-- the newest message makes each thread a single-branch tree, and no code needs a
-- legacy-vs-branched split.
UPDATE conversations c
SET active_leaf_id = (
  SELECT m.id FROM conversation_messages m
  WHERE m.conversation_id = c.id
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
)
WHERE active_leaf_id IS NULL;
```

- [ ] **Step 5: Apply and verify the backfill**

```bash
pnpm db:migrate
```

Then confirm no thread with messages was left unset:

```bash
node -e "
const { Client } = require('pg');
const url = require('fs').readFileSync('.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13).trim();
(async () => {
  const c = new Client({ connectionString: url }); await c.connect();
  const r = await c.query(\`select count(*) from conversations c
    where c.active_leaf_id is null
      and exists (select 1 from conversation_messages m where m.conversation_id = c.id)\`);
  console.log('threads with messages but no leaf (must be 0):', r.rows[0].count);
  await c.end();
})();"
```
Expected: `0`.

- [ ] **Step 6: Typecheck — expect failures, and note them**

Run: `pnpm typecheck`
Expected: FAIL in `server/services/conversations.ts` — `msgToDTO` no longer satisfies `ConversationMessageDTO` (missing `parentId`, `branch`). That failure is Task 3's to-do list.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema/conversations.ts shared/types/conversation.ts server/db/migrations
git commit -m "feat(agent): an active-leaf column, timing fields and branch metadata"
```

---

### Task 3: The server-side walk, and both read paths

**Files:**
- Create: `server/services/conversation-path.ts`
- Modify: `server/services/conversations.ts` (`getConversation` ~:144-155, `getAgentHistory` ~:213-225, `msgToDTO`)
- Test: `test/conversation-path.db.test.ts` (new)

**Interfaces:**
- Consumes: `activePath`, `branchIndex` from `shared/utils/conversation-path`.
- Produces:
  ```ts
  /** Rows of the active path, root-first, plus the sibling index for every row in the thread. */
  export async function loadActivePath(conversationId: string): Promise<{
    rows: Array<typeof conversationMessages.$inferSelect>
    branches: Map<string, { index: number; total: number }>
  }>
  ```
  Both read paths call it; nothing else walks.

- [ ] **Step 1: Write the failing DB test**

Create `test/conversation-path.db.test.ts`. The equality assertion between the two read paths is the point of this file.

```ts
// test/conversation-path.db.test.ts
//
// A thread is a tree. `getAgentHistory` gives the MODEL its context and `getConversation`
// gives the USER the transcript — if they walk different paths, the model answers a
// conversation nobody is reading, and nothing on screen would show it. That is the sharpest
// failure mode in cycle 68, so it is asserted directly on a branched fixture.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { getConversation, getAgentHistory, appendMessages } = await import('../server/services/conversations')

const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`
let convId: string
const ids: Record<string, string> = {}

beforeAll(async () => {
  const db = useDb()
  const [conv] = await db.execute(sql`insert into conversations (title) values (${'zz-path-' + TAG}) returning id`) as unknown as [{ id: string }]
  convId = conv.id
  // a(user) → b(assistant) → c(user) ; and a sibling branch b → d(user)
  const mk = async (key: string, role: string, content: string, parent: string | null) => {
    const [row] = await db.execute(sql`
      insert into conversation_messages (conversation_id, parent_id, role, content, modality)
      values (${convId}::uuid, ${parent}::uuid, ${role}, ${content}, 'text') returning id`) as unknown as [{ id: string }]
    ids[key] = row.id
  }
  await mk('a', 'user', 'question A', null)
  await mk('b', 'assistant', 'answer B', ids.a!)
  await mk('c', 'user', 'follow-up C', ids.b!)
  await mk('d', 'user', 'different follow-up D', ids.b!)
})

afterAll(async () => {
  const db = useDb()
  await db.execute(sql`delete from conversation_messages where conversation_id = ${convId}::uuid`)
  await db.execute(sql`delete from conversations where id = ${convId}::uuid`)
})

async function setLeaf(id: string) {
  await useDb().execute(sql`update conversations set active_leaf_id = ${id}::uuid where id = ${convId}::uuid`)
}

describe('both read paths walk the SAME active path', () => {
  it('agrees on branch C', async () => {
    await setLeaf(ids.c!)
    const ui = (await getConversation(convId))!.messages.map(m => m.content)
    const model = (await getAgentHistory(convId)).map(m => m.content)
    expect(ui).toEqual(['question A', 'answer B', 'follow-up C'])
    expect(model).toEqual(ui)
  })

  it('agrees on branch D, and neither leaks the other branch', async () => {
    await setLeaf(ids.d!)
    const ui = (await getConversation(convId))!.messages.map(m => m.content)
    const model = (await getAgentHistory(convId)).map(m => m.content)
    expect(ui).toEqual(['question A', 'answer B', 'different follow-up D'])
    expect(model).toEqual(ui)
    expect(ui).not.toContain('follow-up C')
  })

  it('falls back to the flat read when no leaf is set rather than showing nothing', async () => {
    await useDb().execute(sql`update conversations set active_leaf_id = null where id = ${convId}::uuid`)
    const ui = (await getConversation(convId))!.messages
    expect(ui.length).toBe(4)          // all rows, today's behaviour
  })
})

describe('branch metadata reaches the DTO', () => {
  it('marks the siblings 1/2 and 2/2 and the trunk 1/1', async () => {
    await setLeaf(ids.c!)
    const msgs = (await getConversation(convId))!.messages
    const c = msgs.find(m => m.content === 'follow-up C')!
    const b = msgs.find(m => m.content === 'answer B')!
    expect(c.branch.total).toBe(2)
    expect(b.branch).toEqual({ index: 1, total: 1 })
    expect(c.parentId).toBe(ids.b)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:db -- test/conversation-path.db.test.ts`
Expected: FAIL — both read paths still return all 4 rows regardless of the leaf, and `branch` is undefined on the DTO.

- [ ] **Step 3: Implement the walk**

Create `server/services/conversation-path.ts`:

```ts
import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { conversationMessages, conversations } from '../db/schema'
import { activePath, branchIndex } from '../../shared/utils/conversation-path'

/**
 * The active path for a thread, root-first, plus sibling indexes for the pager.
 *
 * One query fetches the thread's rows; the walk is pure (shared/utils/conversation-path) so it
 * is unit-tested without a database. A recursive CTE per read would win only on threads far
 * larger than any here, and this keeps the walk identical for BOTH read paths — which is the
 * property that matters most (see test/conversation-path.db.test.ts).
 *
 * A null leaf returns every row in created_at order: the pre-cycle-68 behaviour, so a thread
 * whose leaf is somehow unset renders in full instead of appearing empty.
 */
export async function loadActivePath(conversationId: string) {
  const db = useDb()
  const rows = await db.select().from(conversationMessages)
    .where(sql`${conversationMessages.conversationId} = ${conversationId}`)
    .orderBy(conversationMessages.createdAt)

  const [conv] = await db.select({ leaf: conversations.activeLeafId }).from(conversations)
    .where(sql`${conversations.id} = ${conversationId}`).limit(1)

  const branches = branchIndex(rows.map(r => ({ id: r.id, parentId: r.parentId })))
  const path = activePath(rows.map(r => ({ ...r, parentId: r.parentId })), conv?.leaf ?? null)
  return { rows: path.length ? path : rows, branches }
}
```

- [ ] **Step 4: Point both read paths at it**

In `server/services/conversations.ts`:
- `getConversation` replaces its `db.select().from(conversationMessages)…orderBy(createdAt)` block with `const { rows: msgs, branches } = await loadActivePath(id)`, and maps with `msgToDTO(m, branches.get(m.id))`.
- `getAgentHistory` replaces its own select with the same call and keeps everything downstream (`rowToAgentMessage`, `hydrateAttachments`) unchanged.
- `msgToDTO` takes a second parameter `branch: { index: number; total: number } | undefined` and emits `parentId: r.parentId` plus `branch: branch ?? { index: 1, total: 1 }`.

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm test:db -- test/conversation-path.db.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Prove the equality assertion is load-bearing**

Make `getAgentHistory` ignore the leaf — have it select all rows in `created_at` order again. Re-run the file and confirm the two "agrees on branch" tests go RED. **Quote that failure.** Then restore and confirm green. A test that passes with the read paths diverging is worthless, and that divergence is exactly what this cycle risks.

- [ ] **Step 7: Gates**

Run: `pnpm typecheck` (expect exit 0 now — this clears Task 2's failure) and `pnpm test`.

- [ ] **Step 8: Commit**

```bash
git add server/services/conversation-path.ts server/services/conversations.ts test/conversation-path.db.test.ts
git commit -m "feat(agent): read the active branch, not every row in the thread"
```

---

### Task 4: Writes chain from the leaf, and `branchFrom`

**Files:**
- Modify: `server/services/conversations.ts` (`appendMessages` :83-131)
- Test: `test/conversation-branch.db.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  /** Append msgs as children of `parentId` (null = a new root) and move the leaf. */
  export async function appendMessages(
    conversationId: string, msgs: NewConvMessage[], parentId?: string | null
  ): Promise<void>
  /** The parent a new branch should hang from, for each operation. */
  export async function branchParent(
    conversationId: string, messageId: string, op: 'fork' | 'edit' | 'regenerate'
  ): Promise<string | null>
  ```
  Task 5 and Task 9 consume both. `appendMessages`'s third parameter is optional so existing callers keep working; omitted means "chain from the active leaf".

- [ ] **Step 1: Write the failing DB test**

```ts
// test/conversation-branch.db.test.ts
//
// Fork, edit and regenerate are ONE primitive: append a child to a chosen parent, then move
// the leaf. Nothing is deleted, which is what makes regenerate non-destructive (it used to
// call truncateForRetry and drop the previous reply).
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { appendMessages, branchParent, getConversation } = await import('../server/services/conversations')

const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`
let convId: string

beforeAll(async () => {
  const [conv] = await useDb().execute(sql`insert into conversations (title) values (${'zz-branch-' + TAG}) returning id`) as unknown as [{ id: string }]
  convId = conv.id
})
afterAll(async () => {
  const db = useDb()
  await db.execute(sql`delete from conversation_messages where conversation_id = ${convId}::uuid`)
  await db.execute(sql`delete from conversations where id = ${convId}::uuid`)
})

const msg = (role: 'user' | 'assistant', content: string) => ({
  role, content, modality: 'text' as const, toolCalls: null, reasoning: null, attachments: null, usage: null
})

describe('appendMessages chains from the active leaf', () => {
  it('builds a linear thread when no parent is given', async () => {
    await appendMessages(convId, [msg('user', 'Q1'), msg('assistant', 'A1')])
    const msgs = (await getConversation(convId))!.messages
    expect(msgs.map(m => m.content)).toEqual(['Q1', 'A1'])
    expect(msgs[0]!.parentId).toBeNull()
    expect(msgs[1]!.parentId).toBe(msgs[0]!.id)
  })

  it('appends to the LEAF, not the newest row, once a branch exists', async () => {
    const before = (await getConversation(convId))!.messages
    const q1 = before.find(m => m.content === 'Q1')!
    // Branch a second answer off Q1. It is newer than A1 but A1 is NOT its parent.
    await appendMessages(convId, [msg('assistant', 'A1-alt')], q1.id)
    const after = (await getConversation(convId))!.messages
    expect(after.map(m => m.content)).toEqual(['Q1', 'A1-alt'])   // the active path moved
    const alt = after.find(m => m.content === 'A1-alt')!
    expect(alt.parentId).toBe(q1.id)
    // Appending again must chain from A1-alt (the leaf), not from A1 (still the newest by time
    // only if inserted later — the point is the parent comes from the leaf).
    await appendMessages(convId, [msg('user', 'Q2')])
    const third = (await getConversation(convId))!.messages
    expect(third.map(m => m.content)).toEqual(['Q1', 'A1-alt', 'Q2'])
    expect(third.at(-1)!.parentId).toBe(alt.id)
  })

  it('never deletes: the abandoned branch is still in the table', async () => {
    const rows = await useDb().execute(sql`select content from conversation_messages where conversation_id = ${convId}::uuid`) as unknown as Array<{ content: string }>
    expect(rows.map(r => r.content)).toContain('A1')    // the original answer survives
  })
})

describe('branchParent picks the right parent per operation', () => {
  it('fork hangs off the message itself', async () => {
    const msgs = (await getConversation(convId))!.messages
    const target = msgs.find(m => m.content === 'Q1')!
    expect(await branchParent(convId, target.id, 'fork')).toBe(target.id)
  })

  it('edit hangs off the message PARENT, so the edit replaces it as a sibling', async () => {
    const msgs = (await getConversation(convId))!.messages
    const q2 = msgs.find(m => m.content === 'Q2')!
    expect(await branchParent(convId, q2.id, 'edit')).toBe(q2.parentId)
  })

  it('regenerate hangs off the reply PARENT, so the new reply is a sibling of the old', async () => {
    const msgs = (await getConversation(convId))!.messages
    const a = msgs.find(m => m.content === 'A1-alt')!
    expect(await branchParent(convId, a.id, 'regenerate')).toBe(a.parentId)
  })

  it('returns null for an unknown message rather than throwing', async () => {
    expect(await branchParent(convId, '00000000-0000-4000-8000-000000000000', 'fork')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:db -- test/conversation-branch.db.test.ts`
Expected: FAIL — `appendMessages` takes two arguments and selects the newest row as parent; `branchParent` does not exist.

- [ ] **Step 3: Implement**

In `appendMessages`, replace the "find the current last message id to chain from" block:

```ts
  // The parent is the ACTIVE LEAF, not the newest row. Once a branch exists those differ, and
  // chaining from the newest row would graft this turn onto whichever branch was written last
  // rather than the one the user is reading.
  let prevId: string | null
  if (parentId !== undefined) {
    prevId = parentId
  } else {
    const [conv] = await db.select({ leaf: conversations.activeLeafId }).from(conversations)
      .where(eq(conversations.id, conversationId)).limit(1)
    prevId = conv?.leaf ?? null
  }
```

After the insert loop, move the leaf (inside the same stats update):

```ts
      activeLeafId: prevId,   // prevId is the last inserted id after the loop
```

Add `branchParent`:

```ts
/**
 * Which message a new branch hangs from.
 *
 * fork      → the message itself: the new branch continues FROM there.
 * edit      → the message's parent: the edited version is a SIBLING of the original, so the
 *             original question and everything it produced stay reachable.
 * regenerate→ the reply's parent: same reasoning, applied to an assistant message.
 */
export async function branchParent(
  conversationId: string, messageId: string, op: 'fork' | 'edit' | 'regenerate'
): Promise<string | null> {
  const [row] = await useDb()
    .select({ id: conversationMessages.id, parentId: conversationMessages.parentId })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.id, messageId)))
    .limit(1)
  if (!row) return null
  return op === 'fork' ? row.id : row.parentId
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test:db -- test/conversation-branch.db.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the leaf-chaining is load-bearing**

Revert `appendMessages` to selecting the newest row as parent. Re-run and confirm "appends to the LEAF, not the newest row" goes RED. Quote it, then restore and confirm green.

- [ ] **Step 6: Gates**

Run: `pnpm typecheck`, `pnpm test`, and `pnpm test:db` (the whole DB suite — you changed a function every conversation test touches).

- [ ] **Step 7: Commit**

```bash
git add server/services/conversations.ts test/conversation-branch.db.test.ts
git commit -m "feat(agent): append to the active leaf and resolve a branch parent"
```

---

### Task 5: The branch-switch endpoint

**Files:**
- Create: `server/api/conversations/[id]/leaf.patch.ts`
- Test: `test/conversation-leaf-route.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime.
- Produces: `PATCH /api/conversations/:id/leaf` with body `{ leafId: string }` → `{ ok: true, leafId }`. 400 on a missing/non-uuid `leafId`; 404 when the message is not in that conversation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const setActiveLeaf = vi.fn()
vi.mock('../server/services/conversations', () => ({ setActiveLeaf }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { ctx: Record<string, string> }, k: string) => e.ctx[k])
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

const handler = (await import('../server/api/conversations/[id]/leaf.patch')).default as (e: unknown) => Promise<unknown>
const evt = (body: unknown) => ({ ctx: { id: 'c1' }, body })

beforeEach(() => setActiveLeaf.mockReset())

describe('PATCH /api/conversations/:id/leaf', () => {
  it('moves the leaf', async () => {
    setActiveLeaf.mockResolvedValue(true)
    const out = await handler(evt({ leafId: '6f1e7b4a-0000-4000-8000-000000000001' }))
    expect(setActiveLeaf).toHaveBeenCalledWith('c1', '6f1e7b4a-0000-4000-8000-000000000001')
    expect(out).toEqual({ ok: true, leafId: '6f1e7b4a-0000-4000-8000-000000000001' })
  })

  it('rejects a missing leafId', async () => {
    await expect(handler(evt({}))).rejects.toMatchObject({ statusCode: 400 })
    expect(setActiveLeaf).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid leafId rather than letting Postgres throw', async () => {
    await expect(handler(evt({ leafId: 'not-a-uuid' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(setActiveLeaf).not.toHaveBeenCalled()
  })

  it('404s when the message does not belong to the conversation', async () => {
    setActiveLeaf.mockResolvedValue(false)
    await expect(handler(evt({ leafId: '6f1e7b4a-0000-4000-8000-000000000002' })))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run test/conversation-leaf-route.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Add `setActiveLeaf` to the service**

In `server/services/conversations.ts`:

```ts
/** Point the thread at a different branch. False when the message is not in this conversation —
 *  the caller 404s rather than silently pointing a thread at someone else's message. */
export async function setActiveLeaf(conversationId: string, leafId: string): Promise<boolean> {
  const [row] = await useDb().select({ id: conversationMessages.id }).from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.id, leafId)))
    .limit(1)
  if (!row) return false
  await useDb().update(conversations).set({ activeLeafId: leafId, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
  return true
}
```

- [ ] **Step 4: Write the route**

```ts
import { setActiveLeaf } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event) as { leafId?: unknown }
  const leafId = typeof body?.leafId === 'string' ? body.leafId : ''
  // Validated here so a malformed id is a 400, not a Postgres type error surfacing as a 500.
  if (!UUID.test(leafId)) throw createError({ statusCode: 400, statusMessage: 'leafId must be a uuid' })
  if (!await setActiveLeaf(id, leafId)) {
    throw createError({ statusCode: 404, statusMessage: 'That message is not in this conversation' })
  }
  publishChange({ resource: 'conversation', action: 'updated', id })
  return { ok: true, leafId }
})
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm vitest run test/conversation-leaf-route.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 7: Commit**

```bash
git add server/api/conversations/\[id\]/leaf.patch.ts server/services/conversations.ts test/conversation-leaf-route.test.ts
git commit -m "feat(agent): switch a conversation to another branch"
```

---

### Task 6: Turn timing

**Files:**
- Modify: `server/api/voice/ws.ts`
- Create: `app/lib/agent/metrics.ts`
- Test: `app/lib/agent/metrics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** "24.3 tok/s" — '' when it cannot be computed. */
  export function rateLabel(usage?: MessageUsage | null): string
  /** "4.2s" / "820ms" — '' when no duration was recorded. */
  export function durationLabel(usage?: MessageUsage | null): string
  ```
  Task 8 renders both.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { rateLabel, durationLabel } from './metrics'

describe('rateLabel', () => {
  it('computes output tokens over the generating window, excluding the wait for the first token', () => {
    // 300 tokens, 5s total, 1s of it waiting → 300 / 4s = 75
    expect(rateLabel({ outputTokens: 300, durationMs: 5000, ttftMs: 1000 })).toBe('75.0 tok/s')
  })

  it('is empty when there is no timing at all', () => {
    expect(rateLabel({ outputTokens: 300 })).toBe('')
    expect(rateLabel(null)).toBe('')
    expect(rateLabel(undefined)).toBe('')
  })

  it('is empty rather than Infinity when the window is zero', () => {
    expect(rateLabel({ outputTokens: 300, durationMs: 1000, ttftMs: 1000 })).toBe('')
  })

  it('is empty rather than NaN when ttft exceeds duration', () => {
    expect(rateLabel({ outputTokens: 300, durationMs: 500, ttftMs: 900 })).toBe('')
  })

  it('is empty for a turn that produced no output', () => {
    expect(rateLabel({ outputTokens: 0, durationMs: 5000, ttftMs: 1000 })).toBe('')
  })

  it('treats a missing ttft as zero wait rather than discarding the measurement', () => {
    expect(rateLabel({ outputTokens: 100, durationMs: 2000 })).toBe('50.0 tok/s')
  })
})

describe('durationLabel', () => {
  it('uses seconds with one decimal above a second', () => {
    expect(durationLabel({ durationMs: 4200 })).toBe('4.2s')
  })

  it('uses whole milliseconds below a second', () => {
    expect(durationLabel({ durationMs: 820 })).toBe('820ms')
  })

  it('is empty when nothing was recorded', () => {
    expect(durationLabel({})).toBe('')
    expect(durationLabel(null)).toBe('')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run app/lib/agent/metrics.test.ts`
Expected: FAIL — "Failed to resolve import ./metrics".

- [ ] **Step 3: Implement**

```ts
import type { MessageUsage } from '~~/shared/types/conversation'

/**
 * Output tokens per second over the GENERATING window — duration minus the wait for the
 * first token, so a slow model start does not read as slow generation.
 *
 * Known inaccuracy, stated rather than hidden: a turn that calls tools spends much of its
 * wall-clock waiting on them, and that time is still inside this window, so such a turn reads
 * slower than the model actually generated. `durationLabel` is displayed beside this so a low
 * figure is attributable. Measuring only the streaming intervals would be more accurate and
 * more machinery than a monitoring readout justifies.
 */
export function rateLabel(usage?: MessageUsage | null): string {
  const out = usage?.outputTokens
  const total = usage?.durationMs
  if (typeof out !== 'number' || out <= 0) return ''
  if (typeof total !== 'number' || total <= 0) return ''
  const windowMs = total - (usage?.ttftMs ?? 0)
  if (windowMs <= 0) return ''
  return `${(out / (windowMs / 1000)).toFixed(1)} tok/s`
}

export function durationLabel(usage?: MessageUsage | null): string {
  const ms = usage?.durationMs
  if (typeof ms !== 'number' || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run app/lib/agent/metrics.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Capture the timing in the WS turn**

In `server/api/voice/ws.ts`'s `run()`, beside the existing `liveUserText` / `liveAssistantText` captures (added in `8998085`), add:

```ts
      const turnStart = Date.now()
      let ttftMs: number | undefined
```

In the `emit` closure, where the assistant transcript is already accumulated, record the first one:

```ts
            if (e.role === 'user') liveUserText = e.text
            else {
              // First assistant token: the wait before this is model latency, not generation.
              if (ttftMs === undefined) ttftMs = Date.now() - turnStart
              liveAssistantText += e.text
            }
```

Then merge the timing into the usage that gets persisted, in BOTH the success path and the rescue path, so an interrupted turn still reports what it managed:

```ts
        const usageWithTiming = {
          ...(turnUsage ?? {}),
          startedAt: new Date(turnStart).toISOString(),
          ttftMs,
          durationMs: Date.now() - turnStart
        }
```

and pass `usage: usageWithTiming` instead of `usage: turnUsage` in both `buildTurnPersistPayload` calls.

- [ ] **Step 6: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 7: Commit**

```bash
git add app/lib/agent/metrics.ts app/lib/agent/metrics.test.ts server/api/voice/ws.ts
git commit -m "feat(agent): record turn timing and format a generation rate"
```

---

### Task 7: The branch pager

**Files:**
- Create: `app/components/agent/BranchPager.vue`
- Modify: `app/pages/dev/elements.vue` (fixture)

**Interfaces:**
- Produces: `<AgentBranchPager :index="number" :total="number" @go="(dir: -1 | 1) => void />` — renders nothing when `total <= 1`.

- [ ] **Step 1: Build the component**

```vue
<script setup lang="ts">
// The ‹ n/N › control. Uses the vendored AI Elements branch pieces for LOOK only: the
// MessageBranch wrapper collects VNodes from its slot and pages between them, which assumes
// every variant is rendered client-side. Ours live server-side and only the active path is
// fetched, so the wrapper's model does not fit and we drive these three parts ourselves.
// (Same call cycle 67 made about PromptInput.)
import { MessageBranchPrevious, MessageBranchPage, MessageBranchNext } from '@/components/ai-elements/message'

const props = defineProps<{ index: number, total: number }>()
const emit = defineEmits<{ go: [dir: -1 | 1] }>()
</script>

<template>
  <div v-if="props.total > 1" class="flex items-center gap-0.5" data-branch-pager>
    <MessageBranchPrevious :aria-label="'Previous branch'" @click="emit('go', -1)" />
    <MessageBranchPage>{{ props.index }}/{{ props.total }}</MessageBranchPage>
    <MessageBranchNext :aria-label="'Next branch'" @click="emit('go', 1)" />
  </div>
</template>
```

If those three components require the `MessageBranch` provider context to render (check their source for `usePromptInput`-style `inject`), fall back to three `UButton`s — `i-lucide-chevron-left`, a `tabular-nums` label, `i-lucide-chevron-right` — and say so in your report rather than adding a provider just for styling.

- [ ] **Step 2: Add it to the dev fixture**

In `app/pages/dev/elements.vue`, render three cases: `total: 1` (must render nothing), `index: 1, total: 2`, and `index: 3, total: 3`. Log the emitted direction so a click is observable.

- [ ] **Step 3: Verify in a browser**

Start dev (`PORT=3219 BETTER_AUTH_URL=http://localhost:3219 pnpm dev`), open `/dev/elements` with `playwright-cli`, and confirm: nothing renders for `total: 1`; `1/2` and `3/3` render; both arrows emit the right direction. Screenshot light and dark. Kill the dev server by a PID you have verified names this repo.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add app/components/agent/BranchPager.vue app/pages/dev/elements.vue
git commit -m "feat(agent): a branch pager driven by server-side branches"
```

---

### Task 8: The visible action row

**Files:**
- Modify: `app/components/agent/ReplyActions.vue`
- Modify: `app/components/agent/Conversation.vue` (~:109)

**Interfaces:**
- Consumes: `rateLabel`, `durationLabel` (Task 6); `AgentBranchPager` (Task 7).
- Produces: `<AgentReplyActions :message :branch @retry @edit @fork @branch />` where `branch` is `{ index: number; total: number }`, `@edit`/`@fork` carry no payload (the parent knows the message), and `@branch` carries `-1 | 1`.

- [ ] **Step 1: Make the row permanently visible**

In `ReplyActions.vue`, the wrapper currently reads:

```
class="flex items-center gap-2 pt-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
```

Replace the three opacity/transition classes with `text-dimmed`:

```
class="flex items-center gap-2 pt-0.5 text-dimmed"
```

Add a comment recording why: the row was hover-only, which made copy and regenerate undiscoverable and completely unreachable on touch, where there is no hover.

- [ ] **Step 2: Add the new actions and the metrics**

Keep copy and the assistant-only retry. Add, in this order after them:
- `v-if="message.role === 'user'"` — a pencil (`i-lucide-pencil`), `aria-label="Edit and resend"`, emitting `edit`.
- a branch icon (`i-lucide-git-branch`), `aria-label="Fork from here"`, emitting `fork`.
- `<AgentBranchPager :index="branch.index" :total="branch.total" @go="d => emit('branch', d)" />`.
- the existing time span, then `durationLabel(message.metadata?.usage)` and `rateLabel(message.metadata?.usage)` as `text-[10px] tabular-nums` spans, each `v-if` on a non-empty string.

Move the token count out of the row: `tokenLabel` moves into the hover detail (the `title`/tooltip on the row) together with the model id, so the row stays scannable. Retry's `aria-label` becomes `"Regenerate (keeps the previous reply)"` — it no longer destroys.

- [ ] **Step 3: Thread the props through `Conversation.vue`**

At the `AgentReplyActions` usage (~:109), pass `:branch="msg.metadata?.branch ?? { index: 1, total: 1 }"` and re-emit `edit`, `fork` and `branch` upward alongside the existing `retry`. Add the matching emits to `Conversation.vue`'s `defineEmits`.

- [ ] **Step 4: Verify in a browser**

Start dev, log in, open `/agent` and send one real turn (pick **Haiku 4.5** in the model select — the dev default reasoning chain's head, qwen at `192.168.2.25:8004`, is down). Confirm: the row is visible **without hovering**; copy still copies; duration and tok/s render on the assistant message; the pencil appears only on your message; light and dark; 1440 and 375 px. Screenshot each. Kill the dev server by verified PID.

- [ ] **Step 5: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add app/components/agent/ReplyActions.vue app/components/agent/Conversation.vue
git commit -m "feat(agent): a message action row you can see without hovering"
```

---

### Task 9: Wire fork, edit and regenerate on the page

**Files:**
- Modify: `app/pages/agent/index.vue` (`retryTurn` ~:167-175)
- Modify: `app/composables/useSessions.ts`? **No** — conversations live in `app/composables/useConversations.ts`; add the mutations there.

**Interfaces:**
- Consumes: `PATCH /api/conversations/:id/leaf` (Task 5); `branchParent` semantics (Task 4); the `edit`/`fork`/`branch` emits (Task 8).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Add the client mutations**

In `app/composables/useConversations.ts`:

```ts
  const setLeaf = (id: string, leafId: string) =>
    $fetch<{ ok: true, leafId: string }>(`/api/conversations/${id}/leaf`, {
      method: 'PATCH', body: { leafId }
    })
```

Export it alongside the existing members.

- [ ] **Step 2: Replace destructive retry with a branching regenerate**

`retryTurn` currently calls `truncateForRetry`, assigns `voice.messages.value = plan.messages` and resends — which drops the previous reply. Replace its body so it resends the preceding user text **without** truncating the stored thread: the server appends the new reply as a sibling because the WS turn chains from the leaf, and the leaf is moved by `appendMessages`. Keep `voice.discardTurn()` so a still-streaming reply cannot re-push itself.

Delete the `truncateForRetry` import if nothing else uses it, and delete `app/lib/agent/retry.ts` plus its test **only if** a repo-wide grep shows no other consumer. If anything else uses it, leave it and say so.

- [ ] **Step 3: Add edit and fork handlers**

```ts
// An edit or a fork is a NEW BRANCH, never a rewrite: the original message and everything it
// produced stay reachable through the ‹ n/N › pager.
async function editTurn(messageId: string, nextText: string) { /* resend nextText; the server
  hangs it off the edited message's parent */ }
async function forkFrom(messageId: string) { /* switch the leaf to messageId, then the next
  turn continues from there */ }
```

Implement `forkFrom` as `await setLeaf(conversationId, messageId)` followed by invalidating `['session'...]`— no: the conversation query key. Use whatever key `useConversations` already uses for a single conversation, and invalidate that.

For `editTurn`, open the user message's text in place (a `UTextarea` bound to a local ref, Save/Cancel), then on save call `voice.sendText(nextText, speakReply.value)` after pointing the leaf at the edited message's **parent** via `setLeaf` — so the new turn lands as a sibling.

- [ ] **Step 4: Handle branch switching**

`@branch` gives `-1 | 1`. Resolve the target sibling client-side is **not** possible — only the active path is fetched. So: call a new `GET /api/conversations/:id/branches?messageId=…` … **do not build that.** Instead, have `getConversation` include, for each message on the path, its sibling ids in order. Add `siblingIds: string[]` to `ConversationMessageDTO` in Task 2's type change and populate it in Task 3's `msgToDTO` from the `branches` map's underlying groups. Then `@branch` picks `siblingIds[index - 1 + dir]` and calls `setLeaf` with it.

> **Plan note:** this is a change to Tasks 2 and 3. If you are implementing Task 9 and `siblingIds` is absent from the DTO, add it here (type + `msgToDTO` + the grouping in `loadActivePath`) and record the deviation in your report — it is a defect in this plan, not in the earlier tasks.

- [ ] **Step 5: Verify in a browser**

Start dev, log in, send a turn. Then, screenshotting and asserting each: regenerate → the pager appears reading `2/2` and paging back to `1/2` shows the **original** reply; edit a user message → pager on it, original question still reachable; fork from a message → the next turn continues from there; reload after a switch → the switch persisted. Kill the dev server by verified PID.

- [ ] **Step 6: Gates**

Run: `pnpm typecheck`, `pnpm test`, `pnpm test:db`.

- [ ] **Step 7: Commit**

```bash
git add app/pages/agent/index.vue app/composables/useConversations.ts
git commit -m "feat(agent): fork, edit and regenerate as branches"
```

---

### Task 10: Persona presence

**Files:**
- Modify: `app/components/agent/Persona.client.vue` (`sizeClass`, ~:24-36)

- [ ] **Step 1: Enlarge the hero**

In the `sizeClass` computed, change the `'hero'` case from `'size-40'` to:

```ts
      return 'size-56 sm:size-72'
```

Leave `'full'` and the default `'size-7'` exactly as they are — `full` is the voice-mode overlay whose sizing was tuned in cycle 65 against short viewports, and the default is the composer's status dot, not a portrait.

- [ ] **Step 2: Verify in a browser, including the invariant it could break**

Start dev, open `/agent` on an empty thread. Confirm: the hero Persona is visibly larger and still square; it does not push the suggestions or the composer off-screen at **375 px** or at a short viewport (800×480); and **exactly one WebGL2 canvas is mounted** — the cycle-65 rule. Check that last one explicitly:

```
document.querySelectorAll('canvas').length   // and each canvas's context type
```

Open voice mode and confirm it is still one canvas, not two. Screenshot light and dark at 1440 and 375. Kill the dev server by verified PID.

- [ ] **Step 3: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 4: Commit**

```bash
git add app/components/agent/Persona.client.vue
git commit -m "feat(agent): give the hero Persona real presence"
```

---

### Task 11: Live validation, docs, handover

**Files:**
- Modify: `docs/wiki/agent.md`
- Create: `docs/handovers/2026-09-21-agent-chat-affordances.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`

- [ ] **Step 1: Live validation on `/agent`**

Dev server as above; **Haiku 4.5** selected (the dev default chain's head is down); light and dark; 1440 and 375. Each item: drive it, screenshot, Read the screenshot, record PASS / FAIL / **NOT VERIFIED**:
1. A real turn shows duration and tok/s on the assistant message.
2. The action row is visible without hovering, and reachable at 375 px.
3. Copy copies the message text.
4. Regenerate creates a branch; `1/2` shows the **original** reply, unchanged.
5. Edit a user message creates a branch; the original question is still reachable.
6. Fork from a mid-thread message; the next turn continues from there.
7. Switch branches, reload, and confirm the switch persisted.
8. A thread with no branches shows **no pager** anywhere.
9. Resume an older (pre-cycle-68) thread — it renders in full, in order, because the migration backfilled its leaf.
10. Hero Persona is larger; exactly one WebGL2 canvas; voice mode still one.

Item 9 is the migration's real test: a thread created before this cycle must look untouched.

- [ ] **Step 2: Wiki**

`docs/wiki/agent.md`: a new section on the conversation tree — `active_leaf_id`, the single `loadActivePath` both read paths call and **why they must agree**, the one-primitive table for fork/edit/regenerate, that nothing is deleted, that `message_count` counts all branches and so can exceed what is displayed, and the timing fields with the stated tool-time inaccuracy in `rateLabel`. Note that retry is no longer destructive. Bump `updated` and `cycle`.

- [ ] **Step 3: Handover**

`docs/handovers/2026-09-21-agent-chat-affordances.md`, matching the frontmatter shape and depth of `docs/handovers/2026-09-20-voice-studio-refactor.md`. Record: status (built / merged / deployed, honestly); that a third of the original complaint was a **discoverability defect** — copy, regenerate and token count already existed behind `opacity-0 group-hover:opacity-100`; that **retry changed behaviour** from destructive to branching; the migration and whether it has run on prod; every ruling from the SDD ledger with its cost-if-wrong; and each validation item with its verdict.

- [ ] **Step 4: Roadmap and backlog**

Add the cycle-68 row to `docs/superpowers/plans/00-roadmap.md` in the existing format. In `docs/BACKLOG.md`, close the branching item that cycle 28 deferred (the `parent_id` edge is now read) and refresh the "Last reconciled" preamble.

- [ ] **Step 5: Gates**

`pnpm typecheck`, `pnpm test`, `pnpm test:db`, and `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. Record the client JS file count and gzip total; cycle 67 finished at **267 files / 2,112,164 B**.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: cycle 68 handover, wiki, roadmap and backlog"
```

---

## Self-Review

**Spec coverage.** `active_leaf_id` + backfill → Task 2. Both read paths walking one shared function, and the equality assertion → Task 3. Writes chaining from the leaf → Task 4. The one-primitive table (fork/edit/regenerate parents) → Task 4. Branch switching as a server round-trip → Tasks 5, 9. Sibling-derived branch counts → Tasks 1, 3. Timing in `usage` + the stated tok/s inaccuracy → Task 6. Branch components as presentation only → Task 7. Always-visible action row with copy/regenerate/edit/fork + inline metrics, tokens to hover → Task 8. Retry becoming non-destructive → Task 9. Persona presence with the one-canvas invariant → Task 10. `message_count` oddity documented → Task 11. Out-of-scope items (rail branches, delete/merge/rename, per-branch counts) → absent from every task.

**Defect found in my own plan, fixed inline:** Task 9's branch switching needs sibling ids on the DTO, which Tasks 2 and 3 did not provide. Rather than silently depending on it, Task 9 Step 4 states the gap, tells the implementer to add `siblingIds: string[]` to the type, `msgToDTO` and `loadActivePath`, and to record the deviation. Flagged because this cycle's briefs have already invented two interfaces that did not exist (cycle 67), and the honest fix is to name the gap, not paper it.

**Placeholder scan:** no "TBD"/"TODO"/"handle edge cases". Task 9 Steps 2-3 describe behaviour with partial code rather than full bodies, because the exact resend call depends on `useConversations`' existing query-key names — the step names what to read instead of inventing a key.

**Type consistency.** `activePath`/`branchIndex` (Task 1) are consumed under those names in Task 3. `loadActivePath`'s `{ rows, branches }` (Task 3) is used in both read paths. `appendMessages(conversationId, msgs, parentId?)` and `branchParent(conversationId, messageId, op)` (Task 4) are called in Tasks 5 and 9. `setActiveLeaf` (Task 5 Step 3) backs the route in Step 4. `rateLabel`/`durationLabel` (Task 6) render in Task 8. `AgentBranchPager`'s `:index`/`:total`/`@go` (Task 7) match its usage in Task 8.
