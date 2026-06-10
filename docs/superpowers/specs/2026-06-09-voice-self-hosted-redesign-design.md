---
title: Voice Agent v2 — Self-Hosted, Self-Orchestrated — Design
status: spec
cycle: 18
created: 2026-06-09
supersedes: 2026-06-08-voice-agent-jarvis-design.md (cycle 17 — Unmute-orchestrated voice)
---

# Voice Agent v2 — Self-Hosted, Self-Orchestrated

Replace the Unmute/Kyutai-orchestrated voice path (cycle 17) with a voice layer we own end-to-end
in TypeScript: our own agent loop, our own VAD/barge-in, and **swappable, OpenAI-spec local STT/TTS
providers**. One agent core powers voice, text chat, and cron agents.

## 1. Why (the four costs of the Unmute approach)

Cycle 17 shipped working voice by making our agent loop Unmute's "LLM." That bought barge-in for
free but cost us, concretely:
1. **One global LLM config** on the Unmute backend → dev and prod can't coexist.
2. **All tuning lives on the rig** behind SSH + container restarts (seed, voices, cfg_alpha…).
3. **Model + protocol lock-in** to Kyutai (custom msgpack/moshi binary; dragging; emotional voices; no speed knob).
4. **Voice is structurally separate from text** — different brains, no shared context.

Owning the loop fixes all four. Research (2026-06-09, two deep-research passes) confirmed: local
streaming/turn-based STT is solved off-the-shelf, strong local TTS (Kokoro/Chatterbox/XTTS) all
expose OpenAI-spec `/v1/audio/speech`, and the Vercel AI SDK is the right TS primitive for the loop.
Vendor latency/quality benchmarks did **not** survive verification — so component choices are by
capability/protocol, and final latency is **measured on the rig**, not assumed.

## 2. Architecture — four swappable layers

```
┌ Browser /voice ─────────────────────────────────────────────┐
│  mic capture + Silero VAD (client) → speech/silence + barge-in│
│  plays streamed TTS audio                                     │
└───────────────┬──────────────────────────────────────────────┘
                │ ONE WebSocket (audio up; audio + transcript + tool-events down)
┌ Nitro: Voice Orchestrator (server/lib/voice/*) ─────────────┐
│  utterance audio ─► STT provider ─► text                     │
│        ▲                                  │                  │
│   (abort on barge-in)                     ▼                  │
│   TTS provider ◄── sentence-chunk ◄── AGENT CORE (runAgent)  │
│        │                              (shared w/ chat + cron)│
│        ▼ audio chunks ─────────────────────────────────────► client
└──────────────────────────────────────────────────────────────┘
   STT: faster-whisper (OpenAI /v1/audio/transcriptions)
   TTS: Kokoro + Chatterbox (OpenAI /v1/audio/speech), swappable by config
```

1. **Client voice UI** — mic, Silero VAD, barge-in detection, playback. Owns *when* you're talking.
2. **Voice orchestrator** (Nitro) — STT → agent core → sentence-chunked TTS; cancellation/barge-in; streams audio back. Owns the *pipeline*.
3. **Providers** — `SttProvider` / `TtsProvider` interfaces over OpenAI-spec local endpoints. Owns *which models*.
4. **Agent core** (`server/lib/agent/*`) — tools, prompts, loop (on the AI SDK). Shared verbatim by voice, chat, cron. Owns *the brain*.

The voice surface is the only layer that knows about audio/VAD/providers; the core stays pure.

## 3. Agent core on the Vercel AI SDK

**Keep:** `tools.ts` (registry: name/description/zod/kind/handler/undo — source of truth), `prompt.ts`,
`bus.ts`, `undo.ts`, and the MCP server (registers from the same registry).

**Delete:** `streamChat.ts`, `loop.ts`, the Zod→JSON-schema mapper, and the `/api/agent/llm/v1/*`
Unmute shim (+ the LAN-only middleware exemption, + `openai-chunk.ts`). All replaced by the SDK.

**New — single entry point:** `server/lib/agent/run.ts`:
```ts
export async function* runAgent(messages, opts: { signal?: AbortSignal }): AsyncGenerator<AgentEvent>
// wraps streamText({ model, system: buildSystemPrompt(), tools, stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps), abortSignal: opts.signal })
// consumes result.fullStream → yields { type: 'text-delta'|'tool-start'|'tool-result'|'done', ... }
// tool execute() wrappers publish to bus + register undo (as today)
```
- Model: `@ai-sdk/openai-compatible` `createOpenAICompatible({ baseURL })` pointed at the local `reasoning` model (qwen via vLLM). Swap model = env change.
- Tools: the registry adapts to AI SDK `tool({ description, inputSchema: <zod>, execute })`; registry stays the single source of truth (a small `toAiSdkTools(registry)` adapter).
- **Three consumers, one core:** `runAgent` is called by the voice orchestrator, the text-chat endpoint (`/api/agent/chat`), and cron agents. Same tools, prompt, undo, activity bus everywhere.

New deps: `ai`, `@ai-sdk/openai-compatible`.

## 4. Voice loop + barge-in (we own it; everything tunable)

