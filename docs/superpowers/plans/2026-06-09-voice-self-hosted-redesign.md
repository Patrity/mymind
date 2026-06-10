# Voice Agent v2 (Self-Hosted, Self-Orchestrated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cycle-17 Unmute-orchestrated voice path with a TS-owned voice layer: a Vercel AI SDK agent core (shared by voice/chat/cron), client-side Silero VAD + our own barge-in, and swappable OpenAI-spec local STT/TTS providers.

**Architecture:** Four layers — client voice UI (VAD/capture/playback), a Nitro WebSocket voice orchestrator, swappable `SttProvider`/`TtsProvider` adapters over OpenAI-spec endpoints, and the shared agent core (`runAgent` on the AI SDK). Text chat and cron call the same `runAgent`. All tuning lives in one constants file.

**Tech Stack:** Nuxt 4 / Nitro (h3 v2, crossws WebSockets), Vercel AI SDK v5 (`ai`, `@ai-sdk/openai-compatible`), `@ricky0123/vad-web` (Silero VAD in-browser), Vitest, Drizzle/pg.

**Spec:** `docs/superpowers/specs/2026-06-09-voice-self-hosted-redesign-design.md`
**Model servers:** `docs/model-requirements.md` (Task 1, already written)

---

## Deployed model specs (AUTHORITATIVE — confirmed live 2026-06-09; overrides assumptions in the tasks below)

All three servers are up on `192.168.2.25`, **no API keys**, OpenAI-spec. MyMind env var names (AI_* to match the existing `runtimeConfig.ai` block):
```
AI_STT_BASE_URL=http://192.168.2.25:8881/v1
AI_STT_MODEL=deepdml/faster-whisper-large-v3-turbo-ct2     # turbo, NOT Systran/large-v3
AI_TTS_KOKORO_BASE_URL=http://192.168.2.25:8880/v1
AI_TTS_KOKORO_MODEL=kokoro
AI_TTS_KOKORO_VOICE=af_heart
AI_TTS_CHATTERBOX_BASE_URL=http://192.168.2.25:8884/v1
AI_TTS_CHATTERBOX_MODEL=chatterbox
AI_TTS_CHATTERBOX_VOICE=happy-us.wav                       # the Ex02-Happy clone; also fast1-us.wav, fast2-us.wav, Emily.wav…
```
Measured: STT ~280ms warm; Kokoro ~270ms; Chatterbox ~1s warm (**~12s on first/cold gen**).

