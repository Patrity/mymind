---
title: Voice Studio
status: shipped
cycle: 61
updated: 2026-09-15
mymind_id: b7dc4979-0fa0-41b0-8774-c6c2c470748c
mymind_hash: 4ab89d2411a20075968d3d8d007d3f1c3341d12e930fb719165c4b4832af7c67
---

# Voice Studio

`/voice` — where a voice is **authored**, and where anything in MyMind can be **read aloud**.

Before cycle 61 this route was a redirect to `/agent` (cycle 28 merged the old talk page into the
unified surface). Cycle 61 gave `/voice` a new job rather than restoring the old one: Breeze TTS 2
has no voice enum, so a "voice" is no longer a string you pick from a list — it is a row you write.
This page is the editor for those rows.

See [voice-agent.md](voice-agent.md) for the live conversation loop that *consumes* these presets.

## The page

Three resizable `UDashboardPanel`s inside one flex wrapper:

| Panel | Width | Contents |
|---|---|---|
| `voice-presets` | 18%, `hidden lg:flex` | The rail — every preset, its mode badge, a star on the default. New / Duplicate / Make default / Delete. |
| `voice-design` | 41% | Name, starter picker, instruction, cfg/temperature/top-p/top-k, seed, seed audition, reference clip. |
| `voice-speak` | remainder | Read-from-MyMind picker, text box, event tags, Speak / Stop / Download WAV. |

Below `lg` the rail hides and the page stays usable. Auth is the app-wide
`app/middleware/auth.global.ts` — there is no named `auth` middleware to opt into.

## The four modes are derived, never stored

Breeze picks its prompt template from **which fields are populated**. `presetMode()` in
`shared/types/voice-presets.ts` mirrors that exactly, and there is deliberately no `mode` column —
a stored mode can contradict its fields, a derived one cannot.

| Mode | Instruction | Reference clip | What it is |
|---|---|---|---|
| `plain` | — | — | The model's own default voice. |
| `design` | ✓ | — | A voice described in words. All eight seeded presets are this. |
| `clone` | — | ✓ | A voice copied from ~10 s of recorded speech. |
| `direction` | ✓ | ✓ | A cloned voice, then *directed* — "the same person, but wearier". |

The rail's badge is `modeBadge()` from `app/lib/voice/studio.ts`, which is unit-tested to return one
of the four semantic colour aliases so a raw palette value cannot creep in.

## Preset schema (`voice_presets`, migration 0039)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `name` | text | `voice_presets_name_key` UNIQUE. Duplicating appends `(copy)`, then `(copy) 2`. |
| `instruction` | text null | Blank stores as `NULL`, never `''` — the CHECKs test `NULL`. |
| `cfg_scale` | real, default 4 | How hard the model is pushed toward the instruction. |
| `seed` | integer, default 42 | Same seed + same instruction = the same voice every time. |
| `temperature` / `top_p` / `top_k` | real / real / integer | 0.9 / 1.0 / 50 by default. |
| `ref_storage_key` | text null | The reference clip in blob storage. |
| `ref_text` | text null | Its exact transcript (Whisper, editable). |
| `ref_duration_ms` | integer null | Measured from the WAV header. |
| `max_segment_chars` | integer, default 200 | **Calibrated, not chosen** — see below. |
| `is_default` | boolean | `voice_presets_one_default` partial unique index — exactly one. |

Three CHECK constraints encode rig facts that are otherwise opaque 500s:

- `voice_presets_cfg_positive` — `cfg_scale > 0`.
- `voice_presets_cfg_needs_instruction` — `cfg_scale <= 1 OR instruction is a non-blank string`.
  The clone and plain templates define no negative prompt, so guidance has nothing to push against.
- `voice_presets_ref_needs_text` — a reference clip requires its transcript.

### The cfg lock, in three layers

Because the middle constraint is *both* a DB CHECK and an opaque rig 500, the studio makes the
illegal pair unconstructable rather than merely unsaved:

