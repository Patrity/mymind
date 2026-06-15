# Phase 2 — Capture Fidelity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capture Claude Code sessions at full bridget fidelity — tool events, assistant thinking, sidechain flag, per-message model/stop-reason/parent, and session git/machine/app metadata — so pointing real CC hooks at MyMind (and the Phase-3 bridget import) loses nothing.

**Architecture:** Add first-class columns to `messages`/`sessions` and a new `tool_events` table. Rewrite the pure transcript parser to extract the rich fields + emit tool events (correlating `tool_use`→`tool_result` by `tool_use_id`). Rewrite `ingestTranscript` to persist them and recompute aggregates. Extend the `/api/hooks/cc/[event]` handler + `upsertSession` to persist git/machine/app/ended fields the Phase-1 hook already sends. Surface the new data in the session detail view. **Dual-write** the existing `metadata` fields so pre-Phase-2 rows keep rendering unchanged.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle + Postgres, vitest, Nuxt UI v4.

**Scope:** Phase 2 of 5 of the cycle-13 bridget-parity spec (`docs/superpowers/specs/2026-06-15-bridget-parity-design.md`, Part C). Embedding columns for search (`messages.embedding`, `sessions.summary_embedding`) and the summarization worker are **Phase 4** — not here. Branch: `feat/bridget-parity` (continues from Phase 1).

**Conventions:** pure-function vitest in `test/*.test.ts`; migrations via `pnpm db:generate` + `pnpm db:migrate`; gates = `pnpm typecheck` + `pnpm test` (+ `pnpm build` for UI); repo lint is red repo-wide (not a gate). Every Nitro writer calls `publishChange`. `.vue` = Nuxt UI v4 + semantic tokens only (consult `nuxt-ui-docs`). Validate UI with `playwright-cli`.

---

## File structure

**Create:**
- `server/db/schema/tool-events.ts` — the `tool_events` table.
- `test/tool-event-parse.test.ts` — parser tests for tool-event + thinking extraction.

**Modify:**
- `server/db/schema/messages.ts` — add `thinking, model, stopReason, requestId, parentUuid, isSidechain, usage`.
- `server/db/schema/sessions.ts` — add `machineId, hostname, gitBranch, gitCommit, gitRemote, appVersion, endedAt`.
- `server/db/schema/index.ts` — export `tool-events`.
- `server/services/transcript-parse.ts` — rewrite to extract rich fields + emit tool events.
- `test/transcript-parse.test.ts` — extend with new-field assertions (keep existing passing).
- `server/services/sessions.ts` — `upsertSession` persists new session fields; `ingestTranscript` inserts new message cols + tool events + recomputes; `getSession` returns the new fields + tool events.
- `server/api/hooks/cc/[event].post.ts` — accept + forward the new session fields.
- `shared/types/session.ts` — `SessionMessageDTO`, `SessionDetail`, new `SessionToolEventDTO`.
- `app/pages/sessions/[id].vue` — surface thinking, tool-event args/result/exit-status, and the new header fields.

**Generated:** `server/db/migrations/0016_*.sql` + meta.

---

## Task 1: Schema — message/session columns + `tool_events` table

**Files:** Modify `server/db/schema/messages.ts`, `server/db/schema/sessions.ts`, `server/db/schema/index.ts`; Create `server/db/schema/tool-events.ts`; Generated `0016_*.sql`.

- [ ] **Step 1: Extend `messages` schema**

In `server/db/schema/messages.ts`, add the import for `boolean` and the new columns (after `externalUuid`, before `metadata`):

```typescript
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull(),
  role: text('role'),
  content: text('content').notNull().default(''),
  externalUuid: text('external_uuid'),
  parentUuid: text('parent_uuid'),
  thinking: text('thinking'),
  model: text('model'),
  stopReason: text('stop_reason'),
  requestId: text('request_id'),
  isSidechain: boolean('is_sidechain').notNull().default(false),
  usage: jsonb('usage'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('messages_session_idx').on(t.sessionId),
  uniqueIndex('messages_session_extuuid_uidx').on(t.sessionId, t.externalUuid)
])

export type Message = typeof messages.$inferSelect
```

- [ ] **Step 2: Extend `sessions` schema**

In `server/db/schema/sessions.ts`, add the new columns (after `cwd`, before `title`):

