# Session search + transcript read (MCP tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose MyMind's existing hybrid session/message search over MCP and add two bounded, LLM-safe transcript-read tools, so Claude Code can find keyword references in its own past sessions and then read the surrounding transcript.

**Architecture:** Four new `kind: 'read'` tools on the shared `agentTools` registry (`server/lib/agent/tools.ts`), auto-exposed over MCP by `server/lib/mcp/server.ts` and gained by the in-app agent. Search reuses `searchSessions`/`searchMessages` (given new optional filters + agent-shaped hydration wrappers). Reads are a new `server/services/session-read.ts` (a pure core — snippet/truncate/interleave — plus two thin DB wrappers). No migration, no UI, no mutations.

**Tech Stack:** Nuxt/Nitro + TypeScript, Drizzle ORM (Postgres/pgvector), Zod tool schemas, Vitest.

## Global Constraints

- Package manager: **pnpm** only.
- Branch: **`feat/session-search-mcp`** (already created; the spec is committed there).
- **No database migration. No UI. No mutations** — all four tools are `kind: 'read'`, none `dangerous`.
- **Test convention (verified for this repo):** unit tests cover **PURE** logic only — *no test in this repo touches a real database*. DB-backed behavior is verified with a **`tsx` probe against the running dev DB**, and the probe output is pasted into the task report as the evidence. **Do NOT invent DB-backed vitest tests** (no `useDb()` in any `*.test.ts`).
- **Dev DB** is running and has real data: container `mymind-db`, port 5433, 463 sessions / 96,737 messages / 42,429 tool_events. If a probe reports it is down, bring it up: `docker compose up -d db` then `pnpm db:migrate`.
- **Probe scripts that call `useDb()`** must polyfill Nuxt auto-imports before importing app modules, and run with `--env-file=.env` (the pattern used across this repo):
  ```ts
  ;(globalThis as any).useRuntimeConfig = () => ({ databaseUrl: process.env.DATABASE_URL })
  ;(globalThis as any).$fetch = globalThis.fetch
  ```
  Run with `node_modules/.bin/tsx --env-file=.env ./probe.ts`. Put probe files at the repo root and **delete them before committing** (they must not appear in the diff).
- Gates: per-task focused test/probe + **`pnpm typecheck` = 0**. Branch gate (Task 5): `pnpm typecheck` + `pnpm test` + `pnpm build` all clean.
- Lint is red repo-wide and is **NOT** a gate.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

## File Structure

| File | Responsibility |
|---|---|
| `server/services/session-read.ts` (new) | Pure transcript shaping (`snippetAround`, `truncate`, item mappers, `interleave`) + two bounded DB reads (`readSessionPage`, `readAroundMessage`). |
| `server/services/session-read.test.ts` (new) | Unit tests for the PURE core only. |
| `server/services/session-search.ts` (modify) | Add optional `project`/`session`/`includeSidechain` filters; add agent-shaped hydration wrappers `searchMessagesForAgent`/`searchSessionsForAgent`. |
| `server/services/search.ts` (modify) | Update the two call sites to the new opts signature. |
| `server/lib/agent/tools.ts` (modify) | The four tool objects. |
| `server/lib/agent/tools.test.ts` (modify) | Assert the four tools' `kind`/`schema`. |
| `test/agent-tools.test.ts` (modify) | Registry guard: 33 → 37 tools. |
| `docs/wiki/mcp.md` (modify) | Document the new tool surface. |

---

### Task 1: `session-read.ts` — pure transcript-shaping core

**Files:**
- Create: `server/services/session-read.ts`
- Test: `server/services/session-read.test.ts`

**Interfaces:**
- Produces (Tasks 2-4 depend on these EXACT names/types):
  ```ts
  export const CONTENT_CAP: number      // 2000
  export const TOOL_CAP: number         // 600
  export interface MessageItem { kind: 'message'; id: string; role: string | null; content: string; thinking?: string; createdAt: string; truncated?: number }
  export interface ToolEventItem { kind: 'tool'; id: string; toolName: string; exitStatus: string | null; phase: string; argsSnippet: string; resultSnippet: string; createdAt: string; truncated?: number }
  export type TranscriptItem = MessageItem | ToolEventItem
  export interface MessageRow { id: string; role: string | null; content: string; thinking: string | null; createdAt: Date }
  export interface ToolRow { id: string; toolName: string; exitStatus: string | null; phase: string; args: unknown; result: unknown; createdAt: Date }
  export function truncate(s: string, cap: number): { text: string; truncated?: number }
  export function snippetAround(content: string, query: string, radius?: number): string
  export function mapMessage(row: MessageRow, full: boolean): MessageItem
  export function mapTool(row: ToolRow, full: boolean): ToolEventItem
  export function interleave(msgRows: MessageRow[], toolRows: ToolRow[], full: boolean): TranscriptItem[]
  ```

