# Bridget Toolsets Implementation Plan (cycle 78)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridget sees ~25 core tool schemas per step instead of ~53; the rest live in on-demand toolsets she loads herself (or that auto-load when she calls one of their tools), persisted per conversation.

**Architecture:** Every `AgentTool` gets a required `toolset` tag; a pure `toolsets.ts` registry says which sets are core. `runAgent` keeps a per-run `loaded` set and returns `activeTools` from the AI SDK's existing `prepareStep` hook — the full ToolSet is still built, so a call to an unloaded tool still parses and runs (it just loads its set). The runtime runner reads/writes `conversations.active_toolsets`; jobs declare `toolsets:` in frontmatter, which travels job → wake → `RunInput` → runner like `context:` already does.

**Tech Stack:** Nuxt 4 / Nitro, AI SDK v6 (`ai@6.0.198`), drizzle + Postgres, vitest (`MockLanguageModelV3` from `ai/test`).

**Spec:** `docs/superpowers/specs/2026-10-03-bridget-toolsets-design.md`

## Deviations from the spec (decided while planning)

1. **Job toolsets are a frontmatter key (`toolsets: [images]`), not an `agent_jobs.toolsets` column.** Jobs are markdown; every other job setting (`context`, `thread`, `deliver`) is frontmatter parsed by `jobs/parse.ts` and carried on the wake request. A column would be a second source of truth. No job-editor UI change is needed (the editor edits the markdown).
2. **Migration is 0066**, not 0065 (0064/0065 already exist on master). It only adds `conversations.active_toolsets`.
3. **`/clear` also resets `active_toolsets`** (spec was silent; main is a permanent thread and would otherwise accumulate sets forever).
4. **Auto-load also triggers on an INVALID call to an unloaded tool** (spec D3 covered valid calls). An invalid call never reaches `execute`, so without this the model would never get the schema it needs to fix its arguments.

## Global Constraints