```typescript
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  source: text('source').notNull(),
  externalId: text('external_id').notNull(),
  project: text('project'),
  cwd: text('cwd'),
  machineId: text('machine_id'),
  hostname: text('hostname'),
  gitBranch: text('git_branch'),
  gitCommit: text('git_commit'),
  gitRemote: text('git_remote'),
  appVersion: text('app_version'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  title: text('title'),
  summary: text('summary'),
  messageCount: integer('message_count').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  toolCount: integer('tool_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`)
}, (t) => [
  uniqueIndex('sessions_source_external_uidx').on(t.source, t.externalId),
  index('sessions_machine_idx').on(t.machineId)
])

export type Session = typeof sessions.$inferSelect
```

(Add `index` to the existing `drizzle-orm/pg-core` import in this file.)

- [ ] **Step 3: Create the `tool_events` table**

Create `server/db/schema/tool-events.ts`:

```typescript
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, jsonb, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const toolEvents = pgTable('tool_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull(),
  messageId: uuid('message_id'),
  toolName: text('tool_name').notNull(),
  args: jsonb('args'),
  result: jsonb('result'),
  exitStatus: text('exit_status'),         // ok | error | timeout | cancelled
  phase: text('phase').notNull().default('completed'), // pre | completed | failed
  toolUseId: text('tool_use_id'),
  isSidechain: boolean('is_sidechain').notNull().default(false),
  callerType: text('caller_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('tool_events_session_idx').on(t.sessionId),
  index('tool_events_tool_name_idx').on(t.toolName),
  uniqueIndex('tool_events_session_tooluse_uidx').on(t.sessionId, t.toolUseId)
])

export type ToolEvent = typeof toolEvents.$inferSelect
```

Note: the partial-unique on `(session_id, tool_use_id)` — drizzle's `uniqueIndex` over two columns where one is nullable is fine; rows with `tool_use_id = NULL` are allowed multiple times in Postgres (NULLs distinct). That matches bridget's idempotency intent.

- [ ] **Step 4: Export the new table**

In `server/db/schema/index.ts`, add: `export * from './tool-events'`.

- [ ] **Step 5: Generate + apply the migration**

Run: `pnpm db:generate` → a new `0016_*.sql` containing the `ALTER TABLE` for messages + sessions and `CREATE TABLE "tool_events"`. Read the generated SQL to confirm it only adds (no drops).
Run: `pnpm db:migrate` → applies cleanly.
Run: `pnpm typecheck` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema server/db/migrations
git commit -m "feat(capture): message/session fidelity columns + tool_events table (migration 0016)"
```

---

## Task 2: Parser rewrite — extract rich fields + emit tool events (TDD)

**Files:** Modify `server/services/transcript-parse.ts`; Create `test/tool-event-parse.test.ts`; Modify `test/transcript-parse.test.ts`.

The parser stays **pure** (never throws). It now returns tool events and per-message rich fields, while still dual-writing the legacy `metadata.{usage,model,tools,type}` so existing consumers keep working.

- [ ] **Step 1: Write the new failing tests**

