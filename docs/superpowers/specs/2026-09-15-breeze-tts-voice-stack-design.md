---
title: Breeze TTS 2 — single-engine voice stack, streaming PCM, and the /voice studio
cycle: 61
date: 2026-09-15
status: spec — approved in brainstorm, not yet planned
related:
  - ../../wiki/voice-agent.md (the STT/TTS pipeline this replaces — Kokoro/Chatterbox/Orpheus providers, the WAV frame contract)
  - ../../wiki/agent.md (the /agent surface that consumes TTS)
  - ../../wiki/ai-providers.md (the model registry whose `tts` usage changes semantics)
  - ../specs/2026-08-27-agent-surface-redesign-design.md (cycle 60 — the segmenter, pipeline and settings slideover being re-pointed)
  - ../../model-requirements.md (the rig contract doc this obsoletes)
  - /Users/tony/Documents/GitHub/homelab/breeze-tts-package/ (the handoff package from the rig side)
closes:
  - "Prod voice is fully down — every member of the tts failover chain is gone (Kokoro→Breeze 422, Chatterbox torn down, Orpheus connection-refused)"
  - "Which TTS voice to adopt as default is undecided pending Tony's ears (cycle 60, open since 2026-08-28)"
  - "Retire the interim Gradio tuning UI at 192.168.2.25:7868 (scaffolding, not a systemd service, does not survive reboot)"
defers:
  - "Multi-speaker dialogue composition (script parsing, speaker→preset mapping, pause tuning, concatenation) — own cycle"
out-of-scope:
  - "Bilingual EN/ZH — the model supports it, MyMind builds English only (no language field, no ZH event syntax)"
  - "TTS fallback — Breeze is the only engine by design; an outage takes spoken replies down"
---

# Breeze TTS 2 — single-engine voice stack, streaming PCM, and the /voice studio (cycle 61)

## Why

The AI rig replaced two TTS engines with one. Kokoro and Chatterbox are decommissioned; Breeze
TTS 2 now occupies Kokoro's old host and port on a dedicated RTX 3090. It is not a drop-in — it
speaks a different wire protocol, returns a different payload, and serves one request at a time.

**Prod voice is not "due for migration", it is down.** Every member of the `tts` failover chain is
gone, verified against the live rig on 2026-09-15:

| Chain entry | Port | State |
|---|---|---|
| Kokoro | 8880 | now Breeze — **422** on every request MyMind sends |
| Chatterbox | 8884 | torn down |
| Orpheus | 5005 | **connection refused** |

`withFailoverOver('tts', …)` exhausts the chain on every utterance. Spoken replies produce an
error event and nothing else.

The migration is also an opportunity the old stack never offered. Breeze does voice *design* —
describe a voice in prose and it invents a speaker — and voice *direction* — clone a speaker, then
steer their delivery. Neither Kokoro nor Chatterbox could do either, which is why the rig needed
two engines. Voices stop being an enum the provider hands us and become content we author. That is
what the new `/voice` page is for, and it retires the interim Gradio UI on the rig that currently
holds that role.

## Measured facts

Everything below was measured against `http://192.168.2.25:8880` on 2026-09-15, not taken from the
package's documentation. Where the two disagree, the measurement is what this spec builds on.

**The contract.** `POST /v1/audio/speech`, `multipart/form-data`, nine fields and no more —
confirmed against the service's own OpenAPI schema (`text`, `instruction`, `cfg_scale`,
`ref_audio`, `ref_text`, `seed`, `temperature`, `top_p`, `top_k`). There is no model field, no
language field, no voice enum, and no multi-speaker parameter.

**Latency and throughput.**

| Mode | TTFA | Throughput |
|---|---|---|
| Design (instruction, no reference) | **6–30 ms** | 1.94× realtime |
| Direction (reference + instruction) | **64 ms** | 1.92× realtime |
| Clone (reference, `cfg_scale` 1.0) | **301 ms** | 1.85× realtime |

Direction at 64 ms is far better than the package's quoted 290–321 ms. That measurement is what
makes clone-backed presets viable for the live agent rather than studio-only.

