# Phase 4 — Session Summaries + Session/Message Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Generate titles + summaries for sessions (the 457 imported ones show "(untitled)" today) and make **sessions and messages** semantically searchable, wired into the command palette.

**Architecture:** Add `summary_embedding`/`last_embedded_at` to `sessions`, `embedding` to `messages`, and a `sess_summary_state` table (migration 0017, with hand-appended HNSW + trigram indexes). A scheduled `summarize-sessions` worker (mirrors the proven bridget `sess_summarize`) selects stale/new sessions, builds a transcript, calls `chat('reasoning')` for `{title, summary}`, and writes them + a `title‖summary` embedding. A scheduled `embed-messages` worker (mirrors `runEmbedding`) fills `messages.embedding`. New `searchSessions`/`searchMessages` services (RRF trigram+vector, like `searchMemories`) join the parallel lanes in `searchAll`, surfaced in the palette.

**Tech Stack:** Nuxt 4 / Nitro scheduled tasks, Drizzle + pgvector (`halfvec(2560)` + HNSW cosine), the AI registry (`chat`, `embed`/`embedOne`, `rrfFuse`), vitest, Nuxt UI v4.

**Scope:** Phase 4 of 5 of the cycle-13 bridget-parity spec (Parts D + E). Branch `feat/bridget-parity`. The actual full summarize/embed backfill over 457 sessions / 96K messages happens incrementally via the schedulers (and the Phase-4 E2E triggers a small batch to prove it) — the build does NOT block on full backfill.