Create `test/tool-event-parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseTranscriptLines } from '../server/services/transcript-parse'

const asstThinking = JSON.stringify({
  uuid: 'a1', parentUuid: 'u0', requestId: 'req_1',
  message: {
    role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
    content: [
      { type: 'thinking', thinking: 'Let me reason about this.' },
      { type: 'text', text: 'Here is the answer.' }
    ]
  }
})

const asstToolUse = JSON.stringify({
  uuid: 'a2', isSidechain: true,
  message: {
    role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' }, caller: { type: 'direct' } }]
  }
})

const userToolResultOk = JSON.stringify({
  uuid: 'tr1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1.txt' }] }
})

const userToolResultErr = JSON.stringify({
  uuid: 'tr2',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }] }
})

const asstToolUse2 = JSON.stringify({
  uuid: 'a3',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { path: '/x' } }] }
})

const longPreamble = JSON.stringify({ message: { role: 'user', content: 'X'.repeat(250) } }) // no uuid, >200 chars

describe('parseTranscriptLines — rich capture', () => {
  it('extracts thinking separate from text, plus model/stopReason/requestId/parentUuid', () => {
    const r = parseTranscriptLines([asstThinking])
    const m = r.messages.find(x => x.role === 'assistant')!
    expect(m.content).toBe('Here is the answer.')
    expect(m.thinking).toBe('Let me reason about this.')
    expect(m.model).toBe('claude-opus-4-8')
    expect(m.stopReason).toBe('end_turn')
    expect(m.requestId).toBe('req_1')
    expect(m.parentUuid).toBe('u0')
    expect(m.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 })
  })

  it('emits a tool event from a tool_use block with args + caller + sidechain', () => {
    const r = parseTranscriptLines([asstToolUse])
    expect(r.toolEvents).toHaveLength(1)
    const te = r.toolEvents[0]!
    expect(te.toolName).toBe('Bash')
    expect(te.toolUseId).toBe('tu1')
    expect(te.args).toMatchObject({ command: 'ls' })
    expect(te.phase).toBe('pre')
    expect(te.callerType).toBe('direct')
    expect(te.isSidechain).toBe(true)
    expect(te.parentExternalUuid).toBe('a2')
  })

  it('closes a tool event on a matching tool_result (ok)', () => {
    const r = parseTranscriptLines([asstToolUse, userToolResultOk])
    const te = r.toolEvents.find(e => e.toolUseId === 'tu1')!
    expect(te.phase).toBe('completed')
    expect(te.exitStatus).toBe('ok')
    expect(te.result).toBe('file1.txt')
  })

  it('marks a tool event failed on an error tool_result', () => {
    const r = parseTranscriptLines([asstToolUse2, userToolResultErr])
    const te = r.toolEvents.find(e => e.toolUseId === 'tu2')!
    expect(te.phase).toBe('failed')
    expect(te.exitStatus).toBe('error')
  })

  it('skips a pure tool_result message row but still records the event', () => {
    const r = parseTranscriptLines([asstToolUse, userToolResultOk])
    // the tool_result user line is pure (no text) → no message row for it
    expect(r.messages.some(m => m.externalUuid === 'tr1')).toBe(false)
    expect(r.toolEvents.find(e => e.toolUseId === 'tu1')!.exitStatus).toBe('ok')
  })

  it('flags a long no-uuid user preamble as system_prompt', () => {
    const r = parseTranscriptLines([longPreamble])
    const m = r.messages[0]!
    expect(m.metadata.system_prompt).toBe(true)
  })

  it('defaults isSidechain to false', () => {
    const r = parseTranscriptLines([asstThinking])
    expect(r.messages[0]!.isSidechain).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- tool-event-parse`
Expected: FAIL — `toolEvents` undefined / fields missing.

- [ ] **Step 3: Rewrite the parser**

Replace `server/services/transcript-parse.ts` with:

