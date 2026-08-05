# Structural Tool-History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent see its own prior tool calls and results across turns, at both the live and resume seams, without unbounded prompt growth.

**Architecture:** A normalized `AgentToolRecord` rides on the assistant `AgentMessage` and persists additively onto the existing `conversation_messages.tool_calls` jsonb (no migration). A pure module applies tier/decay policy and expands records into AI SDK tool-call/tool-result message blocks; `runAgent` composes that with the existing `toModelContent` at a single call site, so the live and resumed paths cannot diverge.

**Tech Stack:** Nuxt 4 / Nitro, TypeScript, Vercel AI SDK v6 (`streamText`, `ModelMessage`), Drizzle + Postgres (jsonb), Vitest, playwright-cli for browser validation.

**Spec:** [`../specs/2026-08-05-structural-tool-history-design.md`](../specs/2026-08-05-structural-tool-history-design.md)

## Global Constraints

- Package manager is **pnpm**. Never npm/yarn.
- Gates: `pnpm typecheck` (0 errors), `pnpm test` (all pass), `pnpm build` (clean). Lint is red repo-wide and is **not** a gate.
- DB-backed tests must be named `*.db.test.ts` — they are excluded from `pnpm test` and run via `pnpm test:db`. **CI has no Postgres; a DB test in the normal suite breaks every deploy.**
- **No migration.** `conversation_messages.tool_calls` is untyped jsonb; all new keys are additive.
- **Never put a text marker for an image or attachment into model history.** Removing the artifact entirely is the rule (cycle 39). No `[image]`, no `[attachment]`, no placeholder string.
- `reasoning` stays display/storage only and never enters model history (cycle 45 invariant).
- Retention constants: window **N = 3** tool-bearing turns; read-result replay cap **1500** chars; write cap **8192** chars.
- Tool kinds are exactly `'read' | 'create' | 'destructive'` (`server/lib/agent/types.ts:33`).
- `.vue` changes must be validated with **playwright-cli** (use the `browser-testing` skill), never the Playwright MCP.

---

### Task 1: Pure tool-history core

The policy and block-expansion logic, with zero imports from `run.ts` (which would be circular), zero DB, and zero AI SDK.

**Files:**
- Create: `server/lib/agent/tool-history.ts`
- Test: `server/lib/agent/tool-history.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AgentToolRecord { callId: string; name: string; kind: 'read' | 'create' | 'destructive'; args: Record<string, unknown>; result: unknown; summary: string; undoToken?: string; textOffset: number }`
  - `const TOOL_HISTORY_WINDOW = 3`
  - `const READ_RESULT_CAP = 1500`
  - `const WRITE_RESULT_CAP = 8192`
  - `function capResult(result: unknown, max: number): unknown`
  - `function applyHistoryPolicy<T extends { role: string; toolRecords?: AgentToolRecord[] }>(messages: T[]): T[]`
  - `function toolBlocksFor(records: AgentToolRecord[]): { role: 'assistant' | 'tool'; content: unknown[] }[]`

- [ ] **Step 1: Write the failing tests**

