# Agent Reasoning Block + On-the-fly Model Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the agent's `reasoning_content` as a collapsible "Thinking" block per assistant turn (persisted), and add a navbar dropdown to switch the reasoning-role model live.

**Architecture:** Both features ride the existing WebSocket agent pipeline (`voice.sendText` → `server/api/voice/ws.ts` → `handleTurn` → `runAgent`). `runAgent` already receives `reasoning-delta` parts from the AI SDK `fullStream` but drops them; we forward them as a new event type → a non-TTS'd `VoiceEvent` → the client transcript. Model switching is an ephemeral, cookie-backed, connection-level override that reorders the resolved reasoning chain (chosen model first, rest kept as failover) and never writes `ai_config`.

**Tech Stack:** Nuxt 4 (Vue 3 `<script setup>`, Nuxt UI v4), Nitro WS handler, Drizzle (Postgres/pgvector), `ai`@6 + `@ai-sdk/openai-compatible`@2, Vitest.

## Global Constraints

- **WS pipeline only.** The SSE `/api/agent/chat` + `app/composables/useTextChat.ts` path is dead code — do not touch or revive it.
- **Reasoning is display/storage only — NEVER sent back to the model.** `getAgentHistory` (model context) must keep selecting only `role`/`content`. Reasoning is captured for persistence outside the `AgentMessage` type.
- **Model override is ephemeral.** It lives in a cookie + connection state; it must NOT mutate the `ai_config` settings doc.
- **Nuxt UI v4 only** for markup (`U*` components); **semantic color tokens only** (no raw palette classes). Confirm component props via the `nuxt-ui-docs` skill when unsure.
- **Validate UI in the real browser with `playwright-cli`** (invoke the `browser-testing` skill), not the Playwright MCP. Green typecheck/test/build do not prove rendering/wiring.
- **The AI SDK `fullStream` `reasoning-delta` part carries `.delta`** (verified in `node_modules/ai/dist/index.d.ts`); read it defensively as `p.delta ?? p.text ?? ''`, mirroring the existing `text-delta` handling.
- Gates that matter: `pnpm typecheck`, `pnpm test` (vitest), `pnpm build`. Lint is red repo-wide — not a gate.
- There is **no database in the vitest harness** (`conversations.test.ts` only tests pure helpers). Do not write DB round-trip unit tests; verify persistence via typecheck + `pnpm db:migrate` + the browser E2E.

---

## File Structure

**Feature A — Reasoning block**
- `server/db/schema/conversations.ts` — add `reasoning` column (modify)
- `server/db/migrations/0026_*.sql` — generated migration (create via `pnpm db:generate`)
- `shared/types/conversation.ts` — add `reasoning` to `ConversationMessageDTO` (modify)
- `server/services/conversations.ts` — `NewConvMessage.reasoning`, insert it, map it in `msgToDTO` (modify)
- `server/lib/agent/run.ts` — new `reasoning-delta` `AgentEvent` from the stream (modify)
- `server/lib/voice/orchestrator.ts` — new `reasoning` `VoiceEvent`, emitted, never TTS'd (modify)
- `server/api/voice/ws.ts` — capture reasoning in the emit closure, persist it (modify)
- `app/lib/voice/messages.ts` — map the `reasoning` frame (modify)
- `app/composables/useVoice.ts` — `TranscriptEntry.reasoning` + `pushReasoning` (modify)
- `app/components/agent/ReasoningBlock.vue` — collapsible thinking block, auto-collapse-once (create)
- `app/components/voice/Transcript.vue` — render `AgentReasoningBlock` on assistant turns (modify)
- `app/pages/agent/index.vue` — hydrate `reasoning` on resume (modify)

**Feature B — Model selector**
- `server/lib/ai/registry/resolve.ts` — pure `reorderChain` helper (modify)
- `server/lib/agent/model.ts` — `reasoningModels(modelDefId?)` (modify)
- `server/lib/agent/run.ts` — `ctx.modelDefId` → `reasoningModels` (modify)
- `server/lib/voice/orchestrator.ts` — `TurnDeps.modelDefId` threaded into `run` (modify)
- `server/api/voice/ws.ts` — `ConnState.model` + `{type:'model'}` frame + pass per turn (modify)
- `app/composables/useVoice.ts` — `desiredModel` + `setModel` + resend on open (modify)
- `app/pages/agent/index.vue` — model dropdown from `useAiConfig`, cookie `agent-model` (modify)

**Test files (existing, extend):** `test/run-agent.test.ts`, `test/orchestrator.test.ts`, `test/voice-messages.test.ts`, `test/ai-registry-resolve.test.ts`.

---

## Task 1: Persist reasoning (schema + service + DTO)