```typescript
import { createHash } from 'node:crypto'

export interface ParsedMessage {
  role: string | null
  content: string
  externalUuid: string | null
  parentUuid: string | null
  thinking: string | null
  model: string | null
  stopReason: string | null
  requestId: string | null
  isSidechain: boolean
  usage: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

export interface ParsedToolEvent {
  toolUseId: string | null
  parentExternalUuid: string | null
  toolName: string
  args: unknown
  result: unknown
  exitStatus: string | null            // ok | error | null
  phase: 'pre' | 'completed' | 'failed'
  callerType: string | null
  isSidechain: boolean
}

export interface ParsedTranscript {
  messages: ParsedMessage[]
  toolEvents: ParsedToolEvent[]
  inputTokens: number
  outputTokens: number
  toolCount: number
}

function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as Record<string, unknown>).type === 'text')
      .map(p => (p as Record<string, unknown>).text as string)
      .filter(t => typeof t === 'string')
      .join('\n')
  }
  return ''
}

function extractThinking(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  const parts = raw
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as Record<string, unknown>).type === 'thinking')
    .map(p => (p.thinking ?? p.text) as string)
    .filter(t => typeof t === 'string')
  return parts.length ? parts.join('\n') : null
}

function syntheticUuid(role: string, content: string): string {
  return 'h:' + createHash('sha256').update(role + '|' + content).digest('hex').slice(0, 16)
}

/** Parse CC JSONL lines into rich messages + tool events. Tolerant: never throws. */
export function parseTranscriptLines(lines: string[]): ParsedTranscript {
  const messages: ParsedMessage[] = []
  const toolEvents: ParsedToolEvent[] = []
  const byToolUseId = new Map<string, ParsedToolEvent>()
  let inputTokens = 0
  let outputTokens = 0

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const msg = obj.message as Record<string, unknown> | undefined
      const rawRole = msg?.role ?? obj.role ?? obj.type
      const role = typeof rawRole === 'string' ? rawRole : null
      if (role !== 'user' && role !== 'assistant') continue

      const rawContent = msg?.content ?? obj.content ?? null
      const contentArray = Array.isArray(rawContent) ? rawContent as Record<string, unknown>[] : []
      const isSidechain = obj.isSidechain === true

      // usage / tokens
      const usage = (msg?.usage && typeof msg.usage === 'object') ? msg.usage as Record<string, unknown> : null
      if (usage) {
        inputTokens += ((usage.input_tokens as number | undefined) ?? 0)
          + ((usage.cache_read_input_tokens as number | undefined) ?? 0)
          + ((usage.cache_creation_input_tokens as number | undefined) ?? 0)
        outputTokens += (usage.output_tokens as number | undefined) ?? 0
      }

      // tool blocks → events
      const toolNames: string[] = []
      let hasToolUse = false
      let hasToolResult = false
      const parentUuid = (typeof obj.parentUuid === 'string' ? obj.parentUuid : null)
      const selfUuid = (typeof obj.uuid === 'string' ? obj.uuid : null)
        ?? (typeof msg?.id === 'string' ? msg.id as string : null)

      for (const part of contentArray) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'tool_use') {
          hasToolUse = true
          if (typeof part.name === 'string') toolNames.push(part.name)
          if (typeof part.id === 'string') {
            const ev: ParsedToolEvent = {
              toolUseId: part.id,
              parentExternalUuid: selfUuid,
              toolName: typeof part.name === 'string' ? part.name : 'unknown',
              args: part.input ?? null,
              result: null,
              exitStatus: null,
              phase: 'pre',
              callerType: (part.caller && typeof part.caller === 'object') ? ((part.caller as Record<string, unknown>).type as string ?? null) : null,
              isSidechain
            }
            toolEvents.push(ev)
            byToolUseId.set(part.id, ev)
          }
        } else if (part.type === 'tool_result') {
          hasToolResult = true
          const tuid = typeof part.tool_use_id === 'string' ? part.tool_use_id : null
          if (tuid) {
            const ev = byToolUseId.get(tuid)
            if (ev) {
              ev.result = part.content ?? null
              ev.exitStatus = part.is_error ? 'error' : 'ok'
              ev.phase = part.is_error ? 'failed' : 'completed'
            }
          }
        }
      }

      const text = extractText(rawContent)
      const thinking = extractThinking(rawContent)
      const hasText = text.trim().length > 0

      // pure tool_result (user line that's only a tool_result) → skip the row,
      // but the event was already closed above.
      const pureToolResult = role === 'user' && hasToolResult && !hasText && !hasToolUse
      if (pureToolResult) continue

      // skip empty noise (no text, no tool activity, no usage, no thinking)
      if (!hasText && !hasToolUse && !hasToolResult && !usage && !thinking) continue

      // dual-write legacy metadata for backward-compatible consumers
      const metadata: Record<string, unknown> = {}
      if (usage) metadata.usage = usage
      if (typeof msg?.model === 'string') metadata.model = msg.model
      if (toolNames.length) metadata.tools = toolNames
      if (hasToolResult) metadata.type = 'tool_result'
      // system-prompt heuristic: long, no-uuid user preamble
      if (role === 'user' && !selfUuid && text.length > 200) metadata.system_prompt = true

      messages.push({
        role,
        content: text,
        externalUuid: selfUuid ?? syntheticUuid(role, text),
        parentUuid,
        thinking,
        model: typeof msg?.model === 'string' ? msg.model : null,
        stopReason: typeof msg?.stop_reason === 'string' ? msg.stop_reason : null,
        requestId: typeof obj.requestId === 'string' ? obj.requestId : null,
        isSidechain,
        usage,
        metadata
      })
    } catch {
      // tolerant: skip unparseable lines
    }
  }

  return { messages, toolEvents, inputTokens, outputTokens, toolCount: toolEvents.length }
}
```

- [ ] **Step 4: Update the existing parser tests for the new shape**

The existing `test/transcript-parse.test.ts` asserts `metadata.tools`/`metadata.usage`/`metadata.type` (still dual-written, so those pass) and `toolCount`. **One change:** the "full scenario" test expects `result.messages.length === 4`, but the pure tool_result row is now skipped → it becomes **3**. Update that assertion:

```typescript
  it('full scenario: correct totals across 4 lines', () => {
    const result = parseTranscriptLines([userLine, assistantLine, toolUseLine, toolResultLine])
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
    expect(result.toolCount).toBe(1) // one tool_use → one event (closed by the result)
    // user msg, assistant text msg, assistant tool-only msg (the pure tool_result row is skipped)
    expect(result.messages.length).toBe(3)
  })
```

