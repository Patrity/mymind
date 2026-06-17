---
title: Voice Agent
status: shipped
cycle: 19
updated: 2026-06-10
---

# Voice Agent

> **Cycle 28 update:** the `/voice` page was merged into the unified **`/agent`** surface (talk + type in one place; the visualizer is now a toggle). `/voice` redirects to `/agent`. This page documents the self-hosted STT/TTS + visualizer pipeline (still current); see [agent.md](agent.md) for the unified surface, conversation persistence, and the `speak`-driven convergence.

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
│  TTS provider ◄── sentence-chunk ◄── runAgent(history+text)  │
│         │                            (shared: chat + cron)   │
│         ▼  WAV chunks ──────────────────────────────────────► client
└──────────────────────────────────────────────────────────────┘
   STT: Speaches faster-whisper  (OpenAI /v1/audio/transcriptions)
   TTS: Kokoro or Chatterbox     (OpenAI /v1/audio/speech, streamed)
```

1. **Client voice UI** (`app/composables/useVoice.ts`) — mic capture, Silero VAD, WAV encoding, WebSocket, PCM playback + barge-in. Owns when the user is speaking.
2. **Voice orchestrator** (`server/lib/voice/orchestrator.ts`) — STT → `runAgent` → sentence-chunked TTS; AbortSignal propagation on barge-in; streams audio + transcript + tool-event messages back. Owns the pipeline.
3. **Providers** (`server/lib/voice/providers/`) — `SttProvider` / `TtsProvider` interfaces over OpenAI-spec local endpoints. Owns which models. Swap provider = change env var + `VOICE_TUNING.tts.provider`.
4. **Agent core** (`server/lib/agent/`) — `runAgent` (AI SDK `streamText`), tool registry, prompt, bus, undo. Shared verbatim by voice, `/api/agent/chat`, and future cron agents. Owns the brain.

## Agent core — `runAgent`

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

Active TTS provider is selected by `VOICE_TUNING.tts.provider` (`'kokoro'` or `'chatterbox'`).

See [`docs/model-requirements.md`](../model-requirements.md) for rig setup instructions.

## Tuning (`server/lib/voice/tuning.ts`)

Every runtime knob lives here — no SSH, no rebuild-to-tune:

```ts
export const VOICE_TUNING = {
  vad:     { positiveSpeechThreshold, negativeSpeechThreshold, minSpeechFrames, redemptionFrames, preSpeechPadFrames },
  turn:    { endpointSilenceMs: 700, minUtteranceMs: 250, maxUtteranceMs: 30000 },
  bargeIn: { enabled: true, minSpeechMsToInterrupt: 300 },
  tts:     { provider: 'chatterbox', voice: 'default', sentenceMinChars: 60, playbackRate: 1.1 },
  stt:     { provider: 'faster-whisper', language: 'en' },
  agent:   { maxSteps: 6 },
}
```

The client capture/barge-in/playback knobs are **user-tunable**: `useVoiceSettings` (cookie `voice-settings`, via `useCookie`) holds voice choice, `positiveSpeechThreshold` (negative trails it by 0.15), `minSpeechMs`, `redemptionMs`, `bargeInEnabled`, `playbackRate`. The cog button on `/voice` opens `VoiceSettingsSlideover` — the sensitivity slider has a live meter fed by `voice.speechProb` (Silero per-frame probability via `onFrameProcessed`, the same unit as the threshold). Threshold/timing changes hot-apply through `applyVadSettings()` (debounced VAD-only restart; WS untouched); barge-in and playback rate apply live without restart. Sentence chunking flushes a TTS call on sentence-final punctuation or when `sentenceMinChars` is reached — audio starts before the LLM finishes.

## WebSocket protocol (`/api/voice/ws`)

**Auth:** the WS upgrade is gated by an `upgrade()` hook in `ws.ts` validating the better-auth session — nitro server middleware does NOT run for WS upgrades (crossws handles them), so without this hook the socket was unauthenticated.

**Frame classification:** incoming frames are classified by CONTENT (`server/lib/voice/frames.ts`: `RIFF` magic → audio, JSON → control, else ignored) — never by transport type, because nitro's `crossws@0.3.5` node adapter drops the `isBinary` flag and text frames arrive as Buffers. Relying on `typeof rawData === 'string'` routed JSON control frames into Whisper (HTTP 415).

**Client → server**

| Message | Shape | Meaning |
|---|---|---|
| Binary | `ArrayBuffer` (WAV/PCM, RIFF) | Utterance audio to transcribe |
| Text | `{type:'interrupt'}` | Barge-in: abort current turn |
| Text | `{type:'voice', provider, voice}` | Switch TTS provider/voice |
| Text | `{type:'text', text}` | Typed turn, injected post-STT (`handleTurn`) — same agent loop, TTS reply, and state events as speech |

**Server → client**

| Message | Shape | Meaning |
|---|---|---|
| Binary | `ArrayBuffer` (WAV/PCM) | TTS audio chunk (one per sentence) |
| Text | `{type:'transcript', role, text}` | Transcript line (role: `user` or `assistant`) |
| Text | `{type:'tool', name, summary, undoToken?}` | Tool execution chip |
| Text | `{type:'state', state}` | Orchestrator state: `idle`/`thinking`/`speaking`/`tool` |
| Text | `{type:'error', message}` | Pipeline failure (STT/TTS/agent) — client shows alert + viz error flash, then idle |

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

**VAD asset loading** — `@ricky0123/vad-web` fetches its Silero ONNX model and AudioWorklet from a CDN at runtime. If the CDN 404s (offline lab, air-gap), the VAD silently fails. Fix: set `baseAssetPath` to a self-hosted location, or copy the `dist/` assets into `public/vad/` and point there.

**Mic secure-context** — browsers only grant microphone access in HTTPS or `localhost`. Production must be HTTPS; dev on `http://192.168.*` will be blocked.