**Conventions:** pure-function vitest in `test/`; migrations `pnpm db:generate` then hand-append index SQL, then `pnpm db:migrate`; gates = typecheck + test (+ build for UI); every writer `publishChange`; `.vue` = Nuxt UI v4 + semantic tokens; HNSW/trigram indexes are raw SQL appended to the generated migration (drizzle can't emit them) — pattern from `0003`/`0008`/`0013`.

---

## File structure
**Create:** `server/db/schema/sess-summary-state.ts`; `server/services/session-summarize.ts` (+ pure `selectSummaryCandidates`/`buildSummaryTranscript`/`parseSummary`); `server/services/session-search.ts` (`searchSessions`,`searchMessages`); `server/services/message-embedding.ts` (`runMessageEmbedding`); `server/tasks/summarize-sessions.ts`; `server/tasks/embed-messages.ts`; `test/session-summarize.test.ts`; `test/session-search.test.ts`.
**Modify:** `server/db/schema/sessions.ts` (+`summaryEmbedding`,`lastEmbeddedAt`); `server/db/schema/messages.ts` (+`embedding`); `server/db/schema/index.ts`; `nuxt.config.ts` (scheduledTasks); `shared/types/search.ts` (+`SessionResult`,`MessageResult`); `server/services/search.ts` (+ 2 lanes); the command-palette component (render the 2 new groups).

---

## Task 1: Schema — embeddings + `sess_summary_state` + indexes

**Files:** Modify `server/db/schema/sessions.ts`, `messages.ts`, `index.ts`; Create `server/db/schema/sess-summary-state.ts`; Generated `0017_*.sql` (+ hand-appended index SQL).

- [ ] **Step 1: sessions schema** — add after `lastActive` (before `metadata`):
```typescript
  summaryEmbedding: halfvec(2560),
  lastEmbeddedAt: timestamp('last_embedded_at', { withTimezone: true }),
```
Add the import: `import { halfvec } from '../types/halfvec'` (top of `sessions.ts`).

- [ ] **Step 2: messages schema** — add after `usage` (before `metadata`):
```typescript
  embedding: halfvec(2560),
```
Add `import { halfvec } from '../types/halfvec'` to `messages.ts`.

- [ ] **Step 3: `sess_summary_state` table** — create `server/db/schema/sess-summary-state.ts`:
```typescript
import { sql } from 'drizzle-orm'
import { pgTable, uuid, integer, text, timestamp, index } from 'drizzle-orm/pg-core'

export const sessSummaryState = pgTable('sess_summary_state', {
  sessionId: uuid('session_id').primaryKey(),
  lastSummarizedMessageCount: integer('last_summarized_message_count').notNull().default(0),
  lastRun: timestamp('last_run', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('ok'), // ok | skipped | error
  error: text('error'),
  durationMs: integer('duration_ms'),
  model: text('model'),
  summaryChars: integer('summary_chars'),
  titleChars: integer('title_chars'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('sess_summary_state_last_run_idx').on(t.lastRun)
])
export type SessSummaryState = typeof sessSummaryState.$inferSelect
```
Export from `index.ts`: `export * from './sess-summary-state'`.

- [ ] **Step 4: generate migration** — `pnpm db:generate` → `0017_*.sql` with the ADD COLUMNs + CREATE TABLE. READ it; confirm additive only.

- [ ] **Step 5: hand-append index SQL** — edit the generated `0017_*.sql`, appending (each preceded by `--> statement-breakpoint`):
```sql
CREATE INDEX IF NOT EXISTS messages_embedding_hnsw ON messages USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS sessions_summary_embedding_hnsw ON sessions USING hnsw (summary_embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS messages_content_trgm ON messages USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sessions_title_trgm ON sessions USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sessions_summary_trgm ON sessions USING gin (summary gin_trgm_ops);
```
(`pg_trgm` + `vector`/`halfvec` extensions already exist — used by docs/memories/images.)

- [ ] **Step 6: migrate + typecheck** — `pnpm db:migrate` (clean), `pnpm typecheck` (0).

- [ ] **Step 7: commit**
```bash
git add server/db/schema server/db/migrations
git commit -m "feat(sessions): summary/message embedding cols + sess_summary_state + indexes (0017)"
```

---

## Task 2: Session summarization worker

**Files:** Create `server/services/session-summarize.ts`, `test/session-summarize.test.ts`, `server/tasks/summarize-sessions.ts`; Modify `nuxt.config.ts`.

Mirrors bridget `sess_summarize`. Pure helpers are unit-tested; the LLM/DB orchestration is integration-validated in Task 6.

- [ ] **Step 1: failing tests** — `test/session-summarize.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildSummaryTranscript, parseSummary } from '../server/services/session-summarize'

describe('parseSummary', () => {
  it('parses strict JSON', () => {
    expect(parseSummary('{"title":"T","summary":"S"}')).toEqual({ title: 'T', summary: 'S' })
  })
  it('tolerates code fences + surrounding prose', () => {
    expect(parseSummary('here:\n```json\n{"title":"A","summary":"B"}\n```')).toEqual({ title: 'A', summary: 'B' })
  })
  it('caps title to 200 and summary to 4000 chars', () => {
    const r = parseSummary(JSON.stringify({ title: 'x'.repeat(300), summary: 'y'.repeat(5000) }))
    expect(r!.title.length).toBe(200)
    expect(r!.summary.length).toBe(4000)
  })
  it('returns null on unparseable / empty summary', () => {
    expect(parseSummary('not json')).toBeNull()
    expect(parseSummary('{"title":"t","summary":""}')).toBeNull()
  })
})

describe('buildSummaryTranscript', () => {
  it('renders user/assistant text + thinking + tool one-liners, chronological', () => {
    const t = buildSummaryTranscript([
      { role: 'user', content: 'do X', thinking: null },
      { role: 'assistant', content: 'ok', thinking: 'I will do X' }
    ], [{ toolName: 'Bash', exitStatus: 'ok' }])
    expect(t).toContain('do X')
    expect(t).toContain('<thinking>I will do X</thinking>')
    expect(t).toContain('[tool] Bash')
  })
  it('elides the middle when over the char cap', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: 'm'.repeat(2000) + i, thinking: null }))
    const t = buildSummaryTranscript(msgs, [], 5000)
    expect(t).toContain('messages elided')
    expect(t.length).toBeLessThan(8000)
  })
})
```

- [ ] **Step 2: run → fail** — `pnpm test -- session-summarize`.

- [ ] **Step 3: implement** — `server/services/session-summarize.ts`:
```typescript
import { and, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages, toolEvents, sessSummaryState } from '../db/schema'
import { chat } from '../lib/ai/chat'
import { embedOne } from '../lib/ai/embeddings'
import { publishChange } from '../utils/live-bus'

export interface SummaryResult { enriched: number, processed: number, skipped: number }

const MIN_MESSAGES = 6
const REFRESH_DELTA = 50
const STALE_HOURS = 24
const PER_RUN = 30
const MAX_INPUT_CHARS = 60000

const SYSTEM_PROMPT = `You summarize an AI coding/work session. Output STRICT JSON only: {"title": "...", "summary": "..."}. TITLE: <=100 chars, topical/imperative, no "Tony asked about…" — name the concrete thing done. SUMMARY: 3-6 sentences, neutral past-tense changelog voice (no "successfully", no "comprehensive"): the intent, key decisions/trade-offs, concrete artifacts (names/ids/paths), and the open next step if any. No prose outside the JSON.`

export function parseSummary(raw: string): { title: string, summary: string } | null {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: unknown = null
  try { obj = JSON.parse(s) } catch {
    const m = s.match(/\{[\s\S]*\}/)
    if (m) { try { obj = JSON.parse(m[0]) } catch { /* fall through */ } }
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.slice(0, 200) : ''
  const summary = typeof o.summary === 'string' ? o.summary.slice(0, 4000) : ''
  if (!summary.trim()) return null
  return { title, summary }
}

export function buildSummaryTranscript(
  msgs: { role: string | null, content: string, thinking: string | null }[],
  tools: { toolName: string, exitStatus: string | null }[],
  maxChars = MAX_INPUT_CHARS
): string {
  const lines = msgs.map(m => {
    const think = m.thinking ? ` <thinking>${m.thinking}</thinking>` : ''
    return `[${m.role ?? 'unknown'}] ${m.content}${think}`
  })
  const toolLine = tools.length
    ? '\n[tools] ' + tools.map(t => `[tool] ${t.toolName}${t.exitStatus ? '→' + t.exitStatus : ''}`).join(' ')
    : ''
  let body = lines.join('\n') + toolLine
  if (body.length > maxChars) {
    const head = Math.floor(maxChars * 0.3), tail = maxChars - head
    body = body.slice(0, head) + `\n[… ${msgs.length} messages elided …]\n` + body.slice(-tail)
  }
  return body
}

/** Pure candidate selector (tested via the SQL it builds in Task 6 integration; logic here is the bucket order). */
export async function runSessionSummarize({ limit = PER_RUN }: { limit?: number } = {}): Promise<SummaryResult> {
  const db = useDb()
  // Candidates via drizzle-select + sql subqueries in the where (clean typed rows; mirrors
  // server/services/memory-enrich.ts's selector — avoids db.execute() row-shape ambiguity).
  // Real-message floor (content or thinking, not system_prompt) >= MIN_MESSAGES, AND
  // (never summarized | prior error | grew by >= REFRESH_DELTA | stale > STALE_HOURS with new msgs).
  // (Error sessions are still selected; we order oldest-first rather than error-first for simplicity.)
  const candidates = await db.select({ id: sessions.id })
    .from(sessions)
    .where(and(
      sql`(select count(*) from ${messages} m where m.session_id = ${sessions.id}
            and m.role in ('user','assistant')
            and (coalesce(m.content,'') <> '' or coalesce(m.thinking,'') <> '')
            and coalesce((m.metadata->>'system_prompt')::boolean, false) is not true) >= ${MIN_MESSAGES}`,
      sql`(not exists (select 1 from ${sessSummaryState} st where st.session_id = ${sessions.id})
        or exists (select 1 from ${sessSummaryState} st where st.session_id = ${sessions.id} and (
             st.status = 'error'
             or (${sessions.messageCount} - coalesce(st.last_summarized_message_count, 0)) >= ${REFRESH_DELTA}
             or (${sessions.lastActive} > st.last_run + (${STALE_HOURS} * interval '1 hour') and ${sessions.messageCount} > coalesce(st.last_summarized_message_count, 0)))))`
    ))
    .orderBy(sessions.lastActive)
    .limit(limit)

  let enriched = 0, processed = 0, skipped = 0
  for (const c of candidates) {
    const sessionId = c.id
    const t0 = Date.now()
    try {
      const msgs = await db.select({ role: messages.role, content: messages.content, thinking: messages.thinking, createdAt: messages.createdAt })
        .from(messages).where(eq(messages.sessionId, sessionId)).orderBy(messages.createdAt)
      const real = msgs.filter(m => (m.role === 'user' || m.role === 'assistant') && ((m.content ?? '') !== '' || (m.thinking ?? '') !== ''))
      if (real.length === 0) { await upsertState(sessionId, 0, 'skipped', null, Date.now() - t0); skipped++; continue }
      const tools = await db.select({ toolName: toolEvents.toolName, exitStatus: toolEvents.exitStatus })
        .from(toolEvents).where(eq(toolEvents.sessionId, sessionId)).limit(40)
      const transcript = buildSummaryTranscript(real, tools)
      const raw = await chat('reasoning', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript }
      ], { temperature: 0.3, maxTokens: 1024 })
      const parsed = parseSummary(raw)
      if (!parsed) { await upsertState(sessionId, msgs.length, 'error', 'unparseable summary', Date.now() - t0); skipped++; continue }
      // embed title‖summary before the write (non-fatal)
      let vec: number[] | null = null
      try { vec = await embedOne(`${parsed.title}\n\n${parsed.summary}`) } catch { /* keep null, retry next run */ }
      await db.update(sessions).set({
        title: sql`coalesce(nullif(${parsed.title}, ''), ${sessions.title})`,
        summary: parsed.summary,
        ...(vec ? { summaryEmbedding: vec as unknown as string, lastEmbeddedAt: new Date() } : {})
      }).where(eq(sessions.id, sessionId))
      await upsertState(sessionId, msgs.length, 'ok', null, Date.now() - t0, parsed)
      publishChange({ resource: 'session', action: 'updated', id: sessionId })
      enriched++; processed++
    } catch (err) {
      await upsertState(sessionId, 0, 'error', String(err), Date.now() - t0); skipped++
    }
  }
  return { enriched, processed, skipped }
}

async function upsertState(sessionId: string, count: number, status: string, error: string | null, durationMs: number, parsed?: { title: string, summary: string }) {
  const db = useDb()
  const set = { lastSummarizedMessageCount: count, lastRun: new Date(), status, error, durationMs, updatedAt: new Date(),
    summaryChars: parsed?.summary.length ?? null, titleChars: parsed?.title.length ?? null }
  await db.insert(sessSummaryState).values({ sessionId, ...set })
    .onConflictDoUpdate({ target: sessSummaryState.sessionId, set })
}
```
> Note: confirm `chat`'s import path + signature against `server/services/memory-enrich.ts` (it calls `chat('reasoning', [...], { temperature, maxTokens })`). Confirm `db.execute(sql\`…\`)` row-shape handling against another raw-SQL use in the repo (e.g. `server/services/activity.ts` or `memory-enrich.ts`'s `sql` subqueries) and adjust the row iteration to match drizzle's actual return shape — **this is the one spot to verify carefully**.