**Adjustments these specs force on the tasks:**
1. **STT default model** (Task 8/12) = `deepdml/faster-whisper-large-v3-turbo-ct2`.
2. **Voices endpoint is `/v1/audio/voices`** (Task 14 proxy hits `${base}/audio/voices`, not `/voices`).
3. **Chatterbox 422s if `voice` is omitted** — always pass it. Our `openAiTts.synthesize` always sends `opts.voice`; ensure the WS/orchestrator never passes an empty voice. Each provider has its OWN voice namespace (Kokoro `af_*`, Chatterbox `*.wav`), so **voice selection carries `{provider, voice}` together**, not a bare voice string.
4. **Per-provider default voice** comes from env (`AI_TTS_*_VOICE`); `VOICE_TUNING.tts` holds the default `provider` + a per-provider voice map. Default **provider = `kokoro` / `af_heart`** for first-response snappiness (Chatterbox's cold-start is rough); the picker switches to Chatterbox `happy-us.wav` etc.
5. **Cold-start mitigation (Task 16):** optionally warm Chatterbox with a 1-word synth on server boot so the first real reply isn't ~12s.
6. **Future (not v1):** Chatterbox-turbo accepts paralinguistic tags in the input text (`[laugh]`, `[sigh]`, `[chuckle]`, …) — a later prompt-level feature; don't wire it now.

---

## Conventions
- Run from repo root `/Users/tony/Documents/GitHub/mymind`. Package manager **pnpm**.
- Tests live in flat `test/`, named `<topic>.test.ts`, run `pnpm test <name>` (Vitest, happy-dom available).
- After each task: `pnpm typecheck` must pass before committing.
- The agent core already exists on master: `server/lib/agent/{tools,prompt,bus,undo,types}.ts`. We **keep** those and **delete** `{loop,openai-chunk}.ts` + `server/api/agent/llm/**`.

## AI SDK v5 API notes (verified 2026-06-09)
- `import { streamText, tool, stepCountIs } from 'ai'`; `import { createOpenAICompatible } from '@ai-sdk/openai-compatible'`.
- `streamText({ model, system, messages, tools, stopWhen: stepCountIs(n), abortSignal })`.
- `tool({ description, inputSchema: <zod>, execute: async (input) => result })` — schema field is **`inputSchema`**.
- `result.fullStream` async-iterates typed parts. **Verify the text-part shape against the installed version** (v5 is `{ type: 'text-delta', text }` in recent builds, older summaries say `{ type:'text', text }`); the Task-4 handler accepts both. Tool parts: `{ type:'tool-call', toolName, input }`, `{ type:'tool-result', toolName, output }`, `{ type:'finish' }`.

## File map
**Agent core (keep + add):**
- keep `server/lib/agent/{tools,prompt,bus,undo,types}.ts`
- create `server/lib/agent/model.ts` — AI SDK model factory
- create `server/lib/agent/ai-tools.ts` — registry → AI SDK `ToolSet` adapter
- create `server/lib/agent/run.ts` — `runAgent()` generator (the one entry point)
- delete `server/lib/agent/{loop,openai-chunk}.ts`, `server/lib/ai/chat-stream.ts`, `server/api/agent/llm/**`

**Voice layer (new):**
- `server/lib/voice/tuning.ts` — constants
- `server/lib/voice/providers/types.ts` — `SttProvider`/`TtsProvider`
- `server/lib/voice/providers/stt-whisper.ts` — faster-whisper STT
- `server/lib/voice/providers/tts-openai.ts` — Kokoro + Chatterbox TTS
- `server/lib/voice/chunker.ts` — sentence chunker
- `server/lib/voice/orchestrator.ts` — state machine
- `server/api/voice/ws.ts` — Nitro WebSocket adapter
- `server/api/voice/voices.get.ts` — same-origin proxy to TTS `/v1/voices`

**Client:**
- `app/composables/useVoice.ts` — VAD + capture + playback + WS
- modify `app/pages/voice.vue`, `app/components/voice/*` (reuse reactor/transcript/composer)
- delete `app/composables/useUnmute.ts`, `app/types/opus-recorder.d.ts`, `public/opus/*`

**Config/docs:** `nuxt.config.ts` (runtimeConfig.ai stt/tts), `.env.example`, wiki, handover, roadmap.

---

## Task 1: Model/server requirements doc — DONE

`docs/model-requirements.md` already exists (instructs the infra agent to stand up faster-whisper + Kokoro + Chatterbox behind OpenAI-spec endpoints). No action; the infra work proceeds in parallel. Verify it's present:

- [ ] **Step 1: Confirm**

Run: `test -f docs/model-requirements.md && echo present`
Expected: `present`

---

## Task 2: AI SDK deps + model factory

**Files:** Create `server/lib/agent/model.ts`; modify `nuxt.config.ts` (runtimeConfig already has `ai.reasoning`).

- [ ] **Step 1: Install deps**

Run:
```bash
pnpm add ai @ai-sdk/openai-compatible
```
Expected: both added to `package.json`.

- [ ] **Step 2: Write the model factory**

```ts
// server/lib/agent/model.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { aiProvider } from '../ai/provider'

/** AI SDK language model for the `reasoning` role (local qwen via vLLM, OpenAI-spec). */
export function reasoningModel() {
  const cfg = aiProvider('reasoning', { required: true })
  const provider = createOpenAICompatible({
    name: 'mymind-reasoning',
    baseURL: cfg.baseURL!.replace(/\/$/, ''),
    apiKey: cfg.apiKey || 'none'
  })
  return provider(cfg.model || 'default')
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add server/lib/agent/model.ts package.json pnpm-lock.yaml
git commit -m "feat(agent): add Vercel AI SDK + reasoning model factory"
```

---

## Task 3: Registry → AI SDK tools adapter

**Files:** Create `server/lib/agent/ai-tools.ts`; Test `test/ai-tools.test.ts`.

The existing `agentTools` registry (name/description/schema/kind/handler) stays the source of truth. This adapter turns it into an AI SDK `ToolSet`, wiring each tool's `execute` to the existing handler + publishing activity + registering undo (mirroring what `loop.ts` did).

- [ ] **Step 1: Write the failing test**

```ts
// test/ai-tools.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildAiTools } from '../server/lib/agent/ai-tools'
import type { AgentTool } from '../server/lib/agent/types'

const fake: AgentTool = {
  name: 'create_task', description: 'x', kind: 'create',
  schema: { title: (await import('zod')).z.string() } as never,
  handler: async () => ({ result: { id: 't1', title: 'milk' }, summary: "added 'milk' to todo", undo: async () => {} })
}

describe('buildAiTools', () => {
  it('produces a ToolSet keyed by tool name with an execute that runs the handler', async () => {
    const events: unknown[] = []
    const tools = buildAiTools([fake], { signal: new AbortController().signal, onEvent: e => events.push(e) })
    expect(Object.keys(tools)).toEqual(['create_task'])
    const out = await tools.create_task.execute!({ title: 'milk' }, { toolCallId: 'c1', messages: [] } as never)
    expect(out).toMatchObject({ id: 't1', title: 'milk' })
    // emits a tool-result event with the summary + an undo token
    expect(events.some((e: any) => e.type === 'tool-result' && e.summary.includes('milk') && e.undoToken)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test — confirm FAIL** (`pnpm test ai-tools` → module not found).

- [ ] **Step 3: Implement**

```ts
// server/lib/agent/ai-tools.ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext } from './types'
import { publishActivity } from './bus'
import { registerUndo } from './undo'

export interface RunHooks {
  signal: AbortSignal
  onEvent: (e: { type: 'tool-start'; name: string; args: Record<string, unknown> }
    | { type: 'tool-result'; name: string; summary: string; undoToken?: string }) => void
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = existing handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
  const ctx: ToolContext = { signal: hooks.signal }
  const set: ToolSet = {}
  for (const t of registry) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: z.object(t.schema),
      execute: async (input: Record<string, unknown>) => {
        hooks.onEvent({ type: 'tool-start', name: t.name, args: input })
        try {
          const exec = await t.handler(input, ctx)
          const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
          publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken })
          return exec.result
        } catch (err) {
          const summary = `failed: ${t.name}`
          publishActivity({ type: 'tool', name: t.name, summary })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary })
          return { error: (err as Error).message }
        }
      }
    })
  }
  return set
}
```

- [ ] **Step 4: Run test — PASS** (`pnpm test ai-tools`). `pnpm typecheck`.

> If `z.object(t.schema)` typechecks unhappily (schema is a `ZodRawShape`), that's its purpose — `z.object` takes a raw shape. Confirm `ToolSet`/`tool` import names against the installed `ai` version; adjust if v5 renamed them.

- [ ] **Step 5: Commit**
```bash
git add server/lib/agent/ai-tools.ts test/ai-tools.test.ts
git commit -m "feat(agent): adapt tool registry to AI SDK ToolSet"
```

---

## Task 4: `runAgent` — the single entry point

**Files:** Create `server/lib/agent/run.ts`; Test `test/run-agent.test.ts`.

- [ ] **Step 1: Write the failing test** (mock `streamText` via dependency injection)

```ts
// test/run-agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../server/lib/agent/run'

function fakeFullStream(parts: any[]) {
  return { fullStream: (async function* () { for (const p of parts) yield p })() }
}