**Files:**
- Modify: `server/db/schema/conversations.ts:31`
- Create: `server/db/migrations/0026_*.sql` (generated)
- Modify: `shared/types/conversation.ts:8-16`
- Modify: `server/services/conversations.ts` (`NewConvMessage`, `appendMessages`, `msgToDTO`)

**Interfaces:**
- Produces: `conversation_messages.reasoning text` (nullable); `ConversationMessageDTO.reasoning: string | null`; `NewConvMessage.reasoning?: string | null`.
- Note: `getAgentHistory` (`server/services/conversations.ts:144`) stays unchanged — it selects only `role`/`content`, keeping reasoning out of model context.

- [ ] **Step 1: Add the column to the schema**

In `server/db/schema/conversations.ts`, add the `reasoning` field to `conversationMessages` right after `toolCalls` (line 31). `text` is already imported.

```ts
  toolCalls: jsonb('tool_calls'),               // [{ name, summary, undoToken? }] for assistant turns
  reasoning: text('reasoning'),                 // assistant thinking; display/storage only, NEVER sent back to the model
  attachments: jsonb('attachments'),            // [{ id, kind, mime, name? }] for user turns (Task 5 populates)
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `server/db/migrations/0026_<random-name>.sql` containing:
```sql
ALTER TABLE "conversation_messages" ADD COLUMN "reasoning" text;
```
Open the generated file and confirm it is exactly that one `ADD COLUMN` (no unintended drops). If drizzle emits extra statements from drift, stop and investigate before continuing.

- [ ] **Step 3: Add `reasoning` to the DTO**

In `shared/types/conversation.ts`, add to `ConversationMessageDTO` (after `toolCalls`, ~line 13):

```ts
  toolCalls: { name: string; summary: string; undoToken?: string }[] | null
  reasoning: string | null
  attachments: AttachmentRef[] | null
```

- [ ] **Step 4: Thread reasoning through the service**

In `server/services/conversations.ts`:

`NewConvMessage` (add field):
```ts
export interface NewConvMessage {
  role: 'user' | 'assistant'
  content: string
  modality: 'voice' | 'text'
  toolCalls?: { name: string; summary: string; undoToken?: string }[] | null
  reasoning?: string | null
  attachments?: AttachmentRef[] | null
}
```

`msgToDTO` (map the column — add after `toolCalls`):
```ts
    toolCalls: (r.toolCalls as { name: string; summary: string; undoToken?: string }[] | null) ?? null,
    reasoning: r.reasoning ?? null,
    attachments: (r.attachments as AttachmentRef[] | null) ?? null,
```

`appendMessages` insert values (add after `toolCalls`):
```ts
        toolCalls: msg.toolCalls ?? null,
        reasoning: msg.reasoning ?? null,
        attachments: msg.attachments ?? null
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. (`ConversationMessageDTO` now requires `reasoning`; `msgToDTO` supplies it, so no consumer breaks.)

- [ ] **Step 6: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: the `0026` migration applies cleanly. (Prod runs migrate in CD.)

- [ ] **Step 7: Commit**

```bash
git add server/db/schema/conversations.ts server/db/migrations shared/types/conversation.ts server/services/conversations.ts
git commit -m "feat(agent): persist assistant reasoning on conversation_messages"
```

---

## Task 2: Server reasoning pipeline (stream → event → persist)

**Files:**
- Modify: `server/lib/agent/run.ts` (`AgentEvent`, `fullStream` loop)
- Modify: `server/lib/voice/orchestrator.ts` (`VoiceEvent`, turn loop)
- Modify: `server/api/voice/ws.ts` (emit closure capture + persist)
- Test: `test/run-agent.test.ts`, `test/orchestrator.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentEvent` variant `{ type: 'reasoning-delta'; text: string }`; `VoiceEvent` variant `{ type: 'reasoning'; text: string }`. `handleTurn` emits `reasoning` events but does NOT return reasoning — `ws.ts` accumulates it from the emit stream and passes `reasoning` to `appendMessages`.

- [ ] **Step 1: Write the failing test — run.ts yields reasoning-delta**

Add to `test/run-agent.test.ts`:

```ts
  it('maps fullStream reasoning-delta parts to reasoning-delta events', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'Let me ' },
      { type: 'reasoning-delta', id: 'r', delta: 'think.' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 't', delta: 'Answer.' },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [], buildSystemPrompt: async () => 'test-system' }
    )) events.push(e)
    const reasoning = events.filter(e => e.type === 'reasoning-delta').map(e => e.text).join('')
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(reasoning).toBe('Let me think.')
    expect(text).toBe('Answer.')
  })
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test run-agent`
Expected: FAIL — no `reasoning-delta` events emitted (reasoning is `''`).

- [ ] **Step 3: Implement — AgentEvent + stream handling in run.ts**

In `server/lib/agent/run.ts`, extend the `AgentEvent` union (after the `text-delta` variant, ~line 34):
```ts
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: import('./image-embed').DisplayImage[] }
  | { type: 'done' }
```