- [ ] **Step 4: run unit tests + typecheck** — `pnpm test -- session-summarize` (the pure `parseSummary`/`buildSummaryTranscript` tests pass), `pnpm typecheck` (0).

- [ ] **Step 5: scheduled task** — `server/tasks/summarize-sessions.ts` (mirror `embed-documents.ts` withSpan wrapper):
```typescript
import { runSessionSummarize } from '../services/session-summarize'
import { withSpan, recordEvent } from '../lib/observability/record'

export default defineTask({
  meta: { name: 'summarize-sessions', description: 'Generate titles + summaries for new/stale sessions' },
  async run() {
    const result = await withSpan({ kind: 'job', name: 'summarize-sessions' }, async () => {
      const r = await runSessionSummarize({})
      recordEvent({ kind: 'job', name: 'summarize-sessions:summary', status: 'ok', severity: 'info', meta: r as unknown as Record<string, unknown> })
      return r
    })
    return { result }
  }
})
```
Register in `nuxt.config.ts` `scheduledTasks`: `'*/5 * * * *': ['summarize-sessions']` (merge with the existing entries — keep all existing tasks).

- [ ] **Step 6: commit**
```bash
git add server/services/session-summarize.ts test/session-summarize.test.ts server/tasks/summarize-sessions.ts nuxt.config.ts
git commit -m "feat(sessions): session summarization worker (title+summary+embedding)"
```