- `pnpm` only. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build` (lint is red repo-wide and is NOT a gate). DB tests: `pnpm test:db`.
- No tool's behaviour, schema, kind, approval, or headless classification changes. Only which schemas are visible per step.
- `/api/mcp` keeps exposing every non-dangerous `agentTools` entry. `load_toolsets` must NOT appear on MCP (it lives in `bridgetProfile`, not `agentTools`).
- Subagents (`research_web`, `search_brain`) and the legacy `server/api/agent/chat.post.ts` path pass no `ctx.toolsets` → every tool stays active, exactly as today.
- Commit messages: conventional style, **no co-author or model attribution trailers** (Tony's global rule).
- Work only in the worktree `.claude/worktrees/feat+bridget-toolsets` on branch `feat/bridget-toolsets`.

## Review Focus

1. **Main thread never shrinks** — loaded sets persist on the permanent main thread; `/clear` must reset them. Test in Task 3.
2. **Invalid args to an unloaded tool** — the model never saw the schema; the next step must include it. Test in Task 2.
3. **Headless runs** — loading a set must never expose a tool the headless gate excluded (`decide_review` is in `reviews`; `exec` is core but excluded headless). Test in Task 2.
4. **Stale ids** — a renamed/removed toolset id in `active_toolsets` or job frontmatter must be ignored (column) / rejected with a clear parse error (frontmatter). Tests in Tasks 1 and 3.
5. **Persist failure** — a throwing `onChange` (DB down) must not fail the turn. Test in Task 2.

---

### Task 1: Toolset registry + tag every tool

**Files:**
- Create: `server/lib/agent/toolsets.ts`
- Create: `server/lib/agent/toolsets.test.ts`
- Modify: `server/lib/agent/types.ts` (add `toolset` to `AgentTool`)
- Modify (add `toolset:` to every tool literal): `server/lib/agent/tools.ts`, `server/lib/agent/tools/*.ts` (jobs, channels/send_message, reviews, improvements, exec, any others found), `server/lib/agent/subagents.ts` (`makeSubagentTool` output gets `toolset: 'web'`)
- Modify: any test file that builds an `AgentTool` literal (typecheck will list them — add `toolset: 'core'` to fakes)

**Interfaces:**
- Produces:
  ```ts
  export type ToolsetId = 'memory' | 'docs' | 'tasks' | 'web' | 'core'
    | 'history' | 'projects' | 'doc-admin' | 'images' | 'jobs' | 'skill-admin' | 'reviews' | 'improvements' | 'channels'
  export const TOOLSETS: Record<ToolsetId, { core: boolean; description: string }>
  export function isToolsetId(x: unknown): x is ToolsetId
  export function parseToolsetIds(raw: unknown): ToolsetId[]          // keeps known NON-core ids, dedups, drops the rest
  export function activeToolNames(registry: AgentTool[], loaded: ReadonlySet<ToolsetId>): string[]
  export function directoryText(registry: AgentTool[], loaded: ReadonlySet<ToolsetId>): string   // '' when no on-demand set has a tool in registry
  export const ON_DEMAND_TOOLSETS: ToolsetId[]                        // non-core ids, in TOOLSETS order
  ```
  `AgentTool.toolset: ToolsetId` (required).

- [ ] **Step 1: Write the failing test** — `server/lib/agent/toolsets.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { TOOLSETS, parseToolsetIds, activeToolNames, directoryText, ON_DEMAND_TOOLSETS } from './toolsets'
import { bridgetProfile } from './profile'
import type { AgentTool } from './types'

const t = (name: string, toolset: AgentTool['toolset']): AgentTool =>
  ({ name, toolset, description: name, kind: 'read', schema: {}, handler: async () => ({ result: null, summary: '' }) })

describe('toolset registry', () => {
  it('every Bridget tool has a known toolset', () => {
    for (const tool of bridgetProfile.tools) expect(TOOLSETS[tool.toolset], tool.name).toBeDefined()
  })
  it('every on-demand toolset has a directory line and at least one tool', () => {
    for (const id of ON_DEMAND_TOOLSETS) {
      expect(TOOLSETS[id].description.length, id).toBeGreaterThan(10)
      expect(bridgetProfile.tools.some(x => x.toolset === id), id).toBe(true)
    }
  })
  it('core is ~25 tools (spec §3)', () => {
    const core = activeToolNames(bridgetProfile.tools, new Set())
    expect(core.length).toBeGreaterThanOrEqual(22)
    expect(core.length).toBeLessThanOrEqual(28)
    expect(core).toEqual(expect.arrayContaining(['search_tasks', 'web_search', 'exec', 'search_memories', 'search_docs']))
    expect(core).not.toContain('generate_image')
    expect(core).not.toContain('search_sessions')
  })
  it('spec §3 placements', () => {
    const where = Object.fromEntries(bridgetProfile.tools.map(x => [x.name, x.toolset]))
    expect(where).toMatchObject({
      search_sessions: 'history', read_around_message: 'history', search_projects: 'projects',
      move_document: 'doc-admin', generate_image: 'images', schedule_wake: 'jobs', create_skill: 'skill-admin',
      decide_review: 'reviews', list_improvements: 'improvements', send_message: 'channels',
      research_web: 'web', search_brain: 'web', exec: 'core', use_skill: 'core', quick_capture: 'tasks'
    })
  })
})

describe('parseToolsetIds', () => {
  it('keeps known on-demand ids, drops core/unknown/non-strings, dedups', () => {
    expect(parseToolsetIds(['images', 'memory', 'nope', 3, 'images', 'jobs'])).toEqual(['images', 'jobs'])
  })
  it('non-array → []', () => {
    expect(parseToolsetIds(null)).toEqual([])
    expect(parseToolsetIds('images')).toEqual([])
  })
})

describe('activeToolNames', () => {
  const reg = [t('a', 'memory'), t('b', 'images'), t('c', 'jobs')]
  it('core only by default', () => expect(activeToolNames(reg, new Set())).toEqual(['a']))
  it('core + loaded', () => expect(activeToolNames(reg, new Set(['images']))).toEqual(['a', 'b']))
})

describe('directoryText', () => {
  const reg = [t('a', 'memory'), t('b', 'images'), t('c', 'jobs')]
  it('lists only on-demand sets present in the registry and marks loaded ones', () => {
    const txt = directoryText(reg, new Set(['images']))
    expect(txt).toContain('load_toolsets')
    expect(txt).toMatch(/- images — .*\(loaded\)/)
    expect(txt).toMatch(/- jobs — /)
    expect(txt).not.toContain('- history')
  })
  it('empty when nothing on demand', () => expect(directoryText([t('a', 'memory')], new Set())).toBe(''))
})
```

- [ ] **Step 2: Run it — expect FAIL** (`pnpm vitest run server/lib/agent/toolsets.test.ts` → cannot resolve `./toolsets`).

- [ ] **Step 3: Implement `server/lib/agent/toolsets.ts`**

```ts
// server/lib/agent/toolsets.ts
// Cycle 78: every tool belongs to one toolset. Core sets are always visible to the model; on-demand
// sets are listed in a one-line-each directory and become visible once loaded (load_toolsets, or
// auto-loaded when Bridget calls one of their tools). Visibility only — never availability: the
// full ToolSet is always built, so behaviour, approvals and the headless gate are unchanged.
import type { AgentTool } from './types'

export type ToolsetId = 'memory' | 'docs' | 'tasks' | 'web' | 'core'
  | 'history' | 'projects' | 'doc-admin' | 'images' | 'jobs' | 'skill-admin' | 'reviews' | 'improvements' | 'channels'

// Directory lines say WHEN to load the set, not only what is in it (spec §3).
export const TOOLSETS: Record<ToolsetId, { core: boolean; description: string }> = {
  memory: { core: true, description: 'memories' },
  docs: { core: true, description: 'documents' },
  tasks: { core: true, description: 'tasks and quick capture' },
  web: { core: true, description: 'web search and research subagents' },
  core: { core: true, description: 'shell, skills, toolset loading' },
  history: { core: false, description: "Tony's Claude Code sessions and past messages: what he did, when, in which project" },
  projects: { core: false, description: 'look up, create or edit projects' },
  'doc-admin': { core: false, description: 'move, delete or sync documents' },
  images: { core: false, description: 'generate a new image or edit the last one' },
  jobs: { core: false, description: 'create, edit, run or schedule background jobs and wake-ups' },
  'skill-admin': { core: false, description: 'create, edit or delete skills' },
  reviews: { core: false, description: "list or decide items in Tony's /review queue" },
  improvements: { core: false, description: 'what Bridget has learned or changed about herself' },
  channels: { core: false, description: 'send Tony a message over iMessage or email' }
}

export const ON_DEMAND_TOOLSETS = (Object.keys(TOOLSETS) as ToolsetId[]).filter(id => !TOOLSETS[id].core)

export function isToolsetId(x: unknown): x is ToolsetId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(TOOLSETS, x)
}

/** Stored/declared ids → known on-demand ids. Unknown (renamed/removed) and core ids are dropped. */
export function parseToolsetIds(raw: unknown): ToolsetId[] {
  if (!Array.isArray(raw)) return []
  const out: ToolsetId[] = []
  for (const x of raw) if (isToolsetId(x) && !TOOLSETS[x].core && !out.includes(x)) out.push(x)
  return out
}