In the `for await (const part of result.fullStream)` loop (~line 109), add a branch after the `text-delta` block:
```ts
    if ((part as { type?: unknown }).type === 'text-delta') {
      const p = part as { delta?: string; text?: string }
      const text = p.delta ?? p.text ?? ''
      if (text) yield { type: 'text-delta', text }
    } else if ((part as { type?: unknown }).type === 'reasoning-delta') {
      // AI SDK v6 fullStream reasoning part carries `.delta`; test fakes may use `.text`.
      const p = part as { delta?: string; text?: string }
      const text = p.delta ?? p.text ?? ''
      if (text) yield { type: 'reasoning-delta', text }
    }
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm test run-agent`
Expected: PASS.

- [ ] **Step 5: Write the failing test — orchestrator emits reasoning, never TTS'd**

Add to `test/orchestrator.test.ts` (inside the `handleTurn` describe). Note the shared `tts` mock at the top of the file counts `synthesize` calls.

```ts
  it('emits a reasoning event, keeps it out of TTS and out of the persisted answer', async () => {
    const events: any[] = []
    const reasoningTts = { synthesize: vi.fn(async function* () { yield new Uint8Array([1]) }) }
    const runReason = (async function* () {
      yield { type: 'reasoning-delta', text: 'thinking… ' }
      yield { type: 'text-delta', text: 'Final answer.' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts: reasoningTts, voice: 'af_heart', speak: true, runAgent: runReason,
      signal: new AbortController().signal, emit: e => events.push(e)
    })
    // reasoning surfaced as its own event…
    expect(events.some(e => e.type === 'reasoning' && e.text === 'thinking… ')).toBe(true)
    // …never spoken (TTS only ever saw the answer text)…
    for (const call of reasoningTts.synthesize.mock.calls) {
      expect(call[0]).not.toContain('thinking')
    }
    // …and never merged into the persisted assistant content.
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Final answer.' })
  })
```

- [ ] **Step 6: Run it — verify it fails**

Run: `pnpm test orchestrator`
Expected: FAIL — no `reasoning` event (the orchestrator has no branch for `reasoning-delta`).

- [ ] **Step 7: Implement — VoiceEvent + orchestrator branch**

In `server/lib/voice/orchestrator.ts`, extend `VoiceEvent` (after the `transcript` variant, ~line 13):
```ts
export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[] }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }
```

In the turn loop (`for await (const ev of run(...))`, ~line 88), add a branch. Put it first so it clearly never touches `assistantText`/`chunker`/TTS:
```ts
    if (deps.signal.aborted) break
    if (ev.type === 'reasoning-delta') {
      deps.emit({ type: 'reasoning', text: ev.text })   // display only — never chunked/spoken/persisted here
    } else if (ev.type === 'text-delta') {
      assistantText += ev.text
      deps.emit({ type: 'transcript', role: 'assistant', text: ev.text })
      // …unchanged…
```

- [ ] **Step 8: Run it — verify it passes**

Run: `pnpm test orchestrator`
Expected: PASS.

- [ ] **Step 9: Capture + persist reasoning in ws.ts**

In `server/api/voice/ws.ts`, inside the `run` closure (~line 172), add a `reasoningText` accumulator next to `toolCalls`, capture it in `emit`, and pass it to `appendMessages`:

```ts
        const toolCalls: { name: string; summary: string; undoToken?: string }[] = []
        let reasoningText = ''
        const prevLen = s.history.length
        const emit = (e: VoiceEvent) => {
          if (e.type === 'audio') peer.send(e.bytes)
          else {
            if (e.type === 'tool') toolCalls.push({ name: e.name, summary: e.summary, undoToken: e.undoToken })
            if (e.type === 'reasoning') reasoningText += e.text
            peer.send(JSON.stringify(e))
          }
        }
```

In the `appendMessages(...)` call (~line 183), add `reasoning` to the assistant row:
```ts
          await appendMessages(s.conversationId, added.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: messageText(m.content),
            modality: m.role === 'user' ? inputModality : (speakFlag ? 'voice' : 'text'),
            toolCalls: m.role === 'assistant' && toolCalls.length ? toolCalls : null,
            reasoning: m.role === 'assistant' ? (reasoningText || null) : null,
            attachments: m.role === 'user' ? turnAttachments : null
          })))
```

- [ ] **Step 10: Typecheck + full test run**

Run: `pnpm typecheck && pnpm test`
Expected: 0 typecheck errors; all tests pass (new run-agent + orchestrator tests green).

- [ ] **Step 11: Commit**

```bash
git add server/lib/agent/run.ts server/lib/voice/orchestrator.ts server/api/voice/ws.ts test/run-agent.test.ts test/orchestrator.test.ts
git commit -m "feat(agent): forward reasoning deltas as a non-spoken event and persist them"
```