Also the `'counts tool_result lines toward toolCount and marks metadata'` test sends ONLY `toolResultLine` (a pure tool_result with no preceding tool_use). With the new parser that row is skipped (pure tool_result) and no event is created (no matching tool_use). Update it to assert the row is skipped:

```typescript
  it('skips a standalone pure tool_result line (no matching tool_use)', () => {
    const result = parseTranscriptLines([toolResultLine])
    expect(result.messages).toHaveLength(0)
    expect(result.toolEvents).toHaveLength(0)
  })
```

(The `'emits a message for tool-only assistant turn with metadata.tools'` test still passes — a tool_use-only assistant row is still emitted with `metadata.tools`.)

- [ ] **Step 5: Run all parser tests**

Run: `pnpm test -- transcript-parse tool-event-parse`
Expected: all PASS.
Run: `pnpm typecheck` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add server/services/transcript-parse.ts test/transcript-parse.test.ts test/tool-event-parse.test.ts
git commit -m "feat(capture): parser extracts thinking/model/sidechain + emits tool events"
```

---

## Task 3: Persist rich messages + tool events in `ingestTranscript`

**Files:** Modify `server/services/sessions.ts`.

- [ ] **Step 1: Persist the new message columns + insert tool events**

In `server/services/sessions.ts`, update the imports and rewrite `ingestTranscript`. Import `toolEvents`:

```typescript
import { sessions, messages, toolEvents } from '../db/schema'
```

Rewrite `ingestTranscript` so it (a) inserts messages with the new columns, (b) maps inserted message ids back by `externalUuid` to link tool events, (c) inserts tool events idempotently and closes them, (d) recomputes aggregates from the real tables:

```typescript
export async function ingestTranscript(input: IngestTranscriptInput): Promise<IngestResult> {
  const db = useDb()
  const session = await upsertSession({ source: input.source, externalId: input.externalId })
  const parsed = parseTranscriptLines(input.lines)

  // 1. Insert messages (idempotent on (session_id, external_uuid))
  if (parsed.messages.length > 0) {
    await db.insert(messages).values(parsed.messages.map(m => ({
      sessionId: session.id,
      role: m.role ?? undefined,
      content: m.content,
      externalUuid: m.externalUuid,
      parentUuid: m.parentUuid,
      thinking: m.thinking,
      model: m.model,
      stopReason: m.stopReason,
      requestId: m.requestId,
      isSidechain: m.isSidechain,
      usage: m.usage as unknown as string,
      metadata: m.metadata as unknown as string
    }))).onConflictDoNothing()
  }

  // 2. Map externalUuid -> message id for tool-event linkage
  const msgRows = await db.select({ id: messages.id, externalUuid: messages.externalUuid })
    .from(messages).where(eq(messages.sessionId, session.id))
  const idByUuid = new Map(msgRows.map(r => [r.externalUuid, r.id]))

  // 3. Insert/close tool events (idempotent on (session_id, tool_use_id))
  for (const te of parsed.toolEvents) {
    if (!te.toolUseId) continue
    await db.insert(toolEvents).values({
      sessionId: session.id,
      messageId: te.parentExternalUuid ? idByUuid.get(te.parentExternalUuid) ?? null : null,
      toolName: te.toolName,
      args: te.args as unknown as string,
      result: te.result as unknown as string,
      exitStatus: te.exitStatus,
      phase: te.phase,
      toolUseId: te.toolUseId,
      isSidechain: te.isSidechain,
      callerType: te.callerType
    }).onConflictDoUpdate({
      target: [toolEvents.sessionId, toolEvents.toolUseId],
      // a later batch may carry the closing result — update result/phase/status
      set: { result: te.result as unknown as string, exitStatus: te.exitStatus, phase: te.phase }
    })
  }

  // 4. Recompute aggregates from the real tables
  const [agg] = await db.select({
    msgCount: sql<number>`count(*)::int`,
    inTok: sql<number>`coalesce(sum( coalesce((${messages.usage}->>'input_tokens')::int,0)
      + coalesce((${messages.usage}->>'cache_read_input_tokens')::int,0)
      + coalesce((${messages.usage}->>'cache_creation_input_tokens')::int,0) ),0)::int`,
    outTok: sql<number>`coalesce(sum( coalesce((${messages.usage}->>'output_tokens')::int,0) ),0)::int`,
    minTs: sql<string | null>`min(${messages.createdAt})`,
    maxTs: sql<string | null>`max(${messages.createdAt})`
  }).from(messages).where(eq(messages.sessionId, session.id))

  const [toolAgg] = await db.select({ n: sql<number>`count(*)::int` })
    .from(toolEvents).where(eq(toolEvents.sessionId, session.id))

  await db.update(sessions).set({
    messageCount: agg?.msgCount ?? 0,
    inputTokens: agg?.inTok ?? 0,
    outputTokens: agg?.outTok ?? 0,
    toolCount: toolAgg?.n ?? 0,
    ...(agg?.minTs ? { startedAt: new Date(agg.minTs) } : {}),
    lastActive: agg?.maxTs ? new Date(agg.maxTs) : new Date()
  }).where(eq(sessions.id, session.id))

  publishChange({ resource: 'session', action: 'updated', id: session.id })
  return { ingested: parsed.messages.length, total: agg?.msgCount ?? 0 }
}
```

(Token totals now read the first-class `usage` column. Old pre-Phase-2 rows have `usage = NULL` but kept their totals in `metadata.usage`; since this recompute reads the column, a re-ingest of an old session would zero its tokens — acceptable: old sessions are test data and Phase 3 re-imports fresh. New sessions are correct.)

- [ ] **Step 2: Typecheck + test**

Run: `pnpm typecheck` → 0 errors.
Run: `pnpm test` → suite still green (no DB test here; covered by E2E later).

- [ ] **Step 3: Commit**

```bash
git add server/services/sessions.ts
git commit -m "feat(capture): ingest persists rich messages + tool events, recomputes aggregates"
```

---

## Task 4: Persist session git/machine/app/ended fields from the hook event

**Files:** Modify `server/services/sessions.ts` (`UpsertSessionInput` + `upsertSession`); Modify `server/api/hooks/cc/[event].post.ts`.

- [ ] **Step 1: Extend `UpsertSessionInput` + `upsertSession`**

In `server/services/sessions.ts`, extend the input interface and the conflict-update/insert logic:

```typescript
export interface UpsertSessionInput {
  source: string
  externalId: string
  project?: string | null
  cwd?: string | null
  title?: string | null
  machineId?: string | null
  hostname?: string | null
  gitBranch?: string | null
  gitCommit?: string | null
  gitRemote?: string | null
  appVersion?: string | null
  endedAt?: Date | null
  metadata?: Record<string, unknown>
}
```

In `upsertSession`, add each optional field to BOTH `updateSet` (when provided) and `insertValues` (when non-null), following the existing `project`/`cwd` pattern. For example, after the `cwd` handling:

```typescript
  if (input.machineId != null) updateSet.machineId = input.machineId
  if (input.hostname != null) updateSet.hostname = input.hostname
  if (input.gitBranch != null) updateSet.gitBranch = input.gitBranch
  if (input.gitCommit != null) updateSet.gitCommit = input.gitCommit
  if (input.gitRemote != null) updateSet.gitRemote = input.gitRemote
  if (input.appVersion != null) updateSet.appVersion = input.appVersion
  if (input.endedAt != null) updateSet.endedAt = input.endedAt
