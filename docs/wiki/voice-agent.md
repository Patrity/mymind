---
title: Voice Agent
status: shipped
cycle: 62
updated: 2026-09-16
mymind_id: 34c1de13-ab16-4662-a177-0f8ac99f478e
mymind_hash: 08816de0cc3c8d062a560f1599ced66511df8c78afcf777299156a3970869969
---

# Voice Agent

> **Cycle 28 update:** the `/voice` page was merged into the unified **`/agent`** surface (talk + type in one place). `/voice` redirects to `/agent`. This page documents the self-hosted STT/TTS pipeline and Bridget's renderer; see [agent.md](agent.md) for the unified surface, conversation persistence, and the `speak`-driven convergence.
>
> **Cycle 60 update:** the TTS chain gained a sanitizer + a real segmenter (`SentenceChunker` and `server/lib/voice/chunker.ts` are **deleted**), the microphone gained a device picker, and the **particle sphere became a particle head**. `app/components/voice/Reactor.client.vue` and the 96-bar mic ring (`app/lib/viz/ring.ts`) are **deleted**; the "Voice Visualizer (cycle 19)" section below has been rewritten as [Bridget's avatar](#bridgets-avatar-cycle-60). The GPU machinery underneath — `scene.ts`, `core.ts`, `effects.ts`, `lightning.ts`, `choreographer.ts`, the quality tiers and the FPS watchdog — is unchanged and re-pointed.
>
> **Post-handover update (2026-08-28, superseded in part by cycle 61 below):** five follow-on commits landed after the cycle-60 handover closed, correcting two claims that handover made. **The head mesh now exists and is committed** — `assets/source/bridget-head.glb` and `app/assets/head-points.bin` are both in the repo, `bake-head.ts` was rewritten to merge every mesh/node instead of just the first primitive, keep only the skin shell (66 shells in the real export; eyeballs/teeth/helper ribbons were 40% of the triangles), sample mesh edges instead of random surface points, and use landmarks measured off the discarded shells. **Orpheus is now live** on the rig and registered in production, at the tail of the TTS failover chain. TTS synthesis is also now pipelined (concurrency ramps 1→3) instead of fully sequential. See [Speech pipeline](#speech-pipeline-cycle-60), [Providers](#providers) and [Bridget's avatar](#bridgets-avatar-cycle-60) below, and the [cycle-60 handover's follow-on section](../handovers/2026-08-27-agent-surface-redesign.md#follow-on-work-landed-after-this-handover-2026-08-28) for the full commit list. **Still open, not solved by any of this:** the avatar's jaw doesn't hinge, the talking motion doesn't read as natural, and the model doesn't read as a woman (Tony's own assessment, deferred by him); exposure/density (`VIZ_TUNING.head`) has never been tuned against the real head; the export is body-only (no hair, no eyes) so those sockets are empty by construction; and which TTS voice to adopt is undecided pending Tony's ears.
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
| Text | `{type:'audio-begin', segmentId, sampleRate}` | Opens a spoken segment and carries the rate its PCM must be decoded at. WS delivery is ordered, so this always lands before that segment's first binary frame. |
| Text | `{type:'audio-end', segmentId}` | Closes it. **Strictly paired** with `audio-begin`: a segment whose synthesis threw or aborted before yielding its `begin` never opened on the wire, and emitting an `end` for it would name an id that really did begin — the orchestrator suppresses that rather than sending a lying frame. |
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
| `app/pages/agent/index.vue` | The three-column shell: thread rail, conversation, Bridget; full-bleed overlay. |
| `app/pages/voice.vue` | **The Voice Studio (cycle 61)** — `/voice` is a real route again; the `routeRules` redirect to `/agent` was removed. See [voice-studio.md](voice-studio.md). |
| `app/pages/agent/history.vue` | Full browse view for threads: search, counts, resume, delete-with-confirm |
| `app/composables/useVoice.ts` | VAD, WAV encoding, WebSocket, PCM playback, barge-in; `speechProb`; `conversationId`/`conversationTitle`; `stop()` (abort turn) vs `disconnect()` (teardown); exposes `onVizEvent` |
| `app/composables/useBreezeSpeech.ts` | The studio's playback path — the same PCM-on-the-AudioContext-clock approach over plain `fetch`, so an audition never rides the conversation's socket |
| `app/lib/voice/playback-epoch.ts` | `createPlaybackEpochs()` — which PCM frames still belong to the turn being listened to; drops a frame that was in flight when the user barged in |
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
| `app/components/voice/SettingsSlideover.vue` | Cog slideover: voice replies, **preset picker** (the `voice_presets` rail, not a `/v1/voices` enum), microphone picker, live-metered VAD tuning, barge-in, playback speed |
| `app/components/voice/PresetRail.vue`, `DesignPane.vue`, `SpeakPane.vue` | The studio's three panels (cycle 61) — see [voice-studio.md](voice-studio.md) |
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

> **Deleted in cycle 61:** `server/lib/voice/tts-failover.ts` (`createTtsSynth` / `pinChainToProvider`) and `server/api/voice/voices.get.ts` — there is one TTS engine and a voice is a preset row, so there is no chain to pin and no voice enum to aggregate. `pipeline.ts` also lost `FIRST_SEGMENT_CONCURRENCY` / `effectiveConcurrency` / `firstSegmentDrained` with the concurrency ramp.
>
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

**Lip-sync is amplitude-driven, not visemes.** Breeze returns raw PCM and no phoneme timings (nor did any engine before it), and real visemes need a forced-aligner pass per chunk. This gets the rhythm right, not the shapes.

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

- [`docs/model-requirements.md`](../model-requirements.md) — rig setup for STT + Breeze TTS 2.
- [`docs/wiki/voice-studio.md`](voice-studio.md) — `/voice`, where presets are authored; the preset schema, calibration and the queue priorities.
- [`docs/handovers/2026-08-27-agent-surface-redesign.md`](../handovers/2026-08-27-agent-surface-redesign.md) — cycle 60: the Orpheus serving recipe (and its landmines), the MakeHuman/CC0 provenance requirement, and the open items. The [follow-on section](../handovers/2026-08-27-agent-surface-redesign.md#follow-on-work-landed-after-this-handover-2026-08-28) records the five commits that landed after the handover closed — the head mesh, the bake fixes, the pipeline, and Orpheus going live.
- [`docs/wiki/mcp.md`](mcp.md) — MCP server shares the same `runAgent` tool registry.
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — prod env vars on LXC 114.