---

## Task 3: Client reasoning transport (mapping + transcript entry)

**Files:**
- Modify: `app/lib/voice/messages.ts` (`MsgEffect.reasoning`, mapping)
- Modify: `app/composables/useVoice.ts` (`TranscriptEntry.reasoning`, `pushReasoning`, wiring)
- Test: `test/voice-messages.test.ts`

**Interfaces:**
- Consumes: server `{ type: 'reasoning', text }` frame (Task 2).
- Produces: `MsgEffect.reasoning?: string`; `TranscriptEntry.reasoning?: string`. Reasoning attaches to the current turn's assistant entry (created if the last entry isn't already an assistant bubble); subsequent `text-delta` appends the answer to that same bubble.

- [ ] **Step 1: Write the failing test — reasoning frame maps to a reasoning effect**

Add to `test/voice-messages.test.ts`:

```ts
  it('reasoning message → reasoning effect, no delta', () => {
    const fx = mapServerMessage({ type: 'reasoning', text: 'thinking…' }, false)
    expect(fx.reasoning).toBe('thinking…')
    expect(fx.delta).toBeUndefined()
    expect(fx.events).toEqual([])
  })
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test voice-messages`
Expected: FAIL — `fx.reasoning` is `undefined`.

- [ ] **Step 3: Implement the mapping**

In `app/lib/voice/messages.ts`, add `reasoning?: string` to `MsgEffect`:
```ts
export interface MsgEffect {
  state?: 'idle' | 'thinking' | 'speaking' | 'tool' | 'typing'
  delta?: { role: 'user' | 'assistant'; text: string }
  reasoning?: string
  tool?: { name: string; summary: string; undoToken?: string }
  error?: string
  events: VizEvent[]
  approval?: { requestId: string; tool: string; command: string; proposedPattern: string }
  approvalResolved?: string
}
```

In `mapServerMessage`, add a branch after the `transcript` branch (~line 26):
```ts
  if (m.type === 'reasoning' && m.text) {
    return { reasoning: m.text, events }
  }
```
(`ServerMsg` already declares an optional `text?`, so no type change is needed there.)

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm test voice-messages`
Expected: PASS.

- [ ] **Step 5: Add `reasoning` to the transcript entry + push logic**

In `app/composables/useVoice.ts`, add `reasoning?: string` to `TranscriptEntry` (after `undone?`):
```ts
export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  attachments?: AttachmentRef[]
  name?: string
  summary?: string
  undoToken?: string
  undone?: boolean
  reasoning?: string
}
```

Add a `pushReasoning` function next to `pushDelta` (~line 74). Reasoning arrives before the answer text; the last entry at that point is the user turn, so this seeds a fresh assistant bubble that the following `pushDelta('assistant', …)` appends answer text to:
```ts
  function pushReasoning(text: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === 'assistant') last.reasoning = (last.reasoning ?? '') + text
    else transcript.value.push({ id: newEntryId(), role: 'assistant', text: '', reasoning: text })
  }
```

Wire it into the WS `onmessage` handler (~line 180), after the `fx.delta` line:
```ts
        if (fx.delta) pushDelta(fx.delta.role, fx.delta.text)
        if (fx.reasoning) pushReasoning(fx.reasoning)
```

- [ ] **Step 6: Typecheck + test**

Run: `pnpm typecheck && pnpm test voice-messages`
Expected: 0 errors; PASS.

- [ ] **Step 7: Commit**

```bash
git add app/lib/voice/messages.ts app/composables/useVoice.ts test/voice-messages.test.ts
git commit -m "feat(agent): carry reasoning to the client transcript entry"
```

---

## Task 4: Reasoning UI (collapsible block + resume hydration)

**Files:**
- Create: `app/components/agent/ReasoningBlock.vue`
- Modify: `app/components/voice/Transcript.vue`
- Modify: `app/pages/agent/index.vue` (`resume()`)

**Interfaces:**
- Consumes: `TranscriptEntry.reasoning` (Task 3); `ConversationMessageDTO.reasoning` (Task 1).
- Produces: `AgentReasoningBlock` component (auto-imported by dir prefix) with props `{ reasoning: string; hasAnswer: boolean }`.

- [ ] **Step 1: Create the collapsible block component**

Create `app/components/agent/ReasoningBlock.vue`. It opens while the turn is still thinking (no answer yet) and auto-collapses once the answer starts — but only until the user touches it, after which manual state wins.

```vue
<!-- app/components/agent/ReasoningBlock.vue -->
<script setup lang="ts">
const props = defineProps<{ reasoning: string; hasAnswer: boolean }>()