Create `server/lib/agent/tool-history.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  capResult, applyHistoryPolicy, toolBlocksFor,
  READ_RESULT_CAP, type AgentToolRecord
} from './tool-history'

function rec(over: Partial<AgentToolRecord> = {}): AgentToolRecord {
  return {
    callId: 'call_1', name: 'web_search', kind: 'read',
    args: { query: 'x' }, result: { hits: ['a'] }, summary: 'searched',
    textOffset: 0, ...over
  }
}
const assistant = (records: AgentToolRecord[]) => ({ role: 'assistant', content: 'hi', toolRecords: records })

describe('capResult', () => {
  it('truncates an oversized result and marks it', () => {
    const out = capResult({ body: 'x'.repeat(5000) }, 100) as { truncated: boolean; preview: string }
    expect(out.truncated).toBe(true)
    expect(out.preview.length).toBeLessThanOrEqual(100)
  })

  it('returns small results untouched by identity', () => {
    const small = { ok: true, id: 'abc' }
    expect(capResult(small, 100)).toBe(small)
  })

  it('never throws on a circular result', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(capResult(circular, 100)).toEqual({ unserializable: true })
  })
})

describe('applyHistoryPolicy', () => {
  it('keeps results for the last 3 tool-bearing turns and elides older ones', () => {
    const msgs = [
      assistant([rec({ callId: 'old' })]),   // 4th newest -> elided
      assistant([rec({ callId: 'c3' })]),
      assistant([rec({ callId: 'c2' })]),
      assistant([rec({ callId: 'c1' })])     // newest -> kept
    ]
    const out = applyHistoryPolicy(msgs)
    expect(out[0]!.toolRecords![0]!.result).toEqual({ elided: true, bytes: expect.any(Number) })
    expect(out[3]!.toolRecords![0]!.result).toEqual({ hits: ['a'] })
  })

  it('ALWAYS keeps the call itself, however old', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => assistant([rec({ callId: `c${i}` })]))
    const out = applyHistoryPolicy(msgs)
    expect(out.every(m => m.toolRecords![0]!.callId)).toBe(true)
    expect(out.every(m => m.toolRecords![0]!.name === 'web_search')).toBe(true)
  })

  it('does not let plain chat turns consume the window', () => {
    const msgs = [
      assistant([rec({ callId: 'tool_turn' })]),
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' }, { role: 'assistant', content: 'f' }
    ]
    const out = applyHistoryPolicy(msgs as never[]) as typeof msgs
    expect((out[0] as typeof msgs[0]).toolRecords![0]!.result).toEqual({ hits: ['a'] })
  })

  it('caps read results but keeps write receipts whole', () => {
    const big = { body: 'y'.repeat(5000) }
    const out = applyHistoryPolicy([
      assistant([rec({ kind: 'read', result: big }), rec({ callId: 'w', kind: 'create', result: big })])
    ])
    expect((out[0]!.toolRecords![0]!.result as { truncated?: boolean }).truncated).toBe(true)
    expect(out[0]!.toolRecords![1]!.result).toBe(big)
  })

  it('leaves messages without toolRecords untouched by identity', () => {
    const plain = { role: 'assistant', content: 'no tools' }
    expect(applyHistoryPolicy([plain])[0]).toBe(plain)
  })
})

describe('toolBlocksFor', () => {
  it('pairs every tool-result with a preceding tool-call of the same id', () => {
    const blocks = toolBlocksFor([rec({ callId: 'a' }), rec({ callId: 'b', textOffset: 10 })])
    const callIds = blocks.filter(b => b.role === 'assistant')
      .flatMap(b => b.content as { toolCallId: string }[]).map(c => c.toolCallId)
    const resultIds = blocks.filter(b => b.role === 'tool')
      .flatMap(b => b.content as { toolCallId: string }[]).map(c => c.toolCallId)
    expect(resultIds.every(id => callIds.includes(id))).toBe(true)
    expect(resultIds).toEqual(['a', 'b'])
  })

  it('emits a tool message even when the result is elided (pairing must hold)', () => {
    const blocks = toolBlocksFor([rec({ result: { elided: true, bytes: 900 } })])
    expect(blocks.filter(b => b.role === 'tool')).toHaveLength(1)
  })

  it('groups calls sharing a textOffset into ONE block', () => {
    const blocks = toolBlocksFor([rec({ callId: 'a', textOffset: 0 }), rec({ callId: 'b', textOffset: 0 })])
    expect(blocks).toHaveLength(2)                       // one assistant + one tool
    expect(blocks[0]!.content).toHaveLength(2)
  })

  it('emits successive blocks for calls at different offsets', () => {
    const blocks = toolBlocksFor([rec({ callId: 'a', textOffset: 0 }), rec({ callId: 'b', textOffset: 40 })])
    expect(blocks).toHaveLength(4)                       // assistant,tool,assistant,tool
  })

  it('drops legacy records with no callId (shape-only, never unpaired)', () => {
    const legacy = { name: 'x', summary: 's' } as unknown as AgentToolRecord
    expect(toolBlocksFor([legacy])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/lib/agent/tool-history.test.ts`
Expected: FAIL — `Failed to resolve import "./tool-history"`.

- [ ] **Step 3: Write the implementation**

Create `server/lib/agent/tool-history.ts`:

