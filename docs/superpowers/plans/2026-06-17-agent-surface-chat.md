# Unified Agent Surface (`/agent`) + Conversation Persistence + Bridget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `/voice` into one `/agent` surface where talking and typing are the same persisted conversation, resumable + searchable, driven by a profile-aware shared agent core, with a real (editable, context-aware, time-of-day) Bridget personality — all on the current safe 15-tool surface.

**Architecture:** Both modalities already run through `runAgent` via `orchestrator.handleTurn`. We generalize `runAgent`'s context to `{ signal, speak, profile, context }` (the `speak` flag is the *sole* convergence branch: it both gates TTS and selects prompt mode), persist every turn into a new modality-agnostic `conversations`/`conversation_messages` store (tree-capable `parent_id`, populated linearly), and rebuild the page around the existing voice components with a canvas toggle, a "respond in voice" toggle, and a history slideover. The text SSE endpoint is retained headless-only.

**Tech Stack:** Nuxt 4 / Nitro / Drizzle-pg (pgvector/`halfvec`) / crossws WebSocket / Vercel AI SDK v6 / @tanstack/vue-query / Nuxt UI v4 / Three.js visualizer. Tests: vitest (pure-unit only — the repo has **no DB harness**; DB/integration behavior is validated by `playwright-cli` E2E).

**Spec:** `docs/superpowers/specs/2026-06-17-agent-surface-chat-design.md`.

## Global Constraints

- **Minimal divergence (hard rule):** the UI must NOT fork voice vs. text beyond the single `speak` branch inside `handleTurn`. No second agent code path/composable for the UI — both go through the voice WS + orchestrator + `runAgent`. The SSE `POST /api/agent/chat` is **kept only as a headless/programmatic API** (do not wire it into the page). Every task is reviewed against this.
- **Branching = schema only:** add a nullable `parent_id` self-FK to `conversation_messages`, populate it **linearly** (parent = prior turn), read flat (`ORDER BY created_at`). Do **not** build `active_leaf_id`, path-walking, or fork UI this cycle.
- **Live context assembled once per connection:** the live-state block (active projects + open tasks) is built once and cached on the WS `ConnState`, refreshed on a `new` frame — never rebuilt per turn.
- **Live-data convention:** every mutation calls `publishChange({ resource, action, id })` after commit (`server/utils/live-bus.ts`); reads use `@tanstack/vue-query` (reactive key in a `computed`; `data` is read-only). Add `'conversation'` to the `ResourceName` union (`shared/types/live.ts`) — the dispatch default (invalidate `[resource,id]` + `[resource,'list']`) covers it; no override needed.
- **Nuxt UI v4 + semantic tokens only** (no raw Tailwind palette classes like `text-gray-*`). Invoke `nuxt-ui-docs` before unfamiliar v4 component APIs and `nuxt-ui-templates` for chat/settings layout patterns.
- **Validate UI with `playwright-cli`, NOT the Playwright MCP** — invoke the `browser-testing` skill (dev creds, reka-ui real-click rule, authed fetch fixture).
- **Reuse unchanged:** `runAgent` start-only failover, undo tokens (`useAgentActivity`), `withSpan`/`recordEvent` observability, the 15-tool registry. Do not re-architect them.
- **Gates:** `pnpm typecheck` → 0 errors; `pnpm test` → green (currently ~393); `pnpm build`; `pnpm db:migrate` for the new migration. Lint is **not** a gate.

## File Structure

**Server**
- `server/db/schema/conversations.ts` — **new**: `conversations` + `conversation_messages` tables (T1).
- `server/db/schema/index.ts` — export the new schema (T1).
- `shared/types/conversation.ts` — **new**: DTOs (T1).
- `server/db/migrations/****_*.sql` — **generated** by `pnpm db:generate` (T1).
- `server/services/conversations.ts` — **new**: the store (create / append-linear / get / list+search / delete / `deriveTitle`) (T2).
- `server/lib/agent/profile.ts` — **new**: `AgentProfile` + `bridgetProfile` (T4).
- `server/lib/agent/persona.ts` — **new**: cached persona load/save (settings key `agent_persona`) + default (T3).
- `server/lib/agent/context.ts` — **new**: `buildLiveContext(now)` (T3).
- `server/lib/agent/prompt.ts` — **modify**: pure `composePrompt` + `timeOfDayTone`; async `buildSystemPrompt` (T3).
- `server/lib/agent/run.ts` — **modify**: `ctx` → `{ signal, speak?, profile?, context? }`; injectable `deps.buildSystemPrompt`; use `profile.tools` (T4).
- `server/api/agent/chat.post.ts` — **modify**: `voice:false` → `speak:false` (T4).
- `server/lib/voice/orchestrator.ts` — **modify**: `speak` + `context` in `TurnDeps`; `typing` state; gate TTS on `speak` (T4).
- `server/api/voice/ws.ts` — **modify**: new frames (`text{speak}`, `load`, `new`), per-connection context, turn persistence (T5).
- `shared/types/live.ts` — **modify**: `+ 'conversation'` (T5).
- `server/api/conversations/index.get.ts`, `[id].get.ts`, `[id].delete.ts` — **new** (T6).
- `server/api/settings/persona.get.ts`, `persona.put.ts` — **new** (T10).

**Client**
- `app/lib/viz/types.ts`, `tuning.ts`, `choreographer.ts` — **modify**: add `typing` VizState + knobs (T7).
- `app/lib/voice/messages.ts` — **modify**: map `state:'typing'` (T7).
- `app/composables/useVoice.ts` — **modify**: decouple WS connect from mic; `sendText(text, speak)`; `loadConversation`/`newConversation`; `typing` state (T7).
- `app/composables/useConversations.ts` — **new** (T6).
- `app/pages/agent.vue` — **new** (built from `voice.vue`) + `nuxt.config` route redirect; delete `app/pages/voice.vue` (T8).
- `app/components/agent/HistorySlideover.vue` — **new** (T8).
- `app/components/voice/Composer.vue` — **modify**: pass the `speak` toggle through (T8).
- `app/pages/agent/history.vue` — **new** (T9).
- `app/pages/settings.vue` (+ `app/components/settings/PersonaTab.vue`) — **modify/new**: Bridget tab (T10).