export function activeToolNames(registry: AgentTool[], loaded: ReadonlySet<ToolsetId>): string[] {
  return registry.filter(t => TOOLSETS[t.toolset].core || loaded.has(t.toolset)).map(t => t.name)
}

export function directoryText(registry: AgentTool[], loaded: ReadonlySet<ToolsetId>): string {
  const present = ON_DEMAND_TOOLSETS.filter(id => registry.some(t => t.toolset === id))
  if (!present.length) return ''
  return [
    'TOOLSETS — more tools are available on demand. Call `load_toolsets` with the ids you need before using them (calling one of their tools directly also loads it):',
    ...present.map(id => `- ${id} — ${TOOLSETS[id].description}${loaded.has(id) ? ' (loaded)' : ''}`)
  ].join('\n')
}
```

- [ ] **Step 4: Add `toolset: ToolsetId` to `AgentTool`** in `types.ts` (import type from `./toolsets`), with a one-line comment: `/** Cycle 78: which toolset this tool belongs to (visibility only — see toolsets.ts). */`

- [ ] **Step 5: Tag every tool.** Run `pnpm typecheck` and add `toolset:` to each literal it flags, using this exact mapping (spec §3):
  - `memory`: search_memories, get_recent_memories, save_memory, forget_memory
  - `docs`: search_docs, search_passages, list_documents, read_document, get_document, grep_document, save_document, edit_document, edit_section, update_document
  - `tasks`: search_tasks, create_task, edit_task, delete_task, quick_capture
  - `web`: web_search, web_fetch, research_web, search_brain (in `makeSubagentTool`'s returned object)
  - `core`: exec, use_skill
  - `history`: search_sessions, read_session, search_messages, read_around_message
  - `projects`: search_projects, get_project, create_project, edit_project
  - `doc-admin`: move_document, delete_document, sync_document
  - `images`: generate_image, edit_image
  - `jobs`: list_jobs, get_job, create_job, edit_job, delete_job, run_job, schedule_wake
  - `skill-admin`: create_skill, edit_skill, delete_skill
  - `reviews`: list_reviews, decide_review
  - `improvements`: list_improvements
  - `channels`: send_message
  If a tool exists that is not in this list, STOP and report it (do not guess).
  Test fakes that build `AgentTool` literals get `toolset: 'core'`.

- [ ] **Step 6: Run** `pnpm vitest run server/lib/agent/toolsets.test.ts` → PASS; `pnpm typecheck` → 0 errors; `pnpm test` → green.

- [ ] **Step 7: Commit** — `git commit -am "feat(agent): toolset registry; tag every Bridget tool (cycle 78)"` (plus `git add` the two new files).

---

### Task 2: load_toolsets + per-step activeTools + auto-load + prompt directory

**Files:**
- Create: `server/lib/agent/tools/load-toolsets.ts`
- Create: `server/lib/agent/run-toolsets.test.ts`
- Modify: `server/lib/agent/types.ts` (`ToolContext.loadToolsets?`)
- Modify: `server/lib/agent/ai-tools.ts` (`RunHooks.onToolCalled?`, `RunHooks.loadToolsets?`)
- Modify: `server/lib/agent/run.ts` (ctx.toolsets, loaded set, prepareStep activeTools + scan, forced-final, prompt directory, rewrite "always fully armed" comment)
- Modify: `server/lib/agent/profile.ts` (add `loadToolsetsTool`; rewrite comment)
- Modify: `server/lib/agent/prompt.ts` (`toolsetDirectory` option)
- Modify: `server/lib/agent/prompt.test.ts` (directory rendered)

**Interfaces:**
- Consumes (Task 1): `ToolsetId`, `parseToolsetIds`, `activeToolNames`, `directoryText`, `TOOLSETS`.
- Produces:
  ```ts
  // run.ts ctx
  toolsets?: { initial: ToolsetId[]; onChange?: (loaded: ToolsetId[]) => void | Promise<void> }
  // types.ts ToolContext
  loadToolsets?: (ids: ToolsetId[]) => ToolsetId[]   // returns ids newly loaded
  // ai-tools.ts RunHooks
  onToolCalled?: (name: string) => void
  loadToolsets?: (ids: ToolsetId[]) => ToolsetId[]
  // prompt.ts
  buildSystemPrompt(opts: { …existing; toolsetDirectory?: string })
  composePrompt(opts: { …existing; toolsetDirectory?: string })
  // tools/load-toolsets.ts
  export const loadToolsetsTool: AgentTool   // name 'load_toolsets', toolset 'core', kind 'read'
  ```

- [ ] **Step 1: Write the failing tests** — `server/lib/agent/run-toolsets.test.ts`. Uses the REAL `streamText` with `MockLanguageModelV3` (pattern from `run-live-events.test.ts`) and records the tool names the model was offered on each call (`options.tools`).

```ts
import { describe, it, expect } from 'vitest'
import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { runAgent } from './run'
import { loadToolsetsTool } from './tools/load-toolsets'
import type { AgentTool } from './types'
import type { ToolsetId } from './toolsets'

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
const finish = (r: 'tool-calls' | 'stop') => ({ type: 'finish', finishReason: { unified: r, raw: undefined }, usage })
const text = (s: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }]
const call = (id: string, toolName: string, input: unknown) => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) })