- [ ] **Step 1: Write the failing tests**

Create `server/services/session-read.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { truncate, snippetAround, mapMessage, mapTool, interleave, CONTENT_CAP, TOOL_CAP } from './session-read'

const at = (ms: number) => new Date(1_700_000_000_000 + ms)

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hi', 10)).toEqual({ text: 'hi' })
  })
  it('caps long strings and reports omitted chars', () => {
    const r = truncate('x'.repeat(50), 20)
    expect(r.text).toBe('x'.repeat(20))
    expect(r.truncated).toBe(30)
  })
})

describe('snippetAround', () => {
  it('centers the window on the first case-insensitive match, eliding both sides', () => {
    const content = 'aaaa NAVMESH bbbb'.padStart(400, 'a').padEnd(800, 'b')
    const s = snippetAround(content, 'navmesh', 10)
    expect(s.toLowerCase()).toContain('navmesh')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
  it('falls back to the head when there is no literal match', () => {
    expect(snippetAround('hello world', 'zzz', 4)).toBe('hello wor…'.slice(0, 8) + '…')
  })
  it('handles empty query by returning the head', () => {
    expect(snippetAround('hello', '', 100)).toBe('hello')
  })
})

describe('mapMessage', () => {
  const row = { id: 'm1', role: 'assistant', content: 'y'.repeat(CONTENT_CAP + 100), thinking: 'secret', createdAt: at(0) }
  it('truncates content and drops thinking by default', () => {
    const item = mapMessage(row, false)
    expect(item.kind).toBe('message')
    expect(item.content.length).toBe(CONTENT_CAP)
    expect(item.truncated).toBe(100)
    expect(item.thinking).toBeUndefined()
  })
  it('includes full content + thinking when full', () => {
    const item = mapMessage(row, true)
    expect(item.content.length).toBe(CONTENT_CAP + 100)
    expect(item.truncated).toBeUndefined()
    expect(item.thinking).toBe('secret')
  })
})

describe('mapTool', () => {
  it('stringifies + caps args/result and sums omitted chars', () => {
    const item = mapTool({ id: 't1', toolName: 'exec', exitStatus: '0', phase: 'completed', args: { cmd: 'x'.repeat(TOOL_CAP + 5) }, result: 'r'.repeat(TOOL_CAP + 7), createdAt: at(0) }, false)
    expect(item.kind).toBe('tool')
    expect(item.toolName).toBe('exec')
    expect(item.argsSnippet.length).toBe(TOOL_CAP)
    expect(item.resultSnippet.length).toBe(TOOL_CAP)
    expect(item.truncated).toBe(12)
  })
  it('handles null args/result', () => {
    const item = mapTool({ id: 't2', toolName: 'read', exitStatus: null, phase: 'completed', args: null, result: null, createdAt: at(0) }, false)
    expect(item.argsSnippet).toBe('')
    expect(item.resultSnippet).toBe('')
    expect(item.truncated).toBeUndefined()
  })
})

describe('interleave', () => {
  it('merges messages and tool events into one chronological array', () => {
    const msgs = [
      { id: 'm1', role: 'user', content: 'a', thinking: null, createdAt: at(0) },
      { id: 'm2', role: 'assistant', content: 'b', thinking: null, createdAt: at(20) }
    ]
    const tools = [{ id: 't1', toolName: 'exec', exitStatus: '0', phase: 'completed', args: {}, result: 'ok', createdAt: at(10) }]
    const items = interleave(msgs, tools, false)
    expect(items.map(i => i.id)).toEqual(['m1', 't1', 'm2'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/services/session-read.test.ts`
Expected: FAIL — `Cannot find module './session-read'`.

- [ ] **Step 3: Write the implementation**

Create `server/services/session-read.ts` (this step is the pure core only — the DB functions come in Task 2):