**Docs (T11):** `docs/wiki/agent.md` (new), handover, roadmap row, BACKLOG ticks.

---

## Task 1: Conversation schema + migration + DTOs

**Files:**
- Create: `server/db/schema/conversations.ts`
- Modify: `server/db/schema/index.ts`
- Create: `shared/types/conversation.ts`
- Generated: a new migration under `server/db/migrations/`

**Interfaces — Produces:**
- Drizzle tables `conversations`, `conversationMessages` + inferred `Conversation`, `ConversationMessage`.
- `ConversationDTO`, `ConversationMessageDTO`, `ConversationListItem` types.

- [ ] **Step 1:** Create `server/db/schema/conversations.ts`:

```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { halfvec } from '../types/halfvec'

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  title: text('title'),
  summary: text('summary'),
  projectId: uuid('project_id'),
  messageCount: integer('message_count').notNull().default(0),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  // Reserved for a future summarization worker (keyword search ships first).
  summaryEmbedding: halfvec(2560, 'summary_embedding'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('conversations_last_message_idx').on(t.lastMessageAt),
  // keyword search over titles (pg_trgm already enabled in this DB)
  index('conversations_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`)
])

export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  // Tree-capable edge; populated LINEARLY this cycle (parent = prior turn). Branching
  // (active-leaf/path-walking + fork UI) is deferred — see the spec.
  parentId: uuid('parent_id'),
  role: text('role').notNull(),                 // 'user' | 'assistant'
  content: text('content').notNull().default(''),
  modality: text('modality').notNull(),         // 'voice' | 'text'
  toolCalls: jsonb('tool_calls'),               // [{ name, summary, undoToken? }] for assistant turns
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index('conversation_messages_convo_idx').on(t.conversationId, t.createdAt),
  index('conversation_messages_content_trgm').using('gin', sql`${t.content} gin_trgm_ops`)
])

export type Conversation = typeof conversations.$inferSelect
export type ConversationMessage = typeof conversationMessages.$inferSelect
```

- [ ] **Step 2:** Add `export * from './conversations'` to `server/db/schema/index.ts` (after the `./sessions`/`./messages` lines).

- [ ] **Step 3:** Create `shared/types/conversation.ts`:

```ts
export interface ConversationMessageDTO {
  id: string
  role: 'user' | 'assistant'
  content: string
  modality: 'voice' | 'text'
  toolCalls: { name: string; summary: string; undoToken?: string }[] | null
  createdAt: string
}
export interface ConversationDTO {
  id: string
  title: string | null
  projectId: string | null
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
}
export interface ConversationListItem extends ConversationDTO {
  snippet: string | null   // first/last message preview for the list/slideover
}
```

- [ ] **Step 4:** Generate + apply the migration. The `gin_trgm_ops` indexes need `pg_trgm` (already enabled — other tables use it). Run:

```bash
pnpm db:generate    # writes a new server/db/migrations/****_*.sql
pnpm db:migrate      # applies it locally
pnpm typecheck
```
Expected: migration file created (tables + indexes), `db:migrate` succeeds, typecheck 0. If `db:generate` does not emit the trigram `gin` indexes (drizzle sometimes can't express `gin_trgm_ops`), hand-add them to the generated SQL: `CREATE INDEX "conversations_title_trgm" ON "conversations" USING gin ("title" gin_trgm_ops);` and the equivalent for `conversation_messages.content`.

- [ ] **Step 5:** Commit:
```bash
git add server/db/schema/conversations.ts server/db/schema/index.ts shared/types/conversation.ts server/db/migrations
git commit -m "feat(agent): conversation store schema + migration + DTOs"
```

---

## Task 2: Conversation store service

**Files:**
- Create: `server/services/conversations.ts`
- Test: `test/conversations.test.ts`

**Interfaces:**
- Consumes: `useDb` (`server/db`), schema `conversations`/`conversationMessages` (T1), DTO types (T1).
- Produces:
  - `deriveTitle(text: string): string` — pure.
  - `createConversation(input?: { title?: string | null; projectId?: string | null }): Promise<ConversationDTO>`
  - `appendMessages(conversationId: string, msgs: NewConvMessage[]): Promise<void>` where `NewConvMessage = { role: 'user'|'assistant'; content: string; modality: 'voice'|'text'; toolCalls?: { name:string; summary:string; undoToken?:string }[] | null }`. Sets `parentId` linearly (= the last existing message's id, then chains within the batch), bumps `messageCount` + `lastMessageAt`.
  - `getConversation(id: string): Promise<{ conversation: ConversationDTO; messages: ConversationMessageDTO[] } | null>`
  - `getAgentHistory(id: string): Promise<{ role:'user'|'assistant'; content:string }[]>` — role+content only, ordered, for WS history hydration.
  - `listConversations(opts?: { q?: string }): Promise<ConversationListItem[]>` — newest first by `lastMessageAt`, limit 50; when `q` set, filter title ILIKE OR exists a message content ILIKE.
  - `deleteConversation(id: string): Promise<void>` — cascade deletes messages.

- [ ] **Step 1 (RED):** `test/conversations.test.ts` — pure `deriveTitle` only (DB methods are E2E-validated):
```ts
import { describe, it, expect } from 'vitest'
import { deriveTitle } from '../server/services/conversations'