describe('runAgent', () => {
  it('maps fullStream text + tool parts to AgentEvents and ends with done', async () => {
    const streamText = vi.fn(() => fakeFullStream([
      { type: 'text-delta', text: 'Hello ' },
      { type: 'text-delta', text: 'Tony' },
      { type: 'tool-result', toolName: 'create_task', output: { id: 't1' } },
      { type: 'finish', finishReason: 'stop' }
    ]))
    const events: any[] = []
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal },
      { streamText: streamText as never, tools: [] }
    )) events.push(e)
    const text = events.filter(e => e.type === 'text-delta').map(e => e.text).join('')
    expect(text).toBe('Hello Tony')
    expect(events[events.length - 1]).toEqual({ type: 'done' })
  })
})
```

- [ ] **Step 2: Run test — confirm FAIL.**

- [ ] **Step 3: Implement**

```ts
// server/lib/agent/run.ts
import { streamText as realStreamText, stepCountIs } from 'ai'
import { reasoningModel } from './model'
import { buildAiTools } from './ai-tools'
import { agentTools as realRegistry } from './tools'
import { buildSystemPrompt } from './prompt'
import { publishActivity } from './bus'
import { VOICE_TUNING } from '../voice/tuning'
import type { AgentTool } from './types'

export interface AgentMessage { role: 'system' | 'user' | 'assistant'; content: string }
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string }
  | { type: 'done' }

export interface RunDeps { streamText?: typeof realStreamText; tools?: AgentTool[] }

export async function* runAgent(
  messages: AgentMessage[],
  ctx: { signal: AbortSignal },
  deps: RunDeps = {}
): AsyncGenerator<AgentEvent> {
  const streamText = deps.streamText ?? realStreamText
  const registry = deps.tools ?? realRegistry
  const queue: AgentEvent[] = []
  const tools = buildAiTools(registry, { signal: ctx.signal, onEvent: e => queue.push(e) })

  publishActivity({ type: 'state', state: 'thinking' })
  const result = streamText({
    model: reasoningModel(),
    system: buildSystemPrompt(),
    messages: messages.filter(m => m.role !== 'system'),
    tools,
    stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps),
    abortSignal: ctx.signal
  })

  for await (const part of result.fullStream) {
    // flush any tool events the tool execute() pushed
    while (queue.length) yield queue.shift()!
    if (part.type === 'text-delta' || part.type === 'text') {
      const text = (part as { text?: string }).text ?? ''
      if (text) yield { type: 'text-delta', text }
    }
    // tool-call/tool-result are surfaced via the queue (buildAiTools.onEvent)
  }
  while (queue.length) yield queue.shift()!
  publishActivity({ type: 'state', state: 'idle' })
  yield { type: 'done' }
}
```

- [ ] **Step 4: Run test — PASS.** `pnpm typecheck`.

> The test injects a fake `streamText`, so `reasoningModel()`/`buildAiTools` aren't exercised there. The real path is covered by the integration smoke in Task 5. If the installed `ai` text part is `text-delta` only, the `'text'` branch is harmless.

- [ ] **Step 5: Commit**
```bash
git add server/lib/agent/run.ts test/run-agent.test.ts
git commit -m "feat(agent): runAgent generator over AI SDK streamText"
```

---

## Task 5: Rewire `/api/agent/chat` to `runAgent`

**Files:** Modify `server/api/agent/chat.post.ts`. Keep its SSE shape so the existing client text path is unchanged.

- [ ] **Step 1: Rewrite the handler**

```ts
// server/api/agent/chat.post.ts
import { runAgent, type AgentMessage } from '../../lib/agent/run'

// Session-authed (middleware). Streams plain text deltas as SSE `data:` lines.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ messages?: AgentMessage[] }>(event)
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
    for await (const ev of runAgent(messages, { signal: ac.signal })) {
      if (ev.type === 'text-delta') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.text } }] })}\n\n`)
    }
  } finally {
    res.write('data: [DONE]\n\n')
    res.end()
    event._handled = true
  }
})
```

- [ ] **Step 2: Typecheck + dev smoke** (requires the reasoning model reachable)

Run: `pnpm typecheck` (PASS). With `pnpm dev` + a session cookie, POST `/api/agent/chat` with `{"messages":[{"role":"user","content":"say hi"}]}` → expect streamed `data:` text then `[DONE]`. (Skip the live curl if the model isn't reachable; the run-agent unit test covers the logic.)

- [ ] **Step 3: Commit**
```bash
git add server/api/agent/chat.post.ts
git commit -m "refactor(agent): /api/agent/chat uses runAgent (AI SDK)"
```

---

## Task 6: Teardown the Unmute/cycle-17 path

**Files:** Delete `server/api/agent/llm/` (whole dir), `server/lib/agent/loop.ts`, `server/lib/agent/openai-chunk.ts`, `server/lib/ai/chat-stream.ts`, and their tests (`test/agent-loop.test.ts`, `test/chat-stream.test.ts`, `test/openai-chunk.test.ts`). Modify `server/middleware/auth.ts` to drop the `/api/agent/llm` exemption.

- [ ] **Step 1: Delete files**

Run:
```bash
git rm -r server/api/agent/llm server/lib/agent/loop.ts server/lib/agent/openai-chunk.ts server/lib/ai/chat-stream.ts \
  test/agent-loop.test.ts test/chat-stream.test.ts test/openai-chunk.test.ts
```

- [ ] **Step 2: Remove the auth exemption**

In `server/middleware/auth.ts`, change:
```ts
const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/agent/llm']
```
back to:
```ts
const PUBLIC_PREFIXES = ['/api/auth', '/api/share', '/api/i']
```

- [ ] **Step 3: Verify nothing else imports the deleted files**

Run: `grep -rn "agent/loop\|chat-stream\|openai-chunk\|agent/llm" server app test | grep -v node_modules`
Expected: no results.

- [ ] **Step 4: Typecheck + full test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (mcp-parity, ai-tools, run-agent, etc. still green).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(voice): remove Unmute LLM shim + old hand-rolled loop"
```

---

## Task 7: Voice tuning constants

**Files:** Create `server/lib/voice/tuning.ts`. (Imported already by `run.ts` for `agent.maxSteps`.)

- [ ] **Step 1: Write it**

```ts
// server/lib/voice/tuning.ts
// Single source of voice-loop tuning. Adjust freely — no rebuild-to-tune.
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'chatterbox' as 'chatterbox' | 'kokoro', voice: 'default', sentenceMinChars: 60, playbackRate: 1.1 },
  stt:     { language: 'en' },
  agent:   { maxSteps: 6 }
}
export type VoiceTuning = typeof VOICE_TUNING
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` (PASS — resolves the `run.ts` import).
```bash
git add server/lib/voice/tuning.ts
git commit -m "feat(voice): central tuning constants"
```

---

## Task 8: STT provider (faster-whisper)

**Files:** Create `server/lib/voice/providers/types.ts`, `server/lib/voice/providers/stt-whisper.ts`; Test `test/stt-whisper.test.ts`.

- [ ] **Step 1: Provider interfaces**

```ts
// server/lib/voice/providers/types.ts
export interface SttProvider {
  transcribe(audio: Uint8Array, opts?: { language?: string }): Promise<string>
}
export interface TtsProvider {
  /** Stream synthesized audio bytes for `text` (the whole utterance chunk). */
  synthesize(text: string, opts: { voice: string; signal?: AbortSignal }): AsyncIterable<Uint8Array>
}
```

- [ ] **Step 2: Write the failing test** (mock global fetch)

```ts
// test/stt-whisper.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { whisperStt } from '../server/lib/voice/providers/stt-whisper'