```ts
// server/services/session-read.ts
// Bounded, LLM-safe reads of a session transcript. The pure core (snippet /
// truncate / item mappers / interleave) is unit-tested; the two DB wrappers
// (Task 2) build on it. Messages and tool events live in separate tables and
// are merged chronologically so a transcript reads in order.

export const CONTENT_CAP = 2000
export const TOOL_CAP = 600
export const SNIPPET_RADIUS = 120

export interface MessageItem { kind: 'message'; id: string; role: string | null; content: string; thinking?: string; createdAt: string; truncated?: number }
export interface ToolEventItem { kind: 'tool'; id: string; toolName: string; exitStatus: string | null; phase: string; argsSnippet: string; resultSnippet: string; createdAt: string; truncated?: number }
export type TranscriptItem = MessageItem | ToolEventItem

export interface MessageRow { id: string; role: string | null; content: string; thinking: string | null; createdAt: Date }
export interface ToolRow { id: string; toolName: string; exitStatus: string | null; phase: string; args: unknown; result: unknown; createdAt: Date }

/** Cap a string, reporting how many chars were dropped (undefined if none). */
export function truncate(s: string, cap: number): { text: string; truncated?: number } {
  if (s.length <= cap) return { text: s }
  return { text: s.slice(0, cap), truncated: s.length - cap }
}

/** Window a snippet around the first case-insensitive match of `query`; head-fallback when absent. */
export function snippetAround(content: string, query: string, radius = SNIPPET_RADIUS): string {
  const c = content ?? ''
  const q = (query ?? '').trim().toLowerCase()
  const i = q ? c.toLowerCase().indexOf(q) : -1
  if (i < 0) return c.length > radius * 2 ? c.slice(0, radius * 2) + '…' : c
  const start = Math.max(0, i - radius)
  const end = Math.min(c.length, i + q.length + radius)
  return (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : '')
}

export function mapMessage(row: MessageRow, full: boolean): MessageItem {
  const { text, truncated } = full ? { text: row.content, truncated: undefined as number | undefined } : truncate(row.content, CONTENT_CAP)
  const item: MessageItem = { kind: 'message', id: row.id, role: row.role, content: text, createdAt: row.createdAt.toISOString() }
  if (truncated) item.truncated = truncated
  if (full && row.thinking) item.thinking = row.thinking
  return item
}

export function mapTool(row: ToolRow, full: boolean): ToolEventItem {
  const argsStr = row.args == null ? '' : JSON.stringify(row.args)
  const resStr = row.result == null ? '' : (typeof row.result === 'string' ? row.result : JSON.stringify(row.result))
  const a = full ? { text: argsStr, truncated: undefined as number | undefined } : truncate(argsStr, TOOL_CAP)
  const r = full ? { text: resStr, truncated: undefined as number | undefined } : truncate(resStr, TOOL_CAP)
  const item: ToolEventItem = { kind: 'tool', id: row.id, toolName: row.toolName, exitStatus: row.exitStatus, phase: row.phase, argsSnippet: a.text, resultSnippet: r.text, createdAt: row.createdAt.toISOString() }
  const omitted = (a.truncated ?? 0) + (r.truncated ?? 0)
  if (omitted) item.truncated = omitted
  return item
}

/** Merge messages + tool events into one chronological transcript. */
export function interleave(msgRows: MessageRow[], toolRows: ToolRow[], full: boolean): TranscriptItem[] {
  const rows = [
    ...msgRows.map(m => ({ at: m.createdAt.getTime(), item: mapMessage(m, full) })),
    ...toolRows.map(t => ({ at: t.createdAt.getTime(), item: mapTool(t, full) }))
  ]
  rows.sort((x, y) => x.at - y.at)
  return rows.map(r => r.item)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/services/session-read.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add server/services/session-read.ts server/services/session-read.test.ts
git commit -m "feat(sessions): pure transcript-shaping core (snippet/truncate/interleave)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `session-read.ts` — the two bounded DB reads

**Files:**
- Modify: `server/services/session-read.ts` (append)

**Interfaces:**
- Consumes: Task 1's `interleave`, `MessageRow`, `ToolRow`; `useDb`, `messages`, `toolEvents`, `sessions` from the schema.
- Produces:
  ```ts
  export async function readSessionPage(sessionId: string, opts?: { offset?: number; limit?: number; full?: boolean; includeSidechain?: boolean }):
    Promise<{ error: string; sessionId: string } | { session: { id: string; title: string | null; project: string | null; startedAt: string; endedAt: string | null; messageCount: number }; offset: number; limit: number; returned: number; hasMore: boolean; items: TranscriptItem[] }>
  export async function readAroundMessage(messageId: string, opts?: { radius?: number; full?: boolean; includeSidechain?: boolean }):
    Promise<{ error: string; messageId: string } | { sessionId: string; sessionTitle: string | null; project: string | null; focalMessageId: string; items: TranscriptItem[] }>
  ```

- [ ] **Step 1: Add imports + implementation**

At the top of `server/services/session-read.ts` add:

```ts
import { and, asc, desc, eq, gt, lt, inArray } from 'drizzle-orm'
import { useDb } from '../db'
import { messages, toolEvents, sessions } from '../db/schema'
```

Append at the end:

```ts
const MSG_COLS = { id: messages.id, role: messages.role, content: messages.content, thinking: messages.thinking, createdAt: messages.createdAt }
const TOOL_COLS = { id: toolEvents.id, toolName: toolEvents.toolName, exitStatus: toolEvents.exitStatus, phase: toolEvents.phase, args: toolEvents.args, result: toolEvents.result, createdAt: toolEvents.createdAt }