// Open while thinking; collapse once the answer begins — unless the user has
// taken manual control of the disclosure.
const open = ref(!props.hasAnswer)
let userTouched = false
watch(() => props.hasAnswer, (has) => { if (has && !userTouched) open.value = false })
function onToggle(e: Event) {
  userTouched = true
  open.value = (e.target as HTMLDetailsElement).open
}
</script>

<template>
  <details
    :open="open"
    class="group mb-1 rounded-md border border-default bg-muted/30"
    @toggle="onToggle"
  >
    <summary
      class="flex cursor-pointer select-none list-none items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated/40"
    >
      <UIcon name="i-lucide-brain" class="size-3" />
      Thinking
      <UIcon name="i-lucide-chevron-right" class="size-3 transition-transform group-open:rotate-90" />
    </summary>
    <p class="whitespace-pre-wrap px-2.5 pb-2 pt-0.5 text-xs leading-relaxed text-muted">{{ reasoning }}</p>
  </details>
</template>
```

- [ ] **Step 2: Render it in the transcript**

In `app/components/voice/Transcript.vue`, inside the `<template v-else>` assistant branch, add the block immediately before the `<MdView>` (~line 48):
```html
      <template v-else>
        <span class="text-[10px] uppercase tracking-wide text-muted">{{ e.role === 'user' ? 'You' : 'Bridget' }}</span>
        <AgentReasoningBlock
          v-if="e.role === 'assistant' && e.reasoning"
          :reasoning="e.reasoning"
          :has-answer="!!e.text"
        />
        <MdView
          v-if="e.role === 'assistant'"
          :source="e.text"
          :cache-key="`transcript-${e.id}`"
          class="text-highlighted"
        />
```

- [ ] **Step 3: Hydrate reasoning on resume**

In `app/pages/agent/index.vue`, in `resume()` (~line 55), add `reasoning` to the rebuilt assistant entry:
```ts
    { id: m.id, role: m.role, text: m.content, attachments: m.attachments ?? undefined, reasoning: m.reasoning ?? undefined }
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 0 typecheck errors; build succeeds.

- [ ] **Step 5: Browser E2E (invoke the `browser-testing` skill)**

Using `playwright-cli` against `pnpm dev`, logged in as the dev test account:
1. Open `/agent`, send a text turn that induces thinking (e.g. "Think step by step: what's 17×24? Show brief reasoning.").
2. Assert an assistant bubble renders a **Thinking** disclosure; it is open while the state is `thinking` and collapses when the answer streams in.
3. Click the summary to expand; the reasoning text is visible.
4. Reload the page (or open the conversation from **History**); the **Thinking** block is still present (persistence round-trip).

Capture a screenshot of the expanded block for the handover.

- [ ] **Step 6: Commit**

```bash
git add app/components/agent/ReasoningBlock.vue app/components/voice/Transcript.vue app/pages/agent/index.vue
git commit -m "feat(agent): collapsible Thinking block on assistant turns"
```

---

## Task 5: Model override — server (reorder chain + thread through turn)

**Files:**
- Modify: `server/lib/ai/registry/resolve.ts` (pure `reorderChain`)
- Modify: `server/lib/agent/model.ts` (`reasoningModels(modelDefId?)`)
- Modify: `server/lib/agent/run.ts` (`ctx.modelDefId`)
- Modify: `server/lib/voice/orchestrator.ts` (`TurnDeps.modelDefId`)
- Modify: `server/api/voice/ws.ts` (`ConnState.model` + `model` frame)
- Test: `test/ai-registry-resolve.test.ts`

**Interfaces:**
- Produces: `reorderChain(chain: ResolvedModel[], modelDefId?: string | null): ResolvedModel[]`; `reasoningModels(modelDefId?: string | null): Promise<LanguageModel[]>`; `runAgent` ctx gains `modelDefId?: string`; `TurnDeps.modelDefId?: string | null`; ws `{ type: 'model', modelDefId: string | null }` control frame sets connection-level `s.model`.
- `ResolvedModel` already carries `modelDefId` (`server/lib/ai/registry/resolve.ts`), which is the id matched against the client's pick.

- [ ] **Step 1: Write the failing test — reorderChain**

Add to `test/ai-registry-resolve.test.ts`:
```ts
import { reorderChain } from '../server/lib/ai/registry/resolve'

describe('reorderChain', () => {
  const chain = [
    { modelDefId: 'a', label: 'A' },
    { modelDefId: 'b', label: 'B' },
    { modelDefId: 'c', label: 'C' }
  ] as any[]

  it('moves the chosen model to the front, preserving the rest as failover', () => {
    expect(reorderChain(chain, 'b').map(m => m.modelDefId)).toEqual(['b', 'a', 'c'])
  })
  it('is a no-op when the id is already first, unknown, null, or undefined', () => {
    expect(reorderChain(chain, 'a').map(m => m.modelDefId)).toEqual(['a', 'b', 'c'])
    expect(reorderChain(chain, 'zzz').map(m => m.modelDefId)).toEqual(['a', 'b', 'c'])
    expect(reorderChain(chain, null).map(m => m.modelDefId)).toEqual(['a', 'b', 'c'])
    expect(reorderChain(chain, undefined).map(m => m.modelDefId)).toEqual(['a', 'b', 'c'])
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test ai-registry-resolve`
Expected: FAIL — `reorderChain` is not exported.

