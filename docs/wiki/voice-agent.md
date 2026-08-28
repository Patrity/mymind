---
title: Voice Agent
status: shipped
cycle: 60
updated: 2026-08-27
mymind_id: 34c1de13-ab16-4662-a177-0f8ac99f478e
mymind_hash: 0e1317752e4e7dfa49421a555ad0d15ed3151815bc632e439c16cc3e5579c47c
---

# Voice Agent

> **Cycle 28 update:** the `/voice` page was merged into the unified **`/agent`** surface (talk + type in one place). `/voice` redirects to `/agent`. This page documents the self-hosted STT/TTS pipeline and Bridget's renderer; see [agent.md](agent.md) for the unified surface, conversation persistence, and the `speak`-driven convergence.
>
> **Cycle 60 update (this page's current state):** the TTS chain gained a sanitizer + a real segmenter (`SentenceChunker` and `server/lib/voice/chunker.ts` are **deleted**), the microphone gained a device picker, and the **particle sphere became a particle head**. `app/components/voice/Reactor.client.vue` and the 96-bar mic ring (`app/lib/viz/ring.ts`) are **deleted**; the "Voice Visualizer (cycle 19)" section below has been rewritten as [Bridget's avatar](#bridgets-avatar-cycle-60). The GPU machinery underneath — `scene.ts`, `core.ts`, `effects.ts`, `lightning.ts`, `choreographer.ts`, the quality tiers and the FPS watchdog — is unchanged and re-pointed.

A `/voice` (now `/agent`) page where Tony talks to MyMind with full barge-in and tool use. Cycle 18 replaced the Unmute/Kyutai-orchestrated approach (cycle 17) with a fully self-owned TypeScript pipeline: client-side VAD, a Nitro WebSocket orchestrator, and swappable OpenAI-spec local STT/TTS providers.

## Architecture — four layers

```
┌ Browser /voice ──────────────────────────────────────────────┐
│  mic → Silero VAD (@ricky0123/vad-web)                        │
│  speech-start / silence → utterance WAV encoded              │
│  plays streamed TTS audio (PCM, Web Audio API)               │
│  barge-in: stops playback + sends {type:'interrupt'} on WS   │
└──────────────────┬───────────────────────────────────────────┘
                   │ ONE WebSocket  /api/voice/ws
┌ Nitro: Voice Orchestrator  server/lib/voice/orchestrator.ts ─┐
│  utterance audio ──► STT provider ──► transcript text        │
│         ▲                                    │               │
│  (abort on barge-in)                         ▼               │
│  TTS provider ◄── segment+sanitize ◄── runAgent(history+text)│
│         │                            (shared: chat + cron)   │
│         ▼  WAV chunks ──────────────────────────────────────► client
└──────────────────────────────────────────────────────────────┘
   STT: Speaches faster-whisper  (OpenAI /v1/audio/transcriptions)
   TTS: Kokoro or Chatterbox     (OpenAI /v1/audio/speech, streamed)
```

1. **Client voice UI** (`app/composables/useVoice.ts`) — mic capture, Silero VAD, WAV encoding, WebSocket, PCM playback + barge-in. Owns when the user is speaking.
2. **Voice orchestrator** (`server/lib/voice/orchestrator.ts`) — STT → `runAgent` → segmented, sanitized TTS (see [Speech pipeline](#speech-pipeline-cycle-60)); AbortSignal propagation on barge-in; streams audio + transcript + tool/reasoning/usage messages back. Owns the pipeline.
3. **Providers** (`server/lib/voice/providers/`) — `SttProvider` / `TtsProvider` interfaces over OpenAI-spec local endpoints. Owns which models. Swap provider = change env var + `VOICE_TUNING.tts.provider`.
4. **Agent core** (`server/lib/agent/`) — `runAgent` (AI SDK `streamText`), tool registry, prompt, bus, undo. Shared verbatim by voice, `/api/agent/chat`, and future cron agents. Owns the brain.

## Agent core — `runAgent`

> **Superseded — read [agent.md](agent.md#entry-point-runagent) instead.** This section describes the cycle-18 shape of `runAgent`. The signature, the step budget (16, not 6), the tool registry (20 tools plus `exec` and the subagents, not 11), the profile/context/failover behaviour and the `usage` event have all moved on. Kept for the four-layer framing only.

`server/lib/agent/run.ts` is the single entry point for all AI reasoning surfaces:

```ts
export async function* runAgent(
  messages: CoreMessage[],
  opts: { signal?: AbortSignal }
): AsyncGenerator<AgentEvent>
```

Wraps Vercel AI SDK `streamText` with:
- `@ai-sdk/openai-compatible` model pointed at the local `reasoning` env (qwen via vLLM).
- `server/lib/agent/tools.ts` registry adapted to AI SDK `tool()` via `toAiSdkTools()`.
- `stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps)` (default 6).
- Full `AbortSignal` support (barge-in propagates to the model stream).

The registry (`tools.ts`) is the single source of truth for tool definitions — the same registry feeds `runAgent`, the MCP server, and the chat endpoint. 11 tools: `search_memories`, `get_recent_memories`, `save_memory`, `search_docs`, `search_projects`, `create_project`, `edit_project`, `search_tasks`, `create_task`, `edit_task`, `quick_capture`.

## Providers

All providers are OpenAI-spec endpoints — swapping a model means changing `*_BASE_URL` in env (and optionally the provider constant in `tuning.ts`), never code.

| Role | Env prefix | Default endpoint | Notes |
|---|---|---|---|
| STT | `AI_STT_*` | `:8881` Speaches faster-whisper-turbo | model `deepdml/faster-whisper-large-v3-turbo-ct2` |
| TTS Kokoro | `AI_TTS_KOKORO_*` | `:8880` | voices `af_heart`, `af_sky`, … — see `/v1/voices` |
| TTS Chatterbox | `AI_TTS_CHATTERBOX_*` | `:8884` | voices `happy-us.wav`, `Emily.wav`, … — **voice param is required** (422 if omitted) |

**Which TTS provider actually gets dialed (current behaviour).** STT/TTS models come from the
AI config registry (`assignments.stt` / `assignments.tts`, see [ai-providers.md](ai-providers.md)),
not from env or `VOICE_TUNING.tts.provider` (that constant is legacy and unused for routing).
`/api/voice/voices` aggregates `/v1/audio/voices` from **every** tts model and tags each voice with
its model **label**, so a chosen voice exists on exactly one provider. `server/lib/voice/tts-failover.ts`
(`createTtsSynth` → `pinChainToProvider`) therefore moves the model whose label matches the
client's `provider` to the head of the chain and only then runs `withFailoverOver('tts', …)`.
Absent/unknown provider (legacy clients) → registry order. Failover is unchanged: if the pinned
provider errors, the rest of the chain is tried. *Why:* before 2026-08-16 `ws.ts` dropped the
`provider` field, so with a Chatterbox voice picked every sentence dialed Kokoro first → instant
400 `Voice 'X' not found` → failover to Chatterbox — 190 warn rows and ~1s extra latency per
chunk in one prod session, invisible to the user because the audio still played.

See [`docs/model-requirements.md`](../model-requirements.md) for rig setup instructions.

## Speech pipeline (cycle 60)

The chain used to be `deltas → SentenceChunker → synthesize`. It is now:

```
deltas → raw buffer → segment(raw) → toSpeakable(segment) → synthesize
```

**Segment first, sanitize each completed segment.** The reverse ordering does not work: markdown markers span deltas (`**`, `bold`, `**` can arrive as three), so sanitizing per-delta sees half-markers, and sanitizing the accumulated buffer before segmenting means mapping sanitized offsets back to raw to know what to retain. Segment-then-sanitize avoids both — a partial marker just stays in the retained tail until it completes, and `flush()` sanitizes whatever is left at end of stream.

**The sanitizer must never leak into the transcript.** `assistantText` — what is persisted to `conversation_messages.content` and rendered by `<MdView>` — stays raw markdown. `toSpeakable` output is consumed **only** by the synth. Same display/model split the `reasoning` channel already makes. Verified end to end and mutation-tested both directions.

### `server/lib/voice/speakable.ts` — `toSpeakable(text): string`

Pure, no I/O, unit-tested. The system prompt *asks* the model not to emit markdown in speak mode; this is what **enforces** it (the cycle-37 precedent: never trust the model with a formatting invariant). It strips or rewrites emphasis (`**`, `__`, `*`, `_`), headings, blockquotes, rules, list bullets (ordered items keep their number), links → their label, inline code, fenced code blocks (never read aloud), and tables; and it expands dotted identifiers rather than spelling them — `192.168.2.25` → "one ninety two dot one sixty eight dot two dot twenty five", `v1.2` → "version one point two".

- IPv4 octets are spoken hundreds-digit-first (`192` → "one ninety two", `100` → "one zero zero") — a plain `numberToWords` said "one hundred ninety two", which is not how an address is read.
- The IPv4 rule is ordered **before** the version rule; the version regex would otherwise mangle a 3+-part dotted number.
- **Known limit:** a 4-part dotted number that is not a real address (`1.2.3.4`) is still matched by the IPv4 rule and spoken as one — there is no 0–255 validation. Deliberate for this app's domain.

### `server/lib/voice/segment.ts` — `segment()` + `SpeechChunker`

Pure, unit-tested. Replaces `SentenceChunker`'s `/[^.!?]*[.!?]+(\s|$)/g`, which split on **every** period — so `192.168.2.25` became four separate TTS calls with a seam and a network round-trip between each, in an app whose agent talks about IPs, versions and dotted filenames constantly. That regex was the audible "unnatural pause".

`isSentenceEnd` treats `.!?` as terminal **only** when followed by whitespace or end-of-buffer, which alone protects every complete dotted-numeric token (each internal period is followed by a digit or letter, never a space). On top of that:

- **Streaming guard.** A period at the very end of the buffer immediately preceded by a digit is held in the tail rather than judged — `push('192.168.')` then `push('2.25…')` would otherwise split mid-number at a delta boundary. Scoped to `next === undefined` only; `flush()` sanitizes whatever is left, so nothing is lost if it really was the final period.
- Ellipses are non-terminal; known abbreviations (`Dr.`, `e.g.`, `i.e.`, `etc.`, `vs.`, `approx.`, `St.`, months, …) walk back over letters *and* a single internal dot between letters, so `e.g.` is collected as `e.g` and matched with dots stripped.
- Newlines are hard boundaries; fenced code blocks are tracked so a `.` inside one never splits.
- The `minChars` fallback rose from **60 → 140** and breaks at the last clause boundary (`,` `;` `:` `—` `–`) before the cap, falling back to the last space — it is one-shot per `segment()` call.

`SpeechChunker` keeps `SentenceChunker`'s exact `push(delta): string[]` / `flush(): string[]` signature, which is why the orchestrator's call sites were untouched. It accumulates raw deltas, segments the **raw** buffer, and maps each completed segment through `toSpeakable`.

### TTS model — unchanged this cycle

**Kokoro and Chatterbox are still what serve `/v1/audio/speech`**, selected through the AI config registry as before. The cycle-60 spec's target — **Orpheus 3B** — was **not** stood up: it needs shell on the rig, which is a human step. Everything app-side is already configuration (the registry accepts any OpenAI-spec `/v1/audio/speech` endpoint; no code, no redeploy), so the swap is a `/settings` change whenever the rig serves it. The serving recipe and its landmines are recorded in the [cycle-60 handover](../handovers/2026-08-27-agent-surface-redesign.md).

## Tuning (`server/lib/voice/tuning.ts`)

Every runtime knob lives here — no SSH, no rebuild-to-tune:

```ts
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3, redemptionFrames: 8, preSpeechPadFrames: 4 },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'kokoro', sentenceMinChars: 140, playbackRate: 1.0 },   // see the warning below
  stt:     { language: 'en' },
  agent:   { maxSteps: 16, temperature: 0.7 },
}
```

The client capture/barge-in/playback knobs are **user-tunable**: `useVoiceSettings` (cookie `voice-settings`, via `useCookie`) holds voice choice, `positiveSpeechThreshold` (negative trails it by 0.15), `minSpeechMs`, `redemptionMs`, `bargeInEnabled`, `playbackRate`, and — since cycle 60 — `micDeviceId`. The cog button in the agent toolbar opens `VoiceSettingsSlideover` — the sensitivity slider has a live meter fed by `voice.speechProb` (Silero per-frame probability via `onFrameProcessed`, the same unit as the threshold). Threshold/timing changes hot-apply through `applyVadSettings()` (debounced VAD-only restart; WS untouched); barge-in and playback rate apply live without restart. Segmentation flushes a TTS call on a real sentence end or when `sentenceMinChars` is reached — audio starts before the LLM finishes.

> ⚠️ **`VOICE_TUNING.tts.playbackRate` has no reader.** Cycle 60 moved it 1.1 → 1.0, but playback is driven **solely** by the client cookie — `useVoice` reads `settings.value.playbackRate`, whose default in `VOICE_SETTINGS_DEFAULTS` (`app/composables/useVoiceSettings.ts`) is **still 1.1**. So the audible rate did **not** change for anyone. `VOICE_TUNING.tts.provider` is likewise legacy and unused for routing; only `sentenceMinChars` in that object is actually consumed (by `orchestrator.ts`). Fixing the rate means changing the cookie default, and it is an **open item**, not shipped behaviour.

### Microphone device picker (cycle 60)

`SettingsSlideover.vue` lists `enumerateDevices()`'s `audioinput` entries beside the voice picker; the chosen id persists as `micDeviceId` in the same `voice-settings` cookie. `useVoice` acquires the stream itself with a `deviceId: { exact: … }` constraint (an empty string = no constraint = let the OS choose) and hands it to `MicVAD.new`, which also keeps the analyser wiring explicit.

- **Device labels are empty until microphone permission has been granted at least once** — a browser privacy rule, not a bug. `buildMicOptions` (`app/lib/voice/devices.ts`, pure + unit-tested) falls back to positional names ("Microphone 2") rather than rendering a list of blanks.
- A `devicechange` listener re-enumerates on plug/unplug; a selected device that has vanished is reset to default proactively, and if it is only discovered at `getUserMedia` time the `OverconstrainedError` path resets the cookie, surfaces a message and retries on the default. `NotAllowedError` is **rethrown**, not swallowed into that fallback.
- reka-ui's `USelectMenu`/`ComboboxItem` **rejects an empty-string item value**, so `''` round-trips through a non-empty `DEFAULT_MIC` sentinel — the same pattern as the model picker's `DEFAULT_MODEL`. (This exact bug shipped once before, in cycle 45; it passes typecheck, build and code review, so it is browser-verified with a real click.)

## WebSocket protocol (`/api/voice/ws`)

**Auth:** the WS upgrade is gated by an `upgrade()` hook in `ws.ts` validating the better-auth session — nitro server middleware does NOT run for WS upgrades (crossws handles them), so without this hook the socket was unauthenticated.

**Frame classification:** incoming frames are classified by CONTENT (`server/lib/voice/frames.ts`: `RIFF` magic → audio, JSON → control, else ignored) — never by transport type, because nitro's `crossws@0.3.5` node adapter drops the `isBinary` flag and text frames arrive as Buffers. Relying on `typeof rawData === 'string'` routed JSON control frames into Whisper (HTTP 415).

**Client → server**

| Message | Shape | Meaning |
|---|---|---|
| Binary | `ArrayBuffer` (WAV/PCM, RIFF) | Utterance audio to transcribe |
| Text | `{type:'interrupt'}` | Barge-in: abort current turn |
| Text | `{type:'voice', provider, voice}` | Switch TTS voice; `provider` = the tts model **label** that owns `voice` (from `/api/voice/voices`) and pins the failover chain to it (`ConnState.ttsProvider` → `TurnDeps.ttsProvider` → `synthesize(text, {voice, provider})`) |
| Text | `{type:'text', text}` | Typed turn, injected post-STT (`handleTurn`) — same agent loop, TTS reply, and state events as speech |

**Cancellation is a non-event, end to end.** *Every* inbound frame calls `s.ac?.abort()`
(`ws.ts`), so rapid VAD re-segmentation cancels several turns in a row. Turns then execute
serially behind `s.lock`, so a queued turn can reach STT with an already-dead signal —
`handleUtterance` returns early on `signal.aborted` rather than burning the round-trip.
An abort that lands mid-flight is rethrown **unwrapped** by `withFailoverOver`, so the
`err.name === 'AbortError'` guards in `handleUtterance` and `run()` both fire and the turn
ends silently. Breaking any link in that chain surfaces a spurious "all models failed"
error frame and unacked activity errors on every barge-in (prod, 2026-08-05).

**Server → client**

| Message | Shape | Meaning |
|---|---|---|
| Binary | `ArrayBuffer` (WAV/PCM) | TTS audio chunk (one per sentence) |
| Text | `{type:'transcript', role, text}` | Transcript line (role: `user` or `assistant`) |
| Text | `{type:'tool', name, summary, undoToken?}` | Tool execution chip |
| Text | `{type:'state', state}` | Orchestrator state: `idle`/`thinking`/`speaking`/`tool` |
| Text | `{type:'error', message}` | Pipeline failure (STT/TTS/agent) — client shows alert + viz error flash, then idle |
| Text | `{type:'reasoning', text}` | Reasoning deltas (cycle 45) — display/storage only, never spoken |
| Text | `{type:'usage', inputTokens?, outputTokens?, totalTokens?}` | Per-turn token usage (cycle 60), emitted once — metadata only, never chunked or spoken |
| Text | `{type:'conversation', conversationId, title}` | Emitted once when the first turn lazily creates the thread (cycle 60) |

The full, current frame list — including `{type:'model'}`, `{type:'load'}`, `{type:'new'}` and the exec approve/deny frames — is in [agent.md](agent.md#websocket-protocol-serverapivoicewsts).

## Env vars

```bash
AI_STT_BASE_URL=http://192.168.2.25:8881/v1
AI_STT_MODEL=deepdml/faster-whisper-large-v3-turbo-ct2
AI_TTS_KOKORO_BASE_URL=http://192.168.2.25:8880/v1
AI_TTS_KOKORO_MODEL=kokoro
AI_TTS_KOKORO_VOICE=af_heart
AI_TTS_CHATTERBOX_BASE_URL=http://192.168.2.25:8884/v1
AI_TTS_CHATTERBOX_MODEL=chatterbox
AI_TTS_CHATTERBOX_VOICE=happy-us.wav
```

All wired into `runtimeConfig.ai` in `nuxt.config.ts` (`stt`, `ttsKokoro`, `ttsChatterbox` keys).

## Caveats

**VAD asset loading** — `@ricky0123/vad-web` would fetch its Silero ONNX model and AudioWorklet from a CDN at runtime, and would fail silently in an offline lab. **Already solved:** `nuxt.config.ts` resolves the package's `dist/` and `onnxruntime-web` directories off disk (robust under pnpm's nested layout) and serves them as static `/vad` and `/ort` assets; `useVoice` passes `baseAssetPath: '/vad/'` + `onnxWASMBasePath: '/ort/'`. There are no `public/vad`/`public/ort` directories to look for — the mapping is config, not committed files.

**Mic secure-context** — browsers only grant microphone access in HTTPS or `localhost`. Production must be HTTPS; dev on `http://192.168.*` will be blocked.

## Frontend files

| File | Purpose |
|---|---|
| `app/pages/agent/index.vue` | The three-column shell: thread rail, conversation, Bridget; full-bleed overlay. (`app/pages/voice.vue` no longer exists — `/voice` is a routeRules redirect.) |
| `app/pages/agent/history.vue` | Full browse view for threads: search, counts, resume, delete-with-confirm |
| `app/composables/useVoice.ts` | VAD, WAV encoding, WebSocket, PCM playback, barge-in; `speechProb`; `conversationId`/`conversationTitle`; `stop()` (abort turn) vs `disconnect()` (teardown); exposes `onVizEvent` |
| `app/composables/useVoiceSettings.ts` | Cookie-persisted user settings (`voice-settings`), incl. `micDeviceId` |
| `app/composables/useAgentActivity.ts` | SSE → tool chips (currently unconsumed — chips are inline since cycle 41) |
| `app/composables/useTextChat.ts` | Typed fallback over `/api/agent/chat` |
| `app/components/agent/Toolbar.vue` | The single navbar: thread title, voice-replies switch, model selector, full-screen, threads (under `lg`), settings slot |
| `app/components/agent/ThreadRail.vue` | Permanent left rail: New, search, threads grouped Today / Yesterday / date |
| `app/components/agent/Avatar.client.vue` | Thin mount for `ParticleHead`: boots it, polls the analysers (250 ms), resizes, and renders the CSS fallback when there is no mesh or no WebGL |
| `app/components/agent/MicBand.vue` | "Am I being heard": FFT bars + a separate speech-probability track with the VAD threshold marked |
| `app/components/agent/EmptyState.vue` | Bridget's name, what she can reach, four real starter prompts |
| `app/components/agent/MessageActions.vue` | Per-message copy / retry / timestamp / token count |
| `app/components/agent/ReasoningBlock.vue` | Collapsible "Thinking" block (cycle 45) |
| `app/components/agent/ApprovalPrompt.vue` | Exec approval gate UI |
| `app/components/voice/Transcript.vue` | Live transcript, inline tool chips + Undo, autoscroll pin + "↓ N new", empty state |
| `app/components/voice/Composer.vue` | `UTextarea` (Enter sends / Shift+Enter newline), attachments, mic toggle, Send↔Stop |
| `app/components/voice/SettingsSlideover.vue` | Cog slideover: voice replies, voice picker, **microphone picker**, live-metered VAD tuning, barge-in, playback speed |
| `app/lib/voice/messages.ts` | Pure WS-message → `{state, delta, events, usage, conversation, …}` mapper (tested, no mocks) |
| `app/lib/voice/devices.ts` | Pure `enumerateDevices()` → mic-picker items; the `DEFAULT_MIC` empty-value sentinel |
| `app/lib/agent/transcript.ts` | `buildResumeTranscript` — rebuilds inline chip order from persisted `textOffset` |
| `app/lib/agent/retry.ts` | Pure `truncateForRetry` — walk back to the preceding user turn and truncate |
| `app/lib/avatar/types.ts` | The `Avatar` interface + the `Pose` contract |
| `app/lib/avatar/choreography.ts` | Pure, seeded, event-scheduled pose choreographer: `(state, dt, outLevel) → Pose` |
| `app/lib/avatar/head-buffer.ts` | Pure parsing/validation of the baked point buffer; `HeadBufferError` |
| `app/lib/avatar/particle-head.ts` | The `ParticleHead` renderer — owns the RAF loop, FPS watchdog, context-loss rebuild |
| `scripts/bake-head.ts` | Build-time: MakeHuman export → area-weighted 50k point sample + region weights → `app/assets/head-points.bin` (`pnpm bake:head`) |
| `app/lib/viz/types.ts` | `BAR_COUNT` (96), `VizState` (8), `VizEvent`, `Directives` |
| `app/lib/viz/tuning.ts` | `VIZ_TUNING` (camera/bloom/point size + the new `head` block: scale, jaw travel, pitch pivot, facing floor, scan band) + `PALETTE` per state |
| `app/lib/viz/emitter.ts` | Generic typed event emitter used by `useVoice` |
| `app/lib/viz/choreographer.ts` | Pure-TS per-frame state machine: state + events + audio levels → `Directives` (colour, energy, effects) |
| `app/lib/viz/scene.ts` | WebGLRenderer + EffectComposer + UnrealBloomPass; quality tiers; `degrade()` |
| `app/lib/viz/core.ts` | GPU point cloud — all motion in the GLSL vertex shader; head path adds jaw/brow displacement, yaw + pivoted pitch, assemble, eye gain, tool scan |
| `app/lib/viz/effects.ts` | 3 amber tool-pulse rings + 160-slot pooled transcription sparks |
| `app/lib/viz/lightning.ts` | Neural "synapse" arcs during thinking / tool — pooled jagged LineSegments, additive + bloom |

> **Deleted in cycle 60:** `app/components/voice/Reactor.client.vue`, `app/components/agent/HistorySlideover.vue`, `app/lib/viz/ring.ts`, `server/lib/voice/chunker.ts`. `app/components/voice/VoicePicker.vue` was already gone before this cycle (the picker is inline in `SettingsSlideover.vue`). Once `ring.ts` was gone, `Directives.ringColor`/`ringLevels`/`micMix` had zero readers left anywhere in the repo — a later pass (final-fix wave) removed those three fields plus the per-frame smoothing that filled them, confirmed by grep, not typecheck (the choreographer that fills them also declares the type, so typecheck alone can't prove a field dead). `BAR_COUNT` and `VIZ_TUNING.ring.radius` **do** survive, but not for the ring: `BAR_COUNT` sizes the raw mic-level array the head still resamples every frame to feed `energy` during `listening` (via `micAverage`), and `effects.ts` still reads `VIZ_TUNING.ring.radius` (as `RING_RADIUS`) to place the tool-pulse rings. `PALETTE.*.ring` also survives, but through `MicBand.vue` (`PALETTE.listening.ring` / `PALETTE.idle.ring`), not through `Directives`.

## Bridget's avatar (cycle 60)

The particle **sphere** became a particle **head**. The GPU pipeline cycle 19 built is unchanged and re-pointed: same `scene.ts` renderer + `EffectComposer` + `UnrealBloomPass`, same quality tiers and `degrade()`, same `effects.ts` tool pulses and transcription sparks, same `lightning.ts` synapse bolts, same pure `choreographer.ts`. What changed is the point distribution, a second (pose) choreographer, and a shader that can move a face.

The hard boundary still holds: **`useVoice` never imports Three.js, and nothing under `lib/avatar` touches the WebSocket.**

### The `Avatar` seam

```ts
// app/lib/avatar/types.ts
export interface Avatar {
  setState(s: VizState): void
  pushEvent(e: VizEvent): void
  setAnalysers(mic: AnalyserNode | null, out: AnalyserNode | null): void
  resize(w: number, h: number): void
  dispose(): void
}
```

`ParticleHead` (`app/lib/avatar/particle-head.ts`) is the only implementation. The seam exists so a rigged-mesh renderer can replace it later without touching the orchestrator or `useVoice` — and it is what made the avatar workstream the cycle's designated cut line. `createParticleHead(host, opts)` takes the **container**, not a canvas: `scene.ts` creates and owns the canvas and must, so the context-loss rebuild can replace it.

### Mesh → point buffer (build-time, not a runtime loader)

1. Tony generates a female head in **MakeHuman (official, unmodified build)** and exports it to `assets/source/bridget-head.glb`. An export from an official build is **CC0** — public domain, commercial use, redistribution, no attribution. (FLAME and the Basel Face Model were rejected: research licence only. Recorded so a future session does not reach for them.)
2. `pnpm bake:head` (`scripts/bake-head.ts`) reads it, **area-weighted**-samples 50 000 points across the surface (verified against a synthetic 1-huge-vs-100-tiny-triangle mesh: sampling density tracks *area*, 99.996 %, not triangle count), computes per-point region weights, and writes a packed `Float32Array` to `app/assets/head-points.bin`.
3. At runtime the browser fetches **only that buffer** and uploads it straight into the existing `BufferGeometry`. No mesh, no GLTF loader, no three.js loader chain in the client bundle.

**Layout — 9 interleaved floats per point** (`FLOATS_PER_POINT = 9`, 36-byte stride): `x, y, z, nx, ny, nz, jawW, eyeW, browW`.

| Attribute | Purpose |
|---|---|
| `jawW` | `smoothstep(lipY, chinY, y) ** 0.6 × (1 − 0.6 · smoothstep(hingeInner, hingeOuter, abs(x)))` — zero at the upper lip, full at the chin, falling off toward the hinge |
| `eyeW` | eye region — brightens on listening/thinking, dims on blink |
| `browW` | brow region — lifts on stressed syllables |

**`jawW` is the fix for the cleave.** A *binary* jaw region translated as a block visibly splits the head at the lip line. Measured counterfactual at the jaw trough: 64.2 % row-density idle / 56.7 % with the shipped smooth weight / **3.8 %** with a binary `>0.5` region / **0.0 %** with `>0.15` — the binary version *is* the cleave. The `** 0.6` curve lifts the low end so the lower lip trails the chin at roughly a quarter of the travel, which is what makes the mouth read as opening.

`parseHeadBuffer` validates the stride **hard**, on purpose: a missing static asset does not reliably 404 in this app — the SPA catch-all can return a 200 with an HTML body. An HTML page is essentially never a multiple of 36 bytes, and the finite-value check catches it when it is. Every "no usable buffer" condition (not baked, 404, network failure, truncated download, HTML in place of the asset) raises `HeadBufferError` so the mount can drop to its fallback quietly instead of rendering garbage geometry.

### Pose and the shader

Jaw displacement and head rotation happen in the **vertex shader**, driven by uniforms from the pose choreographer — consistent with cycle 19, where all core motion is already GLSL. `VIZ_TUNING.head` holds the knobs (`scale`, `pointSize`, `alpha`, `jawTravel`, `browLift`, `pivotY`, `pivotZ`, `facingFloor`, the scan band).

- **Pitch rotates about a pivot behind and below the face** (`pivotY -0.6`, `pivotZ -0.5`, head-local), near the base of the skull. Rotating about the mesh origin translates the face up the screen instead of rotating it.
- **Positive pitch means looking UP.** This convention has been inverted three separate times in this project's history, so it is pinned by a unit test and was settled *structurally*: glTF 2.0 defines **+Z as front** and `bake-head.ts` never reorients the mesh (it only normalizes by `maxX` and recentres Y), so the face is on +Z **by construction**, not by luck of one export. The shipped rotation gives `d(screen centroid height)/d(pitch) = +0.70`; the textbook `q.y*cp − q.z*sp` gives −0.70 and drops the nose. The lightning bolts follow with `rotation.set(-pose.pitch, pose.yaw, 0)` because Three's rotation about +X is the textbook one the head shader deliberately inverts.
- A **facing-based alpha** term (`facingFloor 0.28`) dims the far side of the surface. Additive points on a closed surface otherwise read as a blob; this is what makes the cloud read as a head.

### Choreography — event-scheduled, seeded, pure

`app/lib/avatar/choreography.ts`, in the style of the tested `viz/choreographer.ts`. `createChoreographer(rng = Math.random).step(state, dt, outLevel) → Pose`. **The RNG is injected**, so tests seed it and assert deterministic sequences while production gets real randomness. Nothing is a periodic function — the first sketch used summed sines throughout and read as an obvious loop.

| State | Behaviour |
|---|---|
| `connecting` | Points arrive scattered and converge (`assemble` ramps at 0.55/s; every other state snaps in at 1.2/s). One ignition per session. |
| `idle` | Breathing drift — a fresh random yaw target every 1.2–3.6 s, level pitch. |
| `listening` | Turns ~0.24 rad toward the viewer and holds; nods at random intervals with random depth, ~34 % of them doubles; eye points brighten (`eyeGain 2.0`). |
| `thinking` | Chin **lifts** (pitch +0.18…+0.34 — positive is up); gaze **saccades**, jumping to a random target and holding 0.5–2.0 s, with a snappy ease. Not a smooth sweep — that is how eyes actually behave. |
| `speaking` | Faces the viewer. Jaw driven by a syllable-and-phrase envelope from the **TTS output analyser** (randomised peak and duration per syllable, grouped into phrases with pauses); brows lift on stressed syllables; a small head shift at phrase boundaries. |
| `typing` | Fires on **every** text turn, so a neutral face here is a visible dead spot: eyes down at the page (pitch −0.09), gaze ratcheting along a line in 0.10–0.28 s steps with a snap back at the line end. |
| `tool` | Amber scan sweeps down the face (`uScan` past 1.0 into a gap, so there is a pause between sweeps); the existing pulse rings, repositioned. |
| `disconnected` | Dormant, not dead: chin settles toward the chest, `eyeGain` drops to 0.25, and a rare slow drift every 3.5–8 s keeps it from reading as a frozen renderer. Derived structurally from `connected === false`, as in cycle 19. |
| `error` | The face fractures outward and re-forms — the existing shatter impulse, now with something to shatter. |

Every target is **lerped**, including `eyeGain` and `scan`: snapping them on state exit popped brightness (`listening → idle`) and cut the tool sweep dead mid-stroke.

**Lip-sync is amplitude-driven, not visemes.** Neither Kokoro nor Chatterbox returns phoneme timings, and real visemes need a forced-aligner pass per chunk. This gets the rhythm right, not the shapes.

### The mic band replaces the ring

`app/components/agent/MicBand.vue` sits at the foot of her column and along the bottom edge in full-bleed. The 96-bar `ring.ts` InstancedMesh is **deleted** — it was decorative and could not answer the one question that matters. The band carries **two** signals in different units, which is why a single "VAD threshold" line drawn across spectrum bars would have been dishonest:

- **FFT bars** (56, log-spaced, from the existing `micAnalyser` at `fftSize: 256` → 128 bins) — amplitude: what is actually arriving at the microphone.
- **A speech-probability track** along the bottom edge with `positiveSpeechThreshold` marked — Silero's per-frame probability from `onFrameProcessed`, the same unit the settings slideover's sensitivity meter uses, and the thing that actually decides whether a turn fires.

Bars and track go accent-coloured when the VAD reports speech. Colours are reused from the existing `PALETTE` (listening cyan / idle blue / tool amber), not invented. Verified live: the threshold marker lands at exactly `width × threshold` for 0.5 and 0.8, and the canvas is bit-identical when the mic is off — "quiet", not "frozen".

> `micAnalyser` is created **once** per `connect()` and never reassigned by `enableMic`/`disableMic`/`applyVadSettings`/a device change — new streams are routed into the same node. Checked deliberately, because a device switch that swapped the node would silently freeze the band while the avatar beside it kept animating.

### Signal flow

```
useVoice  ──(state + connected)──►  Avatar.client.vue ──► ParticleHead ──┬─► viz choreographer ─► core / effects / lightning
          ──(onVizEvent)─────────►                                       └─► pose choreographer ─► Pose ─► shader uniforms
mic AnalyserNode ──FFT──────────────────────────────────────────────────────┘        │
out AnalyserNode ──amplitude────────────────────────────────────────────────────────┘
```

`Avatar.client.vue` **polls** `micAnalyser()`/`outAnalyser()` every 250 ms for an identity change rather than widening the push-only `Avatar` interface with a getter — `useVoice` creates those nodes lazily. Cost: a mic enabled right at a turn boundary can miss up to a quarter-second of drive.

### Two presentations

- **Column** (default): her `agent-bridget` panel, clamped 240–420 px, with the mic band at her feet.
- **Full-bleed**: the toolbar's full-screen button (Escape returns) drops the chat furniture — her, the band, and the current line as a caption rendered through `<MdView>`. See [agent.md](agent.md#full-bleed-voice-mode).

### Quality tiers, watchdog, resilience

`detectTier()` (in `scene.ts`) still selects at mount from UA + `hardwareConcurrency`:

| Tier | Particles | Pixel-ratio cap | Bloom scale |
|---|---|---|---|
| Mobile | 10 k | 1.5 | 0.5 |
| ≤ 4 cores | 25 k | 2 | 0.75 |
| Desktop | 50 k | 2 | 1.0 |

**One 50 k bake serves every tier** — the renderer draws a prefix (`setDrawRange(tier.particles / points.count)`) rather than baking three files. The **FPS watchdog** lives in `particle-head.ts` now: an EWMA of frame `dt`; sustained sub-27 fps for 3 s steps quality down once via `scene.degrade()` (−25 % pixel ratio) and once more by halving the draw range. Both one-way per session.

- Tab hidden → RAF paused; resumes on `visibilitychange`. Scroll-wheel over her dollies the camera.
- WebGL context loss → full teardown + rebuild. The parsed point buffer is kept in memory, so the rebuild costs no second download.
- 10 consecutive frame faults → teardown + `onFatal`, rather than spamming the console forever.
- **No mesh, no WebGL, or an unusable buffer → the CSS fallback** (a soft pulsing circle). This is an *expected* deployment state, not a fault: it logs **one warning** naming the missing file and the `pnpm bake:head` command, never an error, and voice/chat are unaffected.

### ⚠️ The head mesh does not exist yet

`assets/source/bridget-head.glb` is **not in the repo** — generating it in an official MakeHuman build is a human step, and nothing fabricated was committed in its place (`git ls-files` carries zero `.bin`/`.glb`/`.gltf`/`.obj`/`.fbx`). Until it exists, **`/agent` shows the CSS fallback where Bridget should be.** The renderer was built and validated against a scratch-only placeholder buffer that was never committed; once the real head lands, expect a *tuning* pass on exposure/density and proportions, not a rebuild.

Two operational notes that follow from this:

- **`app/assets/head-points.bin` is deliberately NOT gitignored.** Production builds from source and cannot run MakeHuman, so the baked buffer must be committed or prod renders the fallback forever. It is a committed build artifact, by design.
- **`pnpm bake:head` only takes effect in a built artifact after a rebuild.** `import.meta.glob` resolves at **build** time, so a `.bin` dropped next to a running production build is invisible. (Vite dev *does* pick up a new `.bin` with no restart — confirmed — which is exactly why this is easy to miss.) See [`DEPLOYMENT.md` §12](../DEPLOYMENT.md).

## Cross-references

- [`docs/model-requirements.md`](../model-requirements.md) — rig setup for STT + Kokoro + Chatterbox.
- [`docs/handovers/2026-08-27-agent-surface-redesign.md`](../handovers/2026-08-27-agent-surface-redesign.md) — cycle 60: the Orpheus serving recipe (and its landmines), the MakeHuman/CC0 provenance requirement, and the open items.
- [`docs/wiki/mcp.md`](mcp.md) — MCP server shares the same `runAgent` tool registry.
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — prod env vars on LXC 114.