```ts
// server/lib/agent/tool-history.ts
//
// Pure core for structural tool-history. Deliberately imports NOTHING from
// run.ts (that would be circular) and nothing from the DB or the AI SDK, so
// every rule below is unit-testable with plain objects.
import type { ToolKind } from './types'

/** One tool invocation, normalized. Persisted additively onto conversation_messages.tool_calls. */
export interface AgentToolRecord {
  callId: string                      // AI SDK execute() opts.toolCallId — the pairing key
  name: string
  kind: ToolKind
  args: Record<string, unknown>
  result: unknown
  summary: string                     // existing chip text
  undoToken?: string
  textOffset: number                  // assistantText.length when the call fired
}

/** Tool-bearing assistant turns whose results survive into model history. */
export const TOOL_HISTORY_WINDOW = 3
/** Replay cap for `read` results — mirrors session-read.ts's CONTENT_CAP precedent. */
export const READ_RESULT_CAP = 1500
/** Persist-time ceiling, generous so the replay cap can be retuned with no backfill. */
export const WRITE_RESULT_CAP = 8192

/**
 * Shrink an oversized result to a preview. Returns the ORIGINAL object by identity when it
 * already fits, so callers can cheaply detect "unchanged". Never throws — a circular or
 * otherwise unserializable result degrades to a marker rather than killing the turn.
 */
export function capResult(result: unknown, max: number): unknown {
  let json: string
  try {
    json = JSON.stringify(result) ?? ''
  } catch {
    return { unserializable: true }
  }
  if (json.length <= max) return result
  return { truncated: true, bytes: json.length, preview: json.slice(0, max) }
}

function capForKind(kind: ToolKind): number {
  // create/destructive already return body-free receipts (cycle 52) — keep them whole.
  return kind === 'read' ? READ_RESULT_CAP : Infinity
}

/**
 * Tier + decay. Walks newest-to-oldest counting only TOOL-BEARING assistant turns, so
 * ordinary chat turns never consume the window.
 *
 * The CALL always survives for the life of the conversation — it is the anti-fabrication
 * signal and costs ~50 tokens. Only the RESULT decays.
 */
export function applyHistoryPolicy<T extends { role: string; toolRecords?: AgentToolRecord[] }>(
  messages: T[]
): T[] {
  let toolTurnsSeen = 0
  const out = new Array<T>(messages.length)

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!m.toolRecords?.length) { out[i] = m; continue }

    toolTurnsSeen++
    const withinWindow = toolTurnsSeen <= TOOL_HISTORY_WINDOW

    out[i] = {
      ...m,
      toolRecords: m.toolRecords.map(r => {
        if (!withinWindow) {
          let bytes = 0
          try { bytes = (JSON.stringify(r.result) ?? '').length } catch { bytes = 0 }
          return { ...r, result: { elided: true, bytes } }
        }
        const capped = capResult(r.result, capForKind(r.kind))
        return capped === r.result ? r : { ...r, result: capped }
      })
    }
  }
  return out
}

/**
 * Expand records into AI SDK message blocks: assistant(tool-call parts) → tool(tool-result
 * parts), one pair per distinct textOffset so a multi-step turn replays in step order.
 * Calls sharing an offset (parallel calls in one step) group into a single pair.
 *
 * INVARIANT: a tool-result is only ever emitted alongside its call. Providers reject an
 * unpaired toolCallId, so an elided result still emits its tool message — and a legacy
 * record with no callId emits NOTHING at all rather than an unpaired half.
 */
export function toolBlocksFor(
  records: AgentToolRecord[]
): { role: 'assistant' | 'tool'; content: unknown[] }[] {
  const usable = records.filter(r => r?.callId)
  if (!usable.length) return []

  const blocks: { role: 'assistant' | 'tool'; content: unknown[] }[] = []
  let group: AgentToolRecord[] = []

  const flush = () => {
    if (!group.length) return
    blocks.push({
      role: 'assistant',
      content: group.map(r => ({
        type: 'tool-call', toolCallId: r.callId, toolName: r.name, input: r.args
      }))
    })
    blocks.push({
      role: 'tool',
      content: group.map(r => ({
        type: 'tool-result', toolCallId: r.callId, toolName: r.name,
        output: { type: 'json', value: r.result }
      }))
    })
    group = []
  }

  for (const r of usable) {
    if (group.length && r.textOffset !== group[0]!.textOffset) flush()
    group.push(r)
  }
  flush()
  return blocks
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/lib/agent/tool-history.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Prove the pairing test can fail**

Temporarily change `toolBlocksFor`'s `flush()` to skip pushing the `tool` block when `r.result` has `elided`, re-run, and confirm *"emits a tool message even when the result is elided"* goes RED. Revert the change.

This is required, not optional — a pairing test that cannot fail is worth nothing (see the `vacuous-tests-pass-without-reaching-code` lesson).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add server/lib/agent/tool-history.ts server/lib/agent/tool-history.test.ts
git commit -m "feat(agent): pure tool-history core — tiered decay + paired block expansion"
```

---

### Task 2: Capture callId, args, result and kind

**Files:**
- Modify: `server/lib/agent/ai-tools.ts:13-16` (RunHooks), `:31` (execute signature), `:44`, `:57`, `:62` (the three emit sites)
- Modify: `server/lib/agent/types.ts:59` (`AgentEvent` tool-result variant)
- Modify: `server/lib/agent/run.ts:37` (`AgentEvent` tool-result variant)
- Test: `server/lib/agent/ai-tools.test.ts` (exists — add cases)

**Interfaces:**
- Consumes: `AgentToolRecord` from Task 1.
- Produces: `tool-result` events now carrying `callId: string`, `args: Record<string, unknown>`, `result: unknown`, `kind: ToolKind`.

- [ ] **Step 1: Write the failing test**

Append to `server/lib/agent/ai-tools.test.ts`:

```ts
it('emits callId, args, result and kind on tool-result', async () => {
  const events: Record<string, unknown>[] = []
  const set = buildAiTools([{
    name: 'search_docs', description: 'd', schema: {}, kind: 'read',
    handler: async () => ({ result: { hits: 3 }, summary: 'found 3' })
  } as never], { signal: new AbortController().signal, onEvent: e => events.push(e as never) })

  await (set.search_docs!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
    { q: 'nuxt' }, { toolCallId: 'call_abc' }
  )

  const done = events.find(e => e.type === 'tool-result')!
  expect(done.callId).toBe('call_abc')
  expect(done.kind).toBe('read')
  expect(done.args).toEqual({ q: 'nuxt' })
  expect(done.result).toEqual({ hits: 3 })
})

it('emits a record for a FAILED tool so the agent sees the failure next turn', async () => {
  const events: Record<string, unknown>[] = []
  const set = buildAiTools([{
    name: 'web_fetch', description: 'd', schema: {}, kind: 'read',
    handler: async () => { throw new Error('boom') }
  } as never], { signal: new AbortController().signal, onEvent: e => events.push(e as never) })

  await (set.web_fetch!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: 'call_err' })

  const done = events.find(e => e.type === 'tool-result')!
  expect(done.callId).toBe('call_err')
  expect(done.result).toEqual({ error: 'boom' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/agent/ai-tools.test.ts`
Expected: FAIL — `expected undefined to be 'call_abc'`.

- [ ] **Step 3: Widen the event type in both declarations**