```

and in `insertValues` spread:

```typescript
    ...(input.machineId != null ? { machineId: input.machineId } : {}),
    ...(input.hostname != null ? { hostname: input.hostname } : {}),
    ...(input.gitBranch != null ? { gitBranch: input.gitBranch } : {}),
    ...(input.gitCommit != null ? { gitCommit: input.gitCommit } : {}),
    ...(input.gitRemote != null ? { gitRemote: input.gitRemote } : {}),
    ...(input.appVersion != null ? { appVersion: input.appVersion } : {}),
    ...(input.endedAt != null ? { endedAt: input.endedAt } : {})
```

- [ ] **Step 2: Accept the fields in the hook endpoint**

Rewrite `server/api/hooks/cc/[event].post.ts` to parse + forward the new fields and set `endedAt` on `SessionEnd`:

```typescript
import { z } from 'zod'
import { upsertSession } from '../../../services/sessions'
import { publishChange } from '../../../utils/live-bus'

const Body = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  project: z.string().nullish(),
  cwd: z.string().nullish(),
  git_branch: z.string().nullish(),
  git_commit: z.string().nullish(),
  git_remote: z.string().nullish(),
  machine_id: z.string().nullish(),
  hostname: z.string().nullish(),
  app_version: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export default defineEventHandler(async (event) => {
  const eventName = getRouterParam(event, 'event') ?? 'unknown'
  const body = Body.parse(await readBody(event))

  const metadata: Record<string, unknown> = { ...(body.metadata ?? {}), lastEvent: eventName }
  const isEnd = eventName === 'SessionEnd'

  const session = await upsertSession({
    source: body.source,
    externalId: body.external_id,
    project: body.project ?? undefined,
    cwd: body.cwd ?? undefined,
    gitBranch: body.git_branch ?? undefined,
    gitCommit: body.git_commit ?? undefined,
    gitRemote: body.git_remote ?? undefined,
    machineId: body.machine_id ?? undefined,
    hostname: body.hostname ?? undefined,
    appVersion: body.app_version ?? undefined,
    endedAt: isEnd ? new Date() : undefined,
    metadata
  })

  publishChange({ resource: 'session', action: 'updated', id: session.id })
  return { ok: true, sessionId: session.id }
})
```

- [ ] **Step 3: Typecheck + test + commit**

Run: `pnpm typecheck` → 0; `pnpm test` → green.
```bash
git add server/services/sessions.ts server/api/hooks/cc/[event].post.ts
git commit -m "feat(capture): persist session git/machine/app fields + ended_at from hook events"
```

---

## Task 5: Surface the captured data in the session detail (DTO + API + UI)

**Files:** Modify `shared/types/session.ts`, `server/services/sessions.ts` (`getSession`), `app/pages/sessions/[id].vue`.

- [ ] **Step 1: Extend the DTOs**

In `shared/types/session.ts`:

```typescript
export interface SessionMessageDTO {
  id: string
  role: string | null
  content: string
  thinking: string | null
  model: string | null
  isSidechain: boolean
  metadata: Record<string, unknown>
  createdAt: string
}