async function toolEventsFor(ids: string[], includeSidechain: boolean): Promise<ToolRow[]> {
  if (!ids.length) return []
  const db = useDb()
  const where = includeSidechain
    ? inArray(toolEvents.messageId, ids)
    : and(inArray(toolEvents.messageId, ids), eq(toolEvents.isSidechain, false))
  return db.select(TOOL_COLS).from(toolEvents).where(where) as unknown as Promise<ToolRow[]>
}

/** One chronological page of a session transcript (messages + their tool events). */
export async function readSessionPage(sessionId: string, opts: { offset?: number; limit?: number; full?: boolean; includeSidechain?: boolean } = {}) {
  const { offset = 0, limit = 25, full = false, includeSidechain = false } = opts
  const db = useDb()
  const [sess] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!sess) return { error: 'session not found', sessionId }

  const msgWhere = includeSidechain ? eq(messages.sessionId, sessionId) : and(eq(messages.sessionId, sessionId), eq(messages.isSidechain, false))
  const msgRows = await db.select(MSG_COLS).from(messages).where(msgWhere).orderBy(asc(messages.createdAt)).offset(offset).limit(limit) as unknown as MessageRow[]
  const toolRows = await toolEventsFor(msgRows.map(m => m.id), includeSidechain)

  return {
    session: { id: sess.id, title: sess.title, project: sess.project, startedAt: sess.startedAt.toISOString(), endedAt: sess.endedAt?.toISOString() ?? null, messageCount: sess.messageCount },
    offset, limit, returned: msgRows.length,
    // heuristic: a full page implies there is probably more. messageCount is the
    // stored raw total (may include sidechain) and is informational only.
    hasMore: msgRows.length === limit,
    items: interleave(msgRows, toolRows, full)
  }
}