In `server/lib/agent/types.ts`, replace the `tool-result` line (`:59`):

```ts
    | { type: 'tool-result', name: string, summary: string, undoToken?: string, images?: DisplayImage[], callId?: string, args?: Record<string, unknown>, result?: unknown, kind?: ToolKind }
```

In `server/lib/agent/run.ts`, replace the `tool-result` line (`:37`):

```ts
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: import('./image-embed').DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: import('./types').ToolKind }
```

The new fields are **optional** so no existing emitter or test fake needs touching.

- [ ] **Step 4: Capture the id and payloads in ai-tools.ts**

In `server/lib/agent/ai-tools.ts`, widen `RunHooks.onEvent`'s `tool-result` member the same way, then change the execute signature (`:31`) and the three emit sites:

```ts
      execute: async (input: Record<string, unknown>, opts?: { toolCallId?: string }) => {
        const callId = opts?.toolCallId ?? ''
        hooks.onEvent({ type: 'tool-start', name: t.name, args: input })
```

Denial site (`:44`):

```ts
              const summary = `denied: ${t.name}`
              const result = { denied: true }
              publishActivity({ type: 'tool', name: t.name, summary })
              hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: input, result, kind: t.kind })
              return result
```

Success site (`:57`):

```ts
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken, images: exec.display?.images, callId, args: input, result: exec.result, kind: t.kind })
```

Failure site (`:62`):

```ts
          const summary = `failed: ${t.name}`
          const result = { error: (err as Error).message }
          publishActivity({ type: 'tool', name: t.name, summary })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: input, result, kind: t.kind })
          return result
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run server/lib/agent/ai-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && pnpm test
git add server/lib/agent/ai-tools.ts server/lib/agent/types.ts server/lib/agent/run.ts server/lib/agent/ai-tools.test.ts
git commit -m "feat(agent): capture toolCallId, args, result and kind at the tool seam"
```

---

### Task 3: Attach records to the assistant message

**Files:**
- Modify: `server/lib/voice/orchestrator.ts` (the `tool-result` branch and the two `return` statements of `handleTurn`)
- Test: `test/orchestrator.test.ts` (exists — add cases)

**Interfaces:**
- Consumes: enriched `tool-result` events (Task 2); `AgentToolRecord` (Task 1).
- Produces: `handleTurn` returns an assistant message carrying `toolRecords?: AgentToolRecord[]`, each with `textOffset` set to `assistantText.length` at call time.

- [ ] **Step 1: Write the failing test**

Add to `test/orchestrator.test.ts`:

This file has **no** shared deps helper — every test builds the `TurnDeps` object inline (see `test/orchestrator.test.ts:71-74`). Follow that pattern, reusing the module-level `tts` fixture already defined at the top of the file:

```ts
it('attaches tool records with the text offset at which each fired', async () => {
  const events: any[] = []
  const runTools = (async function* () {
    yield { type: 'text-delta', text: 'Looking. ' }
    yield { type: 'tool-result', name: 'web_search', summary: 's', callId: 'c1', args: { q: 'a' }, result: { hits: 1 }, kind: 'read' }
    yield { type: 'text-delta', text: 'Found it.' }
    yield { type: 'done' }
  }) as never
  const history = await handleTurn('hi', [], {
    tts, voice: 'af_heart', speak: false, runAgent: runTools,
    signal: new AbortController().signal, emit: e => events.push(e)
  })

  const assistant = history.at(-1) as { toolRecords?: { callId: string; textOffset: number }[] }
  expect(assistant.toolRecords).toHaveLength(1)
  expect(assistant.toolRecords![0]!.callId).toBe('c1')
  expect(assistant.toolRecords![0]!.textOffset).toBe('Looking. '.length)
})

it('omits toolRecords entirely when no tool ran', async () => {
  const events: any[] = []
  const runPlain = (async function* () {
    yield { type: 'text-delta', text: 'just chat' }
    yield { type: 'done' }
  }) as never
  const history = await handleTurn('hi', [], {
    tts, voice: 'af_heart', speak: false, runAgent: runPlain,
    signal: new AbortController().signal, emit: e => events.push(e)
  })
  expect((history.at(-1) as { toolRecords?: unknown[] }).toolRecords).toBeUndefined()
})

it('caps an oversized result at the write ceiling before it is ever stored', async () => {
  const events: any[] = []
  const runBig = (async function* () {
    yield { type: 'tool-result', name: 'web_fetch', summary: 's', callId: 'c1', args: {}, result: { body: 'z'.repeat(50_000) }, kind: 'read' }
    yield { type: 'text-delta', text: 'done' }
    yield { type: 'done' }
  }) as never
  const history = await handleTurn('hi', [], {
    tts, voice: 'af_heart', speak: false, runAgent: runBig,
    signal: new AbortController().signal, emit: e => events.push(e)
  })

  const rec = (history.at(-1) as { toolRecords: { result: { truncated?: boolean } }[] }).toolRecords[0]!
  expect(rec.result.truncated).toBe(true)
  expect(JSON.stringify(rec.result).length).toBeLessThan(10_000)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/orchestrator.test.ts`
Expected: FAIL — `expected undefined to have length 1`.

- [ ] **Step 3: Collect the records**

