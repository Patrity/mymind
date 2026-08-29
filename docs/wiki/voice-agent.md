---
title: Voice Agent
status: shipped
cycle: 60
updated: 2026-08-29
mymind_id: 34c1de13-ab16-4662-a177-0f8ac99f478e
mymind_hash: 4c137cfd9909ca9ceb0b2350a7dc9807c90d8bdaa5f664fb5ddb564c4c93c0e3
---

# Voice Agent

> **Cycle 28 update:** the `/voice` page was merged into the unified **`/agent`** surface (talk + type in one place). `/voice` redirects to `/agent`. This page documents the self-hosted STT/TTS pipeline and Bridget's renderer; see [agent.md](agent.md) for the unified surface, conversation persistence, and the `speak`-driven convergence.
>
> **Cycle 60 update:** the TTS chain gained a sanitizer + a real segmenter (`SentenceChunker` and `server/lib/voice/chunker.ts` are **deleted**), the microphone gained a device picker, and the **particle sphere became a particle head**. `app/components/voice/Reactor.client.vue` and the 96-bar mic ring (`app/lib/viz/ring.ts`) are **deleted**; the "Voice Visualizer (cycle 19)" section below has been rewritten as [Bridget's avatar](#bridgets-avatar-cycle-60). The GPU machinery underneath — `scene.ts`, `core.ts`, `effects.ts`, `lightning.ts`, `choreographer.ts`, the quality tiers and the FPS watchdog — is unchanged and re-pointed.
>
> **Post-handover update (2026-08-28, this page's current state):** five follow-on commits landed after the cycle-60 handover closed, correcting two claims that handover made. **The head mesh now exists and is committed** — `assets/source/bridget-head.glb` and `app/assets/head-points.bin` are both in the repo, `bake-head.ts` was rewritten to merge every mesh/node instead of just the first primitive, keep only the skin shell (66 shells in the real export; eyeballs/teeth/helper ribbons were 40% of the triangles), sample mesh edges instead of random surface points, and use landmarks measured off the discarded shells. **Orpheus is now live** on the rig and registered in production, at the tail of the TTS failover chain. TTS synthesis is also now pipelined (concurrency ramps 1→3) instead of fully sequential. See [Speech pipeline](#speech-pipeline-cycle-60), [Providers](#providers) and [Bridget's avatar](#bridgets-avatar-cycle-60) below, and the [cycle-60 handover's follow-on section](../handovers/2026-08-27-agent-surface-redesign.md#follow-on-work-landed-after-this-handover-2026-08-28) for the full commit list. **Still open, not solved by any of this:** the avatar's jaw doesn't hinge, the talking motion doesn't read as natural, and the model doesn't read as a woman (Tony's own assessment, deferred by him); exposure/density (`VIZ_TUNING.head`) has never been tuned against the real head; the export is body-only (no hair, no eyes) so those sockets are empty by construction; and which TTS voice to adopt is undecided pending Tony's ears.

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
| TTS Chatterbox | `AI_TTS_CHATTERBOX_*` | `:8884` | **Chatterbox Turbo** (350M) as of 2026-08-28, not the original 0.5B the cycle-60 handover warned about — voices `happy-us.wav`, `Emily.wav`, … — **voice param is required** (422 if omitted) |
| TTS Orpheus | — (registered via `ai_config`, not env) | `http://192.168.2.25:5005/v1` | model `orpheus`, 25 voices, default `tara`; llama.cpp backbone running `--parallel 3`. **Live as of 2026-08-28** — see [TTS provider status](#tts-provider-status-2026-08-28) below |

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

## Speech pipeline (cycle 60 + pipelined synthesis, 2026-08-28)

The chain used to be `deltas → SentenceChunker → synthesize`. It is now:

```
deltas → raw buffer → segment(raw) → toSpeakable(segment) → SpeechPipeline → synthesize
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
- **`maxChars` (200), added 2026-08-28, is a HARD cap and is NOT one-shot** — it re-fires every time a still-open segment reaches it, however many times that takes within one `segment()` call. Without it, a sentence whose only clause/terminal punctuation sits at the very end could grow arbitrarily long once the one-shot `minChars` cut had already fired — on a slow autoregressive engine (~0.067s/char measured on Orpheus) a 400-char segment is a ~27s stall before a single sample plays.
- **`firstMax` (60), added 2026-08-28**, replaces `minChars` — not `maxChars` — for whichever segment is first to close in a `segment()` call, so the turn's opening segment is short and time-to-first-audio isn't gated on a full sentence. Every later segment, in the same call or a later one, uses the normal `minChars`.

`SpeechChunker` keeps `SentenceChunker`'s exact `push(delta): string[]` / `flush(): string[]` signature, which is why the orchestrator's call sites were untouched. It accumulates raw deltas, segments the **raw** buffer, and maps each completed segment through `toSpeakable`. Its constructor is now `(minChars = 140, maxChars = 200, firstMaxChars = 60)`.

### `server/lib/voice/pipeline.ts` — `SpeechPipeline` (2026-08-28)

`orchestrator.ts` used to `await speak(chunk)` per segment — strictly sequential, each full network round trip completing before the next began. `SpeechPipeline` instead starts synthesis for up to `concurrency` segments **concurrently**, while still **emitting audio strictly in segment order** (out-of-order emission would scramble the sentence — only the *starting* of synthesis is concurrent, draining is a strict serial queue).

- **Concurrency ramps 1 → 3.** The turn's first segment is always synthesized **alone**, at `FIRST_SEGMENT_CONCURRENCY = 1`, regardless of the configured `concurrency`. Some backends behind this app (Orpheus via llama.cpp `--parallel 3`) share one GPU across "concurrent" slots, so racing chunk 1 against others only slows chunk 1 down — and perceived responsiveness is governed entirely by chunk 1's latency. Depth widens to the full `concurrency` (3) only once the first segment has been dispatched (`firstSegmentDrained` flips true the moment it drains, win or lose).
- **A throwing segment is dropped, not fatal.** Before this, a synthesis error killed the rest of the turn. Now a non-abort error is logged and the segment is skipped; the drain continues. `AbortError` is swallowed as before.
- `VOICE_TUNING.tts.pipelineConcurrency` (default 3) is the configured cap; `orchestrator.ts` wires it in alongside the new `sentenceMaxChars` (200) and `firstSegmentMaxChars` (60).

**Measured effect on total wall-clock** (pipelining vs. the old strictly-sequential path): **Chatterbox −43%, Orpheus −18%, Kokoro unchanged** (Kokoro is already far past realtime, so there is nothing to pipeline against). Firing *all* chunks concurrently (no ramp) makes time-to-first-audio *worse*, not better, because the shared GPU slots make the first chunk compete with the rest — which is why the ramp exists rather than a flat concurrency cap.

## TTS provider status (2026-08-28)

**Orpheus is now live**, correcting the cycle-60 handover's "not stood up — needs shell on the rig" note. `http://192.168.2.25:5005/v1`, model `orpheus`, 25 voices, default `tara`, served by a llama.cpp backbone running `--parallel 3`. It is registered in the production `ai_config` as provider "Orpheus rig" / model "Orpheus", **appended to the END of the `tts` chain** — Kokoro stays the head and nothing changes for any existing user until a voice is explicitly picked in the voice picker. Chatterbox at `:8884` is now **Chatterbox Turbo** (see the provider table above).

Both Chatterbox and Orpheus return `{"status":"ok","voices":[...]}` rather than the bare `{"voices":[...]}` Kokoro returns. `server/api/voice/voices.get.ts` reads only the `voices` key off the parsed response (`data?.voices ?? []`), so both shapes work as-is — worth stating explicitly so a future session doesn't "fix" a shape that was never broken.

**Measured throughput** (audio-seconds produced per wall-second; >1.0× keeps up with playback) and time-to-first-audio:

| Provider | Throughput | Time to first audio |
|---|---|---|
| Kokoro | ~38× | ~0.9 s |
| Chatterbox Turbo | ~2.9× | ~1.0–1.5 s |
| Orpheus, sequential backend | **0.83–0.87×** | — |
| Orpheus, `--parallel 3` | **1.20–1.27×** | ~2.9 s (floor ~2.2 s) |

**The decisive fact:** sequential Orpheus ran **below 1.0×** — it could not generate audio as fast as it plays, so it was guaranteed to underrun mid-utterance regardless of any client-side fix. `--parallel 3` clears breakeven, but by only 20–27%, against Chatterbox's ~190% margin. **A sub-1.5s time-to-first-audio target is unreachable for Orpheus** as currently served — 2.17s for a 26-character input is a fixed floor of the backend, not an artifact of input length.

Which voice (Kokoro, Chatterbox Turbo, or Orpheus/`tara`) to adopt as default is **undecided** — it needs Tony's ears on the rig, not a benchmark number. All three are selectable today from the voice picker.

## Tuning (`server/lib/voice/tuning.ts`)

Server-side runtime knobs live here — no SSH, no rebuild-to-tune. As of 2026-08-28 this holds only the groups something actually reads; `vad`, `turn`, `bargeIn`, `tts.provider` and `tts.playbackRate` used to live here too but had **zero server-side readers** and were removed rather than left looking authoritative (that VAD/barge-in/playback tuning is genuinely client-side — see below):

```ts
export const VOICE_TUNING = {
  tts:     { sentenceMinChars: 140, sentenceMaxChars: 200, firstSegmentMaxChars: 60, pipelineConcurrency: 3 },
  stt:     { language: 'en' },
  agent:   { maxSteps: 16, temperature: 0.7 },
}
```

The client capture/barge-in/playback knobs are **user-tunable**: `useVoiceSettings` (cookie `voice-settings`, via `useCookie`) holds voice choice, `positiveSpeechThreshold` (negative trails it by 0.15, via `negativeSpeechThreshold()`), `minSpeechMs`, `redemptionMs`, `bargeInEnabled`, `playbackRate`, and — since cycle 60 — `micDeviceId`. The cog button in the agent toolbar opens `VoiceSettingsSlideover` — the sensitivity slider has a live meter fed by `voice.speechProb` (Silero per-frame probability via `onFrameProcessed`, the same unit as the threshold). Threshold/timing changes hot-apply through `applyVadSettings()` (debounced VAD-only restart; WS untouched); barge-in and playback rate apply live without restart. Segmentation flushes a TTS call on a real sentence end, at `sentenceMaxChars`, or when `sentenceMinChars` is reached — audio starts before the LLM finishes, and now starts synthesizing before earlier segments have finished playing too (see [Speech pipeline](#speech-pipeline-cycle-60--pipelined-synthesis-2026-08-28)).

**The inert `playbackRate` default is fixed (2026-08-27, `26b7b54`).** The cycle-60 handover flagged `VOICE_SETTINGS_DEFAULTS.playbackRate` as still `1.1` while the (unread) server constant said `1.0` — so the audible rate never actually changed. `VOICE_SETTINGS_DEFAULTS.playbackRate` is now `1.0`, and `migrateVoiceSettings()` (`app/composables/useVoiceSettings.ts`) forward-migrates any existing cookie still carrying the old `1.1` default to `1.0` on load — a value any *other* than `1.1` is treated as a deliberate user choice and left untouched. The dead server-side `VOICE_TUNING.tts.playbackRate`/`tts.provider` constants were deleted in the same change; provider selection is `deps.ttsProvider`, threaded through from the client's cookie-backed `VOICE_SETTINGS_DEFAULTS.provider`.

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
| `scripts/bake-head.ts` | Build-time: MakeHuman export → merge every node/primitive → keep the largest shell → 50k points, edge-sampled with surface topping up → region weights → `app/assets/head-points.bin` (`pnpm bake:head`) |
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

1. Tony generates a female head in **MakeHuman (official, unmodified build)** and exports it to `assets/source/bridget-head.glb`. An export from an official build is **CC0** — public domain, commercial use, redistribution, no attribution. (FLAME and the Basel Face Model were rejected: research licence only. Recorded so a future session does not reach for them.) **Both the source export and its baked buffer are committed** (`assets/source/bridget-head.glb`, `app/assets/head-points.bin`, since 2026-08-28) — deliberately, since prod builds from source and cannot run MakeHuman.
2. `pnpm bake:head` (`scripts/bake-head.ts`) reads it, merges **every** node's **every** primitive in the scene graph (world-matrix transforms on positions, inverse-transpose normal matrices on normals — the original baker read only `listMeshes()[0].listPrimitives()[0]`, silently dropping every other mesh/primitive an MPFB2 export produces), then **keeps only the largest connected shell** (see below), walks its mesh **edges at even arc spacing** to place points where the topology already encodes the anatomy (`sampleEdges`, with area-weighted surface sampling — `sampleSurface` — only topping up any shortfall), computes per-point region weights, and writes a packed `Float32Array` to `app/assets/head-points.bin`.
3. At runtime the browser fetches **only that buffer** and uploads it straight into the existing `BufferGeometry`. No mesh, no GLTF loader, no three.js loader chain in the client bundle.

**Why only the largest shell.** A MakeHuman/MPFB2 export is not one surface — the real export has **66 connected shells**: the skin (3203 vertices / 6232 triangles) plus eyeballs, teeth, tongue, mouth cavity, eyelashes, and MakeHuman's clothes-fitting HELPER ribbons (thin 18-vertex strips spanning the full head height, wider than the skin). Together they were **40% of all triangles**, and because sampling is area-weighted, ~40% of every baked point used to land on geometry that must never be seen: eyeballs as dark discs where eyes belong, teeth/tongue/cavity as a bright blob at the mouth, and the helper ribbons as "hair" that swung with the jaw (they span the whole head, so they picked up jaw weight). `largestShell()` (union-find over triangles, ranked by triangle count so a dense-but-tiny island can't outrank the skin) keeps only the biggest island and discards the rest.

**Why edges, not random surface sampling.** Random surface sampling dissolves every edge loop into uniform speckle — a 6232-triangle head renders as a smooth egg no matter how many points you throw at it. A modeller's topology already crowds edge loops around the eyes, nose and mouth, so `sampleEdges()` walks unique undirected mesh edges at constant arc-length spacing instead, reproducing the woven-wireframe look of the reference. A primitive without a `NORMAL` attribute would otherwise leave edge points with zero-length normals (degenerating the shader's facing term and rendering full-bright through the skull); `sampleEdges` now accumulates adjacent face normals per vertex as a fallback.

**Layout — 9 interleaved floats per point** (`FLOATS_PER_POINT = 9`, 36-byte stride): `x, y, z, nx, ny, nz, jawW, eyeW, browW`.

| Attribute | Purpose |
|---|---|
| `jawW` | `smoothstep(lipY, chinY, y) ** 0.6 × (1 − 0.6 · smoothstep(hingeInner, hingeOuter, abs(x))) × neck` — zero at the upper lip, full at the chin, falling off toward the hinge, and (since `HeadMetrics.neckY`, 2026-08-28) fading back to zero below the jawline instead of saturating at 1 forever |
| `eyeW` | eye region — brightens on listening/thinking, dims on blink |
| `browW` | brow region — lifts on stressed syllables |

**`jawW` is the fix for the cleave.** A *binary* jaw region translated as a block visibly splits the head at the lip line. Measured counterfactual at the jaw trough: 64.2 % row-density idle / 56.7 % with the shipped smooth weight / **3.8 %** with a binary `>0.5` region / **0.0 %** with `>0.15` — the binary version *is* the cleave. The `** 0.6` curve lifts the low end so the lower lip trails the chin at roughly a quarter of the travel, which is what makes the mouth read as opening.

**The `neckY` fade (2026-08-28) fixed a second, separate defect.** `smoothstep` saturates at 1 past its upper bound, so before this every point *below* `chinY` — the entire neck — was getting FULL jaw weight, and the neck travelled with the chin on every syllable. `HeadMetrics.neckY` (optional; omitting it preserves the old saturating behaviour) fades jaw influence out across the jaw's underside instead.

**Landmarks were re-measured against the correct geometry (2026-08-28).** The values baked against the un-filtered 66-shell mesh were wrong — `eyeY 0.15`, `lipY -0.47`, `chinY -0.89` — because they were measured through the 40% of junk shell filtering later discarded, which put the jaw region up around the *nose* (why the talking animation moved the wrong half of the face). The discarded shells are themselves the ground truth: the eyeball shells (2 symmetric, 308 vertices each) mark the eyes at `eyeY = -0.05`; the upper and lower teeth shells meet at the bite line, giving `lipY = -0.72`. Standard facial proportions (eyes at 50% chin→crown, mouth at 25%) cross-check both independently to a chin at ~-1.40 — the skin itself ends at -1.33, i.e. **this export is cropped at the jaw with essentially no neck**, so `neckY` is parked below the mesh (`-1.60`) rather than doing real work on this particular export; it still guards a future export that keeps more neck. Current metrics: `browY: 0.10, eyeY: -0.05, lipY: -0.72, chinY: -1.33, neckY: -1.60`.

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

### The head mesh now exists and is committed (2026-08-28)

`assets/source/bridget-head.glb` (4.9 MB) and `app/assets/head-points.bin` (1.8 MB) are **both in the repo** as of `95e4420` — this corrects the cycle-60 handover, which recorded the mesh as a human step not yet done. **`/agent` now renders the particle head, not the CSS fallback**, in any build with this commit.

Landing the real mesh surfaced three defects that a scratch placeholder buffer couldn't have caught (see [Mesh → point buffer](#mesh--point-buffer-build-time-not-a-runtime-loader) above for the fixes): the baker only reading the first mesh/primitive, hardcoded flat normals disabling the renderer's back-face dimming, jaw weight saturating past the chin and dragging the neck, 40% of triangles being non-skin shells that must never be seen, and landmarks measured through that junk. All five are fixed as of `0667798`.

**Still open, per Tony's own review of the shipped render — not fixed by any of this:** the jaw doesn't hinge convincingly, the talking motion doesn't read as natural speech, and the model doesn't read as a woman. `VIZ_TUNING.head` (`alpha`, `pointSize`, `facingFloor`) has never been tuned against the real head — the renderer was proven against geometry, not against *her* proportions. The export is also **body-only**: no hair, no eye assets, so those sockets are empty by construction, not a bug.

Two operational notes that still apply:

- **`app/assets/head-points.bin` is deliberately NOT gitignored.** Production builds from source and cannot run MakeHuman, so the baked buffer must be committed or prod renders the fallback forever. It is a committed build artifact, by design.
- **`pnpm bake:head` only takes effect in a built artifact after a rebuild.** `import.meta.glob` resolves at **build** time, so a `.bin` dropped next to a running production build is invisible. (Vite dev *does* pick up a new `.bin` with no restart — confirmed — which is exactly why this is easy to miss.) See [`DEPLOYMENT.md` §12](../DEPLOYMENT.md). **A rebuild + redeploy is still required to pick up the new committed `.bin`** if a running production build predates `95e4420`.

## Cross-references

- [`docs/model-requirements.md`](../model-requirements.md) — rig setup for STT + Kokoro + Chatterbox.
- [`docs/handovers/2026-08-27-agent-surface-redesign.md`](../handovers/2026-08-27-agent-surface-redesign.md) — cycle 60: the Orpheus serving recipe (and its landmines), the MakeHuman/CC0 provenance requirement, and the open items. The [follow-on section](../handovers/2026-08-27-agent-surface-redesign.md#follow-on-work-landed-after-this-handover-2026-08-28) records the five commits that landed after the handover closed — the head mesh, the bake fixes, the pipeline, and Orpheus going live.
- [`docs/wiki/mcp.md`](mcp.md) — MCP server shares the same `runAgent` tool registry.
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — prod env vars on LXC 114.