/** The neighborhood around one message: `radius` before + the message + `radius` after. */
export async function readAroundMessage(messageId: string, opts: { radius?: number; full?: boolean; includeSidechain?: boolean } = {}) {
  const { radius = 8, full = false, includeSidechain = false } = opts
  const db = useDb()
  const [focal] = await db.select(MSG_COLS).from(messages).where(eq(messages.id, messageId)).limit(1) as unknown as MessageRow[]
  if (!focal) return { error: 'message not found', messageId }
  const [focalMeta] = await db.select({ sessionId: messages.sessionId }).from(messages).where(eq(messages.id, messageId)).limit(1)
  const sessionId = focalMeta!.sessionId

  const side = (col: typeof messages.isSidechain) => includeSidechain ? undefined : eq(col, false)
  const before = await db.select(MSG_COLS).from(messages)
    .where(and(eq(messages.sessionId, sessionId), lt(messages.createdAt, focal.createdAt), side(messages.isSidechain)))
    .orderBy(desc(messages.createdAt)).limit(radius) as unknown as MessageRow[]
  const after = await db.select(MSG_COLS).from(messages)
    .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, focal.createdAt), side(messages.isSidechain)))
    .orderBy(asc(messages.createdAt)).limit(radius) as unknown as MessageRow[]

  const msgRows = [...before.reverse(), focal, ...after]
  const toolRows = await toolEventsFor(msgRows.map(m => m.id), includeSidechain)
  const [sess] = await db.select({ title: sessions.title, project: sessions.project }).from(sessions).where(eq(sessions.id, sessionId)).limit(1)

  return {
    sessionId, sessionTitle: sess?.title ?? null, project: sess?.project ?? null, focalMessageId: messageId,
    items: interleave(msgRows, toolRows, full)
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3: Probe against the real dev DB** (this is the deliverable evidence — no vitest for DB code)

Create `./probe-read.ts` at the repo root:

```ts
;(globalThis as any).useRuntimeConfig = () => ({ databaseUrl: process.env.DATABASE_URL })
;(globalThis as any).$fetch = globalThis.fetch
import { readSessionPage, readAroundMessage } from './server/services/session-read'
import { useDb } from './server/db'
import { sessions, messages } from './server/db/schema'
import { desc, eq } from 'drizzle-orm'

async function main() {
  const db = useDb()
  // pick a real session with a decent number of messages
  const [s] = await db.select({ id: sessions.id, title: sessions.title, mc: sessions.messageCount }).from(sessions).orderBy(desc(sessions.messageCount)).limit(1)
  console.log('session', s.id, '|', s.title, '| messageCount', s.mc)

  const page = await readSessionPage(s.id, { offset: 0, limit: 5 })
  if ('error' in page) throw new Error(page.error)
  console.log('PAGE returned', page.returned, 'hasMore', page.hasMore, '| kinds:', page.items.map(i => i.kind).join(','))
  const times = page.items.map(i => i.createdAt)
  console.log('chronological:', times.every((t, i) => i === 0 || t >= times[i - 1]!))
  console.log('any truncated:', page.items.some(i => i.truncated))

  // page 2 must differ from page 1
  const page2 = await readSessionPage(s.id, { offset: 5, limit: 5 })
  if ('error' in page2) throw new Error(page2.error)
  console.log('PAGE2 first id != PAGE first id:', page2.items[0]?.id !== page.items[0]?.id)

  // read around a real message from this session
  const [m] = await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, s.id)).orderBy(desc(messages.createdAt)).limit(1)
  const around = await readAroundMessage(m.id, { radius: 3 })
  if ('error' in around) throw new Error(around.error)
  console.log('AROUND focal', around.focalMessageId, 'items', around.items.length, 'contains focal:', around.items.some(i => i.id === m.id))

  console.log('bad id ->', JSON.stringify(await readSessionPage('00000000-0000-0000-0000-000000000000')))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

Run: `node_modules/.bin/tsx --env-file=.env ./probe-read.ts`
Expected: a page of 5 items with `chronological: true`, page-2 first id differs, the around-window contains the focal message, and the bad-id call returns `{"error":"session not found",...}`. **Paste the real output into your report.** Then `rm -f ./probe-read.ts`.

- [ ] **Step 4: Commit**

```bash
git add server/services/session-read.ts
git commit -m "feat(sessions): readSessionPage + readAroundMessage (bounded transcript reads)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: search filters + agent-shaped hydration wrappers

**Files:**
- Modify: `server/services/session-search.ts`
- Modify: `server/services/search.ts` (two call sites)

**Interfaces:**
- Consumes: Task 1's `snippetAround`.
- Produces:
  ```ts
  // signature change (opts object): searchSessions(q, opts?), searchMessages(q, opts?)
  export async function searchSessions(q: string, opts?: { limit?: number; project?: string; includeSidechain?: boolean }): Promise<SessionResult[]>
  export async function searchMessages(q: string, opts?: { limit?: number; project?: string; session?: string; includeSidechain?: boolean }): Promise<MessageResult[]>
  // agent-shaped, richer output (used by the MCP tools)
  export async function searchMessagesForAgent(q: string, opts?: { limit?: number; project?: string; session?: string }): Promise<Array<{ messageId: string; sessionId: string; role: string | null; snippet: string; createdAt: string; sessionTitle: string | null; project: string | null }>>
  export async function searchSessionsForAgent(q: string, opts?: { limit?: number; project?: string }): Promise<Array<{ sessionId: string; title: string; snippet: string; project: string | null; startedAt: string; messageCount: number }>>
  ```

**Design notes:**
- The signature moves from positional `limit` to an opts object; the only callers are two lines in `server/services/search.ts` — update them.
- `includeSidechain` defaults to **`true`** in the search services to preserve current web-search behavior; the MCP tools pass `false` via the `*ForAgent` wrappers. (Reads default the opposite — exclude — because they have no legacy caller.)
- `*ForAgent` reuses the ranking from `searchMessages`/`searchSessions`, then hydrates the extra display fields with a single keyed select, so the web DTOs in `shared/types/search.ts` stay untouched.

- [ ] **Step 1: Add the filters to `searchSessions`/`searchMessages`**

In `server/services/session-search.ts`, change `searchSessions(q: string, limit = 5)` to `searchSessions(q: string, opts: { limit?: number; project?: string; includeSidechain?: boolean } = {})`, read `const { limit = 5, project, includeSidechain = true } = opts`, and add a `project` predicate to both lanes' `where` (sessions have a `project` slug column):

```ts
// trigram lane where:
.where(and(
  sql`(${sessions.title} ilike ${'%' + q + '%'} or ${sessions.summary} ilike ${'%' + q + '%'})`,
  project ? eq(sessions.project, project) : undefined
))
// vector lane where:
.where(and(isNotNull(sessions.summaryEmbedding), project ? eq(sessions.project, project) : undefined))
```
(`sessions` has no `isSidechain`, so `includeSidechain` is accepted but a no-op there — keep it in the signature for symmetry.) Import `and`, `eq` from `drizzle-orm` if not already imported.

Change `searchMessages(q: string, limit = 5)` to `searchMessages(q: string, opts: { limit?: number; project?: string; session?: string; includeSidechain?: boolean } = {})`, read `const { limit = 5, project, session, includeSidechain = true } = opts`, and add predicates to both lanes. `messages` has `project`? **No — `messages` has no `project` column**; scope by `session` (its `sessionId`) directly, and for `project` join through `sessions`. Keep it simple: support `session` on `messages` directly, and `project` by pre-selecting session ids:

```ts
// resolve project -> session ids once (only if project given)
let projectSessionIds: string[] | null = null
if (project) {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.project, project))
  projectSessionIds = rows.map(r => r.id)
  if (!projectSessionIds.length) return []
}
const scope = and(
  includeSidechain ? undefined : eq(messages.isSidechain, false),
  session ? eq(messages.sessionId, session) : undefined,
  projectSessionIds ? inArray(messages.sessionId, projectSessionIds) : undefined
)
// trigram lane where: and(ilike(messages.content, `%${q}%`), scope)
// vector lane where:  and(isNotNull(messages.embedding), scope)
```
Import `and`, `eq`, `inArray` from `drizzle-orm` if needed.

- [ ] **Step 2: Update the two callers**

In `server/services/search.ts`, change `searchSessions(q, K)` → `searchSessions(q, { limit: K })` and `searchMessages(q, K)` → `searchMessages(q, { limit: K })`.

- [ ] **Step 3: Add the `*ForAgent` wrappers**

Append to `server/services/session-search.ts` (import `snippetAround` from `./session-read`, and `inArray`/`eq` as needed):

```ts
import { snippetAround } from './session-read'

export async function searchMessagesForAgent(q: string, opts: { limit?: number; project?: string; session?: string } = {}) {
  const hits = await searchMessages(q, { ...opts, includeSidechain: false })
  if (!hits.length) return []
  const db = useDb()
  const ids = hits.map(h => h.id)
  const full = await db.select({ id: messages.id, sessionId: messages.sessionId, content: messages.content, createdAt: messages.createdAt }).from(messages).where(inArray(messages.id, ids))
  const byId = new Map(full.map(r => [r.id, r]))
  const sessIds = [...new Set(full.map(r => r.sessionId))]
  const sessRows = await db.select({ id: sessions.id, title: sessions.title, project: sessions.project }).from(sessions).where(inArray(sessions.id, sessIds))
  const sessById = new Map(sessRows.map(r => [r.id, r]))
  return hits.flatMap(h => {
    const m = byId.get(h.id); if (!m) return []
    const s = sessById.get(m.sessionId)
    return [{ messageId: h.id, sessionId: m.sessionId, role: h.role, snippet: snippetAround(m.content, q), createdAt: m.createdAt.toISOString(), sessionTitle: s?.title ?? null, project: s?.project ?? null }]
  })
}

export async function searchSessionsForAgent(q: string, opts: { limit?: number; project?: string } = {}) {
  const hits = await searchSessions(q, opts)
  if (!hits.length) return []
  const db = useDb()
  const rows = await db.select({ id: sessions.id, title: sessions.title, summary: sessions.summary, project: sessions.project, startedAt: sessions.startedAt, messageCount: sessions.messageCount }).from(sessions).where(inArray(sessions.id, hits.map(h => h.id)))
  const byId = new Map(rows.map(r => [r.id, r]))
  return hits.flatMap(h => {
    const s = byId.get(h.id); if (!s) return []
    return [{ sessionId: s.id, title: s.title || '(untitled session)', snippet: (s.summary || '').slice(0, 200), project: s.project, startedAt: s.startedAt.toISOString(), messageCount: s.messageCount }]
  })
}
```

- [ ] **Step 4: Typecheck + probe**

Run: `pnpm typecheck` (expect 0).

Create `./probe-search.ts` at the repo root:

```ts
;(globalThis as any).useRuntimeConfig = () => ({ databaseUrl: process.env.DATABASE_URL })
;(globalThis as any).$fetch = globalThis.fetch
import { searchMessagesForAgent, searchSessionsForAgent } from './server/services/session-search'

async function main() {
  const term = process.argv[2] ?? 'error'   // a term certain to appear across transcripts
  const msgs = await searchMessagesForAgent(term, { limit: 3 })
  console.log(`search_messages("${term}") -> ${msgs.length} hits`)
  for (const m of msgs) console.log(`  [${m.role}] ${m.sessionTitle ?? '?'} :: ${m.snippet.slice(0, 120).replace(/\n/g, ' ')}`)
  const sess = await searchSessionsForAgent(term, { limit: 3 })
  console.log(`search_sessions("${term}") -> ${sess.length} hits: ${sess.map(s => s.title).join(' | ')}`)
  console.log('snippet centered on term:', msgs[0] ? msgs[0].snippet.toLowerCase().includes(term.toLowerCase()) : 'n/a')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

Run: `node_modules/.bin/tsx --env-file=.env ./probe-search.ts error`
Expected: message hits with `sessionTitle` + a match-centered snippet, and session hits. **Paste the output into your report.** Then `rm -f ./probe-search.ts`.

- [ ] **Step 5: Commit**

```bash
git add server/services/session-search.ts server/services/search.ts
git commit -m "feat(sessions): search filters (project/session/sidechain) + agent-shaped hydration wrappers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: the four MCP tools + registry guards

**Files:**
- Modify: `server/lib/agent/tools.ts`
- Modify: `server/lib/agent/tools.test.ts`, `test/agent-tools.test.ts`

**Interfaces:**
- Consumes: `readAroundMessage`, `readSessionPage` (Task 2); `searchMessagesForAgent`, `searchSessionsForAgent` (Task 3).

- [ ] **Step 1: Write the failing registry tests**

In `test/agent-tools.test.ts`, change the guard from 33 to 37 tools — replace the name array with (alphabetical):

```ts
  it('exposes the expected 37 tools', () => {
    const names = agentTools.map(t => t.name).sort()
    expect(names).toEqual([
      'create_project', 'create_skill', 'create_task',
      'delete_document', 'delete_skill', 'delete_task',
      'edit_document', 'edit_image', 'edit_project', 'edit_section', 'edit_skill', 'edit_task',
      'forget_memory',
      'generate_image',
      'get_document', 'get_project', 'get_recent_memories',
      'grep_document',
      'list_documents',
      'move_document',
      'quick_capture', 'read_around_message', 'read_document', 'read_session',
      'save_document', 'save_memory',
      'search_docs', 'search_memories', 'search_messages', 'search_passages', 'search_projects', 'search_sessions', 'search_tasks',
      'update_document',
      'use_skill',
      'web_fetch', 'web_search'
    ])
  })
```

In `server/lib/agent/tools.test.ts`, add:

```ts
describe('session tools', () => {
  it('are all read tools with the right schema keys', () => {
    expect(toolByName('search_messages')!.kind).toBe('read')
    expect(Object.keys(toolByName('search_messages')!.schema)).toEqual(expect.arrayContaining(['query', 'project', 'session', 'limit']))
    expect(toolByName('search_sessions')!.kind).toBe('read')
    expect(toolByName('read_around_message')!.kind).toBe('read')
    expect(Object.keys(toolByName('read_around_message')!.schema)).toEqual(expect.arrayContaining(['messageId', 'radius', 'full']))
    expect(toolByName('read_session')!.kind).toBe('read')
    expect(Object.keys(toolByName('read_session')!.schema)).toEqual(expect.arrayContaining(['sessionId', 'offset', 'limit', 'full']))
    for (const n of ['search_messages', 'search_sessions', 'read_around_message', 'read_session']) expect(toolByName(n)!.dangerous, n).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/agent-tools.test.ts server/lib/agent/tools.test.ts`
Expected: FAIL (33≠37; `toolByName('search_messages')` undefined).

- [ ] **Step 3: Add the tools**

In `server/lib/agent/tools.ts`, add the import:

```ts
import { readAroundMessage, readSessionPage } from '../../services/session-read'
import { searchMessagesForAgent, searchSessionsForAgent } from '../../services/session-search'
```

Add these four objects to the `agentTools` array (next to the other `search_*` / `read_*` tools):

```ts
  {
    name: 'search_messages',
    description: 'Search your past Claude Code session transcripts for a keyword or topic (hybrid semantic + exact-match). Returns message-level hits with a snippet centered on the match; follow up with read_around_message to see the surrounding conversation. `project` (slug) or `session` (id) scope it. Excludes subagent/sidechain threads.',
    kind: 'read',
    schema: {
      query: z.string().describe('What to find in session transcripts'),
      project: z.string().optional().describe('Restrict to a project slug'),
      session: z.string().optional().describe('Restrict to one session id'),
      limit: z.number().int().min(1).max(25).optional().describe('Max hits (default 8)')
    },
    handler: async (a) => {
      const res = await searchMessagesForAgent(a.query as string, { project: a.project as string | undefined, session: a.session as string | undefined, limit: (a.limit as number | undefined) ?? 8 })
      return { result: { results: res }, summary: `searched messages (${res.length} hits)` }
    }
  },
  {
    name: 'search_sessions',
    description: 'Find a whole past Claude Code session by topic (hybrid search over session title + summary) — use when you do not have an exact keyword. Returns session-level hits; follow up with read_session to page the transcript. `project` (slug) scopes it.',
    kind: 'read',
    schema: {
      query: z.string().describe('Topic to find a session about'),
      project: z.string().optional().describe('Restrict to a project slug'),
      limit: z.number().int().min(1).max(25).optional().describe('Max hits (default 8)')
    },
    handler: async (a) => {
      const res = await searchSessionsForAgent(a.query as string, { project: a.project as string | undefined, limit: (a.limit as number | undefined) ?? 8 })
      return { result: { results: res }, summary: `searched sessions (${res.length} hits)` }
    }
  },
  {
    name: 'read_around_message',
    description: 'Read the conversation around a specific message (e.g. a search_messages hit): the message plus `radius` turns before and after, in order, with tool calls/outputs interleaved. Long content is truncated with a marker (pass full:true for everything). Excludes sidechain by default.',
    kind: 'read',
    schema: {
      messageId: z.string().describe('A message id, e.g. from search_messages'),
      radius: z.number().int().min(0).max(30).optional().describe('Messages before/after (default 8)'),
      full: z.boolean().optional().describe('Return untruncated content'),
      includeSidechain: z.boolean().optional().describe('Include subagent/Task threads')
    },
    handler: async (a) => {
      const res = await readAroundMessage(a.messageId as string, { radius: a.radius as number | undefined, full: a.full as boolean | undefined, includeSidechain: a.includeSidechain as boolean | undefined })
      return { result: res, summary: 'error' in res ? 'read_around_message: not found' : `read ${res.items.length} items around message` }
    }
  },
  {
    name: 'read_session',
    description: 'Page through a whole session transcript in chronological order, tool calls/outputs interleaved. Returns session meta + a page of items + hasMore. Long content is truncated (full:true for everything). Excludes sidechain by default.',
    kind: 'read',
    schema: {
      sessionId: z.string().describe('The session id'),
      offset: z.number().int().min(0).optional().describe('Message offset (default 0)'),
      limit: z.number().int().min(1).max(50).optional().describe('Messages per page (default 25)'),
      full: z.boolean().optional().describe('Return untruncated content'),
      includeSidechain: z.boolean().optional().describe('Include subagent/Task threads')
    },
    handler: async (a) => {
      const res = await readSessionPage(a.sessionId as string, { offset: a.offset as number | undefined, limit: a.limit as number | undefined, full: a.full as boolean | undefined, includeSidechain: a.includeSidechain as boolean | undefined })
      return { result: res, summary: 'error' in res ? 'read_session: not found' : `read ${res.returned} items (offset ${res.offset}${res.hasMore ? ', more' : ''})` }
    }
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/agent-tools.test.ts server/lib/agent/tools.test.ts && pnpm typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/tools.test.ts test/agent-tools.test.ts
git commit -m "feat(agent): search_messages/search_sessions/read_around_message/read_session tools (MCP + agent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: docs + branch gate + MCP round-trip

**Files:**
- Modify: `docs/wiki/mcp.md`

- [ ] **Step 1: Document the tool surface**

Read `docs/wiki/mcp.md`, bump its `updated:` frontmatter to `2026-07-28`, and add a "Session search + transcript read" subsection to the tool list covering: `search_messages` (hybrid, match-centered snippet, sidechain excluded), `search_sessions`, `read_around_message` (windowed), `read_session` (paged), the truncation/`full` behavior, and the message↔tool-event interleave. Note there is no migration/UI (reuses existing search + the `sessions` UI).

- [ ] **Step 2: Full branch gate**

```bash
pnpm typecheck && pnpm test && pnpm build
```
Expected: typecheck 0; all tests green (the pre-existing suite + the new `session-read` unit tests + the updated registry guard); build clean.

- [ ] **Step 3: MCP round-trip probe** (proves the tools are actually exposed + chain end-to-end)

Start dev on an explicit free port (3000 may be taken by another project): `PORT=3210 pnpm dev > /tmp/dev.log 2>&1 &`, poll `http://localhost:3210/api/health` until 200. Mint or reuse a dev `mm_` token (see `.superpowers/sdd/` notes from the skills cycle, or `/settings/api-keys`). Then, with `TOKEN=<mm_...>`:

```bash
# tools list must include all four
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:3210/api/mcp \
  | grep -oE '"(search_messages|search_sessions|read_around_message|read_session)"' | sort -u
# a real chain: search_messages -> take a messageId -> read_around_message
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_messages","arguments":{"query":"error","limit":2}}}' \
  http://localhost:3210/api/mcp | head -c 600
```
Expected: the list shows all four tool names; the `search_messages` call returns hits with `messageId`/`sessionId`/`snippet`. **Paste the output into the report.** Kill the dev server afterward.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/mcp.md
git commit -m "docs(wiki): mcp.md — session search + transcript read tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** search_messages/search_sessions → Task 3 (+ tool objects Task 4); read_around_message/read_session → Task 2 (+ tools Task 4); pure core (snippet/truncate/interleave, caps) → Task 1; match-centered snippet → Task 1 `snippetAround` used by Task 3; project/session/sidechain filters → Task 3; MCP auto-exposure + registry guard → Task 4; tool-event interleave + truncation + `full` → Tasks 1-2; docs + verify → Task 5. Non-goals (no reranker, no backfill, no UI, no migration, no mutations) are respected — no task adds any.
- **Placeholder scan:** none — every code/probe step is concrete.
- **Type consistency:** `MessageItem`/`ToolEventItem`/`TranscriptItem`, `MessageRow`/`ToolRow`, `readSessionPage`/`readAroundMessage`, `searchMessagesForAgent`/`searchSessionsForAgent`, `snippetAround`, `CONTENT_CAP`/`TOOL_CAP` are each defined once (Task 1/2/3) and referenced by the same names in Task 4. The `searchSessions`/`searchMessages` opts-object signature (Task 3) matches the two updated call sites in `search.ts` and the `*ForAgent` internal calls.

## Execution Handoff

Deferred to the parent session — subagent-driven (recommended) or inline.