afterEach(() => vi.restoreAllMocks())

describe('whisperStt', () => {
  it('POSTs multipart audio to /audio/transcriptions and returns text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'hello there' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const stt = whisperStt({ baseURL: 'http://rig:8881/v1', model: 'whisper', apiKey: '' })
    const text = await stt.transcribe(new Uint8Array([1, 2, 3]), { language: 'en' })
    expect(text).toBe('hello there')
    const url = fetchMock.mock.calls[0][0]
    expect(String(url)).toBe('http://rig:8881/v1/audio/transcriptions')
  })
})
```

- [ ] **Step 3: Run test — confirm FAIL.**

- [ ] **Step 4: Implement**

```ts
// server/lib/voice/providers/stt-whisper.ts
import type { SttProvider } from './types'

export function whisperStt(cfg: { baseURL: string; model: string; apiKey?: string }): SttProvider {
  const base = cfg.baseURL.replace(/\/$/, '')
  return {
    async transcribe(audio, opts) {
      const form = new FormData()
      form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'utterance.wav')
      form.append('model', cfg.model)
      if (opts?.language) form.append('language', opts.language)
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
        body: form
      })
      if (!res.ok) throw new Error(`STT failed: ${res.status}`)
      const json = await res.json() as { text?: string }
      return (json.text ?? '').trim()
    }
  }
}
```

- [ ] **Step 5: Run test — PASS.** `pnpm typecheck`.
- [ ] **Step 6: Commit**
```bash
git add server/lib/voice/providers/types.ts server/lib/voice/providers/stt-whisper.ts test/stt-whisper.test.ts
git commit -m "feat(voice): faster-whisper STT provider (OpenAI-spec)"
```

---

## Task 9: TTS providers (Kokoro + Chatterbox) + selector

**Files:** Create `server/lib/voice/providers/tts-openai.ts`; Test `test/tts-openai.test.ts`.

- [ ] **Step 1: Write the failing test** (mock fetch returning a streamed body)

```ts
// test/tts-openai.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openAiTts } from '../server/lib/voice/providers/tts-openai'

afterEach(() => vi.restoreAllMocks())

describe('openAiTts', () => {
  it('POSTs to /audio/speech and yields the response body bytes', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close() } })
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const tts = openAiTts({ baseURL: 'http://rig:8884/v1', model: 'chatterbox', apiKey: '' })
    const chunks: number[] = []
    for await (const c of tts.synthesize('hi', { voice: 'default' })) chunks.push(...c)
    expect(chunks).toEqual([1, 2, 3])
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent).toMatchObject({ model: 'chatterbox', voice: 'default', input: 'hi', response_format: 'wav' })
  })
})
```

- [ ] **Step 2: Run test — confirm FAIL.**

- [ ] **Step 3: Implement**

```ts
// server/lib/voice/providers/tts-openai.ts
import type { TtsProvider } from './types'

/** OpenAI-spec /v1/audio/speech provider — works for Kokoro AND Chatterbox. */
export function openAiTts(cfg: { baseURL: string; model: string; apiKey?: string }): TtsProvider {
  const base = cfg.baseURL.replace(/\/$/, '')
  return {
    async *synthesize(text, opts) {
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        signal: opts.signal,
        body: JSON.stringify({ model: cfg.model, voice: opts.voice, input: text, response_format: 'wav' })
      })
      if (!res.ok || !res.body) throw new Error(`TTS failed: ${res.status}`)
      const reader = res.body.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) yield value
      }
    }
  }
}
```

- [ ] **Step 4: Run test — PASS.** `pnpm typecheck`.
- [ ] **Step 5: Commit**
```bash
git add server/lib/voice/providers/tts-openai.ts test/tts-openai.test.ts
git commit -m "feat(voice): OpenAI-spec TTS provider (Kokoro + Chatterbox)"
```

---

## Task 10: Sentence chunker

**Files:** Create `server/lib/voice/chunker.ts`; Test `test/chunker.test.ts`. Pure function: feed text deltas, emit chunks on sentence-final punctuation or when `minChars` is reached.

- [ ] **Step 1: Write the failing test**

```ts
// test/chunker.test.ts
import { describe, it, expect } from 'vitest'
import { SentenceChunker } from '../server/lib/voice/chunker'