export interface SessionToolEventDTO {
  id: string
  messageId: string | null
  toolName: string
  args: unknown
  result: unknown
  exitStatus: string | null
  phase: string
  toolUseId: string | null
  isSidechain: boolean
  createdAt: string
}

export interface SessionDetail extends SessionListItem {
  cwd: string | null
  machineId: string | null
  gitBranch: string | null
  gitCommit: string | null
  gitRemote: string | null
  appVersion: string | null
  endedAt: string | null
  metadata: Record<string, unknown>
  messages: SessionMessageDTO[]
  toolEvents: SessionToolEventDTO[]
}
```

- [ ] **Step 2: Return the new fields from `getSession`**

In `server/services/sessions.ts` `getSession`, map the new message columns, fetch tool events, and add the session header fields. After loading `msgs`, add:

```typescript
  const tevs = await db.select().from(toolEvents)
    .where(eq(toolEvents.sessionId, id)).orderBy(asc(toolEvents.createdAt))
```

Update the `messageDTOs` map to include `thinking`, `model`, `isSidechain`:

```typescript
  const messageDTOs: SessionMessageDTO[] = msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    model: m.model,
    isSidechain: m.isSidechain,
    metadata: (m.metadata as Record<string, unknown>) ?? {},
    createdAt: m.createdAt.toISOString()
  }))
```

and the returned object to include the new session fields + `toolEvents`:

```typescript
    cwd: session.cwd,
    machineId: session.machineId,
    gitBranch: session.gitBranch,
    gitCommit: session.gitCommit,
    gitRemote: session.gitRemote,
    appVersion: session.appVersion,
    endedAt: session.endedAt?.toISOString() ?? null,
    metadata: (session.metadata as Record<string, unknown>) ?? {},
    messages: messageDTOs,
    toolEvents: tevs.map(t => ({
      id: t.id, messageId: t.messageId, toolName: t.toolName, args: t.args, result: t.result,
      exitStatus: t.exitStatus, phase: t.phase, toolUseId: t.toolUseId,
      isSidechain: t.isSidechain, createdAt: t.createdAt.toISOString()
    }))