In `server/lib/voice/orchestrator.ts`, declare alongside `const turnImages: DisplayImage[] = []`:

```ts
  const toolRecords: AgentToolRecord[] = []
```

Import it: `import { capResult, WRITE_RESULT_CAP, type AgentToolRecord } from '../agent/tool-history'`.

In the `tool-result` branch, capture the offset **before** any further text arrives, and apply the write ceiling here so an oversized payload never reaches memory-history or the DB:

```ts
    } else if (ev.type === 'tool-result') {
      if (ev.images?.length) turnImages.push(...ev.images)
      if (ev.callId) {
        toolRecords.push({
          callId: ev.callId, name: ev.name, kind: ev.kind ?? 'read',
          args: ev.args ?? {}, result: capResult(ev.result, WRITE_RESULT_CAP), summary: ev.summary,
          undoToken: ev.undoToken, textOffset: assistantText.length
        })
      }
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken, images: ev.images })
      deps.emit({ type: 'state', state: 'thinking' })
    }
```

- [ ] **Step 4: Return them on the assistant message**

Replace the final return of `handleTurn`:

```ts
  return assistantText
    ? [...messages, { role: 'assistant', content: assistantText, ...(toolRecords.length ? { toolRecords } : {}) }]
    : messages
```

Leave the abort-path `return messages` (line ~117) untouched — an aborted turn persists nothing.

- [ ] **Step 5: Extend AgentMessage**

In `server/lib/agent/run.ts`, replace the `AgentMessage` interface (`:16`) with a union that adds the optional field to the assistant arm only:

```ts
export type AgentMessage =
  | { role: 'system' | 'user'; content: string | AgentContentPart[] }
  | { role: 'assistant'; content: string | AgentContentPart[]; toolRecords?: import('./tool-history').AgentToolRecord[] }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/orchestrator.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors.

If `toModelContent(m.role, m.content)` now complains about the widened role union, that is expected — Task 4 replaces that call site.

- [ ] **Step 7: Commit**

```bash
git add server/lib/voice/orchestrator.ts server/lib/agent/run.ts test/orchestrator.test.ts
git commit -m "feat(agent): carry tool records + text offsets on the assistant turn"
```

---

### Task 4: Wire replay into runAgent (the single call site)

**Files:**
- Modify: `server/lib/agent/run.ts:86` (extract `buildModelMessages`, use it), and the forced-final follow-up (~`:152`)
- Test: `server/lib/agent/run-history.test.ts` (create)

**Interfaces:**
- Consumes: `applyHistoryPolicy`, `toolBlocksFor` (Task 1); `AgentMessage` with `toolRecords` (Task 3).
- Produces: `export function buildModelMessages(messages: AgentMessage[]): unknown[]`

- [ ] **Step 1: Write the failing tests**

Create `server/lib/agent/run-history.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildModelMessages, type AgentMessage } from './run'
import type { AgentToolRecord } from './tool-history'

const rec = (o: Partial<AgentToolRecord> = {}): AgentToolRecord => ({
  callId: 'c1', name: 'web_search', kind: 'read', args: { q: 'x' },
  result: { hits: 1 }, summary: 's', textOffset: 0, ...o
})