```
Client VAD (Silero)                         Server orchestrator
speak → speech-start
stop  → silence ≥ turn.endpointSilenceMs ─► send utterance audio ─► STT.transcribe() → text
                                            runAgent(history+text) ─► sentence-chunk ─► TTS.synthesize()
play streamed audio  ◄──────────────────────────────────────────  audio chunks + transcript + tool events
── BARGE-IN ──
speech-start while assistant speaking, sustained ≥ bargeIn.minSpeechMsToInterrupt:
  client: stop playback instantly + send {type:'interrupt'}
  server: abort runAgent (AbortSignal) + stop TTS synthesis → back to listening
```
- **Echo:** mic uses `echoCancellation:true` (already proven) so the assistant's own audio doesn't false-trigger barge-in; thresholds are the second defense.
- **Turn-taking** is VAD-silence-based (no streaming STT, no semantic-turn model in v1). A `maxUtteranceMs` cap and `minUtteranceMs` floor guard against runaways and coughs.
- **Sentence chunking:** the orchestrator accumulates `runAgent` text deltas and flushes a TTS chunk on sentence-final punctuation or when `tts.sentenceMinChars` is reached, so audio starts before the LLM finishes.

### Tuning surface — `server/lib/voice/tuning.ts` (client mirrors the VAD/turn/bargeIn subset)
```ts
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'chatterbox', voice: 'default', sentenceMinChars: 60, playbackRate: 1.1 },
  stt:     { provider: 'faster-whisper', language: 'en' },
  agent:   { maxSteps: 6 },
}
```
Every knob we'll iterate on (interrupt sensitivity, end-of-turn pause, chunk size, speed, voice) is a
constant here — no SSH, no rebuild-to-tune. Provider base URLs come from env (§6).

## 5. Providers (swappable, OpenAI-spec)
```ts
// server/lib/voice/providers/
interface SttProvider { transcribe(audio: Buffer, opts: { language?: string }): Promise<string> }      // POST /v1/audio/transcriptions
interface TtsProvider { synthesize(text: string, opts: { voice: string }): AsyncIterable<Uint8Array> }  // POST /v1/audio/speech (streamed)
```
- **STT:** `faster-whisper` adapter (Speaches/faster-whisper-server) → one impl.
- **TTS:** `kokoro` + `chatterbox` adapters (both OpenAI-spec). Selected by `VOICE_TUNING.tts.provider`; per-call voice. Voice list fetched from `/v1/voices` when available (same-origin proxy through MyMind to avoid the CORS issue we hit in cycle 17).
- A new model later = a new adapter or just a base_url. **No protocol lock-in.**

## 6. Transport, config, infra
- **One Nitro WebSocket** via `defineWebSocketHandler` (`/api/voice/ws`): client→server (utterance audio bytes, `{type:'interrupt'}`, `{type:'config'}`), server→client (audio chunks, `{type:'transcript', role, delta}`, `{type:'tool', …}`, `{type:'state', …}`).
- **Audio format:** client sends WAV/PCM utterances; TTS returns WAV/PCM per sentence → browser plays via `decodeAudioData`/PCM scheduling (simpler than cycle-17 Opus pages; the click/decoder pain largely disappears). Reuse the playbackRate speed control + gapless scheduling from cycle 17.
- **Env:** `AI_STT_BASE_URL`/`AI_STT_MODEL`, `AI_TTS_KOKORO_BASE_URL`, `AI_TTS_CHATTERBOX_BASE_URL` (see `docs/model-requirements.md`). No `NUXT_PUBLIC_UNMUTE_URL`.
- **Dev/prod:** the orchestrator + providers are all in-app and env-config'd — dev points at dev, prod at prod. The cycle-17 global-config problem is gone.
- **Model servers** stood up per `docs/model-requirements.md` (build Step 1).

## 7. What gets removed (cycle-17 teardown)
`server/api/agent/llm/**`, `server/lib/agent/{loop,chat-stream,openai-chunk}.ts`, `server/lib/ai/chat-stream.ts`,
the `useUnmute` composable + opus-recorder dep + `public/opus/*`, `NUXT_PUBLIC_UNMUTE_URL`, and the
`/api/agent/llm` middleware exemption. The Unmute backend reconfig is reverted (its LLM points back at qwen).
Net: less code, no custom protocol, no rig-side voice config.

## 8. Testing
- **Unit (no audio):** the orchestrator state machine (idle→listening→thinking→speaking, barge-in abort), the sentence-chunker, `runAgent` event mapping (mock model), provider adapters (mock fetch). Registry↔MCP parity.
- **Integration:** provider adapters against the real rig endpoints (STT round-trip, TTS bytes).
- **E2E (playwright-cli):** `/voice` renders; the **typed** chat path drives `runAgent` end-to-end (tools + chips) with no audio.
- **Manual:** full voice loop (turn-taking feel, barge-in, tuning the constants).

## 9. Scope / YAGNI (v1 cuts)
- Turn-based STT only (no streaming partials, no semantic-turn model) — VAD-silence turn-taking. Revisit if it feels laggy.
- No live captions during speech (turn-based STT → transcript appears after you stop).
- Two TTS providers (Kokoro, Chatterbox); cloud STT/TTS remain a future base_url swap, not built.
- Voice cloning, multi-voice persona switching: out (Chatterbox supports it; not wired in v1 beyond voice selection).

## 10. Unit boundaries
- `server/lib/agent/*` (tools, prompt, run, bus, undo) — no audio/voice imports; consumed by voice, chat, cron, MCP.
- `server/lib/voice/orchestrator.ts` — depends on `runAgent` + the provider interfaces + `tuning.ts`; transport-agnostic (testable with mock providers).
- `server/lib/voice/providers/*` — each adapter depends only on a base URL + fetch.
- `server/api/voice/ws.ts` — thin WS adapter over the orchestrator.
- Client: `useVoice.ts` (VAD + capture + playback + WS) depends only on the WS protocol + `VOICE_TUNING` subset.

## 11. Build sequencing
**Step 1: `docs/model-requirements.md`** (DONE) — instructions for the infra agent to stand up STT +
Kokoro + Chatterbox so provisioning runs in parallel with the build. The rest follows the implementation plan.
