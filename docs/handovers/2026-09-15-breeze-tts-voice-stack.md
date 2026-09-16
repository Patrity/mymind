---
title: Breeze TTS 2 — one engine, presets instead of voices, and a studio to author them (cycle 61)
cycle: 61
date: 2026-09-15
status: >
  BUILT AND BROWSER-VERIFIED, NOT MERGED. 13 of 13 tasks complete on `feat/breeze-tts`
  (subagent-driven, per-task two-verdict review, 12 rulings). The TTS stack was replaced wholesale:
  Kokoro, Chatterbox and Orpheus are gone, there is no TTS failover chain, and a voice is now a
  `voice_presets` row authored at `/voice` rather than a string from a `/v1/voices` enum.
  **All nine mechanical browser checks passed** against the live rig at 192.168.2.25:8880 —
  including the two that no unit test can reach (an audition issues four strictly serial requests
  and ZERO writes; a tab closed mid-audition leaves the preset's seed untouched). Validation found
  and fixed **three real defects** that all three gates had passed: a prompt-ceiling overrun past
  ~3400 characters escaped the route as an unhandled 500 "Server Error"; a hard download failure was
  labelled as a truncation; and the barge-in `epoch` guard was dead code. Gates measured fresh at
  HEAD: **typecheck 0 errors / test 1726 passed (193 files) / build clean**. **TWO ITEMS REMAIN
  OPEN AND NEED TONY'S EARS — neither is verified and neither can be** (chunk-boundary artefacts;
  whether the barge-in tail was ever audible). Not pushed, not merged, not deployed; migration 0039
  has run only against local dev, and **deploying requires a manual registry edit** (see Deploying).
  A final whole-branch review then landed one more wave of fixes (migration **0040**, the
  `calibrated_ref_key` column) — see "Final review fix wave".
branch: feat/breeze-tts
spec: ../superpowers/specs/2026-09-15-breeze-tts-voice-stack-design.md
plan: ../superpowers/plans/2026-09-15-breeze-tts-voice-stack.md
docs:
  - ../wiki/voice-studio.md (NEW — the studio, the four modes, the preset schema, calibration, queue priorities, reference limits; mirrored to MyMind)
  - ../wiki/voice-agent.md (Providers, TTS engine, Speech pipeline concurrency, WebSocket frame contract, Env vars and the frontend-files table rewritten; the three-engine bake-off removed; frontmatter bumped to cycle 61)
  - ../wiki/README.md (voice-studio.md added to the page index)
  - ../wiki/voice-studio.md (UPDATED by the final review fix wave — calibrated_ref_key, ensureCalibrated's three outcomes, the warning's reference gate, queue priority ≠ preemption)
  - ../superpowers/plans/00-roadmap.md (cycle 61 row added)
tasks:
  - 5e4a7c6f-01fb-4596-9e61-06692d4f5772 (MyMind) — "Cycle 61 — Breeze TTS voice stack" — this task.
  - 9b26ae79-7080-4814-9af0-74b3eedf2574 (MyMind) — multi-speaker dialogue composition, DEFERRED to its own cycle.
shipped:
  - Breeze TTS 2 as the only TTS engine — server/lib/voice/breeze.ts owns the wire format; the failover chain is deleted
  - voice_presets (migration 0039) — four modes derived from which fields are populated, three CHECK constraints encoding rig facts, eight seeded design presets
  - /voice — the Voice Studio: author presets, audition seeds, attach reference clips, read MyMind aloud
  - A single-slot priority queue (agent > studio) because Breeze 409s anything concurrent
  - Streaming raw PCM end to end, bracketed by audio-begin/audio-end, replacing one-WAV-per-sentence
  - Calibrated per-preset prompt ceilings — measured, never estimated, and provably distinguishable from unmeasured (migration 0040, `calibrated_ref_key`)
  - In-memory SpeakOverrides so an audition is a preview, not four writes to a live row
outstanding:
  - Chunk-boundary artefacts — NEEDS EARS, unverifiable by any gate
  - Whether the barge-in audio tail was ever audible — the guard is now wired and tested, but the symptom was never confirmed
  - Deploying needs a manual `assignments.tts` edit; no migration does it