describe('buildModelMessages', () => {
  it('expands a tool turn into paired call/result messages plus the text', () => {
    const out = buildModelMessages([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: 'Found it.', toolRecords: [rec()] }
    ]) as { role: string; content: unknown }[]

    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(out.at(-1)!.content).toBe('Found it.')
  })

  it('WIRING: stale results are elided by the time they reach the model', () => {
    const history: AgentMessage[] = []
    for (let i = 0; i < 5; i++) {
      history.push({ role: 'user', content: `q${i}` })
      history.push({ role: 'assistant', content: `a${i}`, toolRecords: [rec({ callId: `c${i}`, result: { big: 'z'.repeat(3000) } })] })
    }
    const out = buildModelMessages(history) as { role: string; content: { output?: { value?: unknown } }[] }[]
    const firstToolMsg = out.find(m => m.role === 'tool')!
    expect(firstToolMsg.content[0]!.output!.value).toEqual({ elided: true, bytes: expect.any(Number) })
  })

  it('IMAGE INVARIANT: no /api/images URL survives into model messages', () => {
    const out = buildModelMessages([
      { role: 'assistant', content: 'here', toolRecords: [rec({ name: 'generate_image', kind: 'create', result: { ok: true, id: 'img1', summary: 'a cat' } })] }
    ])
    expect(JSON.stringify(out)).not.toMatch(/\/api\/images/)
  })

  it('legacy records produce no unpaired tool message', () => {
    const out = buildModelMessages([
      { role: 'assistant', content: 'old turn', toolRecords: [{ name: 'x', summary: 's' } as unknown as AgentToolRecord] }
    ]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['assistant'])
  })

  it('drops system messages, as before', () => {
    const out = buildModelMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['user'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/agent/run-history.test.ts`
Expected: FAIL — `buildModelMessages is not a function`.

- [ ] **Step 3: Implement and use it**

In `server/lib/agent/run.ts`, add the import and the exported function above `runAgent`:

```ts
import { applyHistoryPolicy, toolBlocksFor } from './tool-history'

/**
 * The ONE place history becomes model messages. Policy + expansion live here rather than at
 * the two callers (orchestrator live history, getAgentHistory on resume) so those paths
 * cannot drift apart — a future edit to either physically cannot skip this.
 */
export function buildModelMessages(messages: AgentMessage[]): unknown[] {
  const policed = applyHistoryPolicy(messages.filter(m => m.role !== 'system'))
  return policed.flatMap(m => {
    const text = { role: m.role, content: toModelContent(m.role, m.content) }
    const records = m.role === 'assistant' ? m.toolRecords : undefined
    return records?.length ? [...toolBlocksFor(records), text] : [text]
  })
}
```

Then replace line 86 with:

```ts
  const modelMessages = buildModelMessages(messages)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/lib/agent/run-history.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Confirm the forced-final path still pairs correctly**

The follow-up call (~`:152`) builds `[...modelMessages, ...prior, ...nudge]`, where `prior` is the SDK's own `result.response.messages`. That already contains SDK-native call/result pairs, so it composes with the new blocks without change. Read the code and confirm no edit is needed; do not modify it.

- [ ] **Step 6: Full gates and commit**

```bash
pnpm typecheck && pnpm test
git add server/lib/agent/run.ts server/lib/agent/run-history.test.ts
git commit -m "feat(agent): replay tool history at a single call site inside runAgent"
```

---

### Task 5: Persist and rebuild the records

**Files:**
- Modify: `shared/types/conversation.ts:13` and `:8-17` (DTO), `server/services/conversations.ts:20-27` (`NewConvMessage`), `:147-157` (`getAgentHistory`), and the message DTO mapper
- Modify: `server/api/voice/ws.ts:176`, `:182`, `:196`
- Test: `server/services/conversations.test.ts` (create if absent)

**Interfaces:**
- Consumes: `AgentToolRecord` (Task 1); assistant messages carrying `toolRecords` (Task 3).
- Produces: `getAgentHistory` returns `AgentMessage[]` where assistant rows carry rebuilt `toolRecords`.

- [ ] **Step 1: Write the failing test**

Create/extend `server/services/conversations.test.ts` with a pure test for the row→message mapper (extract it so it needs no DB):

```ts
import { describe, it, expect } from 'vitest'
import { rowToAgentMessage } from './conversations'

describe('rowToAgentMessage', () => {
  it('rebuilds tool records from a modern row', () => {
    const m = rowToAgentMessage({
      role: 'assistant', content: 'hi',
      toolCalls: [{ callId: 'c1', name: 'web_search', kind: 'read', args: { q: 'x' }, result: { hits: 1 }, summary: 's', textOffset: 3 }],
      attachments: null
    })
    expect((m as { toolRecords?: unknown[] }).toolRecords).toHaveLength(1)
  })

  it('tolerates a LEGACY row with no callId', () => {
    const m = rowToAgentMessage({
      role: 'assistant', content: 'hi',
      toolCalls: [{ name: 'web_search', summary: 's' }], attachments: null
    })
    expect((m as { toolRecords?: { callId?: string }[] }).toolRecords![0]!.callId).toBeUndefined()
  })

  it('never throws on malformed tool_calls jsonb', () => {
    expect(() => rowToAgentMessage({ role: 'assistant', content: 'hi', toolCalls: 'garbage' as never, attachments: null })).not.toThrow()
    expect(rowToAgentMessage({ role: 'assistant', content: 'hi', toolCalls: 'garbage' as never, attachments: null }))
      .toEqual({ role: 'assistant', content: 'hi' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/conversations.test.ts`
Expected: FAIL — `rowToAgentMessage is not exported`.

- [ ] **Step 3: Widen the stored types**

In `shared/types/conversation.ts`, replace the `toolCalls` line (`:13`):

```ts
  toolCalls: ToolCallRecordDTO[] | null
```

and add above `ConversationMessageDTO`:

```ts
/** Legacy rows carry only name/summary/undoToken; every field added later is optional. */
export interface ToolCallRecordDTO {
  name: string
  summary: string
  undoToken?: string
  callId?: string
  kind?: 'read' | 'create' | 'destructive'
  args?: Record<string, unknown>
  result?: unknown
  textOffset?: number
}
```

Apply the same type to `NewConvMessage.toolCalls` in `server/services/conversations.ts:24`.

- [ ] **Step 4: Add the mapper and use it in getAgentHistory**

In `server/services/conversations.ts`:

```ts
import type { AgentMessage } from '../lib/agent/run'
import type { AgentToolRecord } from '../lib/agent/tool-history'

/** Row → AgentMessage. Never throws: a malformed tool_calls jsonb yields no records. */
export function rowToAgentMessage(
  r: { role: string; content: string; toolCalls: unknown; attachments: unknown }
): AgentMessage {
  const base = { role: r.role as 'user' | 'assistant', content: r.content }
  if (r.role !== 'assistant' || !Array.isArray(r.toolCalls) || !r.toolCalls.length) return base as AgentMessage
  return { ...base, role: 'assistant', toolRecords: r.toolCalls as AgentToolRecord[] } as AgentMessage
}
```

Rewrite `getAgentHistory` (`:147`) to select the extra columns and map through it:

```ts
export async function getAgentHistory(id: string): Promise<AgentMessage[]> {
  const rows = await useDb()
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
      toolCalls: conversationMessages.toolCalls,
      attachments: conversationMessages.attachments
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, id))
    .orderBy(conversationMessages.createdAt)

  return rows.map(rowToAgentMessage)
}
```

- [ ] **Step 5: Persist records from the message, not a side array**

In `server/api/voice/ws.ts`, delete the `toolCalls` accumulator (`:176`) and its push in `emit` (`:182`) — the `tool` event is still sent to the client, it is simply no longer harvested for storage. Then replace the `toolCalls` field in the `appendMessages` call (`:196`):

```ts
            toolCalls: m.role === 'assistant' && m.toolRecords?.length ? m.toolRecords : null,
```

This removes a source of truth rather than adding one: the records now travel with the message that owns them.

- [ ] **Step 6: Run tests and gates**

Run: `pnpm vitest run server/services/conversations.test.ts && pnpm typecheck && pnpm test`
Expected: PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add shared/types/conversation.ts server/services/conversations.ts server/services/conversations.test.ts server/api/voice/ws.ts
git commit -m "feat(agent): persist + rebuild tool records across resume"
```

---

### Task 6: Live/resume parity test

The property the whole design rests on, asserted directly.

**Files:**
- Test: `server/lib/agent/run-history.test.ts` (extend)

**Interfaces:**
- Consumes: `buildModelMessages` (Task 4); `rowToAgentMessage` (Task 5).

- [ ] **Step 1: Write the failing test**

Append to `server/lib/agent/run-history.test.ts`:

```ts
import { rowToAgentMessage } from '../../services/conversations'

it('PARITY: a resumed conversation yields identical model messages to the live one', () => {
  const live: AgentMessage[] = [
    { role: 'user', content: 'find x' },
    { role: 'assistant', content: 'Found it.', toolRecords: [rec({ callId: 'c1', textOffset: 0 })] }
  ]

  // The same turns as they come back out of Postgres.
  const resumed = [
    { role: 'user', content: 'find x', toolCalls: null, attachments: null },
    { role: 'assistant', content: 'Found it.', toolCalls: [rec({ callId: 'c1', textOffset: 0 })], attachments: null }
  ].map(rowToAgentMessage)

  expect(buildModelMessages(resumed)).toEqual(buildModelMessages(live))
})
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run server/lib/agent/run-history.test.ts`
Expected: PASS. If it fails, the persist/rebuild round-trip in Task 5 is lossy — fix Task 5, never this test.

- [ ] **Step 3: Prove it can fail**

Temporarily drop `textOffset` in `rowToAgentMessage`'s rebuild, re-run, confirm RED, revert.

- [ ] **Step 4: Commit**

```bash
git add server/lib/agent/run-history.test.ts
git commit -m "test(agent): live/resume model-message parity"
```

---

### Task 7: Attachments on resume

**Files:**
- Modify: `server/services/conversations.ts` (`getAgentHistory` — rehydrate user content parts)
- Test: `server/services/conversations.test.ts` (extend)

**Interfaces:**
- Consumes: `rowToAgentMessage` (Task 5), `buildUserMessageParts` (`server/lib/agent/attachments.ts`), `TOOL_HISTORY_WINDOW` (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
it('rehydrates attachments only for the most recent turns, and never leaves a text marker', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    role: 'user', content: `q${i}`,
    toolCalls: null, attachments: [{ id: `img${i}`, kind: 'image', mime: 'image/webp' }]
  }))
  const out = await hydrateAttachments(rows.map(rowToAgentMessage), rows, async () => new Uint8Array([1, 2, 3]))

  expect(Array.isArray(out.at(-1)!.content)).toBe(true)         // newest: real image parts
  expect(out[0]!.content).toBe('q0')                            // oldest: plain text, no marker
  expect(JSON.stringify(out)).not.toMatch(/\[image\]|\[attachment\]/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/conversations.test.ts`
Expected: FAIL — `hydrateAttachments is not exported`.

- [ ] **Step 3: Implement**

```ts
/**
 * Re-attach image/file bytes to the most recent user turns so a resumed agent can still SEE
 * them. Older turns degrade to plain text with NO placeholder — a marker is exactly the
 * artifact cycle 39 removed, and reintroducing one here would re-open the imitation bug.
 */
export async function hydrateAttachments(
  msgs: AgentMessage[],
  rows: { role: string; attachments: unknown }[],
  readBytes: (a: AttachmentRef) => Promise<Uint8Array>
): Promise<AgentMessage[]> {
  const withAttachments = rows
    .map((r, i) => (r.role === 'user' && Array.isArray(r.attachments) && r.attachments.length ? i : -1))
    .filter(i => i >= 0)
  const keep = new Set(withAttachments.slice(-TOOL_HISTORY_WINDOW))

  return Promise.all(msgs.map(async (m, i) => {
    if (!keep.has(i)) return m
    const refs = rows[i]!.attachments as AttachmentRef[]
    return { ...m, content: await buildUserMessageParts(m.content as string, refs, readBytes) }
  }))
}
```

Call it at the end of `getAgentHistory`, passing the real byte readers used by `orchestrator.ts` (`getImageBytes` / `getFileBytes`). Wrap the call in `try/catch` returning the un-hydrated messages on error — a missing blob must not break resume.

- [ ] **Step 4: Run tests and gates**

Run: `pnpm vitest run server/services/conversations.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/conversations.ts server/services/conversations.test.ts
git commit -m "feat(agent): restore attachment vision on resume, windowed, no markers"
```

---

### Task 8: Inline chip ordering on resume (UI)

**Files:**
- Modify: `app/pages/agent/index.vue:68-81` (`resume`)
- Test: browser validation with playwright-cli

**Interfaces:**
- Consumes: `ToolCallRecordDTO.textOffset` (Task 5).

- [ ] **Step 1: Read the browser-testing skill**

Invoke the `browser-testing` skill for the dev credentials, the login flow, and the reka-ui real-click rule. Do not skip — the transcript is behind auth.

- [ ] **Step 2: Rewrite `resume` to split on textOffset**

Replace the body of `resume` (and delete the now-false comment at `:70-72`):

```ts
async function resume(id: string) {
  const { messages } = await useConversations().getConversation(id)
  voice.transcript.value = messages.flatMap<TranscriptEntry>((m) => {
    const records = (m.role === 'assistant' && m.toolCalls?.length) ? m.toolCalls : []
    // Legacy rows have no textOffset — fall back to the old "chips first" render.
    const ordered = records.filter(t => typeof t.textOffset === 'number')
    if (!ordered.length) {
      return [
        ...records.map((t, i) => ({ id: `${m.id}-tool-${i}`, role: 'tool' as const, text: '', name: t.name, summary: t.summary, undoToken: t.undoToken })),
        { id: m.id, role: m.role, text: m.content, attachments: m.attachments ?? undefined, reasoning: m.reasoning ?? undefined }
      ]
    }

    const entries: TranscriptEntry[] = []
    let cursor = 0
    ordered.forEach((t, i) => {
      const at = Math.min(Math.max(t.textOffset!, 0), m.content.length)
      if (at > cursor) entries.push({ id: `${m.id}-txt-${i}`, role: m.role, text: m.content.slice(cursor, at) })
      entries.push({ id: `${m.id}-tool-${i}`, role: 'tool', text: '', name: t.name, summary: t.summary, undoToken: t.undoToken })
      cursor = at
    })
    entries.push({ id: m.id, role: m.role, text: m.content.slice(cursor), attachments: m.attachments ?? undefined, reasoning: m.reasoning ?? undefined })
    return entries
  })
  await voice.loadConversation(id)
  historyOpen.value = false
}
```

The clamp on `at` matters: a record whose offset exceeds the stored content (possible if a turn was edited) must not produce a negative slice.

- [ ] **Step 3: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: 0 errors, clean build.

- [ ] **Step 4: Prove it in the browser**

With `pnpm dev` running, use playwright-cli to log in, open `/agent`, send a message that triggers a tool (e.g. *"search my docs for structural tool history"*), wait for the reply, reload the page, and resume the conversation from history.

Expected: the tool chip renders **between** the opening text and the final answer — matching the live render — not stacked above the whole reply. Screenshot both live and resumed transcripts and compare.

- [ ] **Step 5: Commit**

```bash
git add app/pages/agent/index.vue
git commit -m "fix(agent): render resumed tool chips at their true inline position"
```

---

### Task 9: Docs, wiki and handover

**Files:**
- Modify: `docs/wiki/agent.md`
- Create: `docs/handovers/2026-08-05-structural-tool-history.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (cycle 43 row)

- [ ] **Step 1: Update the wiki**

`docs/wiki/agent.md` gains a *Tool history* section describing current behaviour: records persist on `tool_calls`, results decay after 3 tool-bearing turns while calls persist forever, replay happens once inside `runAgent`, legacy rows degrade to shape-only. The wiki describes what the system does **today** — write it in present tense, not as a change description.

- [ ] **Step 2: Write the handover**

Follow the frontmatter shape of `docs/handovers/2026-08-02-mcp-agent-ergonomics.md`: `title`, `cycle`, `date`, `status`, `branch`, `spec`, `plan`, `docs`, `problem`, `keydecision`, `deferred`. Record the real gate numbers and anything the build discovered that the spec got wrong.

- [ ] **Step 3: Add the roadmap row**

Insert a cycle-43 row in the Round-3 table. There is currently **no** row for 43 — the table jumps 42 → 44.

- [ ] **Step 4: Mirror to MyMind**

Mirror the handover with `sync_document` (path `/projects/mymind/handovers/2026-08-05-structural-tool-history.md`), matching the convention used by the cycle-51 handover.

- [ ] **Step 5: Final gates and commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add docs/
git commit -m "docs(cycle-43): wiki, handover and roadmap row for structural tool-history"
```

---

## Verification checklist

Before declaring the branch done:

- [ ] `pnpm typecheck` → 0 errors
- [ ] `pnpm test` → all pass, count recorded in the handover
- [ ] `pnpm build` → clean
- [ ] Task 1 Step 5 and Task 6 Step 3 mutation checks were actually run and observed RED
- [ ] Browser validation screenshots captured (live vs resumed chip order)
- [ ] No `[image]` / `[attachment]` / any placeholder string introduced into model-facing history
- [ ] No migration added