describe('SentenceChunker', () => {
  it('emits on sentence-final punctuation', () => {
    const c = new SentenceChunker(5)
    expect(c.push('Hello there. How')).toEqual(['Hello there.'])
    expect(c.push(' are you?')).toEqual(['How are you?'])
    expect(c.flush()).toEqual([])
  })
  it('emits when minChars exceeded even without punctuation, and flushes the tail', () => {
    const c = new SentenceChunker(10)
    expect(c.push('abcdefghijk')).toEqual(['abcdefghijk'])
    expect(c.push(' tail')).toEqual([])
    expect(c.flush()).toEqual(['tail'])
  })
})
```

- [ ] **Step 2: Run test — confirm FAIL.**

- [ ] **Step 3: Implement**

```ts
// server/lib/voice/chunker.ts
// Accumulates streamed text and emits speakable chunks: on sentence-final
// punctuation, or when the buffer passes minChars (so TTS starts before the LLM finishes).
export class SentenceChunker {
  private buf = ''
  constructor(private minChars: number) {}

  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    // flush complete sentences
    const re = /[^.!?]*[.!?]+(\s|$)/g
    let m: RegExpExecArray | null
    let consumed = 0
    while ((m = re.exec(this.buf))) {
      const s = m[0].trim()
      if (s) out.push(s)
      consumed = re.lastIndex
    }
    if (consumed) this.buf = this.buf.slice(consumed)
    // size-based flush for a long clause with no terminal punctuation
    if (this.buf.trim().length >= this.minChars) {
      out.push(this.buf.trim())
      this.buf = ''
    }
    return out
  }

  flush(): string[] {
    const s = this.buf.trim()
    this.buf = ''
    return s ? [s] : []
  }
}
```

- [ ] **Step 4: Run test — PASS.** `pnpm typecheck`.
- [ ] **Step 5: Commit**
```bash
git add server/lib/voice/chunker.ts test/chunker.test.ts
git commit -m "feat(voice): streaming sentence chunker for TTS"
```

---

## Task 11: Voice orchestrator state machine

**Files:** Create `server/lib/voice/orchestrator.ts`; Test `test/orchestrator.test.ts`. Transport-agnostic: given an utterance + injected providers + a mock `runAgent`, it transcribes, runs the agent, chunks text → TTS, and emits events; supports abort (barge-in).

- [ ] **Step 1: Write the failing test**

```ts
// test/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleUtterance } from '../server/lib/voice/orchestrator'

const stt = { transcribe: vi.fn(async () => 'what are my tasks') }
const tts = { synthesize: vi.fn(async function* () { yield new Uint8Array([9]) }) }
const runAgent = (async function* () {
  yield { type: 'text-delta', text: 'You have ' }
  yield { type: 'tool-result', name: 'search_tasks', summary: 'listed tasks (2)', undoToken: undefined }
  yield { type: 'text-delta', text: 'two tasks.' }
  yield { type: 'done' }
}) as never