## Frontend files

| File | Purpose |
|---|---|
| `app/pages/voice.vue` | Layout: reactor, transcript, composer, connection state |
| `app/composables/useVoice.ts` | VAD, WAV encoding, WebSocket, PCM playback, barge-in; exposes `onVizEvent` emitter |
| `app/composables/useAgentActivity.ts` | SSE → tool chips, undo tokens, agent state |
| `app/composables/useTextChat.ts` | Typed fallback over `/api/agent/chat` |
| `app/components/voice/Reactor.client.vue` | Thin mount: RAF loop, FFT sampling, FPS watchdog, context-loss rebuild, CSS fallback |
| `app/components/voice/Transcript.vue` | Live transcript + tool-action chips + Undo buttons |
| `app/components/voice/Composer.vue` | Typed input — voice loop via WS `{type:'text'}` when connected (animated + spoken reply), `/api/agent/chat` fallback when not |
| `app/components/voice/SettingsSlideover.vue` | Cog-button slideover: voice picker, live-metered VAD tuning, barge-in, playback speed |
| `app/composables/useVoiceSettings.ts` | Cookie-persisted user settings (`voice-settings` via `useCookie`) |
| `app/components/voice/VoicePicker.vue` | Voice selector (fetches live catalog from providers) |
| `app/lib/viz/types.ts` | `BAR_COUNT` (96), `VizState` (7), `VizEvent`, `Directives` |
| `app/lib/viz/tuning.ts` | **All headline visual knobs**: `VIZ_TUNING` (camera/zoom clamps, bloom, point size/alpha, ring radius) + `PALETTE` (per-state colors) |
| `app/lib/viz/emitter.ts` | Generic typed event emitter used by `useVoice` |
| `app/lib/viz/choreographer.ts` | Pure-TS per-frame state machine: voice state + events + audio levels → `Directives` |
| `app/lib/viz/scene.ts` | WebGLRenderer + EffectComposer + UnrealBloomPass; quality tiers; `degrade()` |
| `app/lib/viz/core.ts` | GPU particle sphere — all motion in GLSL vertex shader |
| `app/lib/viz/ring.ts` | 96-bar InstancedMesh mic-frequency ring + error shockwave coloring |
| `app/lib/viz/effects.ts` | 3 amber tool-pulse rings + 160-slot pooled transcription sparks |
| `app/lib/viz/lightning.ts` | Neural "synapse" arcs during thinking (firing=1) / tool (0.35): pooled jagged LineSegments with branches, additive + bloom |
| `app/lib/voice/messages.ts` | Pure WS-message → `{state, delta, events}` mapper (tested, no mocks needed) |

## Voice Visualizer (cycle 19)

The `/voice` page renders a live Three.js visualizer driven entirely by voice state and audio levels. The hard boundary is *signals in → pixels out*: `useVoice` never imports Three.js; the `lib/viz/` units never touch the WebSocket.