describe('deriveTitle', () => {
  it('trims + collapses whitespace and caps length', () => {
    expect(deriveTitle('  hey   Bridget\n what is up ')).toBe('hey Bridget what is up')
    expect(deriveTitle('x'.repeat(80))).toHaveLength(60)
    expect(deriveTitle('x'.repeat(80)).endsWith('…')).toBe(true)
  })
  it('falls back for empty input', () => {
    expect(deriveTitle('')).toBe('New conversation')
    expect(deriveTitle('   ')).toBe('New conversation')
  })
})
```
Run: `pnpm vitest run test/conversations.test.ts` → FAIL (module/export missing).

- [ ] **Step 2 (GREEN):** Implement `server/services/conversations.ts`. `deriveTitle`:
```ts
export function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return 'New conversation'
  return t.length <= 60 ? t : t.slice(0, 59).trimEnd() + '…'
}
```
The DB methods use `useDb()` and the schema. `appendMessages` reads the current last message id (`select id from conversation_messages where conversation_id=? order by created_at desc limit 1`), then inserts each msg in order with `parentId` chaining (first parent = that last id, subsequent parent = previous inserted id), and updates the conversation (`messageCount = messageCount + n`, `lastMessageAt = now`, `updatedAt = now`). `listConversations` with `q`: `where title ilike '%q%' or id in (select conversation_id from conversation_messages where content ilike '%q%')`, order by `lastMessageAt desc nulls last` limit 50; map rows to DTOs (timestamps `.toISOString()`), compute `snippet` from the conversation's first user message (a small extra select, or left `null` in v1 — `null` is acceptable). Run the test → PASS.

- [ ] **Step 3:** `pnpm typecheck` (0) + `pnpm vitest run test/conversations.test.ts` (PASS). Commit:
```bash
git add server/services/conversations.ts test/conversations.test.ts
git commit -m "feat(agent): conversation store service (linear parent chain) + deriveTitle"
```

---

## Task 3: Prompt composition + persona store + live context

**Files:**
- Modify: `server/lib/agent/prompt.ts`
- Create: `server/lib/agent/persona.ts`
- Create: `server/lib/agent/context.ts`
- Test: `test/agent-prompt.test.ts`

**Interfaces:**
- Consumes: `settings` schema + `useDb`; `projects`/`tasks` schema; `AgentProfile` (forward-declared — T4 creates `profile.ts`; this task's `buildSystemPrompt` takes `profile?` typed as `{ personaKey: string }` to avoid a cycle, or imports the type once T4 lands — implement T4 first if the worker prefers, the two are adjacent).
- Produces:
  - `timeOfDayTone(now: Date): string` — pure.
  - `composePrompt(opts: { persona: string; speak: boolean; toneLine: string; context?: string }): string` — pure.
  - `buildSystemPrompt(opts: { profile?: { personaKey: string }; speak: boolean; context?: string; now?: Date }): Promise<string>` — async (loads persona).
  - `loadPersona()/savePersona(text)/invalidatePersona()` + `DEFAULT_PERSONA` (persona.ts).
  - `buildLiveContext(now: Date): Promise<string>` (context.ts).

- [ ] **Step 1 (RED):** `test/agent-prompt.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { composePrompt, timeOfDayTone } from '../server/lib/agent/prompt'

describe('timeOfDayTone', () => {
  it('buckets by hour', () => {
    expect(timeOfDayTone(new Date('2026-06-17T08:00:00'))).toMatch(/morning/i)
    expect(timeOfDayTone(new Date('2026-06-17T14:00:00'))).toMatch(/afternoon/i)
    expect(timeOfDayTone(new Date('2026-06-17T19:00:00'))).toMatch(/evening/i)
    expect(timeOfDayTone(new Date('2026-06-17T02:00:00'))).toMatch(/late|night/i)
  })
})
describe('composePrompt', () => {
  const base = { persona: 'You are Bridget.', toneLine: 'It is morning.' }
  it('speak mode forbids markdown + adds the filler rule', () => {
    const p = composePrompt({ ...base, speak: true })
    expect(p).toContain('You are Bridget.')
    expect(p).toContain('It is morning.')
    expect(p).toMatch(/no markdown/i)
    expect(p).toMatch(/filler/i)
  })
  it('text mode allows markdown + omits the filler rule', () => {
    const p = composePrompt({ ...base, speak: false })
    expect(p).toMatch(/markdown/i)
    expect(p).not.toMatch(/filler/i)
  })
  it('appends the context block when present', () => {
    expect(composePrompt({ ...base, speak: false, context: 'Active projects: mymind.' })).toContain('Active projects: mymind.')
  })
})
```
Run → FAIL.

- [ ] **Step 2 (GREEN):** Rewrite `server/lib/agent/prompt.ts` (keep the file's existing behaviour rules, parameterize on `speak`):
```ts
import { loadPersona } from './persona'

export function timeOfDayTone(now: Date): string {
  const h = now.getHours()
  if (h >= 5 && h < 12) return 'It is morning — be crisp and help Tony line up his day.'
  if (h >= 12 && h < 17) return 'It is afternoon — stay focused and momentum-oriented.'
  if (h >= 17 && h < 22) return 'It is evening — a lighter, winding-down tone is fine.'
  return 'It is late at night — stay calm and concise; gently flag anything that can wait.'
}

export function composePrompt(opts: { persona: string; speak: boolean; toneLine: string; context?: string }): string {
  const { persona, speak, toneLine, context } = opts
  const lines = [persona, '', toneLine, '']
  if (speak) {
    lines.push(
      'You speak out loud, so keep replies short and conversational. No markdown — lists may not read right.',
      'Keep exclamation to a minimum (voice transcription).'
    )
  } else {
    lines.push('You are in a text chat. You may use concise markdown (short lists, code blocks) when it helps.')
  }
  lines.push(
    '',
    "You can act on Tony's data with tools: search/save memories, search docs, list/create/edit projects and tasks, and capture quick notes.",
    '',
    'Behaviour rules:'
  )
  if (speak) lines.push("- When you need a tool, FIRST say a brief natural filler ('let me check…', 'one sec…') so Tony hears you immediately, THEN call the tool.")
  lines.push(
    '- For creating things (tasks, notes, memories, projects), just do it and tell Tony what you did in one short sentence.',
    '- Before ANY change that edits or deletes existing data (edit_task, edit_project), CONFIRM with Tony first and only act after he says yes.',
    "- After acting, state the result briefly (don't surface raw IDs).",
    '- If a search returns nothing, say so plainly and suggest a next step.'
  )
  if (context) lines.push('', context)
  return lines.join('\n')
}

export async function buildSystemPrompt(opts: { profile?: { personaKey: string }; speak: boolean; context?: string; now?: Date }): Promise<string> {
  const persona = await loadPersona() // single persona this cycle; profile.personaKey reserved for Cycle B
  return composePrompt({ persona, speak: opts.speak, toneLine: timeOfDayTone(opts.now ?? new Date()), context: opts.context })
}
```

- [ ] **Step 3 (GREEN):** Create `server/lib/agent/persona.ts` (mirror `server/lib/ai/registry/store.ts`):
```ts
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