describe('handleUtterance', () => {
  it('STT → runAgent → chunked TTS, emitting transcript/tool/audio events', async () => {
    const events: any[] = []
    await handleUtterance(new Uint8Array([1]), [], {
      stt, tts, voice: 'default', runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events.find(e => e.type === 'transcript' && e.role === 'user')?.text).toBe('what are my tasks')
    expect(events.some(e => e.type === 'tool' && e.name === 'search_tasks')).toBe(true)
    expect(events.some(e => e.type === 'audio')).toBe(true)
    expect(stt.transcribe).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test — confirm FAIL.**

- [ ] **Step 3: Implement**

```ts
// server/lib/voice/orchestrator.ts
import { SentenceChunker } from './chunker'
import { VOICE_TUNING } from './tuning'
import type { SttProvider, TtsProvider } from './providers/types'
import type { AgentMessage, AgentEvent } from '../agent/run'
import { runAgent as realRunAgent } from '../agent/run'

export type VoiceEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool'; name: string; summary: string; undoToken?: string }
  | { type: 'audio'; bytes: Uint8Array }
  | { type: 'state'; state: 'thinking' | 'speaking' | 'idle' }

export interface UtteranceDeps {
  stt: SttProvider
  tts: TtsProvider
  voice: string
  signal: AbortSignal
  emit: (e: VoiceEvent) => void
  runAgent?: (m: AgentMessage[], c: { signal: AbortSignal }) => AsyncGenerator<AgentEvent>
}

/** One user turn: transcribe → run the agent → speak chunked replies. */
export async function handleUtterance(audio: Uint8Array, history: AgentMessage[], deps: UtteranceDeps): Promise<AgentMessage[]> {
  const run = deps.runAgent ?? realRunAgent
  const userText = await deps.stt.transcribe(audio, { language: VOICE_TUNING.stt.language })
  if (!userText) return history
  deps.emit({ type: 'transcript', role: 'user', text: userText })
  const messages: AgentMessage[] = [...history, { role: 'user', content: userText }]

  deps.emit({ type: 'state', state: 'thinking' })
  const chunker = new SentenceChunker(VOICE_TUNING.tts.sentenceMinChars)
  let assistantText = ''

  const speak = async (text: string) => {
    if (deps.signal.aborted) return
    deps.emit({ type: 'state', state: 'speaking' })
    for await (const bytes of deps.tts.synthesize(text, { voice: deps.voice, signal: deps.signal })) {
      if (deps.signal.aborted) return
      deps.emit({ type: 'audio', bytes })
    }
  }

  for await (const ev of run(messages, { signal: deps.signal })) {
    if (deps.signal.aborted) break
    if (ev.type === 'text-delta') {
      assistantText += ev.text
      deps.emit({ type: 'transcript', role: 'assistant', text: ev.text })
      for (const chunk of chunker.push(ev.text)) await speak(chunk)
    } else if (ev.type === 'tool-result') {
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken })
    }
  }
  for (const chunk of chunker.flush()) await speak(chunk)
  deps.emit({ type: 'state', state: 'idle' })

  return assistantText ? [...messages, { role: 'assistant', content: assistantText }] : messages
}
```

- [ ] **Step 4: Run test — PASS.** `pnpm typecheck`.
- [ ] **Step 5: Commit**
```bash
git add server/lib/voice/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(voice): turn orchestrator (STT -> agent -> chunked TTS, abortable)"
```

---

## Task 12: Nitro WebSocket transport

**Files:** Create `server/api/voice/ws.ts`; Modify `nuxt.config.ts` (enable `nitro.experimental.websocket`). Also create `server/lib/voice/providers/index.ts` (factory that builds STT + TTS from env).

- [ ] **Step 1: Provider factory from env**

```ts
// server/lib/voice/providers/index.ts
import { whisperStt } from './stt-whisper'
import { openAiTts } from './tts-openai'
import { VOICE_TUNING } from '../tuning'

export function makeStt() {
  const ai = useRuntimeConfig().ai as Record<string, { baseURL?: string; apiKey?: string; model?: string }>
  const c = ai.stt ?? {}
  return whisperStt({ baseURL: c.baseURL!, model: c.model || 'Systran/faster-whisper-large-v3', apiKey: c.apiKey })
}
export function makeTts(provider = VOICE_TUNING.tts.provider) {
  const ai = useRuntimeConfig().ai as Record<string, { baseURL?: string; apiKey?: string }>
  const key = provider === 'kokoro' ? 'ttsKokoro' : 'ttsChatterbox'
  const c = ai[key] ?? {}
  return openAiTts({ baseURL: c.baseURL!, model: provider, apiKey: c.apiKey })
}
```

- [ ] **Step 2: Enable Nitro websocket** in `nuxt.config.ts` `nitro:` block:
```ts
  nitro: {
    experimental: { tasks: true, websocket: true },
    // ...existing scheduledTasks...
  },
```

- [ ] **Step 3: WebSocket handler**

```ts
// server/api/voice/ws.ts
import { handleUtterance } from '../../lib/voice/orchestrator'
import { makeStt, makeTts } from '../../lib/voice/providers'
import { VOICE_TUNING } from '../../lib/voice/tuning'
import type { AgentMessage } from '../../lib/agent/run'

// Per-connection state lives in the peer's context. Client sends:
//   binary frame = a complete utterance (WAV)  |  text {type:'interrupt'} | {type:'voice', voice}
// Server sends: binary = audio chunk; text JSON = {type:'transcript'|'tool'|'state'}.
export default defineWebSocketHandler({
  open(peer) {
    ;(peer as any).ctx = { history: [] as AgentMessage[], ac: null as AbortController | null, voice: VOICE_TUNING.tts.voice }
  },
  async message(peer, message) {
    const ctx = (peer as any).ctx
    // text control frames
    if (typeof message.text === 'function' && message.text().startsWith?.('{')) { /* h3/crossws: see note */ }
    const raw = message.rawData ?? message.uint8Array?.()
    const asText = (() => { try { return message.text() } catch { return '' } })()
    if (asText && asText.startsWith('{')) {
      const msg = JSON.parse(asText)
      if (msg.type === 'interrupt') ctx.ac?.abort()
      else if (msg.type === 'voice') ctx.voice = msg.voice
      return
    }
    // binary utterance → run a turn
    ctx.ac?.abort()
    ctx.ac = new AbortController()
    const audio = new Uint8Array(raw as ArrayBufferLike)
    ctx.history = await handleUtterance(audio, ctx.history, {
      stt: makeStt(), tts: makeTts(ctx.voice ? VOICE_TUNING.tts.provider : VOICE_TUNING.tts.provider),
      voice: ctx.voice, signal: ctx.ac.signal,
      emit: (e) => {
        if (e.type === 'audio') peer.send(e.bytes)
        else peer.send(JSON.stringify(e))
      }
    })
  },
  close(peer) { (peer as any).ctx?.ac?.abort() }
})
```
> **crossws frame API:** the exact accessor for binary vs text differs by crossws version (`message.text()`, `message.uint8Array()`, `message.rawData`). Confirm against the installed version (`node -e "console.log(require('crossws/package.json').version)"`) and adjust the `message` parsing in `message(peer, message)` accordingly — the control-frame-vs-binary branch is the only thing that must be right. Validate with the smoke test below.

- [ ] **Step 4: Typecheck + WS smoke** (no audio model needed: send a control frame, expect no crash)

Run `pnpm dev`, then a node WS client connects to `ws://localhost:3000/api/voice/ws`, sends `{"type":"voice","voice":"af_heart"}`, and stays open without error. (Full audio path is the manual test in Task 16.)

- [ ] **Step 5: Commit**
```bash
git add server/api/voice/ws.ts server/lib/voice/providers/index.ts nuxt.config.ts
git commit -m "feat(voice): Nitro WebSocket transport + provider factory"
```

---

## Task 13: Client voice composable (`useVoice`)

**Files:** Create `app/composables/useVoice.ts`. Deps: `pnpm add @ricky0123/vad-web`.

This owns mic capture, **Silero VAD** (speech start/stop + barge-in), utterance buffering → WS send, and playback of returned audio. It exposes the same shape the page expects (`state`, `connected`, `transcript`, analysers, `start`/`stop`).

- [ ] **Step 1: Install VAD**

Run: `pnpm add @ricky0123/vad-web`

- [ ] **Step 2: Write the composable**

```ts
// app/composables/useVoice.ts
import { MicVAD } from '@ricky0123/vad-web'

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'
export interface TranscriptEntry { role: 'user' | 'assistant'; text: string }

// Client mirror of the tunable knobs that affect capture/barge-in.
const TUNING = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, bargeInEnabled: true, playbackRate: 1.1 }

export function useVoice() {
  const state = ref<VoiceState>('idle')
  const connected = ref(false)
  const transcript = ref<TranscriptEntry[]>([])
  const error = ref<string | null>(null)

  let ws: WebSocket | null = null
  let vad: MicVAD | null = null
  let audioCtx: AudioContext | null = null
  let micAnalyser: AnalyserNode | null = null
  let outAnalyser: AnalyserNode | null = null
  let playCursor = 0
  let sources: AudioBufferSourceNode[] = []

  function pushDelta(role: 'user' | 'assistant', delta: string) {
    const last = transcript.value[transcript.value.length - 1]
    if (last && last.role === role) last.text += (/\S$/.test(last.text) && /^\w/.test(delta) ? ' ' : '') + delta
    else transcript.value.push({ role, text: delta })
  }

  function stopPlayback() {
    for (const s of sources) { try { s.stop() } catch {} try { s.disconnect() } catch {} }
    sources = []; playCursor = 0
  }

  async function playWav(bytes: ArrayBuffer) {
    if (!audioCtx || !outAnalyser) return
    try {
      const buf = await audioCtx.decodeAudioData(bytes.slice(0))
      const node = audioCtx.createBufferSource()
      node.buffer = buf
      node.playbackRate.value = TUNING.playbackRate
      node.connect(outAnalyser)
      const at = Math.max(audioCtx.currentTime, playCursor)
      node.start(at); playCursor = at + buf.duration / TUNING.playbackRate
      sources.push(node)
      node.onended = () => { sources = sources.filter(s => s !== node) }
    } catch { /* skip undecodable */ }
  }

  async function start() {
    error.value = null
    audioCtx = new AudioContext()
    outAnalyser = audioCtx.createAnalyser(); outAnalyser.fftSize = 256; outAnalyser.connect(audioCtx.destination)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/api/voice/ws`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => { connected.value = true }
    ws.onclose = () => { connected.value = false; state.value = 'idle' }
    ws.onerror = () => { error.value = 'WebSocket error' }
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { state.value = 'speaking'; playWav(e.data) }
      else { const m = JSON.parse(e.data)
        if (m.type === 'transcript') pushDelta(m.role, m.text)
        else if (m.type === 'state') state.value = m.state === 'speaking' ? 'speaking' : m.state === 'thinking' ? 'thinking' : 'idle'
      }
    }

    vad = await MicVAD.new({
      positiveSpeechThreshold: TUNING.positiveSpeechThreshold,
      negativeSpeechThreshold: TUNING.negativeSpeechThreshold,
      minSpeechFrames: TUNING.minSpeechFrames,
      redemptionFrames: TUNING.redemptionFrames,
      onSpeechStart: () => {
        // barge-in: if the assistant is speaking, cut it off
        if (TUNING.bargeInEnabled && state.value === 'speaking') {
          stopPlayback(); ws?.send(JSON.stringify({ type: 'interrupt' }))
        }
        state.value = 'listening'
      },
      onSpeechEnd: (audio: Float32Array) => {
        // VAD gives us the full utterance as Float32 PCM @16kHz → WAV → send
        state.value = 'thinking'
        ws?.send(floatToWav(audio, 16000))
      }
    })
    // expose the VAD's mic stream to the reactor
    micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 256
    vad.start()
  }

  function stop() {
    vad?.destroy(); stopPlayback(); ws?.close(); audioCtx?.close()
    vad = null; ws = null; audioCtx = null; state.value = 'idle'; connected.value = false
  }

  onUnmounted(stop)
  return { state, connected, transcript, error, start, stop, setVoice: (v: string) => ws?.send(JSON.stringify({ type: 'voice', voice: v })),
    micAnalyser: () => micAnalyser, outAnalyser: () => outAnalyser }
}

// Encode Float32 PCM to a 16-bit WAV the STT server accepts.
function floatToWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, samples.length * 2, true)
  let o = 44
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i]!)); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2 }
  return buf
}
```
> `@ricky0123/vad-web` bundles the Silero ONNX model + worklet; it needs the `.onnx` + worklet assets served. If it 404s the model at runtime, copy its `dist` assets into `public/` (mirror the Task notes) or set `baseAssetPath`/`onnxWASMBasePath` options — verify in the manual test and adjust.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS (VAD is client-only; ensure the composable isn't imported server-side).

- [ ] **Step 4: Commit**
```bash
git add app/composables/useVoice.ts package.json pnpm-lock.yaml
git commit -m "feat(voice): useVoice client (Silero VAD + WS + barge-in + playback)"
```

---

## Task 14: Rebuild the `/voice` page on `useVoice`

**Files:** Modify `app/pages/voice.vue` (swap `useUnmute`→`useVoice`); `app/composables/useAgentActivity.ts` stays; reuse `app/components/voice/{Reactor.client,Transcript,Composer}.vue`. Create `server/api/voice/voices.get.ts` (same-origin proxy to the TTS `/v1/voices`).

- [ ] **Step 1: Voices proxy** (avoids the cycle-17 CORS problem)

```ts
// server/api/voice/voices.get.ts
export default defineEventHandler(async () => {
  const ai = useRuntimeConfig().ai as Record<string, { baseURL?: string }>
  const base = (ai.ttsChatterbox?.baseURL || ai.ttsKokoro?.baseURL || '').replace(/\/$/, '')
  if (!base) return { voices: [] }
  try {
    const list = await $fetch<unknown>(`${base}/voices`)
    return { voices: list }
  } catch { return { voices: [] } }
})
```

- [ ] **Step 2: Update `voice.vue`** — change `const unmute = useUnmute()` to `const voice = useVoice()` and update references (`unmute.*` → `voice.*`). The voice picker now fetches from `/api/voice/voices` (same-origin). Keep the reactor/transcript/composer wiring identical (they consume `state`, `transcript`, analysers).

```ts
// app/pages/voice.vue <script setup> (key lines)
const voice = useVoice()
const activity = useAgentActivity()
const activeAnalyser = () => voice.state.value === 'speaking' ? voice.outAnalyser() : voice.micAnalyser()
const { data: voiceList } = await useFetch('/api/voice/voices', { default: () => ({ voices: [] }) })
// build voiceItems from voiceList; on change call voice.setVoice(id)
```
(Reuse the existing `<VoiceReactor>`/`<VoiceTranscript>`/`<VoiceComposer>` template; bind to `voice.*`.)

- [ ] **Step 3: Typecheck + build + render check**

Run: `pnpm typecheck && pnpm build`. Then with `pnpm dev` + login, load `/voice` via playwright-cli: reactor canvas mounts, Connect button present, no console errors.

- [ ] **Step 4: Commit**
```bash
git add app/pages/voice.vue server/api/voice/voices.get.ts
git commit -m "feat(voice): /voice page on useVoice + same-origin voice list"
```

---

## Task 15: Remove cycle-17 client audio

**Files:** Delete `app/composables/useUnmute.ts`, `app/composables/useTextChat.ts` (if only used by old composer — verify), `app/types/opus-recorder.d.ts`, `public/opus/`. Remove `opus-recorder` dep and `NUXT_PUBLIC_UNMUTE_URL`.

- [ ] **Step 1: Verify no references, then delete**

Run: `grep -rn "useUnmute\|opus-recorder\|NUXT_PUBLIC_UNMUTE_URL\|/opus/" app server nuxt.config.ts | grep -v node_modules`
Resolve any remaining references (the Composer's text path should use `/api/agent/chat` directly — keep `useTextChat` if still used). Then:
```bash
git rm app/composables/useUnmute.ts app/types/opus-recorder.d.ts
git rm -r public/opus
pnpm remove opus-recorder
```

- [ ] **Step 2: Drop the env var** from `nuxt.config.ts` `runtimeConfig.public` (`unmuteUrl`) and `.env.example`.

- [ ] **Step 3: Typecheck + build + full test**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: all PASS.

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "chore(voice): remove Unmute/opus client + env"
```