---

## Task 3: Message embedding worker

**Files:** Create `server/services/message-embedding.ts`, `server/tasks/embed-messages.ts`; Modify `nuxt.config.ts`.

- [ ] **Step 1: implement** — `server/services/message-embedding.ts` (mirror `runEmbedding`; message content is immutable so the gate is just `embedding IS NULL`, and skip empty/short content):
```typescript
import { and, eq, isNull, sql, gt } from 'drizzle-orm'
import { useDb } from '../db'
import { messages } from '../db/schema'
import { embed } from '../lib/ai/embeddings'

const MIN_CHARS = 16

export async function runMessageEmbedding({ limit = 500, batch = 16 } = {}): Promise<{ embedded: number, failed: number, remaining: number }> {
  const db = useDb()
  const needWhere = and(isNull(messages.embedding), sql`length(coalesce(${messages.content},'')) >= ${MIN_CHARS}`)
  const rows = await db.select({ id: messages.id, content: messages.content }).from(messages).where(needWhere).limit(limit)
  let embedded = 0, failed = 0
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    const texts = slice.map(r => r.content.slice(0, 8000))
    let vectors: number[][] | null = null
    try { vectors = await embed(texts) } catch { vectors = null }
    if (vectors) {
      for (let j = 0; j < slice.length; j++) {
        await db.update(messages).set({ embedding: vectors[j] as unknown as string }).where(eq(messages.id, slice[j]!.id))
        embedded++
      }
    } else {
      for (let j = 0; j < slice.length; j++) {
        try { const [v] = await embed([texts[j]!]); await db.update(messages).set({ embedding: v as unknown as string }).where(eq(messages.id, slice[j]!.id)); embedded++ }
        catch { failed++ }
      }
    }
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(messages).where(needWhere)
  return { embedded, failed, remaining: Number(count) }
}
```
(No `publishChange` per message — embeddings are silent; a session-detail view doesn't render them.)

- [ ] **Step 2: task** — `server/tasks/embed-messages.ts` (mirror `embed-documents.ts`, calling `runMessageEmbedding({ limit: 1000 })`). Register `'*/4 * * * *': ['embed-messages']` in `nuxt.config.ts`.

- [ ] **Step 3: typecheck + test + commit**
```bash
git add server/services/message-embedding.ts server/tasks/embed-messages.ts nuxt.config.ts
git commit -m "feat(sessions): message embedding worker"
```

---

## Task 4: searchSessions + searchMessages (RRF) + types

**Files:** Create `server/services/session-search.ts`, `test/session-search.test.ts`; Modify `shared/types/search.ts`.

- [ ] **Step 1: types** — in `shared/types/search.ts` add:
```typescript
export interface SessionResult { type: 'session'; id: string; title: string; snippet: string; project: string | null; to: string }
export interface MessageResult { type: 'message'; id: string; sessionId: string; role: string | null; snippet: string; to: string }
```
and extend `SearchResults` with `sessions: SessionResult[]` and `messages: MessageResult[]`.

- [ ] **Step 2: services** — `server/services/session-search.ts` (mirror `searchMemories`'s trigram+vector+`rrfFuse`):
```typescript
import { and, eq, isNotNull, ilike, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages } from '../db/schema'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import type { SessionResult, MessageResult } from '../../shared/types/search'

export async function searchSessions(q: string, limit = 5): Promise<SessionResult[]> {
  if (!q.trim()) return []
  const db = useDb()
  const trg = await db.select({ id: sessions.id }).from(sessions)
    .where(sql`(${sessions.title} ilike ${'%'+q+'%'} or ${sessions.summary} ilike ${'%'+q+'%'})`)
    .orderBy(sql`greatest(coalesce(similarity(${sessions.title}, ${q}),0), coalesce(similarity(${sessions.summary}, ${q}),0)) desc`).limit(50)
  let vec: string[] = []
  try {
    const qv = await embedOne(q); const lit = `[${qv.join(',')}]`
    const v = await db.select({ id: sessions.id }).from(sessions).where(isNotNull(sessions.summaryEmbedding))
      .orderBy(sql`${sessions.summaryEmbedding} <=> ${lit}::halfvec`).limit(50)
    vec = v.map(r => r.id)
  } catch { /* trigram-only fallback */ }
  const ids = rrfFuse([trg.map(r => r.id), vec]).slice(0, limit)
  if (!ids.length) return []
  const rows = await db.select().from(sessions).where(sql`${sessions.id} = any(${ids})`)
  const byId = new Map(rows.map(r => [r.id, r]))
  return ids.flatMap(id => { const r = byId.get(id); return r ? [{ type: 'session' as const, id: r.id, title: r.title || '(untitled session)', snippet: (r.summary || '').slice(0, 160), project: r.project, to: `/sessions/${r.id}` }] : [] })
}

export async function searchMessages(q: string, limit = 5): Promise<MessageResult[]> {
  if (!q.trim()) return []
  const db = useDb()
  const trg = await db.select({ id: messages.id }).from(messages)
    .where(ilike(messages.content, `%${q}%`))
    .orderBy(sql`similarity(${messages.content}, ${q}) desc`).limit(50)
  let vec: string[] = []
  try {
    const qv = await embedOne(q); const lit = `[${qv.join(',')}]`
    const v = await db.select({ id: messages.id }).from(messages).where(isNotNull(messages.embedding))
      .orderBy(sql`${messages.embedding} <=> ${lit}::halfvec`).limit(50)
    vec = v.map(r => r.id)
  } catch { /* trigram-only fallback */ }
  const ids = rrfFuse([trg.map(r => r.id), vec]).slice(0, limit)
  if (!ids.length) return []
  const rows = await db.select({ id: messages.id, sessionId: messages.sessionId, role: messages.role, content: messages.content }).from(messages).where(sql`${messages.id} = any(${ids})`)
  const byId = new Map(rows.map(r => [r.id, r]))
  return ids.flatMap(id => { const r = byId.get(id); return r ? [{ type: 'message' as const, id: r.id, sessionId: r.sessionId, role: r.role, snippet: r.content.slice(0, 160), to: `/sessions/${r.sessionId}` }] : [] })
}
```

- [ ] **Step 3: test** — `test/session-search.test.ts`: unit-test the result-shaping by calling `rrfFuse` directly (import from `../server/lib/ai/rrf`) to confirm fusion order, and assert the `to`/`snippet` mapping with a tiny fake (or keep it a `rrfFuse` ordering test — the DB lanes are integration-validated in Task 6). Keep it pure (no DB).

- [ ] **Step 4: typecheck + test + commit**
```bash
git add server/services/session-search.ts test/session-search.test.ts shared/types/search.ts
git commit -m "feat(search): searchSessions + searchMessages (RRF trigram+vector)"
```

---

## Task 5: Wire into the command palette

**Files:** Modify `server/services/search.ts`; the palette component (find via `useGlobalSearch` usage).

- [ ] **Step 1: searchAll lanes** — in `server/services/search.ts`, add two parallel lanes (each try/catch → `[]` like the others), calling `searchSessions(q, perGroup)` and `searchMessages(q, perGroup)`, and include `sessions`/`messages` in the returned `SearchResults`. Update `emptyResults()` to include `sessions: [], messages: []`. Also update `server/api/search.get.ts` `emptyResults`.

- [ ] **Step 2: palette UI** — find the component that renders `SearchResults` (grep for `useGlobalSearch` / the search groups in `app/`). Add two result groups — **Sessions** (title + project + snippet → `to`) and **Messages** (role + snippet → `to`, deep-linking to the parent session) — mirroring the existing document/memory group rendering. Nuxt UI v4 + semantic tokens; consult `nuxt-ui-docs` if adjusting components.

- [ ] **Step 3: typecheck + build + test + commit**
```bash
git add server/services/search.ts server/api/search.get.ts app/  # the palette component
git commit -m "feat(search): sessions + messages in the command palette"
```

---

## Task 6: Gates + E2E

- [ ] **Step 1: static gates** — typecheck 0, test all pass, build OK.
- [ ] **Step 2: summarize a batch** (dev server). Trigger `summarize-sessions` (`POST /_nitro/tasks/summarize-sessions` or wait for the schedule) → confirm several imported sessions get a `title`+`summary` (no longer "(untitled)") in `/sessions`, and `sess_summary_state` rows appear. Verify title-preservation: a session with an existing manual title isn't clobbered by an empty model title.
- [ ] **Step 3: embed a batch** — trigger `embed-messages` once → `messages.embedding` populated for a batch (`select count(*) where embedding is not null`).
- [ ] **Step 4: search** — in the palette, search a term known to be in an imported session's summary → the **Sessions** group returns it; search a phrase from a message → the **Messages** group returns it and links to the parent session. Confirm semantic (vector) hits work after embedding (a paraphrase finds the message).
- [ ] **Step 5: final review** — dispatch a reviewer over the phase diff: the raw-SQL selector row-shape handling, the HNSW/trigram index SQL in 0017, searchAll lane wiring + `SearchResults` shape, palette rendering, scheduled-task registration (existing tasks intact).

---

## Done criteria
- Imported sessions get titles + summaries (no more "(untitled)"); `summary_embedding` populated; `sess_summary_state` tracks runs.
- `messages.embedding` backfills via the scheduler; sessions + messages are searchable (trigram now, semantic as embeddings fill) from the command palette, message hits deep-link to their session.
- All gates green; E2E verified on the imported corpus.
- **Next:** Phase 5 (enrichment + memory intelligence — incl. the deferred enrichment sweep over the imported sessions).