---

# Breeze TTS 2 — one engine, presets instead of voices, and a studio to author them

## What this cycle actually changed

Before: three TTS engines (Kokoro, Chatterbox Turbo, Orpheus) behind a failover chain, a voice
picked as a string from an aggregated `/v1/voices` enum, and binary frames on the socket that were
one WAV per sentence.

After: **one engine**, no chain, and a voice that is a **row you write** rather than a name you
choose. Breeze TTS 2 has no voice enum at all — a voice is an instruction, a seed, four sampling
parameters and optionally a reference clip — so "pick a voice" stopped being a meaningful
operation and `/voice` was rebuilt as the place where voices are authored.

| | Before (cycle 60) | After (cycle 61) |
|---|---|---|
| Engines | Kokoro `:8880`, Chatterbox `:8884`, Orpheus `:5005` | Breeze TTS 2 `:8880` |
| TTS failover | `tts-failover.ts`, pin-then-chain | **None.** `chain[0]` and stop |
| A voice is | a string (`af_heart`, `tara`, …) | a `voice_presets` row |
| Voice selection frame | `{type:'voice', provider, voice}` | `{type:'preset', presetId}` |
| Binary frames | one WAV per sentence | raw PCM (s16le mono) as produced, bracketed by `audio-begin`/`audio-end` |
| `/voice` | a redirect to `/agent` | the Voice Studio |
| Pipeline concurrency | ramped 1 → 3 | **pinned at 1** (the constructor throws otherwise) |
| Prompt ceiling | assumed 200 chars | **calibrated per preset**, measured on save |

Deleted: `server/lib/voice/tts-failover.ts`, `server/api/voice/voices.get.ts`,
`FIRST_SEGMENT_CONCURRENCY` / `effectiveConcurrency` / `firstSegmentDrained` in `pipeline.ts`, and
the `AI_TTS_KOKORO_*` / `AI_TTS_CHATTERBOX_*` env vars.

Current behaviour lives in [`docs/wiki/voice-studio.md`](../wiki/voice-studio.md) and
[`docs/wiki/voice-agent.md`](../wiki/voice-agent.md); this handover records what happened and what
is still open.

## Browser evidence

Everything below was driven with `playwright-cli` against `pnpm dev` on a spare port, with the live
rig at `192.168.2.25:8880` (`{"status":"ok","sample_rate":24000}`). These are **mechanical**
results — bytes, counts, request shapes, DOM state, database rows. Nothing here is a claim about how
anything *sounds*.