1. the `USlider` is `:disabled` while the instruction is blank;
2. its help text becomes the reason — *"Guidance needs an instruction to push against — write one
   above to raise it past 1.0."*;
3. a watcher clamps `cfgScale` back to 1 when a previously-filled instruction is **cleared**, and
   `draftToBody` clamps again on the way out.

Browser-verified in both directions: blank instruction → slider disabled at 1.0; type an
instruction → enabled, raised to 5.0; clear it again → snaps back to 1.0 and re-locks.

The same rule is enforced server-side by `validateBreezeRequest`, which
`POST /api/voice/speak` runs as a pre-flight — that is the only place the combination can be caught
when it arrives through `overrides` rather than through a row.

### Seeded presets

Migration 0039 inserts eight reference-free design presets from the rig's handoff package, all at
seed 11 / cfg 4: `neutral-lowkey` (the default), `warm-woman`, `bright-man`, `deep-narrator`,
`crisp-anchor`, `dry-laidback`, `latenight-radio`, `light-assistant`. They are seeded rather than
shipped as read-only built-ins so they can be retuned in place — and because prod must deploy into a
state where the agent already has a voice, and the cookie migration needs a valid target.

> The starter descriptions are duplicated between migration 0039 and `DesignPane.vue`'s `STARTERS`.
> Retuning a seeded row in the DB will not update the studio's starter list.

## Seed audition — a preview, never a write

"Try 4 seeds" renders the same sentence four times at four different seeds.

The first implementation PATCHed the row's seed before each take and restored it in a `finally`.
That is wrong in a way a `finally` cannot fix: the live agent resolves the same row **per turn**, so
between two takes it would have spoken in an audition seed — and a closed tab left the row stranded
there permanently.

It is now an in-memory merge. `POST /api/voice/speak` accepts an `overrides` object
(`SpeakOverrides`), `applyOverrides()` merges it over the resolved preset for that one request, and
nothing is written. The allow-list is the point: `seed`, `instruction`, `cfgScale`, `temperature`,
`topP`, `topK` and nothing else, so `maxSegmentChars` and every reference field are structurally
unreachable — an override cannot claim a prompt budget the preset was never measured for.

Because every tunable rides along as an override, the audition renders **what is on screen**, not
what was last saved. There is no "save first" gate.

`runAuditionSequentially` awaits each request before starting the next, and `send` is its only route
to the network — so "an audition performs no write" is a property of the code's shape.

**Browser-verified (2026-09-15):** four `POST /api/voice/speak`, `maxInFlight: 1`, each request
starting ~2 ms after the previous body completed, **zero PATCH**, four distinct seeds, all 200 (no
409). Auditioning and then closing the tab mid-run left the preset's `seed` and `updated_at`
unchanged.

## Calibration — `max_segment_chars` is measured, not guessed

A reference clip consumes the same prompt budget as the text, so a clone-backed preset cannot be
assumed safe at the agent's 200-character segment cap. And an overrun is invisible — the rig answers
`200 OK` before generation begins and then produces nothing — so it has to be *measured*.

`calibrateMaxSegmentChars()` (`server/services/voice-presets.ts`) runs on save:

- **Reference-free presets skip the probe entirely** — they run ~40-token prompts and cannot
  approach the ceiling, so there is no point burning a rig slot to confirm the obvious. They keep
  200.
- Otherwise it probes at 200 characters. Success → 200. A `truncated` error → probe at 100 → 100.
- **Only a `truncated` error narrows the cap.** A busy rig or a network blip is not evidence, and
  narrowing on it would silently degrade a perfectly good preset — so anything else is rethrown.

The probe is a real synthesis through the queue at **studio** priority (`makeLiveProbe`), so saving
a clone can wait behind a live conversation. That is intended.