- [ ] **Step 3: Implement `reorderChain`**

In `server/lib/ai/registry/resolve.ts`, add after `resolveChainFrom` (~line 40):
```ts
/** Pure: move the chosen model to the front (chosen = primary; the rest stay as failover). */
export function reorderChain(chain: ResolvedModel[], modelDefId?: string | null): ResolvedModel[] {
  if (!modelDefId) return chain
  const idx = chain.findIndex(m => m.modelDefId === modelDefId)
  if (idx <= 0) return chain
  return [chain[idx]!, ...chain.slice(0, idx), ...chain.slice(idx + 1)]
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm test ai-registry-resolve`
Expected: PASS.

- [ ] **Step 5: Apply the override in `reasoningModels`**

In `server/lib/agent/model.ts`, import `reorderChain` and accept the id:
```ts
import type { LanguageModel } from 'ai'
import { resolveChain, reorderChain, languageModel } from '../ai/registry/resolve'

export async function reasoningModels(modelDefId?: string | null): Promise<LanguageModel[]> {
  const chain = reorderChain(await resolveChain('reasoning'), modelDefId)
  return chain.map(languageModel)
}
```

- [ ] **Step 6: Thread `modelDefId` through `runAgent`**

In `server/lib/agent/run.ts`, add `modelDefId?: string` to the `ctx` param of `runAgent` (~line 54):
```ts
  ctx: { signal: AbortSignal; speak?: boolean; profile?: AgentProfile; context?: string; maxSteps?: number; requestApproval?: (req: import('./types').ApprovalRequest) => Promise<{ approved: boolean }>; attachmentImageIds?: string[]; modelDefId?: string | null },
```
And pass it when resolving models (~line 74):
```ts
  const models = deps.streamText ? [undefined as never] : await reasoningModels(ctx.modelDefId)
```

- [ ] **Step 7: Thread `modelDefId` through the orchestrator**

In `server/lib/voice/orchestrator.ts`, add `modelDefId?: string | null` to `TurnDeps` and to its optional `runAgent` injection type (~line 18-32):
```ts
export interface TurnDeps {
  tts: TtsProvider
  voice: string
  signal: AbortSignal
  speak: boolean
  context?: string
  modelDefId?: string | null
  profile?: import('../agent/profile').AgentProfile
  requestApproval?: (req: import('../agent/types').ApprovalRequest) => Promise<{ approved: boolean }>
  attachments?: AttachmentRef[]
  readAttachmentBytes?: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
  buildMemoryContext?: (userText: string) => Promise<string>
  emit: (e: VoiceEvent) => void
  runAgent?: (m: AgentMessage[], c: { signal: AbortSignal; speak?: boolean; context?: string; modelDefId?: string | null; profile?: import('../agent/profile').AgentProfile; requestApproval?: (req: import('../agent/types').ApprovalRequest) => Promise<{ approved: boolean }>; attachmentImageIds?: string[] }) => AsyncGenerator<AgentEvent>
}
```
In `handleTurn`, pass it into the `run(...)` call (~line 88):
```ts
  for await (const ev of run(messages, { signal: deps.signal, speak: deps.speak, context, modelDefId: deps.modelDefId, profile: deps.profile, requestApproval: deps.requestApproval, attachmentImageIds: attachments.filter(a => a.kind === 'image').map(a => a.id) })) {
```
(`handleUtterance` already forwards `deps` to `handleTurn`, so no change there.)

- [ ] **Step 8: Add the `model` control frame + connection state in ws.ts**

In `server/api/voice/ws.ts`:

`ConnState` (add field, ~line 22):
```ts
interface ConnState {
  history: AgentMessage[]
  ac: AbortController | null
  voice: string
  model: string | null
  lock: Promise<void>
  conversationId: string | null
  pendingApprovals: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout>; req: ApprovalRequest }>
}
```
`open` (init it, ~line 63):
```ts
    conns.set(peer, { history: [], ac: null, voice: '', model: null, lock: Promise.resolve(), conversationId: null, pendingApprovals: new Map() })
```
Control-frame handling — add next to the `voice` frame (~line 103):
```ts
      if (msg.type === 'voice') { s.voice = msg.voice as string; return }
      if (msg.type === 'model') { s.model = typeof msg.modelDefId === 'string' ? msg.modelDefId : null; return }
```
Pass `modelDefId` into both turn constructors:
```ts
        turn = (signal, emit, context) => handleTurn(text, s.history, { tts, voice: s.voice, speak, context, modelDefId: s.model, buildMemoryContext, requestApproval, attachments, signal, emit })
```
```ts
      turn = (signal, emit, context) => handleUtterance(audio, s.history, { stt, tts, voice: s.voice, speak: true, context, modelDefId: s.model, buildMemoryContext, requestApproval, signal, emit })
```