/** steps[i] = chunks the model emits on call i (last entry repeats). Records offered tool names per call. */
function scripted(steps: unknown[][]) {
  const offered: string[][] = []
  let i = 0
  const model = new MockLanguageModelV3({
    doStream: async (opts: { tools?: Array<{ name: string }> }) => {
      offered.push((opts.tools ?? []).map(t => t.name).sort())
      const chunks = steps[Math.min(i++, steps.length - 1)]!
      return { stream: convertArrayToReadableStream(chunks as never) }
    }
  })
  return { model, offered }
}

const ran: string[] = []
const mk = (name: string, toolset: ToolsetId, schema: AgentTool['schema'] = {}): AgentTool =>
  ({ name, toolset, description: name, kind: 'read', schema, handler: async () => { ran.push(name); return { result: { ok: true }, summary: name } } })
const registry = [mk('core_read', 'memory'), loadToolsetsTool, mk('gen', 'images', { prompt: z.string() }), mk('jobby', 'jobs')]

async function run(model: MockLanguageModelV3, toolsets?: { initial: ToolsetId[]; onChange?: (l: ToolsetId[]) => void | Promise<void> }, tools = registry) {
  ran.length = 0
  for await (const _ of runAgent([{ role: 'user', content: 'hi' }], { signal: new AbortController().signal, maxSteps: 5, toolsets },
    { streamText: ((a: Parameters<typeof streamText>[0]) => streamText({ ...a, model })) as never, tools, buildSystemPrompt: async () => 's' })) { /* drain */ }
}

