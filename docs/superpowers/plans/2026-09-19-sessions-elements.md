# `/sessions/[id]` on AI Elements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session transcript's hand-rolled, load-everything, plain-text rendering with a cursor-paginated, filterable, virtualized list built from AI Elements row components.

**Architecture:** The API gains keyset pagination over a `(created_at, id)` composite cursor, returns only each page's own tool events, and applies all filters as SQL. The client swaps `@vueuse/core`'s fixed-height `useVirtualList` for `@tanstack/vue-virtual` with measured rows, renders each row with the Elements `Tool` / `Reasoning` / `Message` primitives via a pure adapter, and pages older messages in on upward scroll while holding scroll position.

**Tech Stack:** Nuxt 4 (SPA, `ssr: false`), Drizzle + Postgres, `@tanstack/vue-query`, `@tanstack/vue-virtual` (new), AI Elements Vue (vendored under `app/components/ai-elements/`), Nuxt UI v4, Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-19-sessions-elements-design.md`](../specs/2026-09-19-sessions-elements-design.md)

## Global Constraints

- **pnpm only** — never npm or yarn. `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`.
- **No co-author trailer and no model names in any commit message.** Hard user rule.
- **Validate UI work with `playwright-cli`, never the Playwright MCP.** Invoke the project's `browser-testing` skill for credentials and the snapshot→ref→click workflow.
- **Nuxt UI components + semantic design tokens** (`text-muted`, `bg-elevated`, `border-default`, `color="primary"`). Never raw Tailwind palette classes (`text-gray-200`, `bg-purple-600`).
- **Live-data rule:** reads go through `@tanstack/vue-query`; list query keys are `[resource, 'list', params]` with `params` inside a `computed` so the key is reactive. Query `data` is read-only.
- **Production builds at a 4096 MB heap.** Run `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. Success is `.output/server/index.mjs` existing plus "Build complete!" — **not** an exit code. Compare `.output/public/_nuxt/*.js` count and gzip total before/after when adding a dependency.
- **A `nitro.publicAssets` `baseURL` prefix-matches** — not relevant to this cycle unless you add files under `public/`.
- Ordering everywhere is **`(created_at, id)`**. Page payloads are newest-first; the transcript displays oldest-at-top. Reverse each page before prepending.
- Default page size **100**, hard cap **200**.
- DB-backed tests are `*.db.test.ts`, run by `pnpm test:db` only (excluded from `pnpm test` and CI). Scope every fixture to a per-run unique tag.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/utils/session-cursor.ts` (new) | Encode/decode the opaque `(createdAt, id)` cursor. Pure. |
| `shared/types/session.ts` (modify) | `SessionMessagesPage`, `SessionMessageFilters`; `toolNames` on `SessionMeta`. |
| `server/db/schema/messages.ts` (modify) | Add the `(session_id, created_at desc, id desc)` index. |
| `server/db/migrations/00NN_*.sql` (generated) | That index. |
| `server/services/sessions.ts` (modify) | `getSessionMessagesPage`, filters, per-page tool events, `toolNames` in meta. |
| `server/api/sessions/[id]/messages.get.ts` (modify) | Parse/validate params, 400 on `before`+`since`, delegate. |
| `app/lib/sessions/tool-state.ts` (new) | `sessionToolState(event)` adapter. Pure. |
| `app/composables/useSessions.ts` (modify) | `useSessionMessagePages` (infinite query), filter params in the key. |
| `app/components/sessions/TranscriptRow.vue` (new) | One row: user / assistant / thinking / tool, using Elements primitives. |
| `app/components/sessions/TranscriptFilters.vue` (new) | Sidechain toggle, tool-name select, find-in-session input. |
| `app/components/sessions/SessionTranscript.vue` (rewrite) | Virtualizer, upward paging, scroll anchoring, retry row. |
| `app/pages/sessions/[id].vue` (modify) | Wire filters + paged query; keep live-tail delta. |

---

### Task 0: Add `@tanstack/vue-virtual` and prove it measures dynamic rows

Gate task. If the virtualizer cannot hold scroll position on prepend, the whole client half needs rethinking — find out before building on it.

**Files:**
- Modify: `package.json`
- Create: `app/pages/dev/virtual.vue` (dev-only fixture; `/dev/**` is excluded from production builds)

**Interfaces:**
- Produces: a working `useVirtualizer` usage pattern (measured rows + `scrollToIndex`) that Task 8 copies.

- [ ] **Step 1: Install**

```bash
pnpm add @tanstack/vue-virtual
```

- [ ] **Step 2: Record the bundle baseline BEFORE building the fixture**

```bash
NODE_OPTIONS=--max-old-space-size=4096 pnpm build
ls .output/public/_nuxt/*.js | wc -l
cat .output/public/_nuxt/*.js | gzip -c | wc -c
```

Write both numbers into the task report. Confirm `.output/server/index.mjs` exists and the log said "Build complete!".

- [ ] **Step 3: Build a throwaway fixture page**

`app/pages/dev/virtual.vue`: 2,000 items of deliberately varying height (cycle the text length, e.g. `'x '.repeat((i % 40) + 1)`), rendered with `useVirtualizer` using `estimateSize: () => 140` and `measureElement` on each row. Add a "prepend 100" button that unshifts 100 items.

- [ ] **Step 4: Prove the three behaviours in a browser**

```bash
PORT=3219 BETTER_AUTH_URL=http://localhost:3219 pnpm dev
```

(`PORT` alone fails login with "Invalid origin" — pass both.) With `playwright-cli`, record for each:
1. **Dynamic measurement** — rows of different heights render without overlap or gaps. Screenshot.
2. **Scroll anchoring** — scroll to the middle, read `scrollTop` and the text of the row at viewport top, click "prepend 100", then assert the same row is still at viewport top. Record both `scrollTop` values and the row text.
3. **Smoothness** — scroll to the end of 2,000 items; confirm the DOM holds tens of rows, not thousands (`document.querySelectorAll('[data-vrow]').length`).

Kill the dev server by PID, verifying the PID's command line names this repo first.

- [ ] **Step 5: Report the finding**

If anchoring cannot be made to work, STOP and report BLOCKED with what you tried — do not proceed to Task 1.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml app/pages/dev/virtual.vue
git commit -m "chore(sessions): add @tanstack/vue-virtual and a dynamic-row spike fixture"
```

---

### Task 1: The cursor

**Files:**
- Create: `shared/utils/session-cursor.ts`
- Test: `shared/utils/session-cursor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SessionCursor { createdAt: string; id: string }
  export function encodeCursor(c: SessionCursor): string
  export function decodeCursor(raw: string): SessionCursor | null   // null = malformed
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { encodeCursor, decodeCursor } from './session-cursor'

describe('session cursor', () => {
  it('round-trips a cursor', () => {
    const c = { createdAt: '2026-09-19T12:34:56.789Z', id: '6f1e7b4a-0000-4000-8000-000000000001' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('is opaque — the raw value is not the id', () => {
    const c = { createdAt: '2026-09-19T12:34:56.789Z', id: '6f1e7b4a-0000-4000-8000-000000000001' }
    expect(encodeCursor(c)).not.toContain(c.id)
  })

  it('rejects malformed input rather than coercing it', () => {
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(btoa('only-one-part'))).toBeNull()
    expect(decodeCursor(btoa('2026-09-19T12:34:56.789Z|'))).toBeNull()
    expect(decodeCursor(btoa('|6f1e7b4a-0000-4000-8000-000000000001'))).toBeNull()
    expect(decodeCursor(btoa('nonsense-date|6f1e7b4a-0000-4000-8000-000000000001'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run shared/utils/session-cursor.test.ts`
Expected: FAIL — "Failed to resolve import ./session-cursor".

- [ ] **Step 3: Implement**

```ts
export interface SessionCursor {
  createdAt: string
  id: string
}

/**
 * The transcript orders by (created_at, id). 26% of prod messages share a created_at with
 * another message in the same session — one tie group holds 615 rows — so a timestamp-only
 * cursor would skip or repeat whole blocks. `id` is an arbitrary but STABLE tiebreak.
 * Base64 keeps it opaque so nothing client-side starts parsing it.
 */