**Throughput is the design driver.** Kokoro ran ~38× realtime, so synthesizing a whole segment
before sending it cost nothing perceptible. Breeze runs ~1.9×. Buffer a segment and roughly half
its duration elapses as silence before a sample plays. Cycle 60 already measured this class of
failure: Orpheus ran *below* 1.0× and underran mid-utterance regardless of client behaviour. 1.9×
clears breakeven, but only streaming converts it into the 6 ms figure above.

**A prompt-ceiling overrun is invisible in the status code.** Response headers are sent before
generation begins, so a generation failure cannot be reported as an HTTP error:

```
HTTP/1.1 200 OK
content-type: audio/pcm
x-sample-rate: 24000
x-sample-format: s16le
Transfer-Encoding: chunked

→ curl (18) transfer closed with outstanding read data remaining, 0 bytes
```

585 characters at `cfg_scale=1.0` succeeded (2,764,800 bytes). 1,485 characters produced the above.
MyMind's 200-character `sentenceMaxChars` is comfortably safe for reference-free presets, but a
reference consumes the same prompt budget as the text, so the cap is not safe for every preset. See
[Calibration](#calibration).

The response headers carry `x-sample-rate` and `x-sample-format`, which the package does not
document. Read them; do not hardcode 24000.

**Single-request enforcement is a real 409** with a machine-readable body:

```json
{"detail":"An inference request is already running."}
```

**`cfg_scale > 1.0` without an `instruction` is a `500`** with an opaque `Internal Server Error`
body — not the `400` the package's API.md implies, and the body carries nothing to branch on.
Confirmed on both the plain and clone paths. It must be caught pre-flight, never diagnosed from the
response.

**All four vocal events are real.** Identical text, identical seed, against a 1.68 s baseline:

| | duration | | | duration |
|---|---|---|---|---|
| no event | 1.68 s | | `(cough)` | 1.92 s |
| `(laugh)` | 1.92 s | | `(sigh)` | 2.56 s |
| `(clears throat)` | 3.52 s | | | |

**Bilingual output works, and is out of scope.** The model is bilingual EN/ZH from one checkpoint —
a Chinese line with a Chinese instruction rendered 4.56 s of clean speech, using bracket event
syntax (`[笑]`) rather than parentheses. Recorded so a future session does not re-derive it. MyMind
builds English only: no `language` field, no syntax switching, no mismatch warning. Chinese text
sent to Breeze will still work; nothing in MyMind is designed for it.

**Unknown parentheticals are not spoken literally.** `(explodes)` ran 1.2 s longer than baseline,
which looks like the tag being read aloud. Transcribing the output through our own whisper returns
`"Well, that is certainly one way to do it."` with no stray word — the tag perturbs prosody but
introduces no text. No stripping rule is needed, and one would have been written on the strength of
the duration alone.

`toSpeakable()` passes `(laugh)` through untouched today. That is load-bearing and currently
incidental — every other bracket form in that file gets rewritten — so it needs a regression test,
not a change.

## Architecture

The multi-provider TTS abstraction collapses. With one engine there is nothing to fail over to, so
the chain machinery is deleted rather than left inert.

```
/voice studio ──▶ POST /api/voice/speak ──┐
                                          ├──▶ breezeQueue ──▶ breeze.ts ──▶ :8880
/agent WS ──▶ SpeechPipeline ─────────────┘   (agent > studio)   (one client)
```

### `server/lib/voice/breeze.ts` — the only thing that knows the wire format

Builds the multipart form from a preset, streams PCM chunks out, and owns every constraint that
cannot be recovered from a response:

- **Pre-flight validation.** `cfg_scale > 1` requires an `instruction`; `ref_audio` requires
  `ref_text`. Both are 500s with opaque bodies if they reach the rig.
- **Sample rate from headers**, `x-sample-rate` / `x-sample-format`, not a constant.
- **Byte counting.** A stream that ends having produced zero bytes — or that ends early — throws a
  descriptive error rather than yielding silence. This is the only defence against the ceiling
  failure, since the status code cannot carry it.

### `server/lib/voice/breeze-queue.ts` — the whole concurrency story

One in-process queue, two priorities: agent utterances jump studio auditions. Nothing above it ever
sees a raw 409. A 409 *from the rig* means something outside MyMind took the slot (the Gradio UI at
:7868, until it is retired), so that retries with bounded backoff and surfaces as a clear error if
it persists.

`VOICE_TUNING.tts.pipelineConcurrency` drops 3 → 1. `SpeechPipeline`'s ordering guarantee becomes
trivially satisfied, but the class stays — it still owns segment lifecycle, abort handling and the
drop-a-failed-segment behaviour.

### The buffering has to come out

`createTtsSynth` currently collects a whole segment (`for await (…) out.push(c)`, then
`yield* chunks`) so that failover can retry it. That buffering is *why* failover worked, and it is
exactly what would discard the streaming win. No failover means it goes, and PCM flows straight
through to the socket.

This is the single most important change in the cycle: without it, every other streaming change is
decorative.

### What gets deleted

`pinChainToProvider`, the provider-tagged voice aggregation in `/api/voice/voices`, `openAiTts`,
and `tts-failover.ts`'s chain logic. STT failover is untouched — whisper is still registered, still
multi-model, and is now additionally used to transcribe reference clips.

The registry keeps a `tts` usage so the base URL stays configurable from settings, but its
semantics change from *ordered failover list* to *single entry, first wins*.

## Data model

New `voice_presets` table. Reference blobs go through the existing `storage()` put/get, the same
path images and agent files use.

| Column | Notes |
|---|---|
| `id`, `name` | |
| `instruction` | null for plain/clone modes |
| `cfg_scale`, `seed`, `temperature`, `top_p`, `top_k` | the sampling knobs |
| `ref_storage_key`, `ref_text`, `ref_duration_ms` | null for design presets |
| `max_segment_chars` | calibrated; the segmenter reads it per-preset |
| `is_default` | what a fresh cookie points at |
| `created_at`, `updated_at` | |

Mode is derived, never stored — it is a function of which fields are populated, exactly as the rig
derives its template:

| `instruction` | `ref_audio` | Mode | `cfg_scale` |
|---|---|---|---|
| — | — | plain | 1.0 (forced) |
| ✅ | — | **design** | 4.0 default |
| — | ✅ | clone | 1.0 (forced) |
| ✅ | ✅ | **direction** | 4.0 default |

Storing a `mode` column would let it contradict the fields; deriving it cannot.

Seeded on migration with the package's eight starter presets, as ordinary editable rows — prod
must deploy into a state where the agent has a voice, and the cookie migration needs a valid target.

### Calibration

Clone-backed presets are allowed on the live agent, so the fixed 200-character cap is not safe for
all of them: a reference consumes the same prompt budget as the text, and an overrun is an
invisible truncated stream mid-conversation.

On save, a preset carrying a reference gets one probe at 200 characters. If the stream truncates,
one more at 100. Whichever passes becomes `max_segment_chars`, surfaced in the UI. Reference-free
presets skip this entirely — they run ~40-token prompts and cannot approach the ceiling.

Two probes, no binary search. This converts an invisible failure into a number.

Reference uploads are validated at the same seam: reject over 60 s (the model's hard limit), warn
over 20 s (its recommendation). Shorter references leave more budget for text, so this and
calibration serve the same constraint from opposite ends.

## WebSocket contract

Binary frames change meaning: a frame was one complete WAV, it becomes one PCM chunk. Chunks are
bracketed by JSON control events so the client knows the boundaries and format:

| | |
|---|---|
| `{type:'audio-begin', segmentId, sampleRate}` | before a segment's chunks |
| *binary* | raw PCM, mono, s16le |
| `{type:'audio-end', segmentId}` | after |

The client gains a PCM scheduling path on the AudioContext clock — schedule against
`currentTime`, never the `ended` event, which fires late and leaves audible gaps. `playEpoch`
already invalidates queued audio on barge-in and extends to dropping in-flight chunks.
`outAnalyser` stays in the signal chain, so Bridget's jaw envelope keeps working unchanged.

`playWav`'s `catch { /* skip undecodable */ }` goes away. It is the client-side twin of the
truncated-stream problem: a silent swallow of the exact failure we most need to see. A segment that
produces no audio now surfaces an error event.

## The `/voice` page

`/voice` currently 301s to `/agent` (cycle 28, when the old voice page was absorbed). The redirect
is dropped and the name reclaimed.

**Preset rail** — list, select, create, duplicate, delete. Mode and `max_segment_chars` visible per
row.

**Design pane** — instruction textarea with the eight starter descriptions as a dropdown; sliders
for `cfg_scale` (1–8), `temperature`, `top_p`, `top_k`; seed field with a re-roll. Seed audition
renders the same instruction across several seeds so they can be compared — this is casting, and it
is the step that actually determines who the voice is. Reference section: record from the mic or
upload a file, either path auto-transcribing through the existing whisper STT to fill `ref_text`,
which stays editable because it must match the audio exactly.

**Speak pane** — textarea plus a picker that pulls in an existing document, memory or conversation.
An event insert bar: four buttons inserting `(laugh)`, `(sigh)`, `(cough)`, `(clears throat)` at the
cursor. Playback streams through the same PCM path; WAV download wraps server-side.

Studio playback goes over `/api/voice/speak`, not the agent socket, sharing the queue at lower
priority.

## Error handling

| Condition | Where caught | Behaviour |
|---|---|---|
| `cfg_scale > 1` without instruction | pre-flight, `breeze.ts` | rejected before dispatch |
| `ref_audio` without `ref_text` | pre-flight, `breeze.ts` | rejected before dispatch |
| Reference > 60 s | upload | rejected; > 20 s warns |
| 409 from the rig | `breeze-queue.ts` | bounded backoff, then a clear error |
| Truncated / empty stream | `breeze.ts` byte count | throws; agent drops the segment and continues |
| Breeze unreachable | `breeze.ts` | error event; voice is down until it returns |

Breeze is the only engine and there is no fallback — an accepted trade of the rig consolidation, not
an open question. Text replies are unaffected: `speak` simply produces no audio.

## Testing

Unit: form construction per mode, pre-flight validation, truncated-stream detection, queue priority
ordering, calibration, cookie migration, and a regression test pinning that `toSpeakable()` leaves
`(laugh)` intact.

Browser, via `playwright-cli` per CLAUDE.md: create a preset and audition it, speak a document
through the read-aloud pane, and prove `/agent` actually talks using a Breeze preset. The PCM client
path is the one piece with no unit-test safety net — if it is wrong the symptom is silence, which
green typecheck and green unit tests both report as success.

## Migration and cleanup, in the same change

- `VOICE_SETTINGS_DEFAULTS` moves from `{provider, voice}` to `presetId`; `migrateVoiceSettings()`
  maps any stored `chatterbox|Gianna.wav`-era pair to the default preset, following the pattern
  already established there for `playbackRate`.
- `/api/voice/voices` → `/api/voice/presets`.
- `import-env.post.ts` — drop the `AI_TTS_KOKORO` / `AI_TTS_CHATTERBOX` sources.
- `server/lib/analytics/catalog.ts` — the `kokoro-tts` (8880) and `chatterbox-tts` (8884) probes
  become one `breeze-tts` probe on 8880.
- `docs/model-requirements.md` — rewritten; it currently specifies the two-engine rig.
- `docs/wiki/voice-agent.md` — the provider table, the TTS bake-off section, the frame contract and
  the env block all describe a stack that no longer exists.
- `README.md` — the two TTS mentions.
- A new wiki page for the `/voice` studio.

## Deferred

**Multi-speaker dialogue.** The model supports up to eight speakers, but our endpoint takes one
`ref_audio` per call, so it is composition rather than a parameter: parse a `Name: line` or JSON
script, synthesize each line with that speaker's preset, insert pauses, concatenate. It only makes
sense once presets exist, and every line is a separate queued call — a long script monopolizes the
rig. Its own cycle.

## Licence

Breeze weights are **research / non-commercial** (the inference code is Apache-2.0), and
self-hosted output is covered by that restriction. Fine for personal use. This needs revisiting if
anything MyMind produces with it is ever monetized — which is a constraint the previous stack did
not carry.