The calibrated ceiling then does two jobs: the orchestrator clamps `sentenceMaxChars` to it per
preset, and the studio warns *before* spending a rig slot when the text exceeds it
(`overCapWarning`) — `/api/voice/speak` sends the text in one piece, so here it is a hard ceiling
rather than a hint.

## Queue priorities

Breeze serves **one inference at a time** and answers 409 to anything concurrent, so every caller
holds a slot for the whole lifetime of its stream (`server/lib/voice/breeze-queue.ts`).

| Priority | Who | Behaviour |
|---|---|---|
| `agent` | A live conversation turn | Jumps ahead of any waiting studio work. |
| `studio` | `/api/voice/speak`, and the calibration probe | FIFO behind the agent. |

Within a priority the queue is strictly FIFO by arrival. The studio shows the wait rather than
hiding it: after 4 s the pane reads *"Waiting on the rig (Ns) — it renders one request at a time,
and studio work queues behind live conversation."*

## Reference clips

`POST /api/voice/reference` takes a multipart `audio` field, measures it off the RIFF header
(`wavDurationMs`), transcribes it with Whisper, and returns `{ storageKey, refText, durationMs,
warning }`.

| Limit | Constant | Behaviour |
|---|---|---|
| 20 s | `REFERENCE_WARN_LIMIT_MS` | `warning` is set — an amber alert quoting the measured length. Shorter clips leave more prompt budget for the text. |
| 60 s | `REFERENCE_HARD_LIMIT_MS` | **400**, with the measured length and the limit in the sentence. |
| not RIFF | — | **400** "Reference must be a WAV file". |

About ten seconds of clean speech is the target.

Two ways in: drag a WAV onto the `UFileUpload`, or record from the mic.
`MediaRecorder` produces webm/opus, which the route rejects, so a recording is decoded through an
`AudioContext` and re-encoded by `app/lib/voice/wav-encode.ts` — whose tests round-trip through the
**server's own** `wavDurationMs`, because a header this encoder gets subtly wrong is exactly the
failure that would sail past the 60 s gate and die invisibly at the rig.

A reference clip cannot be saved without a transcript (`voice_presets_ref_needs_text`).

## Reading MyMind aloud

The "Read from MyMind" `USelectMenu` groups documents, memories and conversations
(`USelectMenu` renders one `ComboboxGroup` per inner array). Picking a document or memory fills the
box with its content; picking a conversation fills it with the **assistant's** replies only,
blank-line separated (`messagesToScript`), falling back to everything if the assistant never spoke.

Event tags — `(laugh)`, `(sigh)`, `(cough)`, `(clears throat)` — insert at the caret via
`insertAtCursor`, space-separated, never glued onto a word, with the caret landing after the tag.

**Download WAV** re-requests with `format: 'wav'` in the JSON body (not a query parameter) and saves
`<preset>.wav`.

> reka-ui throws on an empty-string item value, which crashes the whole popover while passing every
> gate. Neither `USelectMenu` here can produce one: the starters model is `undefined` when unset, and
> every source item's value is `doc:<uuid>` / `mem:<uuid>` / `conv:<uuid>`.

## Telling a truncation from a failure

This distinction is the reason the cycle exists, so the two alerts mean different things and must
stay that way:

| Alert | Colour | Means |
|---|---|---|
| **Synthesis failed** | error | A hard failure — a 400 from the pre-flight, a 502 from the rig, a dropped request. |
| **Nothing came back** | warning | A prompt-ceiling overrun diagnosed from how much audio actually arrived. |

`diagnoseStreamRender` counts **bytes**, not "did anything arrive": the commoner overrun shape is a
stream that delivers a frame or two and then stops, which sets `ttfaMs` like a healthy render. It
returns `null` when `cancelled` is set, because pressing Stop produces exactly the same shape as a
truncation and telling a user their own cancel was an overrun is worse than saying nothing.