describe('runAgent toolsets', () => {
  it('offers only core tools when nothing is loaded', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, { initial: [] })
    expect(offered[0]).toEqual(['core_read', 'load_toolsets'])
  })

  it('offers loaded sets from initial', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, { initial: ['images'] })
    expect(offered[0]).toEqual(['core_read', 'gen', 'load_toolsets'])
  })

  it('without ctx.toolsets every tool is offered (subagents, legacy callers)', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, undefined)
    expect(offered[0]).toEqual(['core_read', 'gen', 'jobby', 'load_toolsets'])
  })

  it('load_toolsets makes the set visible on the next step and fires onChange', async () => {
    const changes: ToolsetId[][] = []
    const { model, offered } = scripted([[call('c1', 'load_toolsets', { ids: ['jobs'] }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await run(model, { initial: [], onChange: l => { changes.push(l) } })
    expect(offered[1]).toContain('jobby')
    expect(changes).toEqual([['jobs']])
  })

  it('a direct call to an unloaded tool runs and loads its set (D3)', async () => {
    const changes: ToolsetId[][] = []
    const { model, offered } = scripted([[call('c1', 'gen', { prompt: 'x' }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await run(model, { initial: [], onChange: l => { changes.push(l) } })
    expect(ran).toContain('gen')
    expect(offered[1]).toContain('gen')
    expect(changes).toEqual([['images']])
  })

  it('an INVALID call to an unloaded tool still loads its set so the model sees the schema next step', async () => {
    const { model, offered } = scripted([[call('c1', 'gen', { wrong: 1 }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await run(model, { initial: [] })
    expect(ran).not.toContain('gen')
    expect(offered[1]).toContain('gen')
  })

  it('a throwing onChange does not fail the turn', async () => {
    const { model } = scripted([[call('c1', 'gen', { prompt: 'x' }), finish('tool-calls')], [...text('ok'), finish('stop')]])
    await expect(run(model, { initial: [], onChange: () => { throw new Error('db down') } })).resolves.toBeUndefined()
    expect(ran).toContain('gen')
  })

  it('a tool absent from the registry (headless-excluded) is never offered even if its set is loaded', async () => {
    const { model, offered } = scripted([[...text('hi'), finish('stop')]])
    await run(model, { initial: ['jobs'] }, registry.filter(t => t.name !== 'jobby'))
    expect(offered[0]).not.toContain('jobby')
  })
})
```

Add to `server/lib/agent/prompt.test.ts`:

```ts
it('renders the toolset directory after the tool rules and before skills', () => {
  const p = composePrompt({ persona: 'P', speak: false, toneLine: 't', toolsetDirectory: 'TOOLSETS — x', skillsIndex: 'SKILLS — y' })
  expect(p).toContain('TOOLSETS — x')
  expect(p.indexOf('TOOLSETS — x')).toBeLessThan(p.indexOf('SKILLS — y'))
  expect(p.indexOf('SHELL —')).toBeLessThan(p.indexOf('TOOLSETS — x'))
})
```

- [ ] **Step 2: Run** `pnpm vitest run server/lib/agent/run-toolsets.test.ts server/lib/agent/prompt.test.ts` → FAIL (missing module / option).

- [ ] **Step 3: `server/lib/agent/tools/load-toolsets.ts`**

```ts
// Cycle 78: Bridget loads on-demand toolsets herself. Lives in bridgetProfile (not agentTools),
// so /api/mcp never exposes it — MCP clients already see every tool.
import { z } from 'zod'
import type { AgentTool } from '../types'
import { ON_DEMAND_TOOLSETS, TOOLSETS, type ToolsetId } from '../toolsets'

export const loadToolsetsTool: AgentTool = {
  name: 'load_toolsets',
  toolset: 'core',
  kind: 'read',
  description: 'Make on-demand toolsets available from your next step on (see the TOOLSETS list in your instructions). They stay loaded for the rest of this conversation.',
  schema: { ids: z.array(z.enum(ON_DEMAND_TOOLSETS as [ToolsetId, ...ToolsetId[]])).min(1) },
  handler: async (args, ctx) => {
    const ids = args.ids as ToolsetId[]
    const added = ctx.loadToolsets?.(ids) ?? []
    const names = ids.map(id => `${id} (${TOOLSETS[id].description})`).join(', ')
    return { result: { loaded: ids, newlyLoaded: added }, summary: `loaded ${names}` }
  }
}
```

- [ ] **Step 4: `types.ts`** — add to `ToolContext`:
```ts
  /** Cycle 78: load on-demand toolsets for the rest of this run (+ persisted by the runner). Absent on MCP. */
  loadToolsets?: (ids: import('./toolsets').ToolsetId[]) => import('./toolsets').ToolsetId[]
```

- [ ] **Step 5: `ai-tools.ts`** — `RunHooks` gains `onToolCalled?: (name: string) => void` and `loadToolsets?: (ids: ToolsetId[]) => ToolsetId[]`. Put `loadToolsets: hooks.loadToolsets` into the shared `ctx`. As the FIRST line of `execute`, call `hooks.onToolCalled?.(t.name)` (before redaction/approval — the call happened; a denial still means the model wants that set visible).

- [ ] **Step 6: `run.ts`**
  - Extend `runAgent`'s `ctx` type with `toolsets?: { initial: ToolsetId[]; onChange?: (loaded: ToolsetId[]) => void | Promise<void> }` and `RunDeps.buildSystemPrompt`'s opts with `toolsetDirectory?: string`.
  - After `registry` is resolved:
  ```ts
  // Cycle 78: on-demand toolsets. Absent ctx.toolsets (subagents, legacy chat.post) = every tool visible.
  const loaded = new Set<ToolsetId>(parseToolsetIds(ctx.toolsets?.initial ?? []))
  const setOf = new Map(registry.map(t => [t.name, t.toolset]))
  const loadToolsets = (ids: ToolsetId[]): ToolsetId[] => {
    const added = parseToolsetIds(ids).filter(id => !loaded.has(id))
    if (!added.length) return []
    for (const id of added) loaded.add(id)
    const snapshot = [...loaded]
    // Fire-and-forget: losing one write only costs a reload next turn (spec §6).
    Promise.resolve().then(() => ctx.toolsets?.onChange?.(snapshot)).catch((err: unknown) =>
      recordEvent({ kind: 'tool', name: 'toolsets:persist', status: 'error', severity: 'warn', error: { message: (err as Error).message } }))
    return added
  }
  const loadForTool = (name: string) => { const id = setOf.get(name); if (id) loadToolsets([id]) }
  const visibleTools = (): string[] | undefined => ctx.toolsets ? activeToolNames(registry, loaded) : undefined
  ```
  - Pass `onToolCalled: loadForTool, loadToolsets` into `buildAiTools(...)` hooks.
  - Pass `toolsetDirectory: ctx.toolsets ? directoryText(registry, loaded) : undefined` to `buildPrompt(...)`.
  - In `prepareStep`, widen the param type to include `steps?: Array<{ content?: Array<{ type?: string; toolName?: string }> }>`, and before building `out`:
  ```ts
  // An invalid call never reaches execute(); load its set here so the model sees the schema next step.
  for (const p of steps?.at(-1)?.content ?? []) if ((p.type === 'tool-call' || p.type === 'tool-error') && p.toolName) loadForTool(p.toolName)
  ```
  and widen `out` to `{ toolChoice?: 'none'; messages?: never; activeTools?: string[] }`, setting `const vis = visibleTools(); if (vis) out.activeTools = vis`.
  - Forced-final follow-up: when `sawTextToolCallMarker` (tools allowed), spread `...(visibleTools() ? { activeTools: visibleTools() } : {})` into the follow-up call.
  - Replace the comment above `runAgent` ("The agent is ALWAYS fully armed…") with: "Every tool in the profile is always AVAILABLE (the full ToolSet is built each run). Cycle 78: only core + loaded toolsets are VISIBLE per step (prepareStep → activeTools); a call to a hidden tool still runs and loads its set. Safety lives in the approval gate, not in tool stripping."

  If `steps[].content` does not carry `tool-call`/`tool-error` parts with `toolName` in this SDK version, read `steps.at(-1)?.toolCalls` instead and confirm the INVALID-call test still goes red without the scan (mutation check, Step 8).

- [ ] **Step 7: `prompt.ts`** — `composePrompt` opts gain `toolsetDirectory?: string`; push `'', opts.toolsetDirectory` right BEFORE the `skillsIndex` line. `buildSystemPrompt` opts gain `toolsetDirectory?: string` and pass it through. **`profile.ts`**: `tools: [...agentTools, execTool, ...subagentTools, decideReviewTool, loadToolsetsTool]`; update its comment: one profile, every tool available, on-demand sets only change visibility.

- [ ] **Step 8: Run tests + mutation check**
  - `pnpm vitest run server/lib/agent/run-toolsets.test.ts server/lib/agent/prompt.test.ts server/lib/agent/toolsets.test.ts` → PASS.
  - Mutation: comment out the `prepareStep` scan loop → the INVALID-call test must FAIL; comment out `hooks.onToolCalled?.(t.name)` → the direct-call test's `changes` assertion must FAIL. Restore with `git checkout -- <file>` after each (never shell-variable backups). Record both red runs in the report.
  - `pnpm typecheck` → 0; `pnpm test` → green.
  - Confirm `load_toolsets` is classified `run` headless (it is `kind: 'read'`) — add to `server/lib/agent/runtime/gate.test.ts` (or the existing gate test file): `expect(classifyForHeadless(loadToolsetsTool)).toBe('run')`.
  - Confirm MCP: add to the existing MCP server test (or `tools.test.ts`): `expect(agentTools.map(t => t.name)).not.toContain('load_toolsets')`.

- [ ] **Step 9: Commit** — `feat(agent): on-demand toolsets — load_toolsets, per-step activeTools, auto-load (cycle 78)`

---

### Task 3: Persistence, runner wiring, job frontmatter, /clear reset

**Files:**
- Modify: `server/db/schema/conversations.ts` (`activeToolsets`)
- Create: `server/db/migrations/0066_*.sql` via `pnpm db:generate` (must contain only the one `ALTER TABLE "conversations" ADD COLUMN "active_toolsets" text[] DEFAULT '{}' NOT NULL;`)
- Modify: `server/lib/agent/runtime/types.ts` (`RunInput.toolsets?: string[]`)
- Modify: `server/lib/agent/runtime/wake.ts` (`WakeRequest.toolsets?`, copied into `input`)
- Modify: `server/lib/agent/jobs/parse.ts` (`toolsets` key → `JobSpec.toolsets: ToolsetId[]`)
- Modify: `server/lib/agent/jobs/tick.ts` (`wakeRequestFor` passes `toolsets` when non-empty)
- Modify: `server/lib/agent/tools/jobs.ts` (create_job description lists `toolsets`)
- Modify: `server/lib/voice/orchestrator.ts` (`TurnDeps.toolsets?` forwarded into runAgent ctx; widen the `runAgent` type at line ~63)
- Modify: `server/lib/agent/runtime/runner.ts` (read + merge + persist)
- Modify: `server/services/conversation-clear.ts` (reset `activeToolsets: []`)
- Tests: `server/lib/agent/jobs/parse.test.ts`, `server/lib/agent/jobs/tick.test.ts` (or wherever `wakeRequestFor` is tested), `test/agent-runner.db.test.ts`, the clear service's DB test (find with `grep -rln clearConversationContext test server`).

**Interfaces:**
- Consumes: `parseToolsetIds`, `ON_DEMAND_TOOLSETS`, `ToolsetId` (Task 1); `runAgent` ctx `toolsets` (Task 2).
- Produces: `conversations.activeToolsets: string[]`; `JobSpec.toolsets: ToolsetId[]`; `RunInput.toolsets?: string[]`; `TurnDeps.toolsets?: { initial: ToolsetId[]; onChange?: (l: ToolsetId[]) => void | Promise<void> }`.

- [ ] **Step 1: Failing tests**

`parse.test.ts`:
```ts
describe('toolsets key', () => {
  const base = '---\ntrigger: every 1h\n'
  it('defaults to []', () => {
    const r = parseJob(`${base}---\nbody`, { defaultTimezone: 'UTC' })
    expect(r.ok && r.spec.toolsets).toEqual([])
  })
  it('accepts on-demand ids', () => {
    const r = parseJob(`${base}toolsets: [images, jobs]\n---\nbody`, { defaultTimezone: 'UTC' })
    expect(r.ok && r.spec.toolsets).toEqual(['images', 'jobs'])
  })
  it('rejects unknown or core ids with the allowed list', () => {
    const r = parseJob(`${base}toolsets: [gmail]\n---\nbody`, { defaultTimezone: 'UTC' })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toMatch(/invalid toolsets: gmail \(allowed: history, projects/)
    expect(parseJob(`${base}toolsets: [memory]\n---\nbody`, { defaultTimezone: 'UTC' }).ok).toBe(false)
  })
})
```

`wakeRequestFor` test:
```ts
it('carries job toolsets onto the wake request only when declared', () => {
  expect(wakeRequestFor('s', 'j', { ...spec, toolsets: ['images'] }, 'p').toolsets).toEqual(['images'])
  expect(wakeRequestFor('s', 'j', { ...spec, toolsets: [] }, 'p')).not.toHaveProperty('toolsets')
})
```
(`spec` = whatever JobSpec fixture that test file already uses, plus `toolsets: []`.)

`test/agent-runner.db.test.ts` — follow that file's existing fake-`runAgent` harness; add:
```ts
it('passes stored + run-input toolsets to runAgent and persists onChange', async () => {
  // arrange: conversation with active_toolsets ['history'] + a run whose input.toolsets = ['images', 'bogus']
  // fake runAgent captures ctx.toolsets.initial, then calls ctx.toolsets.onChange(['history','images','jobs'])
  // assert: initial === ['history','images'] (bogus dropped), and after the turn
  //   select active_toolsets from conversations → ['history','images','jobs']
})
```
(Write it concretely with the file's existing helpers — insert rows the way its other tests do.)

Clear service DB test:
```ts
it('/clear resets active_toolsets', async () => {
  // conversation with active_toolsets ['images'] → clearConversationContext(id) → column is []
})
```

- [ ] **Step 2: Run them → FAIL.**

- [ ] **Step 3: Schema + migration.** In `conversations.ts` add (import `text` already present; use `.array()`):
```ts
  /** Cycle 78: on-demand toolsets loaded in this conversation (core sets are never stored).
   *  Read + written by runtime/runner.ts; reset by /clear. Unknown ids are ignored on read. */
  activeToolsets: text('active_toolsets').array().notNull().default(sql`'{}'::text[]`),
```
Run `pnpm db:generate`; verify the new SQL file is exactly the one ALTER; run `pnpm db:migrate` (dev DB).

- [ ] **Step 4: Jobs.** `parse.ts`: add `'toolsets'` to `ACCEPTED_KEYS`; `JobSpec.toolsets: ToolsetId[]`; parse:
```ts
  let toolsets: ToolsetId[] = []
  if (data.toolsets !== undefined) {
    const allowed = ON_DEMAND_TOOLSETS.join(', ')
    if (!Array.isArray(data.toolsets) || !data.toolsets.every(x => typeof x === 'string')) return { ok: false, error: `invalid toolsets: ${String(data.toolsets)} (allowed: ${allowed})` }
    const bad = data.toolsets.find(x => !parseToolsetIds([x]).length)
    if (bad !== undefined) return { ok: false, error: `invalid toolsets: ${bad} (allowed: ${allowed})` }
    toolsets = parseToolsetIds(data.toolsets)
  }
```
and return it in `spec`. `tick.ts` `wakeRequestFor`: `...(spec.toolsets.length ? { toolsets: spec.toolsets } : {})`. `wake.ts`: `WakeRequest.toolsets?: string[]`, and `input: { …, ...(req.context ? {context} : {}), ...(req.toolsets?.length ? { toolsets: req.toolsets } : {}) }`. `runtime/types.ts`: `RunInput.toolsets?: string[]` with comment `/** Cycle 78: toolsets a job declared; loaded at run start. */`. `tools/jobs.ts` create_job description: add `toolsets` to the frontmatter key list (`… context, deliver, toolsets (on-demand toolsets the job needs, e.g. [images]), enabled`). Fix any other `JobSpec` literal typecheck flags (add `toolsets: []`).

- [ ] **Step 5: Orchestrator.** `TurnDeps.toolsets?: { initial: ToolsetId[]; onChange?: (l: ToolsetId[]) => void | Promise<void> }`; add `toolsets?: …` to the `runAgent` dep type's ctx; forward `toolsets: deps.toolsets` in the `run(messages, {...})` call at line ~157.

- [ ] **Step 6: Runner.** In `runTurn`, extend the existing `select({ kind, title })` to include `activeToolsets: conversations.activeToolsets`. Then before `handleTurn`:
```ts
    // Cycle 78: on-demand toolsets — what this conversation already loaded + what a job declared.
    const initialToolsets = parseToolsetIds([...(conv?.activeToolsets ?? []), ...(input.toolsets ?? [])])
    const toolsets = {
      initial: initialToolsets,
      onChange: async (loaded: ToolsetId[]) => {
        await useDb().update(conversations).set({ activeToolsets: loaded }).where(eq(conversations.id, conversationId))
      }
    }
```
and pass `toolsets` in the `handleTurn(...)` deps. (Errors from `onChange` are already caught and recorded inside `runAgent`.)
Job-declared sets are persisted only if the run's `onChange` fires — i.e. when Bridget loads something new. To make declared sets stick for later turns of an isolated job thread, also persist `initialToolsets` once when it differs from the stored value (same update, guarded by a string compare). Write that as:
```ts
    if (initialToolsets.join() !== parseToolsetIds(conv?.activeToolsets ?? []).join()) await toolsets.onChange(initialToolsets).catch(() => {})
```

- [ ] **Step 7: `/clear`.** In `conversation-clear.ts` add `activeToolsets: []` to the `.set({...})`, and one sentence to the doc comment: "Loaded toolsets (cycle 78) reset too — a cleared thread starts with only the core tools visible."

- [ ] **Step 8: Run** the four new tests → PASS; mutation: remove `activeToolsets: []` from clear → its test FAILS; restore via `git checkout`. Then `pnpm typecheck`, `pnpm test`, `pnpm test:db` → green.

- [ ] **Step 9: Commit** — `feat(agent): persist loaded toolsets per conversation; job toolsets frontmatter; /clear resets (cycle 78)`

---

### Task 4 (controller, not a subagent): measure, browser-validate, docs, deploy

- [ ] **Measure schema size.** Script in scratchpad: import `bridgetProfile`, `buildAiTools`, `activeToolNames`; serialize each tool's `z.toJSONSchema(z.object(t.schema))` + description; report total chars/≈tokens for all tools vs `activeToolNames(…, new Set())`. Record both numbers in the handover.
- [ ] **Browser (playwright-cli, `browser-testing` skill).** Dev on a spare port. New thread: "generate an image of a lighthouse at dusk" → image renders; tool chips show `load_toolsets` or a direct `generate_image`. Same thread: "make it night" → `edit_image`, no second load. New thread "what are my open tasks?" → only core tools. DB check: `select active_toolsets from conversations order by updated_at desc limit 2`.
- [ ] **Docs.** `docs/wiki/agent.md` (toolsets section: registry, directory, auto-load, persistence, `/clear`, job frontmatter); handover `docs/handovers/2026-10-03-bridget-toolsets.md` with frontmatter; roadmap row 78 → shipped; spec status → shipped with the four deviations noted. Mirror the wiki page via the `wiki-mirror` skill.
- [ ] **Merge + deploy.** Final whole-branch review → merge `feat/bridget-toolsets` to master → push → watch CD with `gh run watch <id> --exit-status` → verify prod: migration 0066 applied, `/api/health` 200, bundle contains `load_toolsets`, and one prod Bridget turn works.