export function encodeCursor(c: SessionCursor): string {
  return btoa(`${c.createdAt}|${c.id}`)
}

export function decodeCursor(raw: string): SessionCursor | null {
  if (!raw) return null
  let decoded: string
  try {
    decoded = atob(raw)
  } catch {
    return null
  }
  const sep = decoded.indexOf('|')
  if (sep <= 0 || sep === decoded.length - 1) return null
  const createdAt = decoded.slice(0, sep)
  const id = decoded.slice(sep + 1)
  if (Number.isNaN(Date.parse(createdAt))) return null
  return { createdAt, id }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run shared/utils/session-cursor.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/utils/session-cursor.ts shared/utils/session-cursor.test.ts
git commit -m "feat(sessions): an opaque (created_at, id) pagination cursor"
```

---

### Task 2: The composite index

**Files:**
- Modify: `server/db/schema/messages.ts:21-27`
- Create: `server/db/migrations/00NN_*.sql` (generated — do not hand-write)

**Interfaces:**
- Produces: `messages_session_created_idx` on `(session_id, created_at desc, id desc)`.

- [ ] **Step 1: Add the index to the schema**

In the index array in `server/db/schema/messages.ts`, after `messages_created_at_idx`:

```ts
  // Keyset pagination for the transcript (cycle 66) walks (session_id, created_at desc, id desc).
  // `messages_session_idx` alone leaves a 5,622-row session sorting on every page fetch.
  index('messages_session_created_idx').on(t.sessionId, t.createdAt.desc(), t.id.desc()),
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm db:generate
```

Read the generated `.sql`. It must contain exactly one `CREATE INDEX` and nothing else. If it contains a `DROP` or touches another table, stop and report — the schema has drifted from the migration history.

- [ ] **Step 3: Apply it locally and confirm**

```bash
pnpm db:migrate
```

- [ ] **Step 4: Commit**

```bash
git add server/db/schema/messages.ts server/db/migrations
git commit -m "feat(sessions): index (session_id, created_at desc, id desc) for keyset paging"
```

---

### Task 3: Types for the paged response

**Files:**
- Modify: `shared/types/session.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SessionMessageFilters {
    hideSidechain?: boolean
    tool?: string
    q?: string
  }
  export interface SessionMessagesPage {
    messages: SessionMessageDTO[]      // NEWEST-FIRST within the page
    toolEvents: SessionToolEventDTO[]  // only those whose messageId is in `messages`
    nextCursor: string | null          // null = no older pages
  }
  ```
  and `SessionMeta` gains `toolNames: string[]`.

- [ ] **Step 1: Add the types**

Append to `shared/types/session.ts`, after `SessionMessages`:

```ts
/** Filters applied server-side. Client-side filtering would make a page of `limit` rows
 *  yield an arbitrary number of visible rows. */
export interface SessionMessageFilters {
  hideSidechain?: boolean
  tool?: string
  q?: string
}

/** One page of a transcript, walking backwards from newest. */
export interface SessionMessagesPage {
  /** NEWEST-FIRST. The transcript displays oldest-at-top, so the client reverses before prepending. */
  messages: SessionMessageDTO[]
  /** Only the events whose messageId appears in `messages` — not the whole session's. */
  toolEvents: SessionToolEventDTO[]
  nextCursor: string | null
}
```

`SessionMessages` stays — `?since=` still returns it.

- [ ] **Step 2: Add `toolNames` to `SessionMeta`**

```ts
export interface SessionMeta extends SessionListItem {
  cwd: string | null
  machineId: string | null
  gitBranch: string | null
  gitCommit: string | null
  gitRemote: string | null
  appVersion: string | null
  endedAt: string | null
  metadata: Record<string, unknown>
  /** Distinct tool_name values in THIS session — the filter dropdown's options.
   *  163 distinct names exist across all sessions; a session has a handful. */
  toolNames: string[]
}
```

- [ ] **Step 3: Typecheck — expect it to fail, and note where**

Run: `pnpm typecheck`
Expected: FAIL in `server/services/sessions.ts` — the object returned by `getSessionMeta` no longer satisfies `SessionMeta`. That failure is the to-do list for Task 4.

- [ ] **Step 4: Commit**

```bash
git add shared/types/session.ts
git commit -m "feat(sessions): types for a paged, filtered transcript"
```

---

### Task 4: The service — paging, filters, per-page tool events

**Files:**
- Modify: `server/services/sessions.ts:358-375` (`getSessionMessages`) and the `getSessionMeta` function above it
- Test: `test/sessions-paging.db.test.ts` (new)

**Interfaces:**
- Consumes: `encodeCursor` / `decodeCursor` / `SessionCursor` from `shared/utils/session-cursor`; `SessionMessagesPage`, `SessionMessageFilters` from `shared/types/session`.
- Produces:
  ```ts
  export async function getSessionMessagesPage(
    id: string,
    opts: { before?: string; limit?: number } & SessionMessageFilters
  ): Promise<SessionMessagesPage>
  ```
  `getSessionMessages(id, { since })` keeps its current signature and behaviour.

- [ ] **Step 1: Write the failing DB test**

Create `test/sessions-paging.db.test.ts`. The tie group is the point of this file — a timestamp-only cursor must fail it.

```ts
// test/sessions-paging.db.test.ts
//
// Keyset pagination over (created_at, id). In prod, 58,417 of 228,692 messages share a
// created_at with another message in the same session, and one tie group holds 615 rows at
// a single timestamp. A timestamp-only cursor skips or repeats those blocks, so the fixture
// below deliberately builds one 12-row tie group and walks it page by page.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { getSessionMessagesPage } = await import('../server/services/sessions')

const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const SESSION_ID = '00000000-0000-4000-8000-' + TAG.padEnd(12, '0').slice(0, 12)
const TIE_AT = '2026-09-19T00:00:00.000Z'

beforeAll(async () => {
  const db = useDb()
  await db.execute(sql`insert into sessions (id, source, started_at, last_active)
    values (${SESSION_ID}::uuid, 'test', now(), now())`)
  // 20 distinctly-timed rows, then 12 sharing ONE timestamp.
  for (let i = 0; i < 20; i++) {
    await db.execute(sql`insert into messages (session_id, role, content, created_at)
      values (${SESSION_ID}::uuid, 'user', ${'distinct-' + i},
              ${new Date(Date.parse(TIE_AT) - (20 - i) * 1000).toISOString()}::timestamptz)`)
  }
  for (let i = 0; i < 12; i++) {
    await db.execute(sql`insert into messages (session_id, role, content, created_at)
      values (${SESSION_ID}::uuid, 'user', ${'tie-' + i}, ${TIE_AT}::timestamptz)`)
  }
})

afterAll(async () => {
  const db = useDb()
  await db.execute(sql`delete from tool_events where session_id = ${SESSION_ID}::uuid`)
  await db.execute(sql`delete from messages where session_id = ${SESSION_ID}::uuid`)
  await db.execute(sql`delete from sessions where id = ${SESSION_ID}::uuid`)
})

/** Walk every page and return the contents in walk order. */
async function walkAll(limit: number, filters = {}) {
  const seen: string[] = []
  let before: string | undefined
  for (let guard = 0; guard < 50; guard++) {
    const page = await getSessionMessagesPage(SESSION_ID, { before, limit, ...filters })
    seen.push(...page.messages.map(m => m.content))
    if (!page.nextCursor) return seen
    before = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

describe('getSessionMessagesPage', () => {
  it('walks a tie group with no gaps and no repeats', async () => {
    const seen = await walkAll(5)          // 32 rows / 5 per page straddles the tie group
    expect(seen).toHaveLength(32)
    expect(new Set(seen).size).toBe(32)     // no repeats
    for (let i = 0; i < 12; i++) expect(seen).toContain(`tie-${i}`)   // no gaps
  })

  it('returns pages newest-first and terminates with a null cursor', async () => {
    const first = await getSessionMessagesPage(SESSION_ID, { limit: 5 })
    expect(first.messages).toHaveLength(5)
    expect(first.messages.every(m => m.content.startsWith('tie-'))).toBe(true)
    const all = await walkAll(100)
    expect(all).toHaveLength(32)
    expect(all.at(-1)).toBe('distinct-0')   // oldest row comes last in the walk
  })

  it('is stable — the same walk twice gives the same order', async () => {
    expect(await walkAll(5)).toEqual(await walkAll(5))
  })

  it('caps limit at 200', async () => {
    const page = await getSessionMessagesPage(SESSION_ID, { limit: 9999 })
    expect(page.messages.length).toBeLessThanOrEqual(200)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:db -- test/sessions-paging.db.test.ts`
Expected: FAIL — `getSessionMessagesPage is not a function`.

- [ ] **Step 3: Implement the paged query**

Add to `server/services/sessions.ts` (keep `getSessionMessages` as-is):

```ts
import { encodeCursor, decodeCursor } from '../../shared/utils/session-cursor'
import type { SessionMessagesPage, SessionMessageFilters } from '../../shared/types/session'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

export async function getSessionMessagesPage(
  id: string,
  opts: { before?: string; limit?: number } & SessionMessageFilters = {}
): Promise<SessionMessagesPage> {
  const db = useDb()
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const conds = [sql`${messages.sessionId} = ${id}`]

  // Keyset, not OFFSET: (created_at, id) < (cursor.created_at, cursor.id) as a row comparison,
  // which Postgres can drive straight off messages_session_created_idx.
  const cursor = opts.before ? decodeCursor(opts.before) : null
  if (opts.before && !cursor) throw createError({ statusCode: 400, statusMessage: 'Malformed cursor' })
  if (cursor) {
    conds.push(sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`)
  }

  if (opts.hideSidechain) conds.push(sql`${messages.isSidechain} = false`)
  if (opts.q) conds.push(sql`${messages.content} ilike ${'%' + opts.q + '%'}`)
  if (opts.tool) {
    conds.push(sql`exists (select 1 from ${toolEvents}
      where ${toolEvents.messageId} = ${messages.id} and ${toolEvents.toolName} = ${opts.tool})`)
  }

  const rows = await db.select().from(messages)
    .where(sql.join(conds, sql` and `))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1)   // one extra row tells us whether an older page exists

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)

  const messageDTOs: SessionMessageDTO[] = page.map(m => ({
    id: m.id, role: m.role, content: m.content, thinking: m.thinking, model: m.model,
    isSidechain: m.isSidechain, metadata: (m.metadata as Record<string, unknown>) ?? {},
    createdAt: m.createdAt.toISOString()
  }))

  // Only THIS page's tool events. The old whole-session fetch shipped up to 3,122 rows per request.
  const ids = page.map(m => m.id)
  const tevs = ids.length
    ? await db.select().from(toolEvents)
        .where(sql`${toolEvents.messageId} in ${ids}`)
        .orderBy(asc(toolEvents.createdAt))
    : []

  return {
    messages: messageDTOs,
    toolEvents: tevs.map(t => ({
      id: t.id, messageId: t.messageId, toolName: t.toolName, args: t.args, result: t.result,
      exitStatus: t.exitStatus, phase: t.phase, toolUseId: t.toolUseId,
      isSidechain: t.isSidechain, createdAt: t.createdAt.toISOString()
    })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null
  }
}
```

Add `desc` to the existing `drizzle-orm` import if it is not already there.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test:db -- test/sessions-paging.db.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the tie-break is load-bearing**

Temporarily change the cursor comparison to timestamp-only:

```ts
    conds.push(sql`${messages.createdAt} < ${cursor.createdAt}::timestamptz`)
```

Run the test again. It MUST fail ("walks a tie group with no gaps and no repeats" — 32 rows expected, fewer seen, because the whole tie group is skipped after the first page that touches it). **Quote that failure in your report**, then restore the row comparison and confirm green. A test that passes either way is not a test.

- [ ] **Step 6: Add `toolNames` to the meta query**

In `getSessionMeta`, before building the returned object:

```ts
  const names = await db.selectDistinct({ name: toolEvents.toolName })
    .from(toolEvents).where(eq(toolEvents.sessionId, id)).orderBy(asc(toolEvents.toolName))
```

and include `toolNames: names.map(n => n.name)` in the returned object. This clears the Task 3 typecheck failure.

- [ ] **Step 7: Gates**

Run: `pnpm typecheck` (expect exit 0 now) and `pnpm test`.

- [ ] **Step 8: Commit**

```bash
git add server/services/sessions.ts test/sessions-paging.db.test.ts
git commit -m "feat(sessions): keyset-paged transcript with server-side filters"
```

---

### Task 5: The endpoint

**Files:**
- Modify: `server/api/sessions/[id]/messages.get.ts`
- Test: `test/sessions-messages-route.test.ts` (new)

**Interfaces:**
- Consumes: `getSessionMessagesPage`, `getSessionMessages` from `server/services/sessions`.
- Produces: `GET /api/sessions/:id/messages?before&limit&hideSidechain&tool&q` → `SessionMessagesPage`; `?since=` → `SessionMessages` unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSessionMessagesPage = vi.fn()
const getSessionMessages = vi.fn()
vi.mock('../server/services/sessions', () => ({ getSessionMessagesPage, getSessionMessages }))

const handler = (await import('../server/api/sessions/[id]/messages.get')).default

/** Minimal H3-ish event: the handler only reads the route param and the query. */
function evt(query: Record<string, string>) {
  return { context: { params: { id: 'sess-1' } }, node: { req: { url: `/?${new URLSearchParams(query)}` } } } as never
}

beforeEach(() => { getSessionMessagesPage.mockReset(); getSessionMessages.mockReset() })

describe('GET /api/sessions/:id/messages', () => {
  it('rejects before + since together instead of guessing', async () => {
    await expect(handler(evt({ before: 'abc', since: '2026-01-01' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(getSessionMessagesPage).not.toHaveBeenCalled()
    expect(getSessionMessages).not.toHaveBeenCalled()
  })

  it('routes since to the delta path', async () => {
    getSessionMessages.mockResolvedValue({ messages: [], toolEvents: [] })
    await handler(evt({ since: '2026-01-01T00:00:00.000Z' }))
    expect(getSessionMessages).toHaveBeenCalledWith('sess-1', { since: '2026-01-01T00:00:00.000Z' })
  })

  it('passes filters through, coercing hideSidechain to a boolean', async () => {
    getSessionMessagesPage.mockResolvedValue({ messages: [], toolEvents: [], nextCursor: null })
    await handler(evt({ limit: '50', hideSidechain: 'true', tool: 'Bash', q: 'error' }))
    expect(getSessionMessagesPage).toHaveBeenCalledWith('sess-1',
      { before: undefined, limit: 50, hideSidechain: true, tool: 'Bash', q: 'error' })
  })

  it('treats a non-numeric limit as absent rather than NaN', async () => {
    getSessionMessagesPage.mockResolvedValue({ messages: [], toolEvents: [], nextCursor: null })
    await handler(evt({ limit: 'abc' }))
    expect(getSessionMessagesPage.mock.calls[0]![1].limit).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run test/sessions-messages-route.test.ts`
Expected: FAIL — the handler still calls `getSessionMessages` unconditionally, so the 400 case and the filter case both fail.

- [ ] **Step 3: Implement**

```ts
import { getSessionMessages, getSessionMessagesPage } from '../../../services/sessions'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const q = getQuery(event)
  const since = q.since as string | undefined
  const before = q.before as string | undefined

  // Two different pagination modes. Honouring one and ignoring the other silently would
  // hand the client a page it did not ask for.
  if (since && before) {
    throw createError({ statusCode: 400, statusMessage: 'Pass either `since` or `before`, not both' })
  }

  if (since) return getSessionMessages(id, { since })

  const rawLimit = Number(q.limit)
  return getSessionMessagesPage(id, {
    before,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
    hideSidechain: q.hideSidechain === 'true',
    tool: (q.tool as string) || undefined,
    q: (q.q as string) || undefined
  })
})
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run test/sessions-messages-route.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/api/sessions/\[id\]/messages.get.ts test/sessions-messages-route.test.ts
git commit -m "feat(sessions): serve paged, filtered transcript pages"
```

---

### Task 6: The tool-state adapter

**Files:**
- Create: `app/lib/sessions/tool-state.ts`
- Test: `app/lib/sessions/tool-state.test.ts`

**Interfaces:**
- Consumes: `SessionToolEventDTO` from `shared/types/session`.
- Produces:
  ```ts
  export interface SessionToolView {
    state: 'output-available' | 'output-error'
    input: unknown
    output: unknown
  }
  export function sessionToolState(event: SessionToolEventDTO): SessionToolView
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { sessionToolState } from './tool-state'
import type { SessionToolEventDTO } from '~~/shared/types/session'

const base: SessionToolEventDTO = {
  id: 't1', messageId: 'm1', toolName: 'Bash', args: { command: 'ls' }, result: 'a\nb',
  exitStatus: null, phase: 'post', toolUseId: 'tu1', isSidechain: false,
  createdAt: '2026-09-19T00:00:00.000Z'
}

describe('sessionToolState', () => {
  it('maps a clean run to output-available', () => {
    expect(sessionToolState({ ...base, exitStatus: 'success' }))
      .toEqual({ state: 'output-available', input: { command: 'ls' }, output: 'a\nb' })
  })

  it('treats a null exitStatus as available, not as an error', () => {
    expect(sessionToolState(base).state).toBe('output-available')
  })

  it.each(['error', 'failure', 'failed', 'ERROR'])('maps %s to output-error', (s) => {
    expect(sessionToolState({ ...base, exitStatus: s }).state).toBe('output-error')
  })

  it('passes a non-string result through untouched for the renderer to format', () => {
    const result = { rows: [1, 2, 3] }
    expect(sessionToolState({ ...base, result }).output).toEqual(result)
  })

  it('survives a missing result', () => {
    expect(sessionToolState({ ...base, result: null }).output).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run app/lib/sessions/tool-state.test.ts`
Expected: FAIL — "Failed to resolve import ./tool-state".

- [ ] **Step 3: Implement**

```ts
import type { SessionToolEventDTO } from '~~/shared/types/session'

export interface SessionToolView {
  state: 'output-available' | 'output-error'
  input: unknown
  output: unknown
}

/**
 * /agent renders AI SDK tool parts, whose `state` is a machine (input-available →
 * output-available / output-error). An ingested session tool event has `exitStatus`
 * instead. This bridges the two so the Elements <Tool> components can be reused verbatim,
 * rather than SessionTranscript growing a second tool-rendering dialect.
 *
 * A session's events are always terminal — they were recorded after the fact — so there is
 * no running state to represent.
 */
const ERROR_STATUSES = new Set(['error', 'failure', 'failed'])

export function sessionToolState(event: SessionToolEventDTO): SessionToolView {
  const status = event.exitStatus?.toLowerCase()
  return {
    state: status && ERROR_STATUSES.has(status) ? 'output-error' : 'output-available',
    input: event.args,
    output: event.result
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run app/lib/sessions/tool-state.test.ts`
Expected: PASS, 8 assertions across 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/sessions/tool-state.ts app/lib/sessions/tool-state.test.ts
git commit -m "feat(sessions): map a session tool event onto the Elements tool states"
```

---

### Task 7: The row component

**Files:**
- Create: `app/components/sessions/TranscriptRow.vue`
- Modify: `app/pages/dev/virtual.vue` (render real row shapes in the fixture)

**Interfaces:**
- Consumes: `sessionToolState` (Task 6); `SessionMessageDTO`, `SessionToolEventDTO`.
- Produces: `<SessionsTranscriptRow :message :tool-events />` — one self-contained row, no scroll or paging knowledge.

- [ ] **Step 1: Build the component**

```vue
<script setup lang="ts">
import type { SessionMessageDTO, SessionToolEventDTO } from '~~/shared/types/session'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { sessionToolState } from '~/lib/sessions/tool-state'

const props = defineProps<{
  message: SessionMessageDTO
  toolEvents: SessionToolEventDTO[]
}>()

// Rows stay scannable: a body is clamped until asked otherwise. Expanding re-measures, so the
// virtualizer is told via the resize observer it already has on each row.
const expanded = ref(false)

// The largest message in prod is 279,751 chars. Even expanded, a row must not be able to blow
// the list out — past this we show the head and say so.
const MAX_EXPANDED = 20_000
const body = computed(() => {
  const c = props.message.content
  if (!expanded.value) return c
  return c.length > MAX_EXPANDED ? c.slice(0, MAX_EXPANDED) : c
})
const truncated = computed(() => expanded.value && props.message.content.length > MAX_EXPANDED)
const clampable = computed(() => props.message.content.length > 400)
const role = computed(() => (props.message.role === 'user' ? 'user' : 'assistant'))
</script>

<template>
  <div class="py-1" :class="message.isSidechain ? 'opacity-70' : ''">
    <Reasoning v-if="message.thinking" class="mb-1">
      <ReasoningTrigger />
      <ReasoningContent>{{ message.thinking }}</ReasoningContent>
    </Reasoning>

    <Message v-if="body" :from="role">
      <MessageContent>
        <div :class="!expanded && clampable ? 'line-clamp-6 overflow-hidden' : ''">
          <MessageResponse>{{ body }}</MessageResponse>
        </div>
        <p v-if="truncated" class="mt-1 text-xs text-dimmed">
          Showing the first {{ MAX_EXPANDED.toLocaleString() }} of
          {{ message.content.length.toLocaleString() }} characters.
        </p>
        <UButton
          v-if="clampable"
          :label="expanded ? 'Show less' : 'Show more'"
          color="neutral"
          variant="link"
          size="xs"
          class="mt-1 px-0"
          @click="expanded = !expanded"
        />
      </MessageContent>
    </Message>

    <Tool v-for="te in toolEvents" :key="te.id" :default-open="false" class="mt-1">
      <ToolHeader type="dynamic-tool" :tool-name="te.toolName" :state="sessionToolState(te).state" />
      <ToolContent>
        <ToolInput :input="sessionToolState(te).input" />
        <ToolOutput :output="sessionToolState(te).output" />
      </ToolContent>
    </Tool>
  </div>
</template>
```

- [ ] **Step 2: Render every row shape in the dev fixture**

Extend `app/pages/dev/virtual.vue` with one of each: a short user message, a long assistant message (over 400 chars, to show the clamp), a message with `thinking`, a message with a successful tool event, one with `exitStatus: 'error'`, one whose `result` is an object, one that is `isSidechain`, and one with a 300,000-char body.

- [ ] **Step 3: Verify in a browser**

Start dev (`PORT=3219 BETTER_AUTH_URL=http://localhost:3219 pnpm dev`), open `/dev/virtual` with `playwright-cli`, and screenshot each shape in **both light and dark**. Confirm: the clamp cuts at six lines, Show more expands in place, the 300,000-char row shows the truncation notice and does not blow out the page, a failed tool reads as failed, and an object result renders readably. Kill the dev server by verified PID.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add app/components/sessions/TranscriptRow.vue app/pages/dev/virtual.vue
git commit -m "feat(sessions): render a transcript row with the Elements primitives"
```

---

### Task 8: The virtualized, paging transcript

The load-bearing task. Scroll anchoring is what makes upward infinite scroll feel right or broken.

**Files:**
- Rewrite: `app/components/sessions/SessionTranscript.vue`
- Modify: `app/composables/useSessions.ts`

**Interfaces:**
- Consumes: `TranscriptRow` (Task 7); `SessionMessagesPage` (Task 3); the Task 0 virtualizer pattern.
- Produces:
  ```ts
  // useSessions.ts
  useSessionMessagePages(
    id: MaybeRefOrGetter<string | undefined>,
    filters: MaybeRefOrGetter<SessionMessageFilters>
  )  // useInfiniteQuery; getNextPageParam = last.nextCursor
  ```
  and `<SessionsSessionTranscript :messages :tool-events :loading :has-more :fetching-more :error @load-more />`

- [ ] **Step 1: Add the infinite query**

In `app/composables/useSessions.ts`:

```ts
import { useQuery, useInfiniteQuery } from '@tanstack/vue-query'
import type { SessionMessagesPage, SessionMessageFilters } from '~~/shared/types/session'

  const getMessagePage = (id: string, before: string | undefined, filters: SessionMessageFilters) =>
    $fetch<SessionMessagesPage>(`/api/sessions/${id}/messages`, {
      query: {
        ...(before ? { before } : {}),
        ...(filters.hideSidechain ? { hideSidechain: 'true' } : {}),
        ...(filters.tool ? { tool: filters.tool } : {}),
        ...(filters.q ? { q: filters.q } : {})
      }
    })

  const useSessionMessagePages = (
    id: MaybeRefOrGetter<string | undefined>,
    filters: MaybeRefOrGetter<SessionMessageFilters>
  ) => {
    const key = computed(() => toValue(id))
    // Filters live IN the key: changing one is a new query and a clean first page, with no
    // manual reset and no stale pages bleeding across filters.
    const f = computed(() => toValue(filters))
    return useInfiniteQuery({
      queryKey: computed(() => ['session', key.value, 'messages', 'paged', f.value] as const),
      queryFn: ({ pageParam }) => getMessagePage(key.value as string, pageParam as string | undefined, f.value),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: SessionMessagesPage) => last.nextCursor ?? undefined,
      enabled: computed(() => !!key.value)
    })
  }
```

Export `getMessagePage` and `useSessionMessagePages` from the returned object, keeping every existing export.

- [ ] **Step 2: Write the failing scroll-anchor test**

Create `app/components/sessions/anchor.test.ts`. The arithmetic is extracted so it is testable without a DOM:

```ts
import { describe, it, expect } from 'vitest'
import { anchorAfterPrepend } from './anchor'

describe('anchorAfterPrepend', () => {
  it('keeps the viewport on the same content by adding the height that appeared above it', () => {
    // Was at 1,000px; 3,000px of older rows were prepended above.
    expect(anchorAfterPrepend({ scrollTop: 1000, prevScrollHeight: 5000, nextScrollHeight: 8000 })).toBe(4000)
  })

  it('is a no-op when nothing was added', () => {
    expect(anchorAfterPrepend({ scrollTop: 1000, prevScrollHeight: 5000, nextScrollHeight: 5000 })).toBe(1000)
  })

  it('never returns a negative offset if the list somehow shrank', () => {
    expect(anchorAfterPrepend({ scrollTop: 100, prevScrollHeight: 5000, nextScrollHeight: 4000 })).toBe(0)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run app/components/sessions/anchor.test.ts`
Expected: FAIL — "Failed to resolve import ./anchor".

- [ ] **Step 4: Implement the helper**

Create `app/components/sessions/anchor.ts`:

```ts
/**
 * Upward infinite scroll: when older rows are prepended, everything the reader was looking at
 * moves DOWN by exactly the height that appeared above it. Restoring scrollTop by that delta
 * keeps the same content under the cursor. Measuring the delta from scrollHeight (rather than
 * summing row heights) is what makes this correct with dynamically-measured rows.
 */
export function anchorAfterPrepend(m: {
  scrollTop: number
  prevScrollHeight: number
  nextScrollHeight: number
}): number {
  return Math.max(0, m.scrollTop + (m.nextScrollHeight - m.prevScrollHeight))
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm vitest run app/components/sessions/anchor.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Rewrite the transcript**

`SessionTranscript.vue` keeps its loading and empty states (reuse the existing `USkeleton` block and the `i-lucide-message-square-off` empty state verbatim) and replaces everything else:

- props: `messages: SessionMessageDTO[]` (oldest-first, ready to render), `toolEvents`, `loading?`, `hasMore?`, `fetchingMore?`, `error?: boolean`; emit `load-more`.
- a `Map<string, SessionToolEventDTO[]>` grouping tool events by `messageId` (keep the existing `toolEventsByMsg` shape).
- `useVirtualizer` over `messages` with `estimateSize: () => 140`, `overscan: 10`, and `measureElement` on each row wrapper.
- a sentinel row at the **top**: when `hasMore` and it scrolls into view, emit `load-more`. Before emitting, capture `scrollTop` and `scrollHeight`; after the new rows have rendered (`await nextTick()`, then one `requestAnimationFrame`), set `scrollTop = anchorAfterPrepend({...})`.
- when `error` is true, the sentinel becomes a retry row (`UButton` "Retry") instead of a spinner, and **the already-loaded rows stay on screen** — a failed older page must never clear the transcript.
- keep the existing autoscroll-to-bottom on first load and the live-tail follow behaviour, driven off `messages.at(-1)?.id` instead of the old length watcher.
- each row: `<div :data-index="i" :ref="measureElement" data-vrow><SessionsTranscriptRow … /></div>`.

- [ ] **Step 7: Gates**

Run: `pnpm typecheck` and `pnpm test`.

- [ ] **Step 8: Commit**

```bash
git add app/components/sessions/SessionTranscript.vue app/components/sessions/anchor.ts app/components/sessions/anchor.test.ts app/composables/useSessions.ts
git commit -m "feat(sessions): virtualized transcript that pages older messages in place"
```

---

### Task 9: Filters

**Files:**
- Create: `app/components/sessions/TranscriptFilters.vue`
- Modify: `app/pages/sessions/[id].vue`

**Interfaces:**
- Consumes: `SessionMessageFilters` (Task 3); `useSessionMessagePages` (Task 8); `meta.toolNames` (Task 4).
- Produces: `<SessionsTranscriptFilters v-model="filters" :tool-names="meta.toolNames ?? []" />`

- [ ] **Step 1: Build the filter bar**

```vue
<script setup lang="ts">
import type { SessionMessageFilters } from '~~/shared/types/session'
import { refDebounced } from '@vueuse/core'

const model = defineModel<SessionMessageFilters>({ required: true })
const props = defineProps<{ toolNames: string[] }>()

// Every keystroke is a new query key and a round trip, so the text box is debounced.
const text = ref(model.value.q ?? '')
const debounced = refDebounced(text, 300)
watch(debounced, v => { model.value = { ...model.value, q: v || undefined } })

// reka-ui's USelectMenu rejects an empty-string item value, so "All tools" uses a sentinel.
const ALL = '__all__'
const toolItems = computed(() => [
  { label: 'All tools', value: ALL },
  ...props.toolNames.map(n => ({ label: n, value: n }))
])
const tool = computed({
  get: () => model.value.tool ?? ALL,
  set: (v: string) => { model.value = { ...model.value, tool: v === ALL ? undefined : v } }
})
const hideSidechain = computed({
  get: () => !!model.value.hideSidechain,
  set: (v: boolean) => { model.value = { ...model.value, hideSidechain: v || undefined } }
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 pb-2">
    <UInput v-model="text" placeholder="Find in session…" icon="i-lucide-search" size="sm" class="w-56" />
    <USelectMenu v-if="toolNames.length" v-model="tool" :items="toolItems" value-key="value" size="sm" class="w-44" />
    <USwitch v-model="hideSidechain" label="Hide subagent" size="sm" />
  </div>
</template>
```

- [ ] **Step 2: Wire the page**

In `app/pages/sessions/[id].vue`: replace `useSessionMessages` with `useSessionMessagePages(() => route.params.id as string, filters)` where `const filters = ref<SessionMessageFilters>({})`. Build the render list by **reversing each page and concatenating oldest-page-first**:

```ts
// Pages walk newest → oldest; each page is newest-first internally. The transcript reads
// top-down oldest-first, so reverse both levels.
const messages = computed(() =>
  [...(data.value?.pages ?? [])].reverse().flatMap(p => [...p.messages].reverse()))
const toolEvents = computed(() => (data.value?.pages ?? []).flatMap(p => p.toolEvents))
```

Pass `:has-more="hasNextPage"`, `:fetching-more="isFetchingNextPage"`, `:error="!!error"` and `@load-more="fetchNextPage"`. Render `<SessionsTranscriptFilters>` above the transcript.

- [ ] **Step 3: Keep live-tail, and make it respect the filters**

The existing `watch` on `meta.messageCount` stays, but its delta fetch must carry the active filters, and it must write into the **paged** cache — append to the newest page (`pages[0]`, newest-first) rather than the old `['session', id, 'messages']` key. If `filters.q` or `filters.tool` is set, a delta row that does not match must not be appended; the simplest correct route is to pass the filters to `getMessages` and let the server decide. Update `getMessages` to accept `filters` and forward them.

- [ ] **Step 4: Verify in a browser**

Start dev, log in, open a session with over 500 messages (13 sessions in prod exceed 2,000; pick one). With `playwright-cli`, confirm and screenshot:
1. the session opens at the **newest** end;
2. scrolling up loads an older page and the row you were reading stays put (record `scrollTop` and the top row's text before and after);
3. "Hide subagent" narrows the list and resets to a clean first page;
4. a tool filter narrows to that tool;
5. find-in-session narrows to matches;
6. an expanded row does not jump the viewport;
7. light and dark, 1440 and 375 px.

Kill the dev server by verified PID.

- [ ] **Step 5: Gates**

Run: `pnpm typecheck`, `pnpm test`, `pnpm test:db`.

- [ ] **Step 6: Commit**

```bash
git add app/components/sessions/TranscriptFilters.vue app/pages/sessions/\[id\].vue app/composables/useSessions.ts
git commit -m "feat(sessions): filter a transcript by subagent, tool and text"
```

---

### Task 10: Remove the dead fixture, docs, handover

**Files:**
- Delete: `app/pages/dev/virtual.vue`
- Modify: `docs/wiki/sessions.md`, `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`
- Create: `docs/handovers/2026-09-20-sessions-elements.md`

- [ ] **Step 1: Delete the spike fixture and confirm nothing references it**

```bash
rm app/pages/dev/virtual.vue
grep -rn "dev/virtual" app server docs || echo "clean"
```

- [ ] **Step 2: Update the wiki**

`docs/wiki/sessions.md`: the transcript section becomes the real current behaviour — keyset pagination on `(created_at, id)` with an opaque cursor, default 100 / max 200, per-page tool events, the three server-side filters, `@tanstack/vue-virtual` with measured rows, upward paging with scroll anchoring, and the Elements row components. Bump `status` and `updated`. State plainly that ordering now includes `id` as a tiebreak and that this changes the rendered order of tie-group rows.

- [ ] **Step 3: Write the handover**

`docs/handovers/2026-09-20-sessions-elements.md`, matching the frontmatter shape and depth of `docs/handovers/2026-09-19-agent-page-rebuild.md`. It must record: status (built / merged / deployed, honestly); the prod measurements that drove the design; the migration (additive index, safe to apply online) and that it has not run on prod; the ordering change for the 26%; the bundle before/after from Task 0; every ruling from the SDD ledger with its cost-if-wrong; the deferred read-around-a-search-hit flow; and each browser-validation item with PASS / FAIL / NOT VERIFIED.

- [ ] **Step 4: Roadmap and backlog**

Add the cycle-66 row to `docs/superpowers/plans/00-roadmap.md` following the existing row format. In `docs/BACKLOG.md`, update the cycle-66 line in the "agent surfaces on AI Elements" block from deferred to built, and refresh the "Last reconciled" preamble.

- [ ] **Step 5: Gates**

Run `pnpm typecheck`, `pnpm test`, `pnpm test:db`, and `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. Record the client JS file count and total gzip, and compare against Task 0's baseline — the delta is `@tanstack/vue-virtual` plus this cycle's components.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: cycle 66 handover, wiki, roadmap and backlog"
```

---

## Self-Review

**Spec coverage.** Stable `(created_at, id)` ordering → Tasks 1, 2, 4. Composite index → Task 2. Paged endpoint with `before`/`limit`/filters and the `before`+`since` 400 → Tasks 4, 5. Per-page tool events → Task 4. `toolNames` on meta → Task 4. Elements row primitives → Task 7. `sessionToolState` adapter → Task 6. Virtualizer swap → Tasks 0, 8. Scroll anchoring → Task 8. Clamp/expand with a hard cap → Task 7. Live-tail carrying filters → Task 9. Retry-without-wiping → Task 8. Deletions → Tasks 8, 9, 10. Testing (unit, DB tie-group, browser) → Tasks 1, 4, 6, 8, 7, 9. Docs → Task 10.

**Deliberate spec deviation:** the spec's deletion list includes the 300-char clamp and the raw `<pre>` JSON dumps; those disappear when `SessionTranscript` is rewritten in Task 8 and rows move to `TranscriptRow` in Task 7, rather than as their own step.

**Type consistency.** `SessionMessagesPage` / `SessionMessageFilters` are defined in Task 3 and used verbatim in 4, 5, 8, 9. `getSessionMessagesPage(id, opts)` is defined in Task 4 and called in Task 5. `sessionToolState` is defined in Task 6 and used in Task 7. `anchorAfterPrepend` is defined in Task 8 and used only there. `encodeCursor`/`decodeCursor` are defined in Task 1 and used in Task 4.