---

## Task 16: Env wiring, docs, cutover

**Files:** `nuxt.config.ts` (runtimeConfig.ai stt/tts), `.env.example`, `docs/wiki/voice-agent.md` (rewrite), `docs/handovers/2026-06-09-voice-v2.md`, roadmap, BACKLOG.

- [ ] **Step 1: Add STT/TTS runtimeConfig** in `nuxt.config.ts` `runtimeConfig.ai`:
```ts
      stt: { baseURL: process.env.AI_STT_BASE_URL, apiKey: process.env.AI_STT_API_KEY, model: process.env.AI_STT_MODEL },
      ttsKokoro: { baseURL: process.env.AI_TTS_KOKORO_BASE_URL, apiKey: process.env.AI_TTS_KOKORO_API_KEY },
      ttsChatterbox: { baseURL: process.env.AI_TTS_CHATTERBOX_BASE_URL, apiKey: process.env.AI_TTS_CHATTERBOX_API_KEY },
```
Append the same keys to `.env.example` (values per `docs/model-requirements.md`).

- [ ] **Step 2: Revert Unmute on the rig (manual, one-time)** — point Unmute's `KYUTAI_LLM_URL` back at qwen (`http://192.168.2.25:8004`) and restart, OR stop the Unmute stack entirely (it's no longer used). Document in the handover.