Server errors arrive as an h3 JSON envelope; `errorFromResponseBody` parses it so the sentence the
server wrote is what renders, not `{"url":…,"statusCode":…}`. It falls through to the raw text when
a body only *looks* like JSON, so a truncated body cannot vanish into a catch.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/voice/presets` | `{ presets: VoicePresetDTO[] }` — the rail. Live via vue-query key `['voicePreset','list']`. |
| `POST /api/voice/presets` | Create; calibrates before returning. |
| `PATCH /api/voice/presets/[id]` | Update; recalibrates when the reference or instruction changed. |
| `DELETE /api/voice/presets/[id]` | Delete. The default cannot be deleted. |
| `POST /api/voice/speak` | `{ text, presetId?, format?: 'pcm'\|'wav', overrides? }`. Streams PCM with an `x-sample-rate` header, or returns a whole WAV. Studio priority. |
| `POST /api/voice/reference` | multipart `audio` → `{ storageKey, refText, durationMs, warning }`. |

Every preset mutation calls `publishChange`, and `app/utils/live-dispatch.ts` invalidates
`['voicePreset','list']` — so a preset created in one tab appears in another without a refresh.
`useFetch` would not see any of it; the rail uses `useQuery`.

## Files

| File | Purpose |
|---|---|
| `app/pages/voice.vue` | The three-panel page, preset CRUD, selection. |
| `app/components/voice/PresetRail.vue` | The rail and its action bar. |
| `app/components/voice/DesignPane.vue` | Instruction, sliders, seed, audition, reference clip. |
| `app/components/voice/SpeakPane.vue` | Text, source picker, event tags, Speak / Stop / Download. |
| `app/composables/useBreezeSpeech.ts` | Studio playback — PCM on the AudioContext clock over plain `fetch`, not the agent socket. |
| `app/lib/voice/studio.ts` | Pure studio logic: validation, cfg lock, modes, audition driver, truncation diagnosis, error extraction. |
| `app/lib/voice/generation.ts` | The preset-switch guard (token + AbortSignal) — see below. |
| `app/lib/voice/wav-encode.ts` | Mic recording → WAV; WAV header reader for sizing a render. |
| `server/api/voice/speak.post.ts` | Studio synthesis, PCM or WAV. |
| `server/api/voice/reference.post.ts` | Reference upload, measurement, transcription. |
| `server/services/voice-presets.ts` | CRUD, defaults, calibration, reference loading. |

### The preset-switch guard

The design pane is **one form** bound to whichever preset is selected, so anything in flight when
the selection changes belongs to the wrong preset. `createGenerationGuard()` uses two mechanisms
because they cover different halves: a **token** captured before the first `await` (for work that
cannot be cancelled — an upload already on the wire, a `decodeAudioData` in progress: the result
arrives and is dropped) and an **AbortSignal** (for work that can — the audition's renders, which is
what frees the rig).

`reset()` bumps the generation, aborts the current controller, and installs a **fresh** one —
without that last step every later request would be born pre-aborted.

The bug this prevents is data corruption, not just flicker: an upload started under preset A used to
resolve into whatever draft was selected when it landed, so B silently acquired A's clip and
transcript, and the next Save persisted them.

## Known gaps

- **`/api/documents` ships full document content** (up to 200 rows) to populate the source picker's
  labels. Fine today; heavy on a large corpus. A summary route plus fetch-on-select is the lighter
  shape if it ever bites.
- **Stop is unreachable once the stream body ends** — `speaking` flips false while buffers are still
  scheduled ahead on the AudioContext clock, so audio keeps playing with the button disabled.
- **Chunk-boundary artefacts are unproven either way.** Each PCM chunk becomes its own 24 kHz
  `AudioBuffer` resampled independently to the device's context rate, so a discontinuity is possible
  at every chunk edge. No gate in this project can detect it; it needs ears. See the
  [cycle-61 handover](../handovers/2026-09-15-breeze-tts-voice-stack.md).
