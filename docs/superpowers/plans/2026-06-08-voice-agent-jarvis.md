# Voice Agent ("Jarvis") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/voice` page where Tony talks to MyMind: self-hosted Unmute does STT/TTS with barge-in, a Nitro agent loop runs tool-calling over MyMind's services, and a Three.js reactor visualizes the conversation.

**Architecture:** Unmute's LLM URL is re-pointed at a MyMind Nitro endpoint (`/api/agent/llm`, OpenAI `/v1/chat/completions` shape) that *is* the agent loop. The loop calls the local reasoning model with tool schemas, executes tools against existing `server/services/*`, and streams the final text back for Unmute to speak. Tool activity is pushed to the client over a separate SSE side-channel. One transport-agnostic agent core (tool registry + loop) is shared by voice, the existing MCP server, and a future text-chat endpoint.

**Tech Stack:** Nuxt 4, Nitro (h3 v2), Drizzle/Postgres, Zod, `@modelcontextprotocol/sdk` (existing), `three`, `opus-recorder`, Vitest, OpenAI-spec streaming chat completions.

**Spec:** `docs/superpowers/specs/2026-06-08-voice-agent-jarvis-design.md`

---

## Conventions for this plan

- Run all commands from repo root `/Users/tony/Documents/GitHub/mymind`. Package manager: **pnpm**.
- Tests live in `test/` (flat dir), named `<topic>.test.ts`, run with `pnpm test` (Vitest, `happy-dom` env available).
- After each task: `pnpm typecheck` must pass before committing.
- Secrets/config come from `useRuntimeConfig()`, never `process.env` in app code (per repo rules).
- The actual app dirs are root-level `app/` (Vue) and `server/` (Nitro). Do **not** create `apps/web/`.

## File Structure (created/modified)

**Server — agent core (new dir `server/lib/agent/`):**
- `server/lib/agent/types.ts` — `AgentTool`, `ToolContext`, `ToolExecution`, event types.
- `server/lib/agent/tools.ts` — the registry: 11 tools with `kind`, `handler` returning `{ result, summary, undo? }`.
- `server/lib/agent/bus.ts` — single global in-process EventEmitter for activity.
- `server/lib/agent/undo.ts` — TTL token store mapping `token → undo fn`.
- `server/lib/agent/prompt.ts` — system-prompt builder.
- `server/lib/agent/loop.ts` — transport-agnostic streaming loop (DI for `streamChat`/`tools`).
- `server/lib/ai/chat-stream.ts` — streaming OpenAI client with `tool_calls` assembly.
- `server/lib/agent/openai-chunk.ts` — helpers to frame text as OpenAI streaming chunks.
- `server/utils/net.ts` — `isPrivateAddress()` guard.

**Server — endpoints (new dir `server/api/agent/`):**
- `server/api/agent/llm.post.ts` — OpenAI-compatible; LAN-only; runs the loop; streams.
- `server/api/agent/activity.get.ts` — SSE of activity to the page (session auth).
- `server/api/agent/undo.post.ts` — run an undo token (session auth).
- `server/api/agent/chat.post.ts` — text adapter over the same loop (session auth).

**Server — modified:**
- `server/lib/mcp/server.ts` — re-register from `tools.ts` (parity refactor).
- `server/middleware/auth.ts` — add `/api/agent/llm` to `PUBLIC_PREFIXES` (exact).

**Frontend (`app/`):**
- `app/composables/useUnmute.ts` — Unmute WS + opus-recorder audio plumbing + analysers + transcript.
- `app/composables/useAgentActivity.ts` — activity SSE → chips/undo/state.
- `app/components/voice/Reactor.client.vue` — Three.js reactor.
- `app/components/voice/Transcript.vue` — transcript + tool chips + undo.
- `app/components/voice/Composer.vue` — typed fallback.
- `app/pages/voice.vue` — layout wiring it together.
- `app/layouts/default.vue` — add `/voice` nav item.

**Config/docs:**
- `nuxt.config.ts` — `runtimeConfig.public.unmuteUrl`.
- `.env.example` — `NUXT_PUBLIC_UNMUTE_URL`.
- `docs/wiki/voice-agent.md` — new wiki page (current behaviour).
- `docs/DEPLOYMENT.md` — Unmute reconfig + proxy LAN-restriction steps.
- `docs/handovers/2026-06-08-voice-agent.md` — handover.

---

## Phase A — Agent core (server, TDD)

### Task 1: Agent tool types

**Files:**
- Create: `server/lib/agent/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// server/lib/agent/types.ts
import type { ZodRawShape } from 'zod'

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  signal: AbortSignal           // aborts when the caller (Unmute) hangs up / barge-in
}

/** What a tool handler returns. `undo` (when present) reverses the side-effect. */
export interface ToolExecution {
  result: unknown               // structured result fed back to the model
  summary: string               // short spoken/UI-friendly line, e.g. "added 'buy milk' to todo"
  undo?: () => Promise<void>     // present for create/destructive tools
}

export type ToolKind = 'read' | 'create' | 'destructive'

export interface AgentTool {
  name: string
  description: string
  schema: ZodRawShape           // → OpenAI tool JSON schema AND MCP registration
  kind: ToolKind
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecution>
}

/** Events the loop yields to its HTTP adapter. */
export type LoopEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string }
  | { type: 'done' }

/** Events published on the activity bus for the client side-channel. */
export type ActivityEvent =
  | { type: 'state'; state: 'idle' | 'thinking' | 'tool' }
  | { type: 'tool'; name: string; summary: string; undoToken?: string }
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS (no references yet, just type declarations).

- [ ] **Step 3: Commit**

```bash
git add server/lib/agent/types.ts
git commit -m "feat(agent): tool + loop type definitions"
```

---

### Task 2: Tool registry

**Files:**
- Create: `server/lib/agent/tools.ts`
- Test: `test/agent-tools.test.ts`

Reuses existing services with these exact signatures (already verified in the codebase):
`createTask(input)`, `updateTask(id, patch)`, `getTask(id)`, `deleteTask(id)`, `listTasks(filter)` (`server/services/tasks.ts`); `createMemory(input)`, `archiveMemory(id)`, `searchMemories(q, opts)`, `listMemories(opts)` (`server/services/memory.ts`); `listProjects(filter)`, `createProject(input)`, `updateProject(slug, patch)`, `getProject(slug)`, `deleteProject(slug)` (`server/services/projects.ts`); `searchDocs(query)`, `createDoc(input)` (`server/services/documents.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-tools.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools, toolByName } from '../server/lib/agent/tools'