- [ ] **Step 3: Rewrite `docs/wiki/voice-agent.md`** for the new architecture (4 layers, AI SDK core, providers, tuning, WS). `status: shipped`, `cycle: 18`.

- [ ] **Step 4: Handover `docs/handovers/2026-06-09-voice-v2.md`** — frontmatter (title/cycle:18/status:shipped/date/deferred), what shipped, the model-server dependency, deferred (streaming STT, semantic turn detection, cloud providers), next seam. Update roadmap (cycle 18 row) + BACKLOG.

- [ ] **Step 5: Manual full-voice acceptance** (after the infra agent confirms `docs/model-requirements.md` is green): serve over HTTPS/localhost, Connect, speak — verify turn-taking (`endpointSilenceMs`), barge-in (`minSpeechMsToInterrupt`), tool turn + chip + undo, and tune the constants in `tuning.ts` to taste.

- [ ] **Step 6: Final verify + commit**
```bash
pnpm test && pnpm typecheck && pnpm build
git add -A
git commit -m "docs(voice): env wiring, wiki, handover, roadmap for voice v2"
```

---

## Self-Review

**Spec coverage:**
- §2 four layers → Tasks 8–14. ✅
- §3 AI SDK core (model, ai-tools, run; delete loop/chat-stream/shim) → Tasks 2–6. ✅
- §4 voice loop + barge-in + tuning constants → Tasks 7, 11, 13. ✅
- §5 providers (STT/TTS, swappable, /v1/voices proxy) → Tasks 8, 9, 14. ✅
- §6 transport (Nitro WS), env, dev/prod → Tasks 12, 16. ✅
- §7 teardown → Tasks 6, 15, 16-step2. ✅
- §8 testing (unit no-audio, integration, E2E, manual) → Tasks 3,4,8,9,10,11 (unit), 14 (E2E), 16 (manual). ✅
- §9 YAGNI cuts respected (turn-based STT, no semantic turn model, two TTS). ✅
- §11 build Step 1 = model-requirements.md → Task 1. ✅

**Placeholder scan:** no TBD/TODO; real code per step. Two external-API uncertainties are explicitly flagged with a concrete verification step rather than left vague: the AI SDK `fullStream` text-part field (Task 4 handler accepts both shapes) and the crossws frame accessor (Task 12 note + smoke test). The VAD asset-serving caveat (Task 13) has a concrete fallback.

**Type consistency:** `AgentEvent` (Task 4) is consumed by `orchestrator.ts` (Task 11) and `chat.post.ts` (Task 5) with the same `{type:'text-delta'|'tool-result'|'done'}` shape. `SttProvider`/`TtsProvider` (Task 8) are implemented in Tasks 8/9 and consumed in 11/12 identically. `VOICE_TUNING` (Task 7) keys (`agent.maxSteps`, `tts.sentenceMinChars/provider/voice`, `stt.language`) match every reference in Tasks 4/11/12/13. `runAgent(messages, {signal}, deps?)` signature is stable across Tasks 4, 5, 11.
