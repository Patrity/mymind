---
title: Voice Agent
status: shipped
cycle: 65
updated: 2026-09-19
mymind_id: 34c1de13-ab16-4662-a177-0f8ac99f478e
mymind_hash: 37234048cd7533d0ccfd61fd6dad2b175baef6636e2f54534b72d4dcabd7389f
---

# Voice Agent

> **Cycle 28 update:** the `/voice` page was merged into the unified **`/agent`** surface (talk + type in one place). `/voice` redirects to `/agent`. This page documents the self-hosted STT/TTS pipeline and Bridget's renderer; see [agent.md](agent.md) for the unified surface, conversation persistence, and the `speak`-driven convergence.
>
> **Cycle 60 update:** the TTS chain gained a sanitizer + a real segmenter (`SentenceChunker` and `server/lib/voice/chunker.ts` are **deleted**), the microphone gained a device picker, and the **particle sphere became a particle head**. `app/components/voice/Reactor.client.vue` and the 96-bar mic ring (`app/lib/viz/ring.ts`) are **deleted**; the "Voice Visualizer (cycle 19)" section below was rewritten as "Bridget's avatar" — **all of which cycle 65 then deleted; see [Bridget's face](#bridgets-face--the-rive-persona-cycle-65)**. The GPU machinery underneath — `scene.ts`, `core.ts`, `effects.ts`, `lightning.ts`, `choreographer.ts`, the quality tiers and the FPS watchdog — is unchanged and re-pointed.
>
> **Post-handover update (2026-08-28, superseded in part by cycle 61 below):** five follow-on commits landed after the cycle-60 handover closed, correcting two claims that handover made. **The head mesh now exists and is committed** — `assets/source/bridget-head.glb` and `app/assets/head-points.bin` are both in the repo, `bake-head.ts` was rewritten to merge every mesh/node instead of just the first primitive, keep only the skin shell (66 shells in the real export; eyeballs/teeth/helper ribbons were 40% of the triangles), sample mesh edges instead of random surface points, and use landmarks measured off the discarded shells. **Orpheus is now live** on the rig and registered in production, at the tail of the TTS failover chain. TTS synthesis is also now pipelined (concurrency ramps 1→3) instead of fully sequential. See [Speech pipeline](#speech-pipeline-cycle-60) and [Providers](#providers) below, and the [cycle-60 handover's follow-on section](../handovers/2026-08-27-agent-surface-redesign.md#follow-on-work-landed-after-this-handover-2026-08-28) for the full commit list. **The head half of this is now history:** the jaw never hinged convincingly, the motion never read as speech, the model never read as a woman, and `VIZ_TUNING.head` was never tuned against the real export — **cycle 65 deleted the head, the bake pipeline and the committed `.bin` rather than continuing to tune them**. Which TTS voice to adopt is still undecided pending Tony's ears.
>
> **Cycle 64 update — the assistant-message frames became the AI SDK's own message protocol.** `transcript` (assistant half)/`reasoning`/`tool`/`usage` are **removed** from the server→client frame list below, replaced by `{type:'chunk', turnId, chunk: UIMessageChunk}` (one AI SDK chunk per encoder event) and `{type:'user-message', turnId, message}`; `audio-begin` **gains `turnId`**. The audio/state/approval/preset frames this page documents in depth are otherwise unchanged — see the updated [WebSocket protocol](#websocket-protocol-apivoicews) section below for the full table, and [agent.md](agent.md#websocket-protocol-serverapivoicewsts) for how the client assembles `chunk`s into `UIMessage`s and renders them.
>
> **Cycle 65 update — the particle head is gone; Bridget's face is a Rive Persona.** The whole three.js avatar/visualizer stack (`app/components/agent/Avatar.client.vue`, `app/lib/avatar/**`, `app/lib/viz/**`, `scripts/bake-head.ts`, `scripts/blender-export-head.py`, `app/assets/head-points.bin`, the `bake:head` script) is **deleted**, along with the viz event channel in `useVoice`/`lib/voice/messages.ts` (`events`, `onVizEvent`, `VizEvent`). It is replaced by **AI Elements' Rive `Persona`** — state-driven only, wrapped as `app/components/agent/Persona.client.vue`. The **cycle-60 notes below about the head mesh, the bake pipeline and `head-points.bin` describe code that no longer exists**; they are left in place as history. `three` stays in `package.json` (Galaxy). See [Bridget's face](#bridgets-face--the-rive-persona-cycle-65) and, for the rest of the `/agent` rebuild, [agent.md § UI](agent.md#ui--the-two-panel-surface-cycle-65). Handover: [`2026-09-19-agent-page-rebuild.md`](../handovers/2026-09-19-agent-page-rebuild.md).
>
> **Cycle 61 update — the TTS stack was replaced wholesale.** Kokoro, Chatterbox and Orpheus are **gone**, and so is the idea of a failover chain for TTS: there is now **one engine, Breeze TTS 2**, at `http://192.168.2.25:8880`, and a voice is a **row** (`voice_presets`) rather than a string from a `/v1/voices` enum. `server/lib/voice/tts-failover.ts` and `server/api/voice/voices.get.ts` are **deleted**; `AI_TTS_KOKORO_*` / `AI_TTS_CHATTERBOX_*` no longer exist. Binary frames on the socket are now **raw PCM chunks as the engine produces them**, bracketed by `audio-begin`/`audio-end` — no longer one WAV per sentence. `/voice` is a real page again: the **[Voice Studio](voice-studio.md)**, where presets are authored. The [Providers](#providers), [TTS engine](#tts-engine-breeze-tts-2-cycle-61), [WebSocket protocol](#websocket-protocol-apivoicews) and [Env vars](#env-vars) sections below have been rewritten; the bake-off table they replaced described three engines that are no longer dialed.

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
│         ▼  PCM chunks ──────────────────────────────────────► client
└──────────────────────────────────────────────────────────────┘
   STT: Speaches faster-whisper  (OpenAI /v1/audio/transcriptions)
   TTS: Breeze TTS 2 :8880       (multipart /v1/audio/speech, raw PCM)
```

1. **Client voice UI** (`app/composables/useVoice.ts`) — mic capture, Silero VAD, WAV encoding, WebSocket, PCM playback + barge-in. Owns when the user is speaking.
2. **Voice orchestrator** (`server/lib/voice/orchestrator.ts`) — STT → `runAgent` → segmented, sanitized TTS (see [Speech pipeline](#speech-pipeline-cycle-60)); AbortSignal propagation on barge-in; streams audio + transcript + tool/reasoning/usage messages back. Owns the pipeline.
3. **Providers** (`server/lib/voice/providers/`) — the `SttProvider` interface over an OpenAI-spec local endpoint. Owns which STT model. TTS no longer lives here: it is `speakWithPreset` in `server/lib/voice/speak.ts`, resolved from the registry's `tts` assignment. Swapping either is a registry edit, not an env change.
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

STT and TTS are both resolved from the AI config registry (`assignments.stt` / `assignments.tts`,
see [ai-providers.md](ai-providers.md)) — **not** from env, and not from any constant in
`tuning.ts`. Swapping an engine is a registry edit.

| Role | Resolution | Endpoint | Notes |
|---|---|---|---|
| STT | `assignments.stt`, with failover | `:8881` Speaches faster-whisper-turbo | model `deepdml/faster-whisper-large-v3-turbo-ct2`. Still a real chain: `withFailover('stt', …)`. |
| TTS | `assignments.tts`, **head only** | `:8880` Breeze TTS 2 | `speakWithPreset` takes `chain[0]` and stops. There is no TTS failover. |

**TTS has no failover, deliberately.** A Breeze preset (instruction, seed, reference clip,
calibrated ceiling) is meaningless to any other engine, so "try the next model" would mean
"answer in a different voice than the one that was asked for". `server/lib/voice/tts-failover.ts`
— `createTtsSynth` / `pinChainToProvider` — is **deleted**, along with `/api/voice/voices` and the
`{type:'voice', provider, voice}` frame it fed.

**The consequence to remember:** `chain[0]` wins, silently. `speakWithPreset` only throws
*"No TTS model configured — set one in Settings → Models"* when there is no entry at all; a stale
entry ahead of Breeze is dialed instead, with no fallback behind it. **Both the live agent
(`server/api/voice/ws.ts:52`) and the studio (`server/api/voice/speak.post.ts`) go through it**, so a
stale assignment silences every spoken reply in a conversation as well as every studio render. This
bit during cycle 61's own browser validation — the dev registry still listed the retired
`chatterbox` at `:8884` first, and every render 502'd against a dead host until the assignment was
pointed at Breeze. **Deploying this cycle requires editing the registry**, which no migration does
for you — see [`DEPLOYMENT.md` §4b](../DEPLOYMENT.md).

The registry stores OpenAI-style base URLs ending in `/v1`; Breeze's own path already includes
`/v1`, so `speak.ts` strips it to get the service root.

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
- **`maxChars` (200), added 2026-08-28, is a HARD cap and is NOT one-shot** — it re-fires every time a still-open segment reaches it, however many times that takes within one `segment()` call. Without it, a sentence whose only clause/terminal punctuation sits at the very end could grow arbitrarily long once the one-shot `minChars` cut had already fired — on a slow autoregressive engine a 400-char segment is a long stall before a single sample plays (~27 s at the ~0.067 s/char measured on the engine this cap was introduced against). Since cycle 61 this cap is further clamped per preset by that preset's calibrated `maxSegmentChars`.
- **`firstMax` (60), added 2026-08-28**, replaces `minChars` — not `maxChars` — for whichever segment is first to close in a `segment()` call, so the turn's opening segment is short and time-to-first-audio isn't gated on a full sentence. Every later segment, in the same call or a later one, uses the normal `minChars`.

`SpeechChunker` keeps `SentenceChunker`'s exact `push(delta): string[]` / `flush(): string[]` signature, which is why the orchestrator's call sites were untouched. It accumulates raw deltas, segments the **raw** buffer, and maps each completed segment through `toSpeakable`. Its constructor is now `(minChars = 140, maxChars = 200, firstMaxChars = 60)`.

### `server/lib/voice/pipeline.ts` — `SpeechPipeline` (2026-08-28)

`orchestrator.ts` used to `await speak(chunk)` per segment — strictly sequential, each full network round trip completing before the next began. `SpeechPipeline` instead starts synthesis for up to `concurrency` segments **concurrently**, while still **emitting audio strictly in segment order** (out-of-order emission would scramble the sentence — only the *starting* of synthesis is concurrent, draining is a strict serial queue).

- **Concurrency is PINNED AT 1 (cycle 61).** Breeze serves one inference at a time and 409s anything
  concurrent, and `pipeline.ts` now emits chunks as they arrive rather than buffering a whole
  segment — so more than one in flight would both 409 the rig and interleave two segments' audio.
  `SpeechPipeline`'s constructor **throws** if `concurrency` is ever raised. The old 1 → 3 ramp
  (`FIRST_SEGMENT_CONCURRENCY`, `effectiveConcurrency`, `firstSegmentDrained`) was **deleted** rather
  than left implying a tunable that is now rejected; recover it from git history if the engine ever
  serves concurrent requests.
- **A throwing segment is dropped, not fatal.** Before this, a synthesis error killed the rest of the turn. Now a non-abort error is logged and the segment is skipped; the drain continues. `AbortError` is swallowed as before. The dropped segment's **text still reaches the client** via the transcript event; there is no wire frame signalling lost audio, and the gap is server-side observability (a dropped segment is a `console.error` with no `recordEvent`).
- `VOICE_TUNING.tts.pipelineConcurrency` (**1**) is the configured cap; `orchestrator.ts` wires it in alongside `sentenceMaxChars` (200) and `firstSegmentMaxChars` (60).
- **`onSegmentEnd` fires for every segment the pipeline owns, including a dropped one** — it owns lifetimes, not frame semantics. The orchestrator therefore tracks whether the current segment actually emitted a `begin`, and suppresses the `audio-end` if it did not; otherwise a dropped segment would close a segment that had already ended, under its predecessor's id.

The cross-engine wall-clock comparison that used to close this section (Chatterbox −43%, Orpheus
−18%, Kokoro unchanged) measured pipelining across three engines that are no longer dialed, against
a concurrency setting that no longer exists. It has been removed rather than left to look current.

## TTS engine — Breeze TTS 2 (cycle 61)

One engine, at `http://192.168.2.25:8880`. `GET /health` answers
`{"status":"ok","sample_rate":24000}` once warm (503 while loading — roughly a 44 s cold start).
Synthesis is `POST /v1/audio/speech`, **multipart**, with `text` (not `input`), optional
`instruction`, `cfg_scale`, `seed`, `temperature`, `top_p`, `top_k`, and optional
`ref_audio` + `ref_text`. The response is **headerless PCM, s16le mono**, streamed, with the rate in
the `x-sample-rate` header — never assume a constant.

`server/lib/voice/breeze.ts` is the only module that knows this wire format.

### Facts that are not recoverable from a response

These are enforced before dispatch because the rig cannot tell you about them:

1. **`cfg_scale > 1` with no instruction → 500**, opaque body. The clone and plain templates define
   no negative prompt for guidance to push against. `validateBreezeRequest` rejects it with a
   sentence instead.
2. **`ref_audio` without `ref_text` → 500**, same opaque body.
3. **A prompt-ceiling overrun → `200 OK`, then a body that stops early.** Headers are sent *before*
   generation begins, so the status line can never carry it. It arrives in two shapes, both mapped
   to `BreezeError('truncated')`:
   - a clean EOF at **zero bytes**;
   - past roughly **3400 characters** (measured 2026-09-15), the rig **drops the socket** part-way
     through, which undici raises as a bare `TypeError: terminated`. Before cycle 61's validation
     pass this escaped the route unmapped — Nitro logged `[unhandled]` and answered 500
     "Server Error" with the message reduced to "terminated". Note that `truncated` is a
     *classification*: a genuine app↔rig network fault rejects the read identically, so the original
     error rides along as `BreezeError.cause`.
4. **Output is capped at 120 seconds.** 900 and 1800 characters both returned exactly 5,760,000
   bytes at 24 kHz (measured 2026-09-15). This cap arrives as a *full* body, so no byte-count
   heuristic can see it — only the calibrated ceiling warning shown before dispatch, and ears.

### One request at a time

Breeze serves a single inference and answers **409** to anything concurrent.
`server/lib/voice/breeze-queue.ts` is the app-wide gate: every caller holds a slot for the whole
lifetime of its stream, with `agent` priority jumping ahead of `studio` and FIFO within a priority.

This is also why `VOICE_TUNING.tts.pipelineConcurrency` is **pinned at 1** and `SpeechPipeline`
throws if it is ever raised — >1 in flight would both 409 the rig and interleave two segments'
audio. The old 1→3 concurrency ramp (`FIRST_SEGMENT_CONCURRENCY`, `firstSegmentDrained`) was
**deleted** rather than left implying a tunable the constructor now rejects; restore it from git
history if Breeze ever serves concurrent requests.

### Measured (2026-09-15, through the app on the dev box)

| | |
|---|---|
| Time to first audio, `POST /api/voice/speak` | **108 ms** measured at the API; **136 ms** end-to-end through the studio UI on a warm render (454 ms on the first render of a session) |
| A 32-character sentence | 153,600 bytes over 40 chunks = 3.2 s of audio |
| A live agent reply | 15 binary frames, 53,760 bytes = 1.12 s, bracketed by one `audio-begin`/`audio-end` pair |

There is no bake-off table any more because there is nothing to bake off against — the previous
three-engine comparison (Kokoro ~38×, Chatterbox Turbo ~2.9×, Orpheus 1.20–1.27×) described a stack
that no longer exists.

**Which voice to use is no longer a benchmark question.** It is a preset, authored in the
[Voice Studio](voice-studio.md), and the eight seeded ones are a starting point rather than a
shortlist.

### Use a LOCKED preset for conversation

Breeze holds **no speaker state between calls**. A seed reproduces an identical input exactly, but
it does not pin an identity across *different* text — and a spoken turn is many segments of
different text, each its own call. So a plain design preset re-casts the voice on every segment, and
a long reply genuinely does sound like several different people. Measured across four segments of
one reply: **23.9 Hz** pitch spread, timbre distance **0.636**.

Three attempts to anchor it with the model's own output within a turn (chaining each segment's
render forward as the next segment's reference) failed or barely helped, and were reverted. What
works is giving the preset a reference clip that exists *before* the turn starts:

| Preset | Pitch spread | Timbre distance |
|---|---|---|
| Design, unlocked | 23.9 Hz | 0.636 |
| **Locked** (a frozen render of its own description) | 22.6 Hz | 0.526 |
| Uploaded human recording | **4.5 Hz** | **0.418** |

`resolveTurnVoice` reads the row as-is, so this is purely a property of the preset: lock it (or give
it a real clip) in the studio and the agent inherits the consistency. A locked preset is spoken as a
**pure clone** — instruction dropped, cfg 1 — which is decided in `presetToRequest` by
`ref_source`, not by the agent. See [Locking a designed voice](voice-studio.md#locking-a-designed-voice).

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
| Text | `{type:'preset', presetId}` | Pick the voice **preset** for this connection (cookie-backed on the client); `null`/absent falls back to the default row. Resolved per turn by `resolveTurnVoice`, so a preset edited mid-conversation takes effect on the next turn. Replaced `{type:'voice', provider, voice}` in cycle 61. |
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
| Binary | `ArrayBuffer` — **raw PCM, s16le mono** | Audio for the segment currently open. Chunks as the engine produces them, **not** one WAV per sentence (cycle 61). Decode at the rate named by the preceding `audio-begin`. |
| Text | `{type:'audio-begin', turnId, segmentId, sampleRate}` | Opens a spoken segment and carries the rate its PCM must be decoded at, plus (cycle 64) the **turn id** that opened it. WS delivery is ordered, so this always lands before that segment's first binary frame. |
| Text | `{type:'audio-end', segmentId}` | Closes it. **Strictly paired** with `audio-begin`: a segment whose synthesis threw or aborted before yielding its `begin` never opened on the wire, and emitting an `end` for it would name an id that really did begin — the orchestrator suppresses that rather than sending a lying frame. |
| Text | `{type:'chunk', turnId, chunk: UIMessageChunk}` | **(cycle 64, replaces `transcript`/`reasoning`/`tool`/`usage`)** One AI SDK `UIMessageChunk` of the turn's assistant message — see [agent.md](agent.md#websocket-protocol-serverapivoicewsts) for the full chunk table and how the client assembles it with `readUIMessageStream`. |
| Text | `{type:'user-message', turnId, message: UIMessage}` | **(cycle 64)** The turn's user message (STT text for a voice turn, or the typed text + attachment parts), sent once before that turn's `chunk`s |
| Text | `{type:'state', state}` | Orchestrator state: `idle`/`thinking`/`speaking`/`tool` |
| Text | `{type:'error', message}` | Pipeline failure (STT/TTS/agent) — client shows alert + viz error flash, then idle |
| Text | `{type:'conversation', conversationId, title}` | Emitted once when the first turn lazily creates the thread (cycle 60) |
| ~~`{type:'transcript', role, text}`~~ / ~~`{type:'tool', ...}`~~ / ~~`{type:'reasoning', text}`~~ / ~~`{type:'usage', ...}`~~ | — | **Removed in cycle 64.** Folded into `chunk`'s `text-delta`/`tool-*`/`reasoning-delta`/`message-metadata.usage` |

The full, current frame list — including `{type:'model'}`, `{type:'load'}`, `{type:'new'}` and the exec approve/deny frames — is in [agent.md](agent.md#websocket-protocol-serverapivoicewsts).

**Stale-segment rejection (`turnId` on `audio-begin`, cycle 64).** Before this, no frame named which turn an `audio-begin` belonged to — `useVoice` documented this as an open barge-in gap ("the client cannot tell whose `audio-begin` this is"). A superseded turn's already-in-flight synthesis could still open a segment and start streaming PCM after the client had moved on to the next turn. Now every `audio-begin` carries the `turnId` the server stamped on the turn (`ConnState.turnSeq`, monotonic per connection), and the client (`app/lib/voice/playback-epoch.ts`'s `createPlaybackEpochs`, wired from `createClientTurns`'s staleness check in `app/lib/agent/turn-stream.ts`) rejects a segment whose `turnId` is not the current turn's outright, instead of relying solely on the epoch-at-flight-time check that existed before. The two checks are complementary: `turnId` rejects a whole stale segment before it starts; the epoch guard (cycle 61) still drops an individual in-flight PCM frame that was queued when the user barged in mid-segment.

## Env vars

```bash
AI_STT_BASE_URL=http://192.168.2.25:8881/v1
AI_STT_MODEL=deepdml/faster-whisper-large-v3-turbo-ct2
```

Wired into `runtimeConfig.ai.stt` in `nuxt.config.ts`.

**There are no TTS env vars.** `AI_TTS_KOKORO_*` and `AI_TTS_CHATTERBOX_*` were removed in cycle 61
along with the engines they named — Breeze's base URL comes from the registry's `tts` assignment and
nowhere else, and the voice itself is a `voice_presets` row, not a value.

## Caveats

**VAD asset loading** — `@ricky0123/vad-web` would fetch its Silero ONNX model and AudioWorklet from a CDN at runtime, and would fail silently in an offline lab. **Already solved:** `nuxt.config.ts` resolves the package's `dist/` and `onnxruntime-web` directories off disk (robust under pnpm's nested layout) and serves them as static `/vad` and `/ort` assets; `useVoice` passes `baseAssetPath: '/vad/'` + `onnxWASMBasePath: '/ort/'`. There are no `public/vad`/`public/ort` directories to look for — the mapping is config, not committed files.

**Mic secure-context** — browsers only grant microphone access in HTTPS or `localhost`. Production must be HTTPS; dev on `http://192.168.*` will be blocked.

## Frontend files

| File | Purpose |
|---|---|
| `app/pages/agent/index.vue` | **(cycle 65)** The two-panel shell: thread rail + conversation; full-bleed voice mode on `AgentPersona size="full"`. The `agent-bridget` column is gone. |
| `app/pages/voice.vue` | **The Voice Studio (cycle 61)** — `/voice` is a real route again; the `routeRules` redirect to `/agent` was removed. See [voice-studio.md](voice-studio.md). |
| `app/pages/agent/history.vue` | Full browse view for threads: search, counts, resume, delete-with-confirm |
| `app/composables/useVoice.ts` | VAD, WAV encoding, WebSocket, PCM playback, barge-in; `speechProb`; `micAnalyser`/`outAnalyser` (MicBand only); `conversationId`/`conversationTitle`; `stop()` (abort turn) vs `disconnect()` (teardown). **(cycle 65)** The viz event channel (`events`, `onVizEvent`, `VizEvent`) is **deleted**; `restAfterAbort()` returns the client to idle for `stop`/`newConversation`/`loadConversation`, because an aborted turn sends no `state:'idle'` frame |
| `app/composables/useBreezeSpeech.ts` | The studio's playback path — the same PCM-on-the-AudioContext-clock approach over plain `fetch`, so an audition never rides the conversation's socket |
| `app/lib/voice/playback-epoch.ts` | `createPlaybackEpochs()` — which PCM frames still belong to the turn being listened to; drops a frame that was in flight when the user barged in |
| `app/composables/useVoiceSettings.ts` | Cookie-persisted user settings (`voice-settings`), incl. `micDeviceId` |
| `app/components/agent/Toolbar.vue` | The single navbar: thread title, full-screen (voice mode), threads (under `lg`), settings slot. **(cycle 65)** The voice-replies switch and the model selector moved into the composer |
| `app/components/agent/ThreadRail.vue` | Permanent left rail: New, search, threads grouped Today / Yesterday / date |
| `app/components/agent/Persona.client.vue` | **(cycle 65)** `AgentPersona` — wraps Elements' Rive `Persona`; `hero`/`inline`/`full` sizes, mapped state, variant from settings, CSS-disc fallback warned once per page. Replaces `Avatar.client.vue` (deleted) |
| `app/components/agent/MicBand.vue` | "Am I being heard": FFT bars + a separate speech-probability track with the VAD threshold marked. **(cycle 65)** Its three colours are now local constants — `lib/viz/tuning.ts` is deleted |
| `app/components/agent/EmptyState.vue` | **(cycle 65)** Hero Persona + Bridget's name, what she can reach, and four real starter prompts on Elements' `Suggestions` |
| `app/components/agent/ApprovalConfirmation.vue` | **(cycle 65)** Elements `Confirmation` rendered **inside** the tool card — command, remember checkbox, editable allow-pattern, Deny/Approve. Replaces the detached `ApprovalPrompt.vue` (deleted) |
| `app/components/agent/ContextMeter.vue` | **(cycle 65)** Elements `Context` (cost rows patched out, no `tokenlens`) over `contextMeterData(...)` — hidden with no usage, count-only for an unknown window |
| `app/components/agent/PromptInput.vue` | **(cycle 65)** `AgentPromptInput` — the Elements composer: attachments (picker/paste/drop), model select, speak toggle, context meter, mic, send/stop, `?q=` auto-send and starter prefill. Replaces `voice/Composer.vue` (deleted) |
| `app/components/agent/Conversation.vue` | **(cycle 64)** The AI-Elements-rendered conversation — replaces `voice/Transcript.vue` (deleted). Full per-part render table + the design-token bridge: [agent.md § Conversation](agent.md#conversation-cycle-64--ai-elements-vue-replaces-the-hand-rolled-transcript) |
| `app/components/agent/ToolPart.vue`, `SubagentSteps.vue`, `Attachment.vue`, `ReplyActions.vue` | **(cycle 64)** Tool status badge + input/output, a subagent's nested `ChainOfThought` steps, user file/image chips, and copy/retry/timestamp/token-count — replace `agent/MessageActions.vue` and `agent/ReasoningBlock.vue` (both deleted; reasoning is now just a `reasoning`-type part, rendered by Elements' `Reasoning` inside `Conversation.vue` itself) |
| `app/components/voice/SettingsSlideover.vue` | Cog slideover: voice replies, **Persona variant** (cycle 65), **preset picker** (the `voice_presets` rail, not a `/v1/voices` enum), microphone picker, live-metered VAD tuning, barge-in, playback speed |
| `app/components/voice/PresetRail.vue`, `DesignPane.vue`, `SpeakPane.vue` | The studio's three panels (cycle 61) — see [voice-studio.md](voice-studio.md) |
| `app/lib/voice/messages.ts` | Pure WS-message → `{state, messageFrame, approval, conversation, audioBegin, audioEnd, …}` mapper (tested, no mocks). **(cycle 64)** `delta`/`usage` are gone — a `chunk`/`user-message` frame now rides through as `messageFrame`, handed to `app/lib/agent/turn-stream.ts` as-is. **(cycle 65)** `events` is gone too, with the viz channel |
| `app/lib/voice/devices.ts` | Pure `enumerateDevices()` → mic-picker items; the `DEFAULT_MIC` empty-value sentinel |
| `app/lib/agent/turn-stream.ts` | **(cycle 64)** `createClientTurns` — one `ReadableStream<UIMessageChunk>` per turn assembled with the SDK's `readUIMessageStream`; drops stale-`turnId` frames; `finalizeMessage` closes out a dangling tool/text/reasoning part on interrupt/error/disconnect; `discard()` (fix wave) silences a turn entirely when the page replaces the message list (new thread / resume / retry) — see [agent.md](agent.md#websocket-protocol-serverapivoicewsts) |
| `app/lib/agent/to-ui-messages.ts` | **(cycle 64)** `toUIMessages` — persisted messages → `AgentUIMessage[]` on resume; replaces `agent/transcript.ts`'s `buildResumeTranscript` (deleted, test ported) |
| `app/lib/agent/render.ts` | **(cycle 64)** Pure render helpers kept out of the SFCs: `uiMessageText`, `subagentSteps` (looks up a tool's `data-subagent` part by `toolCallId`), `tokenLabel`, `toolTitle`, `isRunning` |
| `app/lib/agent/retry.ts` | Pure `truncateForRetry` — walk back to the preceding user turn and truncate |

> **Deleted in cycle 65:** `app/components/agent/Avatar.client.vue`, `app/components/agent/ApprovalPrompt.vue`, `app/components/voice/Composer.vue`, `app/lib/avatar/**` (types, choreography, head-buffer, particle-head + 2 tests), `app/lib/viz/**` (types, tuning, emitter, choreographer, scene, core, effects, lightning), `scripts/bake-head.ts`, `scripts/blender-export-head.py`, `app/assets/head-points.bin`, `test/viz-emitter.test.ts`, `test/viz-choreographer.test.ts`, `test/bake-head.test.ts`, the `bake:head` package script, and `DEPLOYMENT.md` §12's head-bake gotcha. `useVoice.ts` and `app/lib/voice/messages.ts` lost the viz event channel (`events`/`onVizEvent`/`VizEvent`) with them. `three` is **kept** — `app/lib/galaxy/scene.ts` still imports it. Note for readers of older notes below: the cycle-60 statement that `head-points.bin` is a deliberately-committed build artifact no longer applies, because neither the file nor the pipeline exists.
>
> **Deleted in cycle 64:** `app/components/voice/Transcript.vue`, `app/components/agent/ReasoningBlock.vue`, `app/components/agent/MessageActions.vue`, `app/lib/agent/transcript.ts` (+ its test, ported into `to-ui-messages.test.ts`), `app/composables/useTextChat.ts` and `app/composables/useAgentActivity.ts` (both callerless before this cycle — the SSE-fed chips block they served was already gone since cycle 41). See the Frontend files table above for the cycle-64 replacements, and [agent.md § Conversation](agent.md#conversation-cycle-64--ai-elements-vue-replaces-the-hand-rolled-transcript) for the full per-part render table.
>
> **Deleted in cycle 61:** `server/lib/voice/tts-failover.ts` (`createTtsSynth` / `pinChainToProvider`) and `server/api/voice/voices.get.ts` — there is one TTS engine and a voice is a preset row, so there is no chain to pin and no voice enum to aggregate. `pipeline.ts` also lost `FIRST_SEGMENT_CONCURRENCY` / `effectiveConcurrency` / `firstSegmentDrained` with the concurrency ramp.
>
> **Deleted in cycle 60:** `app/components/voice/Reactor.client.vue`, `app/components/agent/HistorySlideover.vue`, `app/lib/viz/ring.ts`, `server/lib/voice/chunker.ts`. `app/components/voice/VoicePicker.vue` was already gone before this cycle (the picker is inline in `SettingsSlideover.vue`). Once `ring.ts` was gone, `Directives.ringColor`/`ringLevels`/`micMix` had zero readers left anywhere in the repo — a later pass (final-fix wave) removed those three fields plus the per-frame smoothing that filled them, confirmed by grep, not typecheck (the choreographer that fills them also declares the type, so typecheck alone can't prove a field dead). `BAR_COUNT` and `VIZ_TUNING.ring.radius` **do** survive, but not for the ring: `BAR_COUNT` sizes the raw mic-level array the head still resamples every frame to feed `energy` during `listening` (via `micAverage`), and `effects.ts` still reads `VIZ_TUNING.ring.radius` (as `RING_RADIUS`) to place the tool-pulse rings. `PALETTE.*.ring` also survives, but through `MicBand.vue` (`PALETTE.listening.ring` / `PALETTE.idle.ring`), not through `Directives`.

## Bridget's face — the Rive Persona (cycle 65)

Cycle 60 built a three.js particle **head** on the cycle-19 GPU pipeline (a baked 50k-point buffer
from a MakeHuman export, a seeded pose choreographer, a jaw/brow/yaw shader, quality tiers, bloom,
tool-pulse rings, transcription sparks and synapse lightning). **Cycle 65 deleted all of it.** It
was never finished — the CC0 MakeHuman export it depended on was blocked on a human and never
happened, so `/agent` rendered the CSS fallback for its whole life — and Tony had already rejected
the look. The whole subsystem is gone: `app/components/agent/Avatar.client.vue`, `app/lib/avatar/**`,
`app/lib/viz/**`, `scripts/bake-head.ts`, `scripts/blender-export-head.py`,
`app/assets/head-points.bin`, the `bake:head` package script, and `DEPLOYMENT.md` §12's head-bake
gotcha. `three` itself **stays** in `package.json` — Galaxy (`app/lib/galaxy/scene.ts`) still uses it.

In its place, **AI Elements' `Persona`** — a [Rive](https://rive.app) animation rendered through
`@rive-app/webgl2`, wrapped as `app/components/agent/Persona.client.vue` (`AgentPersona`). The
architecture boundary that mattered still holds, in a simpler form: **`useVoice` imports no renderer,
and the Persona never touches the WebSocket.** It takes two props (`state`, `connected`) and a
`size`.

- **It is state-driven, not audio-reactive.** `personaState(state, connected)`
  (`app/lib/agent/persona.ts`, pure + unit-tested) maps our `VoiceState` onto Rive's five states:
  not connected or `connecting` → `asleep`; `idle` → `idle`; `listening` → `listening`;
  `thinking | tool | typing` → `thinking`; `speaking` → `speaking`. Those are pushed into the
  artboard through `stateMachineInputs`, which every variant honours. An audio-reactive Persona was
  explicitly deferred — `micAnalyser`/`outAnalyser` survive on `useVoice`, but only `MicBand.vue`
  reads them now.
- **Three placements, one canvas.** `.client.vue` plus a `size` prop (`hero` / `inline` / `full`)
  guarantees exactly one Rive canvas is mounted at a time — hero in the empty thread, inline in the
  composer once the thread has messages, full in voice mode (the empty state's hero is suppressed
  while full-bleed is open). `MicBand`'s own 2D canvas is separate and unaffected.
- **Variants: `obsidian` (default), `mana`, `opal`, `glint`**, picked in `SettingsSlideover.vue` and
  cookie-persisted via `useVoiceSettings().settings.personaVariant` (unknown/retired values
  normalize to `obsidian`). Upstream's `halo` and `command` were **removed from the picker** — they
  render pure white regardless of theme, i.e. invisible in light mode.
- **Assets are ours.** Rive's wasm is served from our own origin via a Nitro `publicAssets` entry
  (`baseURL: 'rive'` → the `@rive-app/webgl2` package dir); the component calls
  `RuntimeLoader.setWasmUrl('/rive/rive.wasm')` + `setWasmFallbackUrl(...)` before the first
  `new Rive`, so nothing is fetched from a CDN at runtime. The four `.riv` files are committed under
  `public/persona-riv/` with the vendored sources map patched to those paths. **The directory cannot
  be named `rive-*`:** the wasm entry's `rive` baseURL prefix-matches, and `public/rive-personas/*.riv`
  404s because Nitro routes it into the wasm asset dir.
- **Fallback.** On `loadError` — unreachable `.riv`, no WebGL2 — the wrapper renders a CSS disc
  (`rounded-full bg-primary/20`, pulsing for `thinking`/`speaking`/`listening`) and warns **once per
  page load**, via a module-scoped latch in `persona.ts` rather than a per-instance flag. Nothing
  else on the page is affected.

Full UI detail (placements, the composer, inline approvals, the context meter) lives in
[agent.md § UI](agent.md#ui--the-two-panel-surface-cycle-65).

## Cross-references

- [`docs/model-requirements.md`](../model-requirements.md) — rig setup for STT + Breeze TTS 2.
- [`docs/wiki/voice-studio.md`](voice-studio.md) — `/voice`, where presets are authored; the preset schema, calibration and the queue priorities.
- [`docs/handovers/2026-08-27-agent-surface-redesign.md`](../handovers/2026-08-27-agent-surface-redesign.md) — cycle 60: the Orpheus serving recipe (and its landmines), the MakeHuman/CC0 provenance requirement, and the open items. The [follow-on section](../handovers/2026-08-27-agent-surface-redesign.md#follow-on-work-landed-after-this-handover-2026-08-28) records the five commits that landed after the handover closed — the head mesh, the bake fixes, the pipeline, and Orpheus going live.
- [`docs/wiki/mcp.md`](mcp.md) — MCP server shares the same `runAgent` tool registry.
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — prod env vars on LXC 114.