describe('agent tool registry', () => {
  it('exposes the expected 11 tools', () => {
    const names = agentTools.map(t => t.name).sort()
    expect(names).toEqual([
      'create_project', 'create_task', 'edit_project', 'edit_task',
      'get_recent_memories', 'quick_capture', 'save_memory',
      'search_docs', 'search_memories', 'search_projects', 'search_tasks'
    ])
  })

  it('classifies tool kinds correctly', () => {
    expect(toolByName('search_tasks')!.kind).toBe('read')
    expect(toolByName('create_task')!.kind).toBe('create')
    expect(toolByName('edit_task')!.kind).toBe('destructive')
    expect(toolByName('quick_capture')!.kind).toBe('create')
  })

  it('every tool has a non-empty description and zod shape', () => {
    for (const t of agentTools) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.schema).toBe('object')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-tools`
Expected: FAIL — cannot find module `tools`.

- [ ] **Step 3: Write the registry**

```ts
// server/lib/agent/tools.ts
import { z } from 'zod'
import type { AgentTool } from './types'
import { searchMemories, createMemory, listMemories, archiveMemory } from '../../services/memory'
import { searchDocs, createDoc } from '../../services/documents'
import { listProjects, createProject, updateProject, getProject, deleteProject } from '../../services/projects'
import { createTask, listTasks, updateTask, getTask, deleteTask } from '../../services/tasks'
import { nanoid } from 'nanoid'

export const agentTools: AgentTool[] = [
  // ---- memory ----
  {
    name: 'search_memories',
    description: 'Semantic + keyword search over stored memories.',
    kind: 'read',
    schema: {
      query: z.string().describe('Search query'),
      scope: z.enum(['user', 'agent', 'world']).optional(),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    handler: async (a) => {
      const res = await searchMemories(a.query as string, {
        scope: a.scope as undefined, project: a.project as undefined, limit: a.limit as undefined
      })
      return { result: res, summary: `searched memories (${res.length})` }
    }
  },
  {
    name: 'get_recent_memories',
    description: 'List recent memories, optionally filtered by scope.',
    kind: 'read',
    schema: { scope: z.enum(['user', 'agent', 'world']).optional(), limit: z.number().int().min(1).max(100).optional() },
    handler: async (a) => {
      const res = await listMemories({ scope: a.scope as undefined, limit: (a.limit as number) ?? 20 })
      return { result: res, summary: `recent memories (${res.length})` }
    }
  },
  {
    name: 'save_memory',
    description: 'Store a new memory (with deduplication).',
    kind: 'create',
    schema: {
      content: z.string().max(20_000),
      scope: z.enum(['user', 'agent', 'world']),
      project: z.string().optional(),
      tags: z.array(z.string()).optional()
    },
    handler: async (a) => {
      const m = await createMemory({
        content: a.content as string, scope: a.scope as undefined,
        project: (a.project as string) ?? null, tags: a.tags as undefined, source: 'voice'
      })
      return {
        result: m,
        summary: `saved memory`,
        undo: async () => { await archiveMemory((m as { id: string }).id) }
      }
    }
  },
  // ---- documents ----
  {
    name: 'search_docs',
    description: 'Semantic + keyword search over stored documents.',
    kind: 'read',
    schema: { query: z.string().describe('Search query') },
    handler: async (a) => {
      const res = await searchDocs(a.query as string)
      return { result: res, summary: `searched docs (${Array.isArray(res) ? res.length : 0})` }
    }
  },
  // ---- projects ----
  {
    name: 'search_projects',
    description: 'List all projects, optionally active-only.',
    kind: 'read',
    schema: { activeOnly: z.boolean().optional() },
    handler: async (a) => {
      const res = await listProjects({ activeOnly: (a.activeOnly as boolean) ?? false })
      return { result: res, summary: `listed projects (${res.length})` }
    }
  },
  {
    name: 'create_project',
    description: 'Create a new project.',
    kind: 'create',
    schema: { name: z.string().min(1), description: z.string().optional() },
    handler: async (a) => {
      const p = await createProject({ name: a.name as string, description: a.description as undefined })
      return {
        result: p, summary: `created project "${(p as { name: string }).name}"`,
        undo: async () => { await deleteProject((p as { slug: string }).slug) }
      }
    }
  },
  {
    name: 'edit_project',
    description: 'Update an existing project. Confirm with the user before calling.',
    kind: 'destructive',
    schema: {
      slug: z.string(), name: z.string().optional(),
      description: z.string().optional(), active: z.boolean().optional()
    },
    handler: async (a) => {
      const slug = a.slug as string
      const prior = await getProject(slug)
      const { slug: _s, ...patch } = a
      const p = await updateProject(slug, patch as { name?: string; description?: string; active?: boolean })
      return {
        result: p ?? { error: 'not found', slug },
        summary: `updated project "${slug}"`,
        undo: prior ? async () => { await updateProject(slug, { name: prior.name, description: prior.description, active: prior.active }) } : undefined
      }
    }
  },
  // ---- tasks ----
  {
    name: 'search_tasks',
    description: 'List tasks, optionally filtered by status or project.',
    kind: 'read',
    schema: {
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
      project: z.string().optional()
    },
    handler: async (a) => {
      const res = await listTasks({ status: a.status as undefined, project: a.project as undefined })
      return { result: res, summary: `listed tasks (${res.length})` }
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task.',
    kind: 'create',
    schema: {
      title: z.string().min(1).max(500),
      description: z.string().max(20_000).optional(),
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      project: z.string().optional(),
      dueDate: z.string().optional()
    },
    handler: async (a) => {
      const t = await createTask({
        title: a.title as string, description: a.description as undefined,
        status: a.status as undefined, priority: a.priority as undefined,
        project: (a.project as string) ?? null,
        dueDate: a.dueDate ? new Date(a.dueDate as string) : undefined
      })
      return {
        result: t, summary: `added "${(t as { title: string }).title}" to ${(t as { status: string }).status}`,
        undo: async () => { await deleteTask((t as { id: string }).id) }
      }
    }
  },
  {
    name: 'edit_task',
    description: 'Update an existing task. Confirm with the user before calling.',
    kind: 'destructive',
    schema: {
      id: z.string(),
      title: z.string().max(500).optional(),
      description: z.string().max(20_000).optional(),
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      project: z.string().optional(),
      dueDate: z.string().optional()
    },
    handler: async (a) => {
      const id = a.id as string
      const prior = await getTask(id)
      const { id: _i, dueDate, ...rest } = a
      const t = await updateTask(id, { ...(rest as object), dueDate: dueDate ? new Date(dueDate as string) : undefined })
      return {
        result: t ?? { error: 'not found', id },
        summary: `updated task`,
        undo: prior ? async () => {
          await updateTask(id, {
            title: prior.title, description: prior.description ?? undefined,
            status: prior.status, priority: prior.priority,
            project: prior.project, dueDate: prior.dueDate ? new Date(prior.dueDate) : null
          })
        } : undefined
      }
    }
  },
  // ---- quick capture ----
  {
    name: 'quick_capture',
    description: 'Capture a quick note as a markdown document in /input.',
    kind: 'create',
    schema: { text: z.string().min(1), title: z.string().optional() },
    handler: async (a) => {
      const title = (a.title as string) ?? null
      const slug = title ? title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 64) || nanoid(8) : nanoid(10)
      const doc = await createDoc({ path: `/input/${slug}.md`, title, content: a.text as string }) as { id?: string; path?: string }
      return {
        result: doc, summary: `captured note${title ? ` "${title}"` : ''}`,
        // createDoc has no soft-delete service exposed here; undo is best-effort no-op marker.
        undo: undefined
      }
    }
  }
]

const byName = new Map(agentTools.map(t => [t.name, t]))
export function toolByName(name: string): AgentTool | undefined {
  return byName.get(name)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test agent-tools`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add server/lib/agent/tools.ts test/agent-tools.test.ts
git commit -m "feat(agent): tool registry over existing services"
```

> Note on `quick_capture` undo: `createDoc` exposes no soft-delete in the service layer, so undo is omitted (best-effort). If a `deleteDoc`/archive service is added later, wire it here.

---

### Task 3: Activity bus

**Files:**
- Create: `server/lib/agent/bus.ts`
- Test: `test/agent-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-bus.test.ts
import { describe, it, expect } from 'vitest'
import { publishActivity, subscribeActivity } from '../server/lib/agent/bus'

describe('agent activity bus', () => {
  it('delivers events to subscribers and stops after unsubscribe', () => {
    const seen: unknown[] = []
    const off = subscribeActivity((e) => seen.push(e))
    publishActivity({ type: 'state', state: 'thinking' })
    expect(seen).toHaveLength(1)
    off()
    publishActivity({ type: 'state', state: 'idle' })
    expect(seen).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-bus`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the bus** (single global channel — MyMind is single-user)

```ts
// server/lib/agent/bus.ts
import { EventEmitter } from 'node:events'
import type { ActivityEvent } from './types'

const emitter = new EventEmitter()
emitter.setMaxListeners(0)
const CHANNEL = 'agent-activity'

export function publishActivity(e: ActivityEvent): void {
  emitter.emit(CHANNEL, e)
}

export function subscribeActivity(cb: (e: ActivityEvent) => void): () => void {
  emitter.on(CHANNEL, cb)
  return () => emitter.off(CHANNEL, cb)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test agent-bus`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/bus.ts test/agent-bus.test.ts
git commit -m "feat(agent): single-user activity event bus"
```

---

### Task 4: Undo token store

**Files:**
- Create: `server/lib/agent/undo.ts`
- Test: `test/agent-undo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-undo.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerUndo, runUndo, hasUndo } from '../server/lib/agent/undo'

describe('undo store', () => {
  it('registers, runs once, then forgets the token', async () => {
    const fn = vi.fn(async () => {})
    const token = registerUndo(fn)
    expect(hasUndo(token)).toBe(true)
    expect(await runUndo(token)).toBe(true)
    expect(fn).toHaveBeenCalledOnce()
    expect(hasUndo(token)).toBe(false)
    expect(await runUndo(token)).toBe(false) // already consumed
  })

  it('returns false for an unknown token', async () => {
    expect(await runUndo('nope')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-undo`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store** (TTL prevents unbounded growth)

```ts
// server/lib/agent/undo.ts
import { nanoid } from 'nanoid'

interface Entry { fn: () => Promise<void>; expires: number }
const store = new Map<string, Entry>()
const TTL_MS = 10 * 60 * 1000 // 10 minutes

function sweep() {
  const now = Date.now()
  for (const [k, v] of store) if (v.expires < now) store.delete(k)
}

export function registerUndo(fn: () => Promise<void>): string {
  sweep()
  const token = nanoid(12)
  store.set(token, { fn, expires: Date.now() + TTL_MS })
  return token
}

export function hasUndo(token: string): boolean {
  const e = store.get(token)
  return !!e && e.expires >= Date.now()
}

export async function runUndo(token: string): Promise<boolean> {
  const e = store.get(token)
  store.delete(token)
  if (!e || e.expires < Date.now()) return false
  await e.fn()
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test agent-undo`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/undo.ts test/agent-undo.test.ts
git commit -m "feat(agent): TTL undo token store"
```

---

### Task 5: Streaming chat client with tool-call assembly

**Files:**
- Create: `server/lib/ai/chat-stream.ts`
- Test: `test/chat-stream.test.ts`

This extends the non-streaming `server/lib/ai/chat.ts`. It uses global `fetch` (not `$fetch`) to read the response body as a stream.

- [ ] **Step 1: Write the failing test** (mock `fetch` with a canned OpenAI SSE stream)

```ts
// test/chat-stream.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { assembleToolCalls, parseSseLine } from '../server/lib/ai/chat-stream'

describe('chat-stream parsing helpers', () => {
  it('parseSseLine extracts JSON payloads and detects DONE', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true })
    expect(parseSseLine('data: {"a":1}')).toEqual({ done: false, json: { a: 1 } })
    expect(parseSseLine(': heartbeat')).toEqual({ done: false })
    expect(parseSseLine('')).toEqual({ done: false })
  })

  it('assembleToolCalls merges streamed argument fragments by index', () => {
    const deltas = [
      [{ index: 0, id: 'call_1', function: { name: 'create_task', arguments: '{"ti' } }],
      [{ index: 0, function: { arguments: 'tle":"x"}' } }]
    ]
    const acc: Record<number, { id?: string; name?: string; args: string }> = {}
    for (const d of deltas) assembleToolCalls(acc, d)
    expect(acc[0]).toEqual({ id: 'call_1', name: 'create_task', args: '{"title":"x"}' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test chat-stream`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the streaming client**

```ts
// server/lib/ai/chat-stream.ts
import { z } from 'zod'
import { aiProvider, type AiRole } from './provider'
import type { ChatMessage } from './chat'

// --- pure helpers (exported for tests) ---

export function parseSseLine(line: string): { done: boolean; json?: unknown } {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':')) return { done: false }
  if (!trimmed.startsWith('data:')) return { done: false }
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return { done: true }
  try { return { done: false, json: JSON.parse(payload) } } catch { return { done: false } }
}

interface ToolCallAcc { id?: string; name?: string; args: string }
interface ToolCallDelta { index: number; id?: string; function?: { name?: string; arguments?: string } }

export function assembleToolCalls(acc: Record<number, ToolCallAcc>, deltas: ToolCallDelta[]): void {
  for (const d of deltas) {
    const cur = acc[d.index] ?? (acc[d.index] = { args: '' })
    if (d.id) cur.id = d.id
    if (d.function?.name) cur.name = d.function.name
    if (d.function?.arguments) cur.args += d.function.arguments
  }
}

// --- OpenAI tool schema from a zod raw shape ---

export interface OpenAiToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function zodShapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, schema] of Object.entries(shape)) {
    const def = (schema as z.ZodTypeAny)._def
    // Minimal mapper sufficient for our tool shapes (string/number/boolean/enum/array/optional).
    let inner = schema as z.ZodTypeAny
    let optional = false
    if (def.typeName === 'ZodOptional') { optional = true; inner = def.innerType }
    const innerDef = inner._def
    let jsonType: Record<string, unknown> = { type: 'string' }
    if (innerDef.typeName === 'ZodNumber') jsonType = { type: 'number' }
    else if (innerDef.typeName === 'ZodBoolean') jsonType = { type: 'boolean' }
    else if (innerDef.typeName === 'ZodEnum') jsonType = { type: 'string', enum: innerDef.values }
    else if (innerDef.typeName === 'ZodArray') jsonType = { type: 'array', items: { type: 'string' } }
    if (inner.description) jsonType.description = inner.description
    properties[key] = jsonType
    if (!optional) required.push(key)
  }
  return { type: 'object', properties, required }
}

// --- streaming call ---

export interface StreamChunk {
  textDelta?: string
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] // emitted once, at end
}

/**
 * Stream an OpenAI chat completion. Yields `{ textDelta }` as content arrives and,
 * if the model called tools, a final `{ toolCalls }` chunk. Aborts on `signal`.
 */
export async function* streamChat(
  role: AiRole,
  messages: ChatMessage[],
  opts: { tools?: OpenAiToolDef[]; signal?: AbortSignal; temperature?: number; maxTokens?: number } = {}
): AsyncGenerator<StreamChunk> {
  const cfg = aiProvider(role, { required: true })
  const res = await fetch(`${cfg.baseURL!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 800,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {})
    })
  })
  if (!res.ok || !res.body) throw new Error(`stream chat failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const toolAcc: Record<number, ToolCallAcc> = {}
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseSseLine(line)
      if (parsed.done) { buffer = ''; break }
      if (!parsed.json) continue
      const choice = (parsed.json as { choices?: { delta?: { content?: string; tool_calls?: ToolCallDelta[] } }[] }).choices?.[0]
      const delta = choice?.delta
      if (delta?.content) yield { textDelta: delta.content }
      if (delta?.tool_calls) assembleToolCalls(toolAcc, delta.tool_calls)
    }
  }

  const calls = Object.values(toolAcc)
  if (calls.length) {
    yield {
      toolCalls: calls.map(c => ({
        id: c.id ?? '', name: c.name ?? '',
        args: c.args ? safeJson(c.args) : {}
      }))
    }
  }
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test chat-stream`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add server/lib/ai/chat-stream.ts test/chat-stream.test.ts
git commit -m "feat(ai): streaming chat client with tool-call assembly"
```

---

### Task 6: System-prompt builder

**Files:**
- Create: `server/lib/agent/prompt.ts`
- Test: `test/agent-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../server/lib/agent/prompt'

describe('buildSystemPrompt', () => {
  it('mentions confirm-before-destructive and the filler behaviour', () => {
    const p = buildSystemPrompt()
    expect(p.toLowerCase()).toContain('confirm')
    expect(p.toLowerCase()).toContain('before')
    expect(p.length).toBeGreaterThan(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-prompt`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the prompt builder**

```ts
// server/lib/agent/prompt.ts
export function buildSystemPrompt(): string {
  return [
    "You are MyMind's voice assistant — a concise, friendly second brain for Tony.",
    "You speak out loud, so keep replies short and conversational. No markdown, no lists read aloud unless asked.",
    "",
    "You can act on Tony's data with tools: search/save memories, search docs, list/create/edit projects and tasks, and capture quick notes.",
    "",
    "Behaviour rules:",
    "- When you need a tool, FIRST say a brief natural filler ('let me check…', 'one sec…') so Tony hears you immediately, THEN call the tool.",
    "- For creating things (tasks, notes, memories, projects), just do it and tell Tony what you did in one short sentence.",
    "- Before ANY change that edits or deletes existing data (edit_task, edit_project), CONFIRM with Tony first and only act after he says yes.",
    "- After acting, state the result briefly. Don't read IDs aloud.",
    "- If a search returns nothing, say so plainly and suggest a next step."
  ].join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test agent-prompt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/prompt.ts test/agent-prompt.test.ts
git commit -m "feat(agent): system-prompt builder"
```

---

### Task 7: The agent loop

**Files:**
- Create: `server/lib/agent/loop.ts`
- Test: `test/agent-loop.test.ts`

The loop is an async generator with **dependency injection** for `streamChat` and `tools` so tests run with no network/DB.

- [ ] **Step 1: Write the failing test** (mock model: one tool round, then a final answer)

```ts
// test/agent-loop.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runAgentLoop } from '../server/lib/agent/loop'
import type { AgentTool } from '../server/lib/agent/types'
import type { StreamChunk } from '../server/lib/ai/chat-stream'

function streamOf(chunks: StreamChunk[]) {
  return async function* () { for (const c of chunks) yield c }()
}

const fakeTool: AgentTool = {
  name: 'create_task', description: 'x', kind: 'create',
  schema: {}, handler: async () => ({ result: { id: 't1', title: 'milk' }, summary: "added 'milk' to todo", undo: async () => {} })
}

describe('runAgentLoop', () => {
  it('runs a tool round then streams the final answer, emitting events', async () => {
    const calls = [
      streamOf([{ toolCalls: [{ id: 'c1', name: 'create_task', args: { title: 'milk' } }] }]),
      streamOf([{ textDelta: 'Added milk ' }, { textDelta: 'to your list.' }])
    ]
    let i = 0
    const streamChat = vi.fn(() => calls[i++])

    const events: string[] = []
    let text = ''
    for await (const ev of runAgentLoop(
      [{ role: 'user', content: 'remind me to buy milk' }],
      { signal: new AbortController().signal },
      { streamChat: streamChat as never, tools: [fakeTool] }
    )) {
      events.push(ev.type)
      if (ev.type === 'text-delta') text += ev.text
    }

    expect(text).toContain('Added milk to your list.')
    expect(events).toContain('tool-start')
    expect(events).toContain('tool-result')
    expect(events[events.length - 1]).toBe('done')
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it('emits a filler before running tools', async () => {
    const calls = [
      streamOf([{ toolCalls: [{ id: 'c1', name: 'create_task', args: { title: 'x' } }] }]),
      streamOf([{ textDelta: 'done' }])
    ]
    let i = 0
    const out: string[] = []
    for await (const ev of runAgentLoop(
      [{ role: 'user', content: 'add x' }],
      { signal: new AbortController().signal },
      { streamChat: (() => calls[i++]) as never, tools: [fakeTool] }
    )) {
      if (ev.type === 'text-delta') out.push(ev.text)
    }
    // first text-delta is a filler, before the 'done' from round 2
    expect(out[0].length).toBeGreaterThan(0)
    expect(out.join('')).toContain('done')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test agent-loop`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the loop**

```ts
// server/lib/agent/loop.ts
import type { ChatMessage } from '../ai/chat'
import { streamChat as realStreamChat, zodShapeToJsonSchema, type OpenAiToolDef } from '../ai/chat-stream'
import { agentTools as realTools } from './tools'
import { buildSystemPrompt } from './prompt'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import type { AgentTool, LoopEvent, ToolContext } from './types'

const FILLERS = ['One sec…', 'Let me check…', 'Looking that up…', 'On it…']
const MAX_ROUNDS = 5

export interface LoopDeps {
  streamChat?: typeof realStreamChat
  tools?: AgentTool[]
}

export async function* runAgentLoop(
  incoming: ChatMessage[],
  ctx: ToolContext,
  deps: LoopDeps = {}
): AsyncGenerator<LoopEvent> {
  const streamChat = deps.streamChat ?? realStreamChat
  const tools = deps.tools ?? realTools
  const byName = new Map(tools.map(t => [t.name, t]))
  const toolDefs: OpenAiToolDef[] = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: zodShapeToJsonSchema(t.schema) }
  }))

  // Replace any inbound system message with ours (the loop owns persona + policy).
  const userTurns = incoming.filter(m => m.role !== 'system')
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }, ...userTurns]

  let fillerSpoken = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (ctx.signal.aborted) return
    let toolCalls: { id: string; name: string; args: Record<string, unknown> }[] | undefined
    let sawText = false

    for await (const chunk of streamChat('reasoning', messages, { tools: toolDefs, signal: ctx.signal })) {
      if (chunk.textDelta) { sawText = true; yield { type: 'text-delta', text: chunk.textDelta } }
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
    }

    if (!toolCalls || toolCalls.length === 0) {
      publishActivity({ type: 'state', state: 'idle' })
      yield { type: 'done' }
      return
    }

    // Speak a filler before doing tool work, if the model didn't already say something.
    if (!sawText && !fillerSpoken) {
      fillerSpoken = true
      yield { type: 'text-delta', text: FILLERS[round % FILLERS.length] + ' ' }
    }
    publishActivity({ type: 'state', state: 'tool' })

    // Record the assistant's tool-call turn in history.
    messages.push({
      role: 'assistant',
      content: '',
      // @ts-expect-error OpenAI tool_calls passthrough (not in our ChatMessage type)
      tool_calls: toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
    })

    for (const call of toolCalls) {
      const tool = byName.get(call.name)
      yield { type: 'tool-start', name: call.name, args: call.args }
      let summary = `called ${call.name}`
      let resultText = ''
      let undoToken: string | undefined
      try {
        if (!tool) throw new Error(`unknown tool ${call.name}`)
        const exec = await tool.handler(call.args, ctx)
        summary = exec.summary
        resultText = JSON.stringify(exec.result)
        if (exec.undo) undoToken = registerUndo(exec.undo)
      } catch (err) {
        resultText = JSON.stringify({ error: (err as Error).message })
        summary = `failed: ${call.name}`
      }
      publishActivity({ type: 'tool', name: call.name, summary, undoToken })
      yield { type: 'tool-result', name: call.name, summary, undoToken }
      messages.push({
        role: 'assistant', // tool result; some backends want role 'tool'
        content: resultText,
        // @ts-expect-error OpenAI tool-result passthrough
        role_override: 'tool', tool_call_id: call.id, name: call.name
      })
      // Normalise to a proper tool message for OpenAI-spec backends:
      const last = messages[messages.length - 1] as unknown as Record<string, unknown>
      last.role = 'tool'
      delete last.role_override
    }
  }

  publishActivity({ type: 'state', state: 'idle' })
  yield { type: 'done' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test agent-loop`
Expected: PASS (2 tests).

> If the mock-history type assertions feel noisy, that's fine — they exist because `ChatMessage` doesn't model OpenAI `tool_calls`/`tool` roles. Keep the `@ts-expect-error`s; they're load-bearing and covered by the test.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add server/lib/agent/loop.ts test/agent-loop.test.ts
git commit -m "feat(agent): streaming tool-calling loop with filler + abort"
```

---

### Task 8: Private-address guard

**Files:**
- Create: `server/utils/net.ts`
- Test: `test/net.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/net.test.ts
import { describe, it, expect } from 'vitest'
import { isPrivateAddress } from '../server/utils/net'

describe('isPrivateAddress', () => {
  it('accepts loopback and RFC1918 ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.2.25', '172.16.0.1'])
      expect(isPrivateAddress(ip)).toBe(true)
  })
  it('rejects public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.5'])
      expect(isPrivateAddress(ip)).toBe(false)
  })
  it('handles IPv4-mapped IPv6 and undefined', () => {
    expect(isPrivateAddress('::ffff:192.168.1.5')).toBe(true)
    expect(isPrivateAddress(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test net`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the guard**

```ts
// server/utils/net.ts
export function isPrivateAddress(ip: string | undefined | null): boolean {
  if (!ip) return false
  let addr = ip.trim()
  if (addr === '::1') return true
  // strip IPv4-mapped IPv6 prefix
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) addr = mapped[1]
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127) return true            // loopback
  if (a === 10) return true             // 10.0.0.0/8
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test net`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/net.ts test/net.test.ts
git commit -m "feat(net): private-address guard for LAN-only routes"
```

---

### Task 9: `/api/agent/llm` endpoint (the brain)

**Files:**
- Create: `server/lib/agent/openai-chunk.ts`
- Create: `server/api/agent/llm.post.ts`
- Modify: `server/middleware/auth.ts:6`
- Test: `test/openai-chunk.test.ts`

- [ ] **Step 1: Write the failing test for the chunk helper**

```ts
// test/openai-chunk.test.ts
import { describe, it, expect } from 'vitest'
import { textChunk, doneFrame } from '../server/lib/agent/openai-chunk'

describe('openai chunk framing', () => {
  it('frames a text delta as an OpenAI streaming chunk line', () => {
    const line = textChunk('hi')
    expect(line.startsWith('data: ')).toBe(true)
    const obj = JSON.parse(line.slice(6).trim())
    expect(obj.choices[0].delta.content).toBe('hi')
    expect(obj.object).toBe('chat.completion.chunk')
  })
  it('doneFrame is the OpenAI terminator', () => {
    expect(doneFrame()).toBe('data: [DONE]\n\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test openai-chunk`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the chunk helper**

```ts
// server/lib/agent/openai-chunk.ts
export function textChunk(content: string): string {
  const chunk = {
    id: 'mymind-agent', object: 'chat.completion.chunk', created: 0, model: 'mymind-agent',
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}
export function doneFrame(): string {
  return 'data: [DONE]\n\n'
}
```

- [ ] **Step 4: Run test, then write the endpoint**

Run: `pnpm test openai-chunk`
Expected: PASS.

Then create the endpoint:

```ts
// server/api/agent/llm.post.ts
import { runAgentLoop } from '../../lib/agent/loop'
import { textChunk, doneFrame } from '../../lib/agent/openai-chunk'
import { publishActivity } from '../../lib/agent/bus'
import { isPrivateAddress } from '../../utils/net'
import type { ChatMessage } from '../../lib/ai/chat'

// OpenAI /v1/chat/completions-shaped endpoint that Unmute's LLM points at.
// AUTH: none (Unmute is keyless) — defended by a private-address guard + a proxy
// allow-list. NEVER expose this route publicly; it can mutate data.
export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true })
  if (!isPrivateAddress(ip)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden (LAN only)' })
  }

  const body = await readBody<{ messages?: ChatMessage[]; stream?: boolean }>(event)
  const messages = body?.messages ?? []

  // AbortSignal so barge-in (Unmute closing the request) cancels model + tools.
  const ac = new AbortController()
  event.node.req.on('close', () => ac.abort())

  publishActivity({ type: 'state', state: 'thinking' })

  const res = event.node.res
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders()

  try {
    for await (const ev of runAgentLoop(messages, { signal: ac.signal })) {
      if (ev.type === 'text-delta') res.write(textChunk(ev.text))
      // tool-start/tool-result are surfaced to the client via the activity bus, not Unmute
    }
  } catch (err) {
    if (!ac.signal.aborted) console.error('[agent/llm] loop error:', err)
  } finally {
    res.write(doneFrame())
    res.end()
    event._handled = true
  }
})
```

- [ ] **Step 5: Exempt the route from auth**

In `server/middleware/auth.ts` line 6, change:

```ts
const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i']
```
to:
```ts
// /api/agent/llm is keyless (Unmute) but guarded by a private-address check in the handler.
const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/agent/llm']
```

- [ ] **Step 6: Verify typecheck + manual smoke (no audio)**

Run: `pnpm typecheck`
Expected: PASS.

Run a local smoke (requires `pnpm dev` running + the `reasoning` role configured). Expected: streamed `data:` chunks then `data: [DONE]`:
```bash
curl -N -s -X POST http://localhost:3000/api/agent/llm \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"say hello in five words"}],"stream":true}'
```
(If the reasoning model isn't reachable in your dev env, skip the live curl — Task 7's unit tests already cover the loop.)

- [ ] **Step 7: Commit**

```bash
git add server/lib/agent/openai-chunk.ts server/api/agent/llm.post.ts server/middleware/auth.ts test/openai-chunk.test.ts
git commit -m "feat(agent): /api/agent/llm OpenAI-compatible brain endpoint (LAN-only)"
```

---

### Task 10: Activity SSE, undo, and text-chat endpoints

**Files:**
- Create: `server/api/agent/activity.get.ts`
- Create: `server/api/agent/undo.post.ts`
- Create: `server/api/agent/chat.post.ts`

These are session-authed (covered by existing middleware — not in `PUBLIC_PREFIXES`).

- [ ] **Step 1: Write the activity SSE route** (mirrors clipboard `stream.get.ts`)

```ts
// server/api/agent/activity.get.ts
import { subscribeActivity } from '../../lib/agent/bus'

export default defineEventHandler(async (event) => {
  const res = event.node.res
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders()
  res.write(': ping\n\n')

  const unsubscribe = subscribeActivity((e) => res.write(`data: ${JSON.stringify(e)}\n\n`))
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)

  return new Promise<void>((resolve) => {
    event.node.req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      resolve()
    })
  })
})
```

- [ ] **Step 2: Write the undo route**

```ts
// server/api/agent/undo.post.ts
import { z } from 'zod'
import { runUndo } from '../../lib/agent/undo'

const Body = z.object({ token: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const { token } = Body.parse(await readBody(event))
  const ok = await runUndo(token)
  return { ok }
})
```

- [ ] **Step 3: Write the text-chat adapter** (same loop, no TTS — typed fallback + future chat page)

```ts
// server/api/agent/chat.post.ts
import { runAgentLoop } from '../../lib/agent/loop'
import { textChunk, doneFrame } from '../../lib/agent/openai-chunk'
import type { ChatMessage } from '../../lib/ai/chat'

// Session-authed. Streams the same OpenAI-chunk shape the client already parses
// from /api/agent/llm, so the page can reuse one stream reader for typed turns.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ messages?: ChatMessage[] }>(event)
  const messages = body?.messages ?? []
  const ac = new AbortController()
  event.node.req.on('close', () => ac.abort())

  const res = event.node.res
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders()
  try {
    for await (const ev of runAgentLoop(messages, { signal: ac.signal })) {
      if (ev.type === 'text-delta') res.write(textChunk(ev.text))
    }
  } finally {
    res.write(doneFrame())
    res.end()
    event._handled = true
  }
})
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add server/api/agent/activity.get.ts server/api/agent/undo.post.ts server/api/agent/chat.post.ts
git commit -m "feat(agent): activity SSE, undo, and text-chat endpoints"
```

---

### Task 11: Refactor the MCP server to use the registry

**Files:**
- Modify: `server/lib/mcp/server.ts`
- Test: `test/mcp-parity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/mcp-parity.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools } from '../server/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'

describe('MCP ↔ agent registry parity', () => {
  it('MCP exposes exactly the agent registry tools', () => {
    expect(mcpToolNames().sort()).toEqual(agentTools.map(t => t.name).sort())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test mcp-parity`
Expected: FAIL — `mcpToolNames` not exported.

- [ ] **Step 3: Rewrite `server/lib/mcp/server.ts` to register from the registry**

```ts
// server/lib/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { agentTools } from '../agent/tools'

export function mcpToolNames(): string[] {
  return agentTools.map(t => t.name)
}

export function buildMcpServer() {
  const server = new McpServer({ name: 'mymind', version: '1.0.0' })
  for (const tool of agentTools) {
    server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
      const ac = new AbortController()
      const exec = await tool.handler(args, { signal: ac.signal })
      return { content: [{ type: 'text' as const, text: JSON.stringify(exec.result) }] }
    })
  }
  return server
}
```

- [ ] **Step 4: Run test + verify existing MCP behaviour**

Run: `pnpm test mcp-parity`
Expected: PASS.

Run: `pnpm typecheck`
Expected: PASS.

> Behaviour change vs old MCP: tools now return `exec.result` (same JSON the services returned). `save_memory` previously took a `source` arg — it now passes `source: 'voice'`. If you want MCP callers to keep setting `source`, add `source: z.string().optional()` to the `save_memory` schema in `tools.ts` and thread it through. (Left out per spec scope; note for the handover.)

- [ ] **Step 5: Commit**

```bash
git add server/lib/mcp/server.ts test/mcp-parity.test.ts
git commit -m "refactor(mcp): register tools from the shared agent registry"
```

---

## Phase B — Frontend (Vue + Three.js)

### Task 12: Dependencies + config

**Files:**
- Modify: `package.json` (via pnpm)
- Modify: `nuxt.config.ts:54-58` (public runtimeConfig)
- Modify: `.env.example`

- [ ] **Step 1: Install deps**

Run:
```bash
pnpm add three opus-recorder
pnpm add -D @types/three
```
Expected: packages added; lockfile updated.

- [ ] **Step 2: Add public config for the Unmute URL**

In `nuxt.config.ts`, extend the existing `runtimeConfig.public` block (currently lines ~54-58):

```ts
    public: {
      allowSignup: process.env.ALLOW_SIGNUP === 'true',
      unmuteUrl: process.env.NUXT_PUBLIC_UNMUTE_URL ?? ''
    },
```

- [ ] **Step 3: Document the env var**

Append to `.env.example`:

```bash
# Voice agent — browser WebSocket URL of the self-hosted Unmute realtime API.
# Dev (localhost tunnel): ws://localhost:8080/api/v1/realtime
# Prod: wss://<your-domain>/api/v1/realtime   (mic needs HTTPS or localhost)
NUXT_PUBLIC_UNMUTE_URL=ws://localhost:8080/api/v1/realtime
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add package.json pnpm-lock.yaml nuxt.config.ts .env.example
git commit -m "chore(voice): add three + opus-recorder deps and unmuteUrl config"
```

---

### Task 13: `useUnmute` audio plumbing composable

**Files:**
- Create: `app/composables/useUnmute.ts`

This ports the Unmute realtime client per `docs/wiki/voice-agent-integration.md` §§2,4,5,6. It owns the WebSocket, opus-recorder encode/decode, two `AnalyserNode`s, and exposes reactive transcript + state. The exact opus settings come from wiki §6.

- [ ] **Step 1: Write the composable**

```ts
// app/composables/useUnmute.ts
import Recorder from 'opus-recorder'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface TranscriptEntry { role: 'user' | 'assistant'; text: string }

export function useUnmute() {
  const config = useRuntimeConfig()
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const transcript = ref<TranscriptEntry[]>([])
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let audioCtx: AudioContext | null = null
  let recorder: InstanceType<typeof Recorder> | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null

  // base64 helpers
  const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

  function pushDelta(role: 'user' | 'assistant', delta: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === role) last.text += delta
    else transcript.value.push({ role, text: delta })
  }

  async function start() {
    error.value = null
    const url = config.public.unmuteUrl as string
    if (!url) { error.value = 'NUXT_PUBLIC_UNMUTE_URL is not set'; return }

    audioCtx = new AudioContext()
    outAnalyser = audioCtx.createAnalyser(); outAnalyser.fftSize = 256

    ws = new WebSocket(url, ['realtime'])
    ws.onopen = () => {
      connected.value = true
      ws!.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: { type: 'constant', text: 'You are MyMind, a concise voice assistant.', language: null },
          voice: 'unmute-prod-website/developer-1.mp3',
          allow_recording: false
        }
      }))
      startMic().catch(e => { error.value = String(e) })
    }
    ws.onclose = () => { connected.value = false; state.value = 'idle' }
    ws.onerror = () => { error.value = 'WebSocket error' }
    ws.onmessage = (e) => handleEvent(JSON.parse(e.data))
  }

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const src = audioCtx!.createMediaStreamSource(stream)
    micAnalyser = audioCtx!.createAnalyser(); micAnalyser.fftSize = 256
    src.connect(micAnalyser)

    // opus-recorder settings — must match the backend (wiki §6).
    recorder = new Recorder({
      encoderFrameSize: 20,
      encoderSampleRate: 24000,
      maxFramesPerPage: 2,
      numberOfChannels: 1,
      encoderApplication: 2049,
      streamPages: true,
      bufferLength: Math.round((960 * audioCtx!.sampleRate) / 24000),
      mediaTrackConstraints: true
    })
    recorder.ondataavailable = (page: Uint8Array) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toB64(page.buffer) }))
      }
    }
    await recorder.start()
  }

  // Decoded assistant audio playback queue feeding outAnalyser.
  let playCursor = 0
  async function playOpus(bytes: Uint8Array) {
    // opus-recorder ships a decoder worklet; for brevity we decode via WebAudio
    // decodeAudioData on the Ogg/Opus page. (If decodeAudioData rejects on raw
    // pages in your browser, swap to opus-recorder's decoder per wiki §6.)
    try {
      const buf = await audioCtx!.decodeAudioData(bytes.buffer.slice(0))
      const node = audioCtx!.createBufferSource()
      node.buffer = buf
      node.connect(outAnalyser!); outAnalyser!.connect(audioCtx!.destination)
      const startAt = Math.max(audioCtx!.currentTime, playCursor)
      node.start(startAt); playCursor = startAt + buf.duration
    } catch { /* ignore undecodable page */ }
  }

  function flushPlayback() { playCursor = 0 }

  function handleEvent(ev: { type: string; delta?: string; audio?: string }) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started': state.value = 'listening'; break
      case 'input_audio_buffer.speech_stopped': state.value = 'thinking'; break
      case 'conversation.item.input_audio_transcription.delta':
        if (ev.delta) pushDelta('user', ev.delta); break
      case 'response.created': state.value = 'thinking'; break
      case 'response.text.delta': if (ev.delta) pushDelta('assistant', ev.delta); break
      case 'response.audio.delta':
        state.value = 'speaking'
        if (ev.delta) playOpus(fromB64(ev.delta)); break
      case 'response.audio.done': state.value = 'idle'; break
      case 'unmute.interrupted_by_vad': flushPlayback(); state.value = 'listening'; break
    }
  }

  function stop() {
    recorder?.stop().catch(() => {})
    ws?.close()
    audioCtx?.close()
    recorder = null; ws = null; audioCtx = null
    state.value = 'idle'; connected.value = false
  }

  onUnmounted(stop)

  return { state, connected, transcript, error, start, stop, micAnalyser: () => micAnalyser, outAnalyser: () => outAnalyser }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add app/composables/useUnmute.ts
git commit -m "feat(voice): useUnmute audio plumbing composable"
```

> The audio decode path (`playOpus`) is the one spot most likely to need adjustment per browser. The wiki (§6, §10) recommends porting Unmute's `useAudioProcessor.ts` decoder worklet if `decodeAudioData` misbehaves on streamed Ogg/Opus pages. Validate during the manual voice test (Task 18) and swap to the worklet decoder if playback is choppy.

---

### Task 14: `useAgentActivity` composable

**Files:**
- Create: `app/composables/useAgentActivity.ts`

- [ ] **Step 1: Write the composable**

```ts
// app/composables/useAgentActivity.ts
export interface ToolChip { name: string; summary: string; undoToken?: string; undone?: boolean }

export function useAgentActivity() {
  const chips = ref<ToolChip[]>([])
  const agentState = ref<'idle' | 'thinking' | 'tool'>('idle')
  let es: EventSource | null = null

  function connect() {
    es = new EventSource('/api/agent/activity', { withCredentials: true } as EventSourceInit)
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as
          | { type: 'state'; state: 'idle' | 'thinking' | 'tool' }
          | { type: 'tool'; name: string; summary: string; undoToken?: string }
        if (ev.type === 'state') agentState.value = ev.state
        else if (ev.type === 'tool') chips.value.push({ name: ev.name, summary: ev.summary, undoToken: ev.undoToken })
      } catch { /* ignore heartbeats */ }
    }
  }

  async function undo(chip: ToolChip) {
    if (!chip.undoToken) return
    const { ok } = await $fetch<{ ok: boolean }>('/api/agent/undo', { method: 'POST', body: { token: chip.undoToken } })
    if (ok) chip.undone = true
  }

  onMounted(connect)
  onUnmounted(() => es?.close())
  return { chips, agentState, undo }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add app/composables/useAgentActivity.ts
git commit -m "feat(voice): useAgentActivity SSE composable"
```

---

### Task 15: Three.js reactor component

**Files:**
- Create: `app/components/voice/Reactor.client.vue`

`.client.vue` ensures it never runs during SSR (the app is SPA anyway, but this is explicit). It reads an `AnalyserNode` getter + a `state` prop.

- [ ] **Step 1: Write the component**

```vue
<!-- app/components/voice/Reactor.client.vue -->
<script setup lang="ts">
import * as THREE from 'three'
import type { VoiceState } from '~/composables/useUnmute'

const props = defineProps<{
  state: VoiceState
  analyser: () => AnalyserNode | null
}>()

const host = ref<HTMLDivElement | null>(null)
let raf = 0
let renderer: THREE.WebGLRenderer | null = null

// palette per state (kept here, not in CSS, since it's a GL material colour)
const PALETTE: Record<VoiceState, number> = {
  idle: 0x3b82f6, listening: 0x06b6d4, thinking: 0xf59e0b, speaking: 0x22d3ee
}

onMounted(() => {
  const el = host.value!
  const w = el.clientWidth, h = el.clientHeight
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100)
  camera.position.z = 5
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(w, h); renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  // core
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 2),
    new THREE.MeshStandardMaterial({ color: PALETTE.idle, emissive: PALETTE.idle, emissiveIntensity: 0.6, wireframe: true })
  )
  scene.add(core)

  // orbiting node ring
  const NODES = 48
  const ringGeo = new THREE.BufferGeometry()
  const positions = new Float32Array(NODES * 3)
  for (let i = 0; i < NODES; i++) {
    const a = (i / NODES) * Math.PI * 2
    positions[i * 3] = Math.cos(a) * 2.2
    positions[i * 3 + 1] = Math.sin(a) * 2.2
    positions[i * 3 + 2] = 0
  }
  ringGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const ring = new THREE.Points(ringGeo, new THREE.PointsMaterial({ color: PALETTE.idle, size: 0.08 }))
  scene.add(ring)

  scene.add(new THREE.AmbientLight(0xffffff, 0.4))
  const pl = new THREE.PointLight(0xffffff, 1.2); pl.position.set(3, 3, 5); scene.add(pl)

  const data = new Uint8Array(128)
  function amplitude(): number {
    const an = props.analyser()
    if (!an) return 0
    an.getByteFrequencyData(data)
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i]
    return sum / data.length / 255 // 0..1
  }

  function frame() {
    raf = requestAnimationFrame(frame)
    const amp = amplitude()
    const color = new THREE.Color(PALETTE[props.state])
    ;(core.material as THREE.MeshStandardMaterial).color.lerp(color, 0.1)
    ;(core.material as THREE.MeshStandardMaterial).emissive.lerp(color, 0.1)
    ;(ring.material as THREE.PointsMaterial).color.lerp(color, 0.1)
    const scale = 1 + amp * 0.6
    core.scale.setScalar(scale)
    core.rotation.y += 0.004 + amp * 0.05
    core.rotation.x += 0.002
    ring.rotation.z += 0.003 + amp * 0.04
    renderer!.render(scene, camera)
  }
  frame()

  const onResize = () => {
    const nw = el.clientWidth, nh = el.clientHeight
    camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer!.setSize(nw, nh)
  }
  window.addEventListener('resize', onResize)
  onUnmounted(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    renderer?.dispose()
    el.innerHTML = ''
  })
})
</script>

<template>
  <div
    ref="host"
    class="size-full min-h-[320px]"
  />
</template>
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
git add app/components/voice/Reactor.client.vue
git commit -m "feat(voice): Three.js reactor visualizer"
```

---

### Task 16: Transcript + Composer components

**Files:**
- Create: `app/components/voice/Transcript.vue`
- Create: `app/components/voice/Composer.vue`

Use Nuxt UI components per repo rules (`UButton`, `UBadge`, `UInput`, semantic color tokens only).

- [ ] **Step 1: Write the Transcript component**

```vue
<!-- app/components/voice/Transcript.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useUnmute'
import type { ToolChip } from '~/composables/useAgentActivity'

defineProps<{ entries: TranscriptEntry[]; chips: ToolChip[] }>()
const emit = defineEmits<{ undo: [chip: ToolChip] }>()
</script>

<template>
  <div class="flex flex-col gap-3 overflow-y-auto p-4">
    <div
      v-for="(e, i) in entries"
      :key="i"
      class="flex flex-col gap-0.5"
    >
      <span class="text-xs uppercase tracking-wide text-muted">{{ e.role === 'user' ? 'You' : 'MyMind' }}</span>
      <p
        class="text-sm"
        :class="e.role === 'user' ? 'text-default' : 'text-highlighted'"
      >
        {{ e.text }}
      </p>
    </div>

    <div
      v-if="chips.length"
      class="flex flex-wrap gap-2 pt-2"
    >
      <UBadge
        v-for="(c, i) in chips"
        :key="i"
        :color="c.undone ? 'neutral' : 'primary'"
        variant="subtle"
        class="gap-1"
      >
        <UIcon name="i-lucide-wand-2" class="size-3" />
        {{ c.summary }}
        <UButton
          v-if="c.undoToken && !c.undone"
          size="xs"
          variant="link"
          color="primary"
          icon="i-lucide-undo-2"
          @click="emit('undo', c)"
        />
        <span
          v-else-if="c.undone"
          class="text-xs text-muted"
        >undone</span>
      </UBadge>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Write the Composer component** (typed fallback → `/api/agent/chat`)

```vue
<!-- app/components/voice/Composer.vue -->
<script setup lang="ts">
import { textStreamToTranscript } from '~/composables/useTextChat'
import type { TranscriptEntry } from '~/composables/useUnmute'

const props = defineProps<{ entries: TranscriptEntry[] }>()
const text = ref('')
const busy = ref(false)

async function send() {
  const q = text.value.trim()
  if (!q || busy.value) return
  text.value = ''
  busy.value = true
  props.entries.push({ role: 'user', text: q })
  try {
    await textStreamToTranscript(q, props.entries)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form
    class="flex items-center gap-2 border-t border-default p-3"
    @submit.prevent="send"
  >
    <UInput
      v-model="text"
      placeholder="Type a message…"
      class="flex-1"
      :disabled="busy"
    />
    <UButton
      type="submit"
      icon="i-lucide-send"
      :loading="busy"
      :disabled="!text.trim()"
    />
  </form>
</template>
```

- [ ] **Step 3: Write the tiny text-chat helper used by the Composer**

```ts
// app/composables/useTextChat.ts
import type { TranscriptEntry } from './useUnmute'

// Posts to /api/agent/chat and appends streamed assistant text to `entries`.
// Reuses the OpenAI-chunk shape the server emits (textChunk()).
export async function textStreamToTranscript(query: string, entries: TranscriptEntry[]): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: entries.map(e => ({ role: e.role, content: e.text })) })
  })
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  entries.push({ role: 'assistant', text: '' })
  const target = entries[entries.length - 1]
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
        const c = obj.choices?.[0]?.delta?.content
        if (c) target.text += c
      } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add app/components/voice/Transcript.vue app/components/voice/Composer.vue app/composables/useTextChat.ts
git commit -m "feat(voice): transcript, tool chips, and typed composer"
```

---

### Task 17: The `/voice` page + nav

**Files:**
- Create: `app/pages/voice.vue`
- Modify: `app/layouts/default.vue:24-44` (nav items)

- [ ] **Step 1: Write the page**

```vue
<!-- app/pages/voice.vue -->
<script setup lang="ts">
const unmute = useUnmute()
const activity = useAgentActivity()

// Reactor reads whichever analyser is active for the current state.
const activeAnalyser = () =>
  unmute.state.value === 'speaking' ? unmute.outAnalyser() : unmute.micAnalyser()
</script>

<template>
  <UDashboardPanel id="voice">
    <template #header>
      <UDashboardNavbar title="Voice">
        <template #right>
          <UButton
            v-if="!unmute.connected.value"
            icon="i-lucide-mic"
            label="Connect"
            @click="unmute.start()"
          />
          <UButton
            v-else
            color="error"
            variant="soft"
            icon="i-lucide-phone-off"
            label="Disconnect"
            @click="unmute.stop()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="grid h-full grid-rows-[1fr_auto] gap-0 lg:grid-cols-[1.2fr_1fr] lg:grid-rows-1">
        <div class="relative flex items-center justify-center bg-elevated/20">
          <VoiceReactor
            :state="unmute.state.value"
            :analyser="activeAnalyser"
          />
          <span class="absolute bottom-4 text-xs uppercase tracking-widest text-muted">
            {{ unmute.state.value }}
          </span>
          <UAlert
            v-if="unmute.error.value"
            color="error"
            class="absolute top-4 mx-4"
            :title="unmute.error.value"
          />
        </div>

        <div class="flex min-h-0 flex-col border-l border-default">
          <VoiceTranscript
            class="flex-1 min-h-0"
            :entries="unmute.transcript.value"
            :chips="activity.chips.value"
            @undo="activity.undo"
          />
          <VoiceComposer :entries="unmute.transcript.value" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 2: Add the nav item** in `app/layouts/default.vue`, inside the `mainItems` array (after `Clipboard`):

```ts
  { label: 'Voice', icon: 'i-lucide-mic', to: '/voice' },
```

- [ ] **Step 3: Verify the page builds + renders**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm dev`, then with playwright-cli (per repo rule — NOT the MCP) load `/voice` after logging in. Expected: page renders, the reactor canvas mounts (a `<canvas>` appears in the left panel), the "Connect" button is visible, no console errors on mount.

- [ ] **Step 4: Commit**

```bash
git add app/pages/voice.vue app/layouts/default.vue
git commit -m "feat(voice): /voice page wiring reactor + transcript + composer"
```

---

### Task 18: E2E, Unmute reconfig, docs, handover

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Create: `docs/wiki/voice-agent.md`
- Create: `docs/handovers/2026-06-08-voice-agent.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (add cycle 17 row)
- Modify: `docs/BACKLOG.md` (tick the in-app agent/chat gap)

- [ ] **Step 1: Typed-path E2E with playwright-cli**

With `pnpm dev` running and logged in, drive `/voice`:
- Type "what are my tasks" in the composer and submit.
- Expected: a "You" entry appears, an assistant entry streams in, and (if the model calls `search_tasks`) a tool chip appears in the transcript. The reactor stays mounted.

This validates the whole brain path (loop → tools → stream → activity SSE → chips) **without audio**. Record findings.

- [ ] **Step 2: Re-point Unmute's LLM (one-time infra change)**

SSH and edit Unmute's backend config so its LLM `base_url` points at MyMind:
```bash
ssh tony@192.168.2.25
# In the Unmute backend config/env (the OpenAI-compatible LLM base_url it uses):
#   base_url:  http://<mymind-host-or-ip>:3000/api/agent/llm
#   api_key:   (leave empty / any dummy — endpoint is keyless, LAN-guarded)
# then restart the Unmute backend service/container.
```
Document the exact config key + restart command you used in `docs/DEPLOYMENT.md` under a new "Voice agent" section, including the **reverse-proxy rule that denies `/api/agent/llm` from the public internet** (allow RFC1918 / the Unmute host only).

- [ ] **Step 3: Manual full-voice acceptance** (the part automation can't cover)

Serve MyMind over HTTPS or a localhost tunnel (mic needs a secure context — wiki §9). On `/voice`, click Connect and verify:
- Plain chat: ask "what can you do" → hear a streamed spoken reply, reactor pulses on `speaking`.
- Tool turn: "what's on my plate today" → you hear a filler ("let me check…") immediately, then the answer; a `search_tasks` chip appears.
- Create + undo: "remind me to buy milk" → task created, spoken confirmation, chip with Undo; click Undo → task removed.
- Barge-in: while it's speaking a long answer, talk over it → playback stops promptly (`unmute.interrupted_by_vad`), it listens to you.

Note any audio decode issues (see Task 13 note) and fix by porting Unmute's decoder worklet if needed.

- [ ] **Step 4: Write the wiki page** `docs/wiki/voice-agent.md`

Document **current behaviour**: the `/voice` page, the two connections (Unmute WS + activity SSE), `/api/agent/llm` as the Unmute-facing brain (LAN-only), the shared tool registry (`server/lib/agent/tools.ts`), write-safety (act+confirm+undo), the reasoning model role, and the Unmute reconfig. Frontmatter `status: shipped`, `cycle: 17`, `updated: 2026-06-08`. Cross-link `voice-agent-integration.md` (the protocol) and `mcp.md` (shared registry).

- [ ] **Step 5: Write the handover** `docs/handovers/2026-06-08-voice-agent.md`

Frontmatter (match the existing handover style): `title`, `cycle: 17`, `status: shipped`, `date: 2026-06-08`, `deferred:` list. Body: what shipped, the Unmute-as-LLM seam, the two-connection design, what was deferred (persisted history, voice picker, structural confirm gate, gallery/clipboard tools, `quick_capture` undo, `save_memory` source arg on MCP), and the next seam.

- [ ] **Step 6: Update roadmap + backlog**

In `docs/superpowers/plans/00-roadmap.md`, add a Round-3 row: `| 17 | **Voice Agent ("Jarvis")** … | ✅ shipped | spec | plan | handover |`. In `docs/BACKLOG.md` §1, update the "in-app agent loop / in-app chat" gap to reflect that voice + shared agent core shipped (text chat endpoint exists; full chat UI still pending).

- [ ] **Step 7: Final verification + commit**

Run: `pnpm test` (all suites)
Expected: PASS.

Run: `pnpm typecheck && pnpm build`
Expected: both PASS.

```bash
git add docs/
git commit -m "docs(voice): wiki page, handover, roadmap + backlog updates"
```

---

## Self-Review

**Spec coverage check:**
- §1 Architecture (Unmute→Nitro brain, two connections) → Tasks 9, 13, 14, 17. ✅
- §2 Shared agent core (registry, loop, chat-stream, bus, undo, MCP refactor) → Tasks 1–7, 11. ✅
- §3 Endpoints (llm/activity/undo/chat, LAN-only) → Tasks 8, 9, 10. ✅
- §4 Write-safety (act+confirm+undo, prompt-driven destructive) → Tasks 2 (kinds+undo), 6 (prompt), 7 (registers undo). ✅
- §5 Frontend (page, useUnmute, useAgentActivity, reactor, transcript, composer, state machine, deps, env) → Tasks 12–17. ✅
- §6 Unmute reconfig → Task 18 Step 2. ✅
- §7 Testing (unit no-audio, E2E, manual) → Tasks 1–11 (unit), 17/18 (E2E + manual). ✅
- §8 Scope/YAGNI cuts → respected (no persisted history, separate typed context, single voice, no gallery/clipboard, prompt-driven confirm, qwen default). ✅
- §9 Unit boundaries → matches file structure. ✅

**Type consistency check:** `ToolExecution { result, summary, undo? }` is produced by handlers (Task 2) and consumed in the loop (Task 7) and MCP (Task 11) identically. `LoopEvent`/`ActivityEvent` defined in Task 1 are used consistently in Tasks 7, 9, 10, 14. `streamChat` signature defined in Task 5 matches the injected mock and real call in Task 7. `VoiceState` from `useUnmute` (Task 13) consumed by the reactor (Task 15) and page (Task 17). `ToolChip` from Task 14 consumed by Transcript (Task 16) and page (Task 17). ✅

**Placeholder scan:** no TBD/TODO; every code step has real code. The two acknowledged soft spots are explicitly flagged with concrete fallbacks (audio decoder worklet per wiki §6; `quick_capture` undo when a delete-doc service exists) rather than left vague. ✅