```

- [ ] **Step 3: Surface in the UI** (`app/pages/sessions/[id].vue`)

Consult `nuxt-ui-docs` for any component you adjust. Make three additive changes (keep the existing transcript working):

1. **Session header git/machine** — replace the metadata-derived `gitBranch`/`gitRepo` computeds with the first-class fields, and add machine/app:
   ```typescript
   const gitBranch = computed(() => session.value?.gitBranch ?? null)
   const gitRepo = computed(() => session.value?.gitRemote ?? null)
   const gitCommit = computed(() => session.value?.gitCommit ?? null)
   ```
   In the CWD+git block, show `{{ gitBranch }}{{ gitCommit ? ' @ ' + gitCommit.slice(0,8) : '' }}`, and add a line for `session.machineId` (icon `i-lucide-monitor`) and `session.appVersion` (icon `i-lucide-tag`) when present.

2. **Assistant thinking** — in the assistant turn card, before `<MdView :source="msg.content" />`, add a collapsible:
   ```vue
   <details v-if="msg.thinking" class="mb-1.5">
     <summary class="text-xs text-dimmed cursor-pointer select-none">thinking…</summary>
     <pre class="mt-1 text-xs text-dimmed font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{{ msg.thinking }}</pre>
   </details>
   ```

3. **Tool events** — build a map from `toolEvents` keyed by `messageId`, and in the tool turn card render the real args/result/exit-status when available (falling back to today's `metadata`-based rendering for old rows). Add:
   ```typescript
   const toolEventsByMsg = computed(() => {
     const m = new Map<string, SessionToolEventDTO[]>()
     for (const te of session.value?.toolEvents ?? []) {
       if (!te.messageId) continue
       const arr = m.get(te.messageId) ?? []; arr.push(te); m.set(te.messageId, arr)
     }
     return m
   })
   ```
   (import `SessionToolEventDTO` from `~~/shared/types/session`.) In the tool card, for each event of `toolEventsByMsg.get(msg.id)` show a `UBadge` for `toolName`, an exit-status `UBadge` (`color: te.exitStatus === 'ok' ? 'success' : te.exitStatus ? 'error' : 'neutral'`), and the args/result JSON inside the existing collapsible. Keep the current `toolNames(msg)`/`metadata` path as the fallback when there are no tool events for the message.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck` → 0; `pnpm build` → OK; `pnpm test` → green.

- [ ] **Step 5: Commit**

```bash
git add shared/types/session.ts server/services/sessions.ts app/pages/sessions/[id].vue
git commit -m "feat(capture): surface thinking, tool events, and git/machine/app in session detail"
```

---

## Task 6: Gates + E2E validation

**Files:** none (verification).

- [ ] **Step 1: Static gates** — `pnpm typecheck` (0), `pnpm test` (all pass, note count), `pnpm build` (OK).

- [ ] **Step 2: Ingest E2E** (dev server running). Drive a transcript through the hook with a captured sample, then verify capture:
  1. Build a small JSONL with an assistant `thinking`+`text` turn, an assistant `tool_use` (Bash), and a user `tool_result` (ok), plus a `SessionEnd` event carrying `git_branch`/`git_commit`/`machine_id`.
  2. `POST /api/hooks/cc/SessionStart` (or via the installed `cc-hook.sh`) with the session fields, then `POST /api/hooks/cc/transcript` with the lines, then `POST /api/hooks/cc/SessionEnd`.
  3. `GET /api/sessions/{id}` → assert: a message has non-null `thinking` + `model`; `toolEvents` has a `Bash` event with `phase:'completed'`, `exitStatus:'ok'`, populated `args`+`result`; the session has `gitBranch`/`gitCommit`/`machineId` and an `endedAt`; `toolCount` ≥ 1.
  4. Open `/sessions/{id}` in the browser (playwright-cli) → the thinking collapsible, the tool event (name + ok badge + args), and the git/machine header all render.

- [ ] **Step 3: Idempotency** — re-POST the same transcript lines → message + tool-event counts do NOT double (unique constraints hold).

- [ ] **Step 4: Final whole-phase review** — dispatch a reviewer over `git diff` of the phase to catch integration gaps (parser↔ingest↔DTO↔UI shapes; the dual-write metadata still feeding the old UI path; migration↔snapshot consistency).

---

## Done criteria for Phase 2
- A CC transcript ingested via the hook stores: per-message thinking/model/stop_reason/request_id/parent_uuid/is_sidechain/usage; tool events (args/result/exit_status/phase) in `tool_events`; session git/machine/app/ended fields.
- The session detail surfaces thinking, tool-event detail, and the git/machine header.
- Re-ingest is idempotent; existing pre-Phase-2 sessions still render.
- All gates green; E2E verified against the rigs.
- **Next:** Phase 3 (raw bridget import) — now that the rich schema exists.