- [ ] **Step 9: Typecheck + full test run**

Run: `pnpm typecheck && pnpm test`
Expected: 0 errors; all tests pass (reorderChain green).

- [ ] **Step 10: Commit**

```bash
git add server/lib/ai/registry/resolve.ts server/lib/agent/model.ts server/lib/agent/run.ts server/lib/voice/orchestrator.ts server/api/voice/ws.ts test/ai-registry-resolve.test.ts
git commit -m "feat(agent): connection-level reasoning-model override (chosen primary, failover kept)"
```

---

## Task 6: Model selector — client + UI

**Files:**
- Modify: `app/composables/useVoice.ts` (`desiredModel`, `setModel`, resend on open)
- Modify: `app/pages/agent/index.vue` (dropdown + cookie)

**Interfaces:**
- Consumes: `useAiConfig()` (`draft.models`, `draft.assignments.reasoning`); ws `model` frame (Task 5).
- Produces: `voice.setModel(modelDefId: string | null)`; cookie `agent-model` (`''` = default/no override).

- [ ] **Step 1: Add `desiredModel` + `setModel` to useVoice**

In `app/composables/useVoice.ts`, alongside `desiredVoice` (~line 47):
```ts
  let desiredVoice: { provider: string; voice: string } | null = null
  let desiredModel: string | null = null
```
On WS open, after the `voice` frame is sent (~line 198), resend the model pick so it survives reconnects:
```ts
        socket.send(JSON.stringify({ type: 'voice', ...v }))
        if (desiredModel) socket.send(JSON.stringify({ type: 'model', modelDefId: desiredModel }))
```
Add `setModel` to the returned object (next to `setVoice`, ~line 339):
```ts
    setModel: (modelDefId: string | null) => {
      desiredModel = modelDefId
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'model', modelDefId }))
    },
```

- [ ] **Step 2: Wire the dropdown into the agent page script**

In `app/pages/agent/index.vue` `<script setup>`, add after the existing cookies (~line 12):
```ts
// Reasoning-model override (ephemeral, cookie-backed). '' = default chain order.
const { load: loadAiConfig, draft: aiDraft } = useAiConfig()
const agentModel = useCookie<string>('agent-model', { default: () => '' })
const modelItems = computed(() => {
  const models = aiDraft.value.models
  const chain = (aiDraft.value.assignments.reasoning ?? [])
    .map(id => models.find(m => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  return [{ label: 'Default (chain order)', value: '' }, ...chain.map(m => ({ label: m.label, value: m.id }))]
})
const selectedModel = computed({
  get: () => agentModel.value,
  set: (val: string) => { agentModel.value = val; voice.setModel(val || null) }
})
```
In `onMounted`, load the config and apply the persisted pick after connecting (~line 63):
```ts
onMounted(async () => {
  await voice.connect()
  await loadAiConfig()
  if (agentModel.value) voice.setModel(agentModel.value)
  const c = route.query.c
  if (typeof c === 'string' && c) await resume(c)
})
```

- [ ] **Step 3: Add the dropdown to both navbar header variants**

In `app/pages/agent/index.vue`, add the selector to the `#right` template of the canvas navbar (before `<VoiceSettingsSlideover>`, ~line 126) AND to the transcript-only navbar `#right` (~line 216). Same markup in both:
```html
            <USelectMenu
              v-model="selectedModel"
              :items="modelItems"
              value-key="value"
              icon="i-lucide-cpu"
              size="sm"
              class="w-44"
              aria-label="Agent model"
            />
```
(Confirm `USelectMenu` v4 props via the `nuxt-ui-docs` skill if anything mismatches — this mirrors the working voice picker in `SettingsSlideover.vue`.)

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: 0 typecheck errors; build succeeds.

- [ ] **Step 5: Browser E2E (invoke the `browser-testing` skill)**

Using `playwright-cli` against `pnpm dev`:
1. Open `/agent`. The model dropdown shows **Default (chain order)** plus the reasoning-chain models (today: the two qwen3.6 labels). Use a real reka-ui `click <e-ref>` to open/select (not `el.click()`).
2. Select the non-default model, send a turn.
3. Confirm the turn ran on the chosen model via the DB:
   `docker exec -i mymind-db psql -U mymind -d mymind -c "select model_id, created_at from activity_log where name='reasoning:agent' order by created_at desc limit 3;"`
   (run inside the LXC per the `prod-deploy` skill if testing against prod; for local dev, the local `mymind-db`.)