UI: the page is two sibling `UDashboardPanel`s — the canvas panel is `resizable` (sized in **%** of the content area: default 75, min 50, max 90; the layout's `UDashboardGroup` uses the default `%` unit app-wide; double-click the handle to reset) with `:ui="{ body: '!p-0' }"` so the Three.js canvas fills it edge-to-edge, and the transcript panel is fluid on the right, hidden below `lg`. Nuxt UI's resize handle only supports a sized panel LEFT of the handle, which is why the canvas (not the transcript) carries `resizable`. Scroll-wheel over the canvas dollies the camera (clamped by `VIZ_TUNING.camera.minZ/maxZ`); an opaque caption over the canvas shows the current turn's message (the only live text on phones). Visual tuning — bloom, zoom, particle size/alpha, ring radius, per-state colors — lives in `app/lib/viz/tuning.ts`; motion timing (lerp speeds, impulse decays, energy/swirl/dim tables) in `choreographer.ts`.

### Signal flow

```
useVoice  ──(state + connected)──►  Reactor.client.vue  ──►  choreographer  ──►  core / ring / effects
            ──(onVizEvent)─────►            │                  (Directives)
mic AnalyserNode ──FFT──────────────────────┘
out AnalyserNode ──amplitude────────────────┘
```

### Seven visual states

`VizState` has 7 values. The first 6 map 1:1 to `VoiceState`; `disconnected` is derived by the choreographer whenever `connected === false` (it is not part of `VoiceState`):

| State | Core (agent sphere) | Ring (mic bars) | Palette |
|---|---|---|---|
| `connecting` | Particles scattered → assembling; ignition swell on WS open | Flat/dim | Dim blue |
| `idle` | Slow breathing, dim, lazy rotation | Near-flat shimmer | Blue |
| `listening` | Calm, slightly brighter | Full 96-bar FFT dance | Cyan ring, blue core |
| `thinking` | Fast swirling vortex (sphere flattens) + neural lightning arcs between particles | Quiet | Violet |
| `speaking` | Burst/scatter driven by TTS amplitude | Faint sympathetic ripple | Bright cyan |
| `tool` | Vortex at reduced energy | Quiet | Amber + radiating pulse rings |
| `disconnected` | Sagged/dim sphere, slow irregular flicker | Off | Desaturated gray-blue |

All transitions are lerped (no hard cuts). The pre-connect look is `disconnected` — the sphere wakes up through `connecting → idle` (ignition impulse on WS open).

### Event impulses

Events are one-shot impulses layered on the active state — they decay, not switch state:

| `VizEvent` | Effect |
|---|---|
| `bargein` | `shatter` spike → particles fly outward then re-form as state flips to `listening` |
| `error` | `errorFlash` → red shockwave sweeps the ring + brief red tint in core (~700 ms) |
| `sttFinal` | `sparks` count → transcription spark particles stream from the ring inward to the core |
| `disconnected` | Structural (derived from `connected === false`); event emitted for future consumers |

### Quality tiers and watchdog

`detectTier()` (in `scene.ts`) selects a tier at mount based on UA + `hardwareConcurrency`:

| Tier | Particles | Pixel-ratio cap | Bloom scale |
|---|---|---|---|
| Mobile | 10 k | 1.5 | 0.5 |
| ≤ 4 cores | 25 k | 2 | 0.75 |
| Desktop | 50 k | 2 | 1.0 |

The **FPS watchdog** in `Reactor.client.vue` uses an EWMA of frame `dt`. If frames stay below ~27 fps for 3 seconds, it steps quality down — step 1: `scene.degrade()` (drops pixel ratio 25%); step 2: `core.setDrawRange(0.5)` (halves particle draw range). Both steps are one-way per session.

### Resilience

- Tab hidden → RAF paused; resumes on `visibilitychange`.
- WebGL context loss → `onContextLost` callback triggers full teardown + rebuild.
- Init failure → `webglOk` flag flipped, CSS `animate-pulse` circle rendered as fallback; voice audio unaffected.
- Unmount → full `geo.dispose()` / `mat.dispose()` / `composer.dispose()` / `renderer.dispose()` chain.

## Cross-references

- [`docs/model-requirements.md`](../model-requirements.md) — rig setup for STT + Kokoro + Chatterbox.
- [`docs/wiki/mcp.md`](mcp.md) — MCP server shares the same `runAgent` tool registry.
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — prod env vars on LXC 114.