const KEY = 'agent_persona'
let cache: string | null = null

export const DEFAULT_PERSONA = [
  "You are Bridget — Tony's personal assistant and digital partner, not a generic chatbot.",
  'You know Tony well, talk to him like a sharp colleague who has earned candour, and address him by name when it lands naturally.',
  'Take initiative: when the next step is obvious, do it and say so — don\'t ask permission for safe, reversible actions.',
  'Have a spine: if Tony is about to do something you think is wrong, say so directly and explain why. Push back rather than just agreeing — he prefers honest disagreement to flattery.',
  'Be concise and specific. Skip filler and hedging. Warmth is welcome; sycophancy is not.'
].join('\n')

export async function loadPersona(): Promise<string> {
  if (cache !== null) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  const v = row?.value as { text?: unknown } | undefined
  cache = typeof v?.text === 'string' && v.text.trim() ? v.text : DEFAULT_PERSONA
  return cache
}
export async function savePersona(text: string): Promise<void> {
  const db = useDb()
  await db.insert(settings).values({ key: KEY, value: { text }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: { text }, updatedAt: new Date() } })
  cache = text
}
export function invalidatePersona(): void { cache = null }
```

- [ ] **Step 4 (GREEN):** Create `server/lib/agent/context.ts`:
```ts
import { desc, eq, inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { projects, tasks } from '../../db/schema'

/** Cheap live-state block injected into Bridget's prompt; assembled once per connection. */
export async function buildLiveContext(now: Date): Promise<string> {
  const db = useDb()
  const [activeProjects, openTasks] = await Promise.all([
    db.select({ name: projects.name }).from(projects).where(eq(projects.active, true)).orderBy(desc(projects.lastActivityAt)).limit(12),
    db.select({ title: tasks.title, project: tasks.project, status: tasks.status }).from(tasks).where(inArray(tasks.status, ['todo', 'in_progress'])).orderBy(desc(tasks.updatedAt)).limit(10)
  ])
  const lines: string[] = []
  if (activeProjects.length) lines.push(`Active projects: ${activeProjects.map(p => p.name).join(', ')}.`)
  if (openTasks.length) lines.push('Open tasks:', ...openTasks.map(t => `- ${t.title}${t.project ? ` (${t.project})` : ''} [${t.status}]`))
  if (!lines.length) return ''
  return [`Current context (as of ${now.toISOString().slice(0, 10)}):`, ...lines].join('\n')
}
```
(If the `tasks` table lacks an `updatedAt` column, order by `createdAt` instead — verify against `server/db/schema/tasks.ts`.)

- [ ] **Step 5:** `pnpm typecheck` (0) + `pnpm vitest run test/agent-prompt.test.ts` (PASS). Commit:
```bash
git add server/lib/agent/prompt.ts server/lib/agent/persona.ts server/lib/agent/context.ts test/agent-prompt.test.ts
git commit -m "feat(agent): editable + time-of-day + context-aware Bridget prompt composition"
```

---

## Task 4: Profile + `runAgent` refactor + call-site updates

**Files:**
- Create: `server/lib/agent/profile.ts`
- Modify: `server/lib/agent/run.ts`
- Modify: `server/api/agent/chat.post.ts`
- Modify: `server/lib/voice/orchestrator.ts`
- Test: `test/agent-run.test.ts` (existing — keep green; inject `deps.buildSystemPrompt`)

**Interfaces:**
- Consumes: `buildSystemPrompt` (T3), `agentTools` (`server/lib/agent/tools.ts`).
- Produces:
  - `AgentProfile = { id: string; tools: AgentTool[]; personaKey: string }`; `bridgetProfile`.
  - `runAgent(messages, ctx: { signal: AbortSignal; speak?: boolean; profile?: AgentProfile; context?: string }, deps?)` — `RunDeps` gains `buildSystemPrompt?: (o: { profile?: { personaKey: string }; speak: boolean; context?: string }) => Promise<string>`.
  - `handleTurn`/`handleUtterance` `TurnDeps` gains `speak: boolean` + `context?: string`; orchestrator emits `state: 'typing'`.

- [ ] **Step 1:** Create `server/lib/agent/profile.ts`:
```ts
import { agentTools } from './tools'
import type { AgentTool } from './types'

export interface AgentProfile { id: string; tools: AgentTool[]; personaKey: string }

// The only profile this cycle. The shape is the seam for Cycle B (powerful tools).
export const bridgetProfile: AgentProfile = { id: 'bridget', tools: agentTools, personaKey: 'agent_persona' }
```

- [ ] **Step 2:** Edit `server/lib/agent/run.ts`:
  - Import `bridgetProfile`, `type AgentProfile`, and `buildSystemPrompt as realBuildSystemPrompt`.
  - Change the signature to `ctx: { signal: AbortSignal; speak?: boolean; profile?: AgentProfile; context?: string }`.
  - `RunDeps` gains `buildSystemPrompt?`.
  - At the top: `const profile = ctx.profile ?? bridgetProfile`; `const registry = deps.tools ?? profile.tools`; `const buildPrompt = deps.buildSystemPrompt ?? realBuildSystemPrompt`.
  - Compute the system prompt ONCE before the model loop: `const system = await buildPrompt({ profile, speak: ctx.speak ?? false, context: ctx.context })`.
  - In the `streamTextFn({ ... })` call, replace `system: buildSystemPrompt(ctx.voice ?? false)` with `system`.
  - Remove the old `voice` field from the ctx type.

- [ ] **Step 3:** Keep `test/agent-run.test.ts` green. The existing tests pass `deps.streamText` + `deps.tools`; now also pass `deps.buildSystemPrompt: async () => 'test-system'` so the loop never touches the DB-backed persona. Update any test that constructed `ctx: { signal, voice: ... }` to `ctx: { signal, speak: ... }`. Run `pnpm vitest run test/agent-run.test.ts` → PASS.

- [ ] **Step 4:** Update the SSE endpoint `server/api/agent/chat.post.ts`: change `runAgent(messages, { signal: ac.signal, voice: false })` → `runAgent(messages, { signal: ac.signal, speak: false })`. (Headless API — unchanged otherwise.)

- [ ] **Step 5:** Update `server/lib/voice/orchestrator.ts`:
  - `VoiceEvent` state union: add `'typing'` → `{ type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }`.
  - `TurnDeps`: add `speak: boolean` and `context?: string`; the optional `runAgent` dep signature becomes `(m, c: { signal: AbortSignal; speak?: boolean; context?: string }) => AsyncGenerator<AgentEvent>`.
  - In `handleTurn`, call `run(messages, { signal: deps.signal, speak: deps.speak, context: deps.context })`.
  - Gate TTS on `speak`: only push to the chunker / call `speak()` when `deps.speak`; otherwise emit `{ type: 'state', state: 'typing' }` on the first text delta. Replace the trailing `for (const chunk of chunker.flush())` with `if (deps.speak) for (...) await speak(...)`. The final `idle` emit stays.
  - `handleUtterance` passes `speak` through (callers set it).

- [ ] **Step 6:** Grep for any other `runAgent(` callers and the old `voice:` ctx (e.g. cron): `rg "runAgent\(" server` and `rg "voice:\s*(true|false)" server/lib server/api`. Update each to `speak`. Run `pnpm typecheck` → 0.

- [ ] **Step 7:** Commit:
```bash
git add server/lib/agent/profile.ts server/lib/agent/run.ts server/api/agent/chat.post.ts server/lib/voice/orchestrator.ts test/agent-run.test.ts
git commit -m "feat(agent): profile-aware runAgent; speak flag is the sole voice/text branch"
```

---

## Task 5: WS protocol + per-connection context + turn persistence

**Files:**
- Modify: `server/api/voice/ws.ts`
- Modify: `shared/types/live.ts` (`+ 'conversation'`)
- Test: none new (WS + DB is E2E-validated).

**Interfaces:**
- Consumes: `createConversation`, `appendMessages`, `getAgentHistory`, `deriveTitle` (T2); `buildLiveContext` (T3); `publishChange` (`server/utils/live-bus.ts`); orchestrator `handleTurn`/`handleUtterance` with `speak`+`context` (T4).
- Produces: WS frames `{type:'text', text, speak?}`, `{type:'load', conversationId}`, `{type:'new'}`; persisted conversations.

- [ ] **Step 1:** Add `'conversation'` to the `ResourceName` union in `shared/types/live.ts` (after `'apiToken'`). The dispatch default covers it; no `live-dispatch.ts` change needed.

- [ ] **Step 2:** Edit `server/api/voice/ws.ts`:
  - `ConnState`: add `conversationId: string | null`, `context: string | null`. Initialize both `null` in `open`.
  - **`load` frame:** `if (msg.type === 'load' && typeof msg.conversationId === 'string') { s.lock = s.lock.then(async () => { s.history = await getAgentHistory(msg.conversationId as string); s.conversationId = msg.conversationId as string; s.context = null }); return }`.
  - **`new` frame:** `if (msg.type === 'new') { s.history = []; s.conversationId = null; s.context = null; return }`.
  - **`text` frame:** parse optional `speak` (default `false`); build the turn with `speak` + `context` + capture `inputModality = 'text'` and `speakFlag = speak`.
  - **audio (utterance):** `inputModality = 'voice'`, `speakFlag = true`.
  - The turn deps now include `speak: speakFlag` and `context: s.context` (pass to `handleTurn`/`handleUtterance`).

- [ ] **Step 3:** Wrap the `run()` body to assemble context lazily + persist after the turn:
```ts
const run = async () => {
  try {
    if (!s.context) s.context = await buildLiveContext(new Date())
    const toolCalls: { name: string; summary: string; undoToken?: string }[] = []
    const prevLen = s.history.length
    const emit = (e: VoiceEvent) => {
      if (e.type === 'audio') peer.send(e.bytes)
      else { if (e.type === 'tool') toolCalls.push({ name: e.name, summary: e.summary, undoToken: e.undoToken }); peer.send(JSON.stringify(e)) }
    }
    s.history = await exec(ac.signal, emit)               // exec built with speak+context
    const added = s.history.slice(prevLen)                // [user] or [user, assistant]
    if (added.length && !ac.signal.aborted) {
      const created = prevLen === 0 && !s.conversationId
      if (!s.conversationId) s.conversationId = (await createConversation({ title: deriveTitle(added[0]!.content) })).id
      await appendMessages(s.conversationId, added.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        modality: m.role === 'user' ? inputModality : (speakFlag ? 'voice' : 'text'),
        toolCalls: m.role === 'assistant' && toolCalls.length ? toolCalls : null
      })))
      publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: s.conversationId })
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    console.error('[agent] turn failed:', err)
    peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'agent pipeline error' }))
    peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
  }
}
```
`inputModality` and `speakFlag` are captured in the closure where the turn is classified (Step 2). Keep the existing `s.lock = s.lock.then(run, run)` serialization.

- [ ] **Step 4:** `pnpm typecheck` → 0. Commit:
```bash
git add server/api/voice/ws.ts shared/types/live.ts
git commit -m "feat(agent): WS load/new/text-speak frames + per-connection context + turn persistence"
```

---

## Task 6: Conversation HTTP endpoints + composable

**Files:**
- Create: `server/api/conversations/index.get.ts`, `server/api/conversations/[id].get.ts`, `server/api/conversations/[id].delete.ts`
- Create: `app/composables/useConversations.ts`
- Test: none new (covered by E2E).

**Interfaces:**
- Consumes: `listConversations`, `getConversation`, `deleteConversation` (T2); `publishChange`.
- Produces:
  - `GET /api/conversations?q=` → `ConversationListItem[]`
  - `GET /api/conversations/[id]` → `{ conversation: ConversationDTO; messages: ConversationMessageDTO[] }` (404 if missing)
  - `DELETE /api/conversations/[id]` → `{ ok: true }` + `publishChange({resource:'conversation',action:'deleted',id})`
  - `useConversations()` → `{ useConversationList(params), useConversation(id), getConversation(id), remove(id) }`

- [ ] **Step 1:** Endpoints (session-authed via middleware, like other `server/api/**`):
  - `index.get.ts`: `const q = getQuery(event).q as string | undefined; return listConversations({ q: q?.trim() || undefined })`.
  - `[id].get.ts`: `const r = await getConversation(getRouterParam(event,'id')!); if (!r) throw createError({ statusCode: 404 }); return r`.
  - `[id].delete.ts`: `const id = getRouterParam(event,'id')!; await deleteConversation(id); publishChange({ resource:'conversation', action:'deleted', id }); return { ok: true }`.

- [ ] **Step 2:** `app/composables/useConversations.ts` (mirror `useSessions.ts`):
```ts
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { ConversationListItem, ConversationDTO, ConversationMessageDTO } from '~~/shared/types/conversation'

export function useConversations() {
  const list = (params?: { q?: string }) => $fetch<ConversationListItem[]>('/api/conversations', { query: params })
  const getConversation = (id: string) => $fetch<{ conversation: ConversationDTO; messages: ConversationMessageDTO[] }>(`/api/conversations/${id}`)
  const remove = (id: string) => $fetch(`/api/conversations/${id}`, { method: 'DELETE' })

  const useConversationList = (params?: MaybeRefOrGetter<{ q?: string } | undefined>) => {
    const key = computed(() => toValue(params))
    return useQuery({
      queryKey: computed(() => ['conversation', 'list', key.value] as const),
      queryFn: () => list(key.value)
    })
  }
  const useConversation = (id: MaybeRefOrGetter<string | undefined>) => {
    const key = computed(() => toValue(id))
    return useQuery({
      queryKey: computed(() => ['conversation', key.value] as const),
      queryFn: () => getConversation(key.value as string),
      enabled: computed(() => !!key.value)
    })
  }
  return { list, getConversation, remove, useConversationList, useConversation }
}
```

- [ ] **Step 3:** `pnpm typecheck` → 0. Commit:
```bash
git add server/api/conversations app/composables/useConversations.ts
git commit -m "feat(agent): conversation list/detail/delete endpoints + useConversations"
```

---

## Task 7: Client transport refactor + `typing` visualizer state

**Files:**
- Modify: `app/lib/viz/types.ts`, `app/lib/viz/tuning.ts`, `app/lib/viz/choreographer.ts`
- Modify: `app/lib/voice/messages.ts`
- Modify: `app/composables/useVoice.ts`
- Test: extend `test/voice-messages.test.ts` (if present) / `test/choreographer.test.ts` for the `typing` state.

**Interfaces — Produces:**
- `VizState` + `VoiceState` include `'typing'`.
- `useVoice()` adds: `connect()` (WS only, no mic), `enableMic()`/`disableMic()`, `sendText(text, speak)`, `loadConversation(id)`, `newConversation()`. `start()` becomes `connect()` + optional `enableMic()`.

- [ ] **Step 1 (RED):** In `test/choreographer.test.ts` (the existing 14-test file), add a case: feeding `state:'typing'` produces a `vizState:'typing'` directive without error (and `dim` near 0, `firing` > 0 but < the `thinking` value). In `test/voice-messages.test.ts` (if present), assert `mapServerMessage({type:'state',state:'typing'}, false)` → `{ state:'typing', events: [] }`. Run → FAIL.

- [ ] **Step 2 (GREEN — viz):**
  - `app/lib/viz/types.ts`: add `'typing'` to the `VizState` union.
  - `app/lib/viz/tuning.ts`: add a `PALETTE.typing` entry (reuse the `speaking` colors, or a distinct calm cyan — semantic only matters for the canvas, raw RGB is fine here). Add `typing` to any other `Record<VizState, …>` in tuning.
  - `app/lib/viz/choreographer.ts`: add `typing` to each `Record<VizState, number>` — `ENERGY.typing = 0.3`, `SWIRL.typing = 0`, `DIM.typing = 0`, `FIRING.typing = 0.5` (a steady "composing" glow, gentler than `thinking`'s `1`). TypeScript will force these (the records are exhaustive).
  - `app/lib/voice/messages.ts`: in `MsgEffect.state` add `'typing'`; in `mapServerMessage`, handle `if (m.state === 'typing') return { state: 'typing', events }`.

- [ ] **Step 3 (GREEN — useVoice transport):** Refactor `app/composables/useVoice.ts`:
  - `VoiceState` union: add `'typing'`.
  - Split `start()` (decouple mic): create `connect()` that builds the `AudioContext` (for playback) + opens the WS + sets up `onopen/onclose/onmessage/onerror` (everything except `startVad`). Create `enableMic()` that runs the current `startVad(...)` + `getUserMedia` path (guarded: requires `connected`). `disableMic()` destroys the VAD + releases `vizStream`. Keep `stop()`/`disconnect()` tearing down everything. Backwards-compatible `start()` = `await connect()` (mic stays OFF by default — text-first).
  - `sendText(text: string, speak = false)`: send `{ type: 'text', text, speak }`; keep the typed-barge-in stop-playback.
  - `loadConversation(id: string)`: send `{ type: 'load', conversationId: id }` (the page sets the transcript from the HTTP fetch — see T8).
  - `newConversation()`: send `{ type: 'new' }`; `transcript.value = []`.
  - Add `setTranscript(entries: TranscriptEntry[])` (or expose `transcript` writable — it already is) so the page can hydrate it on resume.
  - In `onmessage`, the binary branch sets `state.value = 'speaking'` — leave as is (audio only arrives when `speak`). Text turns get `state:'typing'` from the server via `mapServerMessage`.
  - Return the new functions.

- [ ] **Step 4:** `pnpm typecheck` (0) + `pnpm vitest run test/choreographer.test.ts test/voice-messages.test.ts` (PASS). Commit:
```bash
git add app/lib/viz app/lib/voice/messages.ts app/composables/useVoice.ts test/choreographer.test.ts test/voice-messages.test.ts
git commit -m "feat(agent): typing viz state + mic-decoupled WS transport (connect/enableMic/sendText/load/new)"
```

---

## Task 8: `/agent` page + history slideover + `/voice` redirect

**Files:**
- Create: `app/pages/agent.vue` (from `voice.vue`)
- Create: `app/components/agent/HistorySlideover.vue`
- Modify: `app/components/voice/Composer.vue` (speak toggle pass-through)
- Modify: `nuxt.config.ts` (route redirect)
- Delete: `app/pages/voice.vue`
- Test: none (.vue) — typecheck + build + E2E (T11).

**Interfaces — Consumes:** `useVoice()` (T7), `useConversations()` (T6), `useAgentActivity()`.

- [ ] **Step 1:** Create `app/pages/agent.vue` from `voice.vue` with these additions (Nuxt UI v4 + semantic tokens; invoke `nuxt-ui-docs` for `USwitch`/`USlideover`):
  - State: `const showCanvas = useCookie<boolean>('agent-canvas', { default: () => true })`, `const speakReply = useCookie<boolean>('agent-speak', { default: () => false })`, `const historyOpen = ref(false)`.
  - Header `#right`: a `USwitch` bound to `showCanvas` (label/icon "Visualizer"), a `USwitch` bound to `speakReply` ("Respond in voice"), a `UButton` ("History", `icon i-lucide-history`, `@click="historyOpen = true"`), a `UButton` ("New", `icon i-lucide-plus`, `@click="voice.newConversation()"`), plus the existing Connect/Disconnect + settings.
  - Connect button now calls `voice.connect()` (mic off). Add a mic toggle button (`i-lucide-mic`) that calls `voice.enableMic()`/`voice.disableMic()` and reflects mic-on state.
  - Canvas panel: `v-if="showCanvas"` around `<VoiceReactor>` (and make the canvas panel non-resizable / transcript full-width when hidden — wrap so the transcript `UDashboardPanel` is always shown and the canvas panel is conditional).
  - Composer: pass `:speak="speakReply"` so typed sends use it (Step 3).
  - `<AgentHistorySlideover v-model:open="historyOpen" @select="resume" />`.
  - `resume(id)`: `const { conversation, messages } = await useConversations().getConversation(id); voice.transcript.value = messages.map(m => ({ role: m.role, text: m.content })); voice.loadConversation(id); historyOpen = false`. Render tool chips from `messages[].toolCalls` if `VoiceTranscript` supports chips (optional polish — chips already come live via `useAgentActivity` for the active turn).
  - On mount: if `route.query.c` is a string, `await voice.connect(); resume(route.query.c)` (deep-link from the history page, T9).

- [ ] **Step 2:** `app/components/agent/HistorySlideover.vue`: a `USlideover` (`v-model:open`); body lists `useConversations().useConversationList()` data as clickable rows (title || 'New conversation', relative `lastMessageAt`); each row `@click="emit('select', c.id)"`. A `UButton` "Browse all →" → `navigateTo('/agent/history')`. Read-only list per the live-data rule (`computed(() => data.value ?? [])`).

- [ ] **Step 3:** `app/components/voice/Composer.vue`: add a `speak?: boolean` prop (default `false`); on submit call `props.sendText(text, props.speak)` (the parent passes `voice.sendText`, whose new signature is `(text, speak)`).

- [ ] **Step 4:** `nuxt.config.ts`: add `routeRules: { '/voice': { redirect: '/agent' } }` (merge into existing `routeRules`). Delete `app/pages/voice.vue`.

- [ ] **Step 5:** `pnpm typecheck` (0) + `pnpm build`. Commit:
```bash
git add app/pages/agent.vue app/components/agent/HistorySlideover.vue app/components/voice/Composer.vue nuxt.config.ts
git rm app/pages/voice.vue
git commit -m "feat(agent): unified /agent page (canvas + respond-in-voice toggles, history slideover); /voice redirects"
```

---

## Task 9: `/agent/history` browse + search page

**Files:**
- Create: `app/pages/agent/history.vue`
- Test: none (.vue) — E2E (T11).

**Interfaces — Consumes:** `useConversations().useConversationList({ q })`, `remove(id)`.

- [ ] **Step 1:** `app/pages/agent/history.vue` (Nuxt UI v4):
  - `definePageMeta({ title: 'Conversations' })`.
  - `const q = ref('')`; `const { data, error } = useConversations().useConversationList(() => ({ q: q.value.trim() || undefined }))` (reactive getter param → reactive key, per the live-data rule).
  - A `UInput` (search icon, `v-model="q"`, placeholder "Search conversations…").
  - A list of rows (title, relative `lastMessageAt`, `messageCount`); row click → `navigateTo('/agent?c=' + c.id)`; a per-row delete (`UButton` ghost `i-lucide-trash`) → `await useConversations().remove(c.id)` (the live event refreshes the list — do NOT hand-refetch).
  - Empty state when `data` is empty; surface `error` via a `UAlert`.

- [ ] **Step 2:** `pnpm typecheck` (0) + `pnpm build`. Commit:
```bash
git add app/pages/agent/history.vue
git commit -m "feat(agent): /agent/history browse + keyword search"
```

---

## Task 10: Bridget persona settings tab + endpoints

**Files:**
- Create: `server/api/settings/persona.get.ts`, `server/api/settings/persona.put.ts`
- Modify: `app/pages/settings.vue` (+ optional `app/components/settings/PersonaTab.vue`)
- Test: none new (E2E).

**Interfaces:**
- Consumes: `loadPersona`/`savePersona`/`invalidatePersona` + `DEFAULT_PERSONA` (T3).
- Produces: `GET /api/settings/persona` → `{ text: string }`; `PUT /api/settings/persona` `{ text }` → `{ text }`.

- [ ] **Step 1:** Endpoints:
  - `persona.get.ts`: `return { text: await loadPersona() }`.
  - `persona.put.ts`: `const { text } = await readBody<{ text?: string }>(event); if (typeof text !== 'string' || !text.trim()) throw createError({ statusCode: 400, message: 'persona text required' }); await savePersona(text.trim()); return { text: text.trim() }`. (`savePersona` already updates the module cache; no extra `invalidatePersona` needed.)

- [ ] **Step 2:** Add a **"Bridget"** tab to `app/pages/settings.vue` (the page already uses tabs — invoke `nuxt-ui-docs` for the v4 `UTabs` API and follow the existing tab pattern). The tab body (inline or `PersonaTab.vue`):
  - On mount, `const { text } = await $fetch('/api/settings/persona')`; bind to a `UTextarea` (`:rows="14"`, monospace optional).
  - A "Save" `UButton` → `await $fetch('/api/settings/persona', { method: 'PUT', body: { text } })`, success toast. A "Reset to default" link clears to refetch after a future default (optional — minimal: just Save).
  - Helper text: "This is Bridget's base personality, used by both voice and chat. Live context (date, projects, tasks) and time-of-day tone are added automatically."

- [ ] **Step 3:** `pnpm typecheck` (0) + `pnpm build`. Commit:
```bash
git add server/api/settings/persona.get.ts server/api/settings/persona.put.ts app/pages/settings.vue app/components/settings/PersonaTab.vue
git commit -m "feat(agent): editable Bridget persona — /settings tab + get/put endpoints"
```

---

## Task 11: E2E validation + docs (wiki, handover, roadmap, backlog)

**Files:**
- Create: `docs/wiki/agent.md`
- Create: `docs/handovers/2026-06-17-agent-surface-chat.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (add the cycle-28 row), `docs/BACKLOG.md` (tick cycle 14 / §5 chat UI), `CLAUDE.md`/wiki index if applicable.

- [ ] **Step 1 (E2E — invoke the `browser-testing` skill, use `playwright-cli`):** With `pnpm dev` running and logged in as the dev test account, on `/agent`:
  1. Click **Connect** (no mic prompt should appear). Type "create a task called e2e-agent-check in project mymind" → assistant streams a **text** reply, canvas shows the **typing** animation (not speaking), the task is created (confirm via an authed `fetch('/api/tasks?...')` or the tasks page).
  2. Reload `/agent`, open **History** → the conversation appears → click it → the transcript repopulates (resume).
  3. Toggle **Visualizer** off → the canvas hides, transcript goes full-width. Toggle **Respond in voice** on → send a message → audio plays (server emits audio frames).
  4. Go to `/agent/history` → search a word from the message → the conversation is found → row click deep-links back to `/agent?c=<id>` and resumes.
  5. `/settings → Bridget` → edit the persona, Save, reload → persists.
  6. Visit `/voice` → redirects to `/agent`.
  Capture screenshots; fix any wiring bugs (green gates won't catch these).

- [ ] **Step 2:** Write `docs/wiki/agent.md` — the living "how the agent surface works today" page: the convergence model (one WS, `speak` is the only branch), the conversation store schema, the WS frame protocol, the prompt composition (persona + tone + context), and the deferred items (branching, semantic search, capability tools = Cycle B). Add it to the wiki index if one exists.

- [ ] **Step 3:** Write the handover `docs/handovers/2026-06-17-agent-surface-chat.md` with accurate frontmatter (date, cycle: 28, status, branch `feat/agent-surface`, gates, what shipped, what's deferred). Add the **cycle 28** row to `00-roadmap.md` and tick the chat-UI item in `BACKLOG.md` §2/§5 (note the powerful-tools = Cycle B task `d1d7f0ab`).

- [ ] **Step 4:** Final gates: `pnpm typecheck` (0), `pnpm test` (green), `pnpm build`, `pnpm db:migrate` (clean). Commit:
```bash
git add docs
git commit -m "docs(agent): wiki page + handover + roadmap/backlog for cycle 28"
```

---

## Self-Review (author)

**Spec coverage:**
- §1 convergence / `speak` sole branch → T4 (orchestrator) + Global Constraints; SSE headless-only → T4 (endpoint untouched, not wired to UI). ✓
- §1 entry-point parameterization (`profile`, `speak`, `context`) → T4 (`profile.ts`, `runAgent`). ✓
- §2 mic decoupling → T7 (`connect`/`enableMic`). ✓
- §3 schema (modality-agnostic, tree-capable `parent_id` linear, indexes, reserved `summary_embedding`) → T1; store → T2. ✓
- §4 `/agent` page (canvas toggle, respond-in-voice, history slideover, redirect) → T8; markdown vs spoken transcript handled by `speak`/prompt (T3/T4). ✓
- §4 `/agent/history` keyword search → T2 (`listConversations q`) + T9. ✓
- §5 Bridget: rich base persona + editable + context-aware (once per connection) + time-of-day → T3 (compose/persona/context) + T5 (per-connection cache) + T10 (settings UI). ✓
- §6 live `conversation` resource + publish/vue-query → T5 (union + emit) + T6 (composable) + T8/T9 (reads). Resilience (TTS only on `speak`) → T4. ✓
- §7 tests: pure-unit (`deriveTitle`, `composePrompt`, `timeOfDayTone`, `typing` choreographer/map) + playwright E2E → T2/T3/T7/T11. ✓

**Deviations from spec (intentional, noted):** the spec listed a separate `{type:'mode', speak}` frame; this plan instead carries `speak` per `text` frame (less connection state, same UX — the "respond in voice" toggle just changes what the client sends). Audio turns are always `speak:true`.

**Type consistency:** `runAgent` ctx `{signal, speak?, profile?, context?}` (T4) ← `chat.post.ts` `speak:false` (T4) ← orchestrator `run(... {signal, speak, context})` (T4); `TurnDeps.speak/context` (T4) ← `ws.ts` turn deps (T5). `appendMessages(id, {role,content,modality,toolCalls})` (T2) ← `ws.ts` persistence (T5). `ConversationListItem`/`ConversationDTO`/`ConversationMessageDTO` (T1) ← endpoints (T6) ← `useConversations` (T6) ← page/history (T8/T9). `VizState` + `VoiceState` + `MsgEffect.state` all gain `'typing'` (T7) ← orchestrator `VoiceEvent` `'typing'` (T4). `buildSystemPrompt({profile?,speak,context?})` (T3) ← `runAgent` default + `deps.buildSystemPrompt` stub (T4).

**No-DB-harness:** all DB/WS/integration paths are E2E-validated (T11); vitest covers only pure functions.