| # | Check | Result |
|---|---|---|
| 1 | `/voice` loads without redirecting to `/agent`, lists the eight seeded presets | **PASS** — `location.pathname === '/voice'`; all eight names present, each with a mode badge, `neutral-lowkey` starred |
| 2 | Speaking produces a real body with `x-sample-rate`, and the UI renders `ttfaMs` | **PASS** — 200, `x-sample-rate: 24000`, **153,600 bytes over 40 chunks** (3.2 s of audio for a 32-char sentence), TTFA **108 ms** at the API; the pane rendered "first audio in 136 ms" on a warm render (454 ms on the session's first) |
| 3 | A created preset survives a reload | **PASS** — created via the rail, row present in Postgres with `cfg_scale` correctly clamped to 1 (no instruction), still in the rail after a full reload |
| 4 | The cfg slider is locked above 1.0 while the instruction is empty, **and re-locks when a filled instruction is cleared** | **PASS, both directions** — blank → `data-disabled`, value 1, help text is the lock reason; typed instruction → enabled, raised to **5.0** by keyboard; instruction cleared → **snapped back to 1.0 and re-locked** |
| 5 | "Try 4 seeds" is strictly serial and issues **no** PATCH | **PASS** — exactly 4 requests, all `POST /api/voice/speak`, **`maxInFlight: 1`**, each starting ~2 ms *after* the previous body completed, **`patchCount: 0`**, four distinct seeds (11, 355682, 762101, 266012), all 200, no 409 |
| 6 | Audition, close the tab mid-run, reopen — the seed is unchanged | **PASS** — sentinel seed 4242 set, audition started, tab closed ~5 s in; the row still read `seed: 4242` with an `updated_at` predating the audition |
| 7 | `/agent` speaks with a Breeze preset over the WebSocket | **PASS** — frame sequence `transcript → state:thinking → transcript → state:speaking → usage → audio-begin(segmentId 1, sampleRate 24000) → PCM ×15 → audio-end(segmentId 1) → state:idle`; **53,760 binary bytes = 1.12 s**; `state` reached `speaking` |
| 8 | Over-ceiling text produces the truncation explanation, not a generic error | **PASS after a fix** — see Defect 1 |
| 9 | A 400 from the pre-flight shows a readable sentence, not raw JSON | **PASS** — the server really returns `cfg_scale above 1.0 requires an instruction (the clone/plain templates define no negative prompt)`; the UI renders that sentence under "Synthesis failed" on **both** the Speak and Download paths, with no `{"url":…,"statusCode":…}` anywhere on screen |

Nine of nine mechanical checks pass. Test data was cleaned up: the scratch preset deleted, the
sentinel seed restored, eight presets at seed 11 as seeded.

### Two notes on method

**`playwright-cli requests` double-lists.** Every request appeared twice with identical duration and
timestamp, which looked exactly like a duplicate-request bug. A page-side `window.fetch` recorder
proved one click = one POST. Any future session reading request counts off that command should
cross-check before concluding the app fires twice.

**The dev browser session was hijacked mid-run** by another project sharing playwright-cli's default
session (it navigated to a `localhost:3003` page from an unrelated repo). Validation was redone in a
named session (`playwright-cli -s=mymindvoice`). Worth doing by default on this machine.

## Three defects found by validation, all fixed

All three passed `typecheck`, `test` and `build`. This is the whole argument for the browser step.

### 1. A prompt-ceiling overrun escaped as an unhandled 500

**Symptom.** 3600 characters through `/api/voice/speak` returned `500 "Server Error"` with the
message reduced to undici's `terminated`, and Nitro logged `[request error] [unhandled]`.

**Cause.** `breezeSpeak`'s `chunks()` generator handled exactly one overrun shape — a clean EOF at
zero bytes — and mapped it to `BreezeError('truncated')` with a good sentence. But past roughly 3400
characters the rig does not manage a clean EOF: it **drops the socket** mid-body, and
`reader.read()` rejects with a bare `TypeError: terminated` that nothing mapped. Worse, the throw
happened inside the `ReadableStream`'s `pull()`, which is *outside* the route handler's try/catch,
so `toHttpError` never ran.

This is the exact failure this cycle exists to make legible, arriving as the least legible thing in
the app.

**Fix.** `breeze.ts` now catches a mid-body read failure and raises `BreezeError('truncated')` with
a message naming the overrun and how many bytes did arrive — while letting an `AbortError` (or any
read on an aborted signal) through untouched, because a caller walking away is not a rig failure.
`speak.post.ts`'s `pull()` now calls `controller.error(toHttpError(err))` instead of rethrowing raw.

**Verified.** Before: `500 "Server Error"` / `terminated`. After: **502** with
*"Breeze stopped sending after 0 bytes and dropped the connection — that is what a prompt-ceiling
overrun looks like from here. Shorten the text, or trim the reference clip."* — and the studio UI
shows that sentence rather than a JSON envelope.

**Tests.** 5 new in `server/lib/voice/breeze.test.ts`. Reverted to the old read loop and watched 3 of
them go red, so they demonstrably reach the bug rather than merely passing.

### 2. A hard download failure was dressed as a truncation

`onDownload`'s catch wrote into `note`, which renders under the alert titled **"Nothing came back"** —
which in this cycle means specifically *"the rig accepted the text and then died on a prompt-ceiling
overrun"*. So a 400 from the pre-flight, a 502 from an unreachable rig, or a dropped connection was
reported as an overrun, destroying the one diagnostic distinction the truncation path exists to
draw. (Recorded as a deferred minor during Task 11; validation made its consequence concrete, since
the same screen showed *both* alerts for a single 400.)

**Fix.** Hard failures now go to `error` (the "Synthesis failed" alert) and `note` is left to mean
truncation only; `onDownload` clears `error` on entry so the two buttons stay symmetrical. Verified
in the browser: the 502 above renders under "Synthesis failed" and "Nothing came back" is absent.

### 3. The barge-in `epoch` guard was dead code

`enqueuePcm(data, epoch)` checked `epoch !== playEpoch` and returned — but the socket handler called
it as `enqueuePcm(e.data, playEpoch)`, reading the same variable the guard compared against, in the
same synchronous tick. The two could never differ. It had read as protection for a full cycle while
providing none.

This was a decision the task was asked to settle either way — wire it or delete it — and **wiring it
is the right answer, because it does real work**. `stopPlayback()` kills the sources it has
*already scheduled*, but a PCM frame still in flight when the user interrupts arrives afterwards and
schedules itself onto a cleared playhead. That frame is the tail, and nothing was refusing it.

**Fix.** The epoch is now captured at `audio-begin` (the segment's stamp) and checked on arrival.
This is safe because the frame contract is ordered and strictly bracketed — a stale frame can only
arrive *before* the next segment's `audio-begin`, so re-stamping can never retroactively admit one.

The rule was extracted to `app/lib/voice/playback-epoch.ts` and given 7 tests, because the reason it
stayed dead for a cycle is that it was untestable inside the composable's closure. Reverting
`segment()` to return the live epoch (the old behaviour) turns 3 of the 7 red, including the one
named `REGRESSION: drops a frame still in flight when the user barged in`.

**What this does NOT establish:** that the tail was ever audible. See Outstanding.

## A deploy prerequisite that no migration performs

`speakWithPreset` resolves `chain[0]` of the registry's `tts` assignment and stops — there is no
failover behind it. Task 12 retired the two-engine world from code, probes, env and docs, but
**nothing updates the runtime registry**, which is a `settings` row (`ai_config`), not a migration.

On the dev box the assignment still read `[chatterbox@:8884, kokoro@:8880]`, so every render 502'd
against a host that has been dead since the rig was repurposed. The fix was a data edit: drop the
retired entry, point `assignments.tts` at the `:8880` provider, relabel it `tts: breeze`.

**Production will be in the same state.** Before or immediately after deploying this branch, edit
Settings → Models so `tts` names exactly one model on the Breeze rig. Symptom if missed: every
spoken reply fails with *"Breeze unreachable at http://…: fetch failed"*, and nothing falls back.

Note also that the registry cache is process-local with explicit invalidation, so a direct SQL edit
needs a restart; editing through the settings UI does not.

## Rig facts measured this session

Worth recording because they are not recoverable from a response:

- `GET /health` → `{"status":"ok","sample_rate":24000}`; 503 while warming (~44 s cold).
- **Output is capped at 120 seconds.** 900 and 1800 characters both returned exactly **5,760,000
  bytes** at 24 kHz. This cap arrives as a *full* body, so no byte-count heuristic can detect it —
  only the pre-dispatch ceiling warning, and ears, can. A 900-character render producing *more*
  audio than its character count predicts is a strong hint the output is degenerate, but that is a
  listening question.
- Clean renders: 180 chars → 17.6 s; 450 chars → 46.8 s.
- Past ~3400 characters the rig drops the connection (Defect 1).

## Outstanding — these need Tony's ears, and are NOT verified

Both were carried into this task as listening items. A browser can prove bytes arrived; it cannot
hear. Neither of these is resolved, and neither should be recorded anywhere as verified.

### 1. Chunk-boundary artefacts (ruling R10, Task 9)

Each PCM chunk becomes its **own** 24 kHz `AudioBuffer`, resampled independently to the device's
AudioContext rate (typically 48 kHz). A discontinuity is therefore possible at every chunk edge,
which would be audible as a faint buzz **at chunk rate** — for reference, a single studio render
above was 40 chunks over 3.2 s, so the artefact would sit around 12 Hz.

**Status: unverified in both directions.** No gate in this project can detect it, the original
reviewer could not prove it occurs, and this session could not either.

**Listen for it** across a long spoken reply on `/agent`, not a short one — a two-second reply gives
too few boundaries to hear a pattern.

**If it is audible**, the remedy is batching chunks into larger buffers before scheduling. Pinning
the context sample rate is **not** available: `useVoice`'s AudioContext must stay at the device rate
for vad-web. Fixing on suspicion was deliberately declined, because both plausible remedies change
the audio path materially and would trade a hypothetical buzz for a real latency or VAD regression.

### 2. Whether the barge-in tail was ever audible

The dead guard described in Defect 3 is now wired and tested, so a frame arriving after an interrupt
is refused. **But nothing has established that the tail was audible to begin with**, and nothing has
established that it is gone.

What is proven: the guard can now fire, and the unit tests go red without the fix. What is not
proven: that a real barge-in ever produced audible audio after the interrupt, or that it no longer
does. Reproducing this deliberately needs a mic, a long reply, and an interruption timed to land
while a frame is in flight — a human, in other words.

**Listen for it** by barging in mid-reply on `/agent` and judging whether anything continues past
the cut. If something still does, the next suspect is the scheduling floor rather than the epoch:
`+0.02` is unconditional, so on underrun it inserts up to 20 ms of silence where starting at the
playhead would have been legal.

## Out of scope by decision, not by omission

**Multi-speaker dialogue.** Breeze supports up to eight speakers in one generation, and this build
does not use it: our endpoint takes one speaker, and script parsing, speaker→preset mapping, pause
tuning and concatenation are a cycle's worth of design on their own. Deferred to its own cycle —
MyMind task `9b26ae79-7080-4814-9af0-74b3eedf2574`. Nothing in the schema blocks it; a dialogue
would be a new composition layer above presets, not a change to them.

**Bilingual EN/ZH.** The model is bilingual from one checkpoint, and it works — the spec records a
Chinese line with a Chinese instruction rendering 4.56 s of clean speech, with bracket event syntax
intact. **MyMind builds English only, by decision.** There is no `language` field, no syntax
switching and no mismatch warning, and that is a choice rather than an oversight: adding a language
dimension means a language on every preset, language-aware segmentation (the segmenter's rules are
built on Latin punctuation and whitespace), and a story for what happens when the text and the
instruction disagree. None of that earns its keep for a single English-speaking user today.

Both are recorded in the spec's own `defers` block, so the decision is not being invented here.

## Known gaps carried forward

Deferred minors from the per-task reviews, none of which validation contradicted:

- **Stop is unreachable once the stream body ends** — `speaking` flips false while buffers are still
  scheduled ahead on the AudioContext clock, so audio keeps playing with the button disabled.
- **A dropped segment is silent on the wire.** `pipeline.ts` logs it to `console.error` with no
  `recordEvent`, so a rig dropping one segment in ten is invisible in the activity log. The text
  still reaches the client via the transcript event. This is an observability gap, not a protocol
  one.
- **`resolvePreset` / `loadReferenceBytes` sit outside the try in `speak.post.ts`**, so an unreadable
  reference blob returns an unmapped 500 rather than a mapped 502/400.
- **No runtime body validation on `PATCH /api/voice/presets/[id]`** — the raw body is spread into
  `.set()`, so a client can write `maxSegmentChars` / `isDefault` despite both being measured rather
  than chosen.
- **The starter descriptions are duplicated** between migration 0039 and `DesignPane.vue`'s
  `STARTERS`; retuning a seeded row in the DB will not update the studio's list.
- **`/api/documents` ships full document content** (up to 200 rows) to label the studio's source
  picker.
- **`clearOtherDefaults` + insert/update is not transactional** — a concurrent write could briefly
  leave zero defaults. Single-user app, not pursued.
- **h3 warns that `statusMessage` will be sanitized by default in future.** Every carefully written
  sentence in this cycle's error handling travels in `statusMessage`; if that sanitization lands,
  they all vanish at once. Nothing is broken today, and the codebase is consistent — but this is the
  single change most likely to silently undo this cycle's diagnostics.

## Final review fix wave

A whole-branch review after the cycle was otherwise complete found two Important defects and three
Minors. All five are fixed; the two audio-quality items below still need ears, and the registry
repoint is still manual.

**1. A failed calibration was never retried (Important).** `[id].patch.ts` persisted the new
`refStorageKey` *before* comparing it to the previous row's, so a probe that threw anything but
`truncated` — a down or busy rig, i.e. prod's exact state until the §4b registry repoint — 500ed
the request with the new reference already stored. On the retry the keys matched, calibration was
skipped, and the preset kept a **200 cap nobody had ever measured**: a clone-backed voice on the
live agent, running on precisely the invisible-truncation assumption calibration exists to
eliminate. `presets.post.ts` had the same shape on Duplicate (row created, caller saw only a 500).

Fixed by **gating on "is this cap a measurement of the clip the row carries" rather than on "did the
key change"**. `max_segment_chars` is `NOT NULL DEFAULT 200` and cannot carry that distinction, so
migration **0040** adds a nullable `calibrated_ref_key`, holding the clip the cap was measured
against. Both routes now call one `ensureCalibrated()`: no reference → reset the cap (which also
fixes the Minor where a clone→design demotion kept a 100 cap); marker matches the clip → no rig
slot spent; anything else → probe. **A probe failure no longer fails the save and no longer counts
as a measurement** — the row is saved at the conservative 100 floor with the marker still `NULL`,
the response carries a `calibrationWarning` the studio shows, and the next save probes again.
`max_segment_chars` and `calibrated_ref_key` are stripped from request bodies, because a client that
could assert them could assert a calibration that never ran.

**2. The studio's cap warning cried wolf (Important).** `overCapWarning` compared against
`maxSegmentChars` alone, but for a reference-free preset 200 is a default the spec deliberately does
*not* measure — 585 characters render fine on the rig — and all eight seeded presets carry it. So
pulling any document into the speak pane fired "the render will very likely stop early", which
devalues the one warning that means something. It now takes the preset and returns `null` unless
there is a `refStorageKey`.

**Minors:** `CFG_MIN`/`CFG_MAX` had no readers outside `studio.ts` while `DesignPane.vue` hardcoded
`1`/`8` — the slider now reads the constants that `clampCfgScale()` enforces. `breeze-queue.ts`'s
header claimed a live turn is never stalled behind a studio render; there is no preemption, so it
now says that priority reorders **waiters** only. `test/voice-frames.test.ts` still classified a
`{type:'voice',provider:'kokoro'}` payload — a frame this branch deleted — and now uses
`{type:'preset',presetId}`.

Tests: **+10 in the gate** (8 × `ensureCalibrated` against a fake row store, including the retry
proof, plus `withoutCalibrationFields`; 2 × the warning's reference gate) and +1 DB round-trip in
`voice-presets.db.test.ts`, which CI excludes by convention. Both
Important fixes were mutation-checked — recording a failed probe as calibrated, and dropping the
reference gate, each turn the new tests red.

## Gates

Measured fresh at HEAD for this handover, with the dev server stopped (running `pnpm build` beside
`pnpm dev` races the shared `.nuxt` directory and corrupts the dev server):

```
pnpm typecheck   → 0 errors
pnpm test        → 193 files, 1726 tests passed
pnpm build       → clean, Σ 65.1 MB (19.5 MB gzip)
```

1695 → 1713 across this task: +7 `playback-epoch`, +5 `breeze` mid-stream, plus the tests that
landed in the two commits after Task 11's report. Those commits carried it to **1716** (the 1713
above was measured one commit early); the final review fix wave below takes it 1716 → **1726**.

`server/api/voice/speak-overrides.db.test.ts` (4 tests, real Postgres) is excluded from the CI gate
by convention and passes via `pnpm test:db`.

## Status

**Built on `feat/breeze-tts` — not pushed, not merged into `master`, not deployed.** Migrations 0039
and 0040 have run only against local dev. No merge or deploy authorization was requested or granted.