4. Reload; the dropdown still shows the picked model (cookie), and the next turn still uses it.

- [ ] **Step 6: Commit**

```bash
git add app/composables/useVoice.ts app/pages/agent/index.vue
git commit -m "feat(agent): navbar dropdown to switch the reasoning model on the fly"
```

---

## Task 7: Ship — gates, docs, wiki, handover

**Files:**
- Modify: `docs/wiki/<agent-or-voice-page>.md` (find the agent/voice system page)
- Create: `docs/handovers/2026-07-10-agent-reasoning-model-selector.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (add the cycle-45 row)
- Mirror the wiki page to MyMind (`save_document`/`edit_document`, project `mymind`)

**Interfaces:** none (documentation + release).

- [ ] **Step 1: Full gate run**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 0 typecheck errors; all tests pass; build succeeds. Record the test count for the handover.

- [ ] **Step 2: Whole-branch review**

Invoke `superpowers:requesting-code-review` for the branch diff (or `/code-review high`). Address any confirmed findings; re-run gates.

- [ ] **Step 3: Update the wiki page**

Find the agent/voice system wiki page (`rg -l -i "agent|voice|bridget" docs/wiki/`). Update it to describe, as shipped: the `reasoning` column on `conversation_messages` (display/storage only, excluded from `getAgentHistory`), the `reasoning` `VoiceEvent`, the `{type:'model'}` WS control frame + connection-level override (chosen primary, failover preserved, never writes `ai_config`), and the two new UI controls (Thinking block, model dropdown). Bump the page's `status`. If no agent page exists, add one.

- [ ] **Step 4: Mirror the wiki page to MyMind**

Use the `mymind` MCP (`save_document` for a new page or `edit_document` for an existing one), project `mymind`, so the wiki and MyMind stay in sync.

- [ ] **Step 5: Write the handover**

Create `docs/handovers/2026-07-10-agent-reasoning-model-selector.md` with accurate frontmatter (date, cycle 45, status, branch, gate results, spec + plan links). Cover: what shipped, the migration (0026), the reasoning-never-fed-to-model invariant, the ephemeral override semantics, the multi-step-reasoning v1 caveat, the E2E evidence (screenshot + `activity_log` proof), and the dead SSE path noted for later removal.

- [ ] **Step 6: Add the roadmap row**

Add a cycle-45 row to `docs/superpowers/plans/00-roadmap.md` linking the spec, plan, and handover.

- [ ] **Step 7: Update the MyMind task + finish the branch**

Mark the MyMind task (`cd7f859b-43ed-49ab-bf5f-84a1b4860594`) done. Then invoke `superpowers:finishing-a-development-branch` to choose merge/PR for `feat/agent-reasoning-model-selector`.

- [ ] **Step 8: Commit the docs**

```bash
git add docs/
git commit -m "docs(agent): cycle 45 handover + wiki + roadmap — reasoning block & model selector"
```

---

## Self-Review

**Spec coverage:**
- Data model (`reasoning` column, excluded from model context) → Task 1 (+ invariant preserved because `getAgentHistory` is untouched, called out in Task 1 interfaces).
- Reasoning server pipeline (run.ts → orchestrator → ws.ts) → Task 2.
- Reasoning client + UI (messages/useVoice, Transcript, resume) → Tasks 3–4.
- Model selector server (reorder, runAgent, orchestrator, ws) → Task 5.
- Model selector client + UI (useVoice, dropdown, cookie) → Task 6.
- Testing (unit for run/orchestrator/mapping/reorder; browser for both features) → embedded in Tasks 2/3/5 (unit) and 4/6 (browser).
- Wiki/handover/mirror on ship → Task 7.
- Decisions locked: persist ✓ (T1), never-fed-to-model ✓ (T1 invariant + T2 captures outside AgentMessage), ephemeral override ✓ (T5 connection state + T6 cookie, no ai_config write), failover preserved ✓ (T5 reorderChain), dropdown = reasoning chain + Default ✓ (T6).

**Placeholder scan:** No TBD/TODO; every code step shows real code; browser steps list concrete assertions and the exact `activity_log` query.

**Type consistency:** `reorderChain`/`reasoningModels(modelDefId?)`/`ctx.modelDefId`/`TurnDeps.modelDefId`/`s.model`/`{type:'model',modelDefId}`/`setModel`/cookie `agent-model` are consistent across Tasks 5–6. `reasoning` naming is consistent across the column, `NewConvMessage`, `ConversationMessageDTO`, `AgentEvent('reasoning-delta')`, `VoiceEvent('reasoning')`, `MsgEffect.reasoning`, `TranscriptEntry.reasoning`, and the `AgentReasoningBlock` prop.
