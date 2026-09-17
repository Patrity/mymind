---
title: Voice studio UX pass, an un-wedged rig, and locking a designed voice (cycle 62 + follow-on)
cycle: 62
date: 2026-09-16
status: >
  SHIPPED AND DEPLOYED. Three pieces of work landed on `master` after cycle 61 merged, all
  verified in production. (1) **Cycle 62 — the studio UX pass**: the design pane became two
  tabs, Speak now renders what is on screen rather than the last-saved row, seeds can be
  kept, and studio renders are planned as one call by default instead of always being
  chopped per sentence. (2) **The rig no longer wedges**: MyMind's AbortController pattern
  was killing Breeze mid-stream and leaving it stuck; renders are now drained rather than
  aborted, 409 is treated as transient, and requests are serialized. (3) **Locked voices** —
  the fix for "every segment sounds like a different person". The root cause was measured,
  not guessed: Breeze holds NO speaker state between calls, so a design preset re-casts the
  voice on every segment. Three attempts to anchor it with the model's own output within a
  turn failed and were REVERTED; freezing a preset to a render of itself and speaking it as
  a pure clone is what works, and Tony confirmed it by ear. Gates at HEAD: typecheck 0
  errors / test 1801 passed / build clean. Migrations 0041 and 0042 have run in prod.
branch: master (cycle 62 merged as d19e703; follow-on commits direct)
spec: none — cycle 62 was a bounded UX pass, the lock work a bounded follow-on
plan: none
docs:
  - ../wiki/voice-studio.md (UPDATED — the two tabs, starred_seeds and ref_source columns, a new "Locking a designed voice" section with the measurements, a new "Quality vs realtime" section with the prompt-ceiling table, the lock/unlock endpoints; frontmatter bumped to cycle 62)
  - ../wiki/voice-agent.md (UPDATED — a new "Use a LOCKED preset for conversation" section explaining why a design preset drifts across a turn and what actually fixes it; frontmatter bumped to cycle 62)
tasks:
  - 535eb32d (MyMind) — record dropped TTS segments in the activity log. STILL DEFERRED.
  - 43541d16 (MyMind) — `pnpm typecheck` does not cover `test/`. STILL DEFERRED.
  - 9b26ae79 (MyMind) — multi-speaker dialogue composition. STILL DEFERRED.
shipped:
  - Tabbed design pane (Voice / Reference), always two tabs on every preset
  - Speak and audition render live form state; no save-first gate
  - Starred seeds (migration 0041) — keep a seed you liked instead of re-rolling for it
  - Quality vs realtime segmentation (`server/lib/voice/plan-segments.ts`) — one call by default
  - Playback fixed — an AudioContext created after an `await` is born suspended under Chrome's autoplay policy
  - Never abort a Breeze render mid-stream; drain it. 409 is transient, not fatal. Warmup is respected.
  - Locked voices (migration 0042, `ref_source`) — freeze a designed voice to a render of itself
  - `POST /api/voice/presets/[id]/lock` and `/unlock`
outstanding:
  - The interim Gradio UI still serves on rig port 7868 and competes for the single inference slot. Retiring it is a homelab change, not a MyMind one.
  - A locked preset still drifts more than a real recording (22.6 Hz vs 4.5 Hz). Uploading a clip remains the better answer when a specific person's voice is the goal.
  - Locking is a ~12 s live render; on a busy rig the backoff can push the round trip past the edge proxy's patience and surface as a 503 the endpoint never sent.
---

# Voice studio UX pass, an un-wedged rig, and locking a designed voice

Three bounded pieces of work after cycle 61. The first two are ordinary; the third is the one
worth reading, because it is a case where the measurements repeatedly contradicted the obvious
explanation.

## 1. Cycle 62 — the studio UX pass

Tony's feedback after living with the studio for a day:

- **Tabs.** The middle pane held the description *and* the reference clip in one scroll. It is
  now `UTabs` — Voice / Reference — and deliberately **always two tabs**, not tabs-when-a-clip-
  exists: a pane that grows a tab only in one mode makes the clip read as an advanced feature
  rather than the other half of the editor.
- **Speak uses live state.** Previously Speak rendered the saved row, so getting a voice right
  meant save-listen-adjust-save. Every tunable now rides along as a `SpeakOverrides` object
  merged in memory for that one request, so the button renders what is on screen and nothing is
  written. The allow-list is the point: `maxSegmentChars` and the reference fields are
  structurally unreachable, so an override cannot claim a prompt budget the preset was never
  measured for.
- **Starred seeds** (migration 0041). A seed is a name for a voice you liked. Without somewhere
  to put it, finding one again meant re-rolling until it came back.
- **Playback "only worked sometimes."** Not a race and not a decoding bug: an `AudioContext`
  constructed *after* an `await` is created without a user gesture on its stack, and Chrome's
  autoplay policy starts it suspended. Sticky activation is what made it intermittent — it
  worked whenever a previous gesture was still counting. The gate is now created synchronously
  on the click and resumed explicitly (`createAudioGate`).
- **Quality vs realtime.** Tony asked whether the studio was optimized for streaming or quality
  and whether it could be a toggle. It could, and the difference is measurable: three segments
  produced **10.3% more audio for the same words** than one call — about half a second of
  padding at each seam, where prosody restarts — and bought 22 ms of time-to-first-audio, which
  is invisible because Breeze streams within a call anyway. Quality is now the default; realtime
  exists to hear the agent's seams.

> **The bug the unit tests could not see.** The first quality implementation reused the agent's
> `segment()`, which flushes per sentence — so "quality" mode split 1479 characters into **20**
> segments, the exact opposite of its purpose. Every unit test passed, because "more than one
> segment, each under the cap" is true of 20 segments. Browser validation caught it. It is now a
> greedy sentence packer (`splitToCap`).

## 2. The rig stopped wedging

A homelab-side report identified MyMind as the client wedging the Breeze server, with four
required changes. All four landed in `b8b0cab`:

| Required | What changed |
|---|---|
| Never abort a request mid-stream | The `signal` was removed from the rig fetch entirely. A cancelled render is **drained** in the background (`drainRest()`), and the queue slot is held until the `drained` promise settles. |
| Serialize all requests | The single-slot priority queue already did this in-process; the drain fix is what made it true in practice, since an aborted request used to free the slot while the rig was still working. |
| Treat 409 as transient | `dialWithBusyRetry` — five attempts, linear 1.5 s × attempt. |
| Respect warmup | `waitForBreeze` / `breezeHealth` poll before dialing rather than firing into a cold rig. |

The report also said explicitly: *do not "fix" this by adding request timeouts that abort*. That
is why the abort path was deleted rather than tuned.

> An earlier plan defect belongs here too, because it is the same class of mistake: the plan had
> the queue slot released from h3's `cancel()` callback. An implementer probed the installed h3
> and found `sendStream`'s `pipeTo` branch swallows the failed write, so `cancel()` never fires —
> the slot would have leaked on **every** client disconnect. It is now `res.on('close')`.

## 3. Locked voices — the part worth reading

Tony: *"every audio segment sounds like a completely different person... From both voice clone
configs and text configs."* Then, after the first fix shipped and changed nothing: *"even the
voices that we create in the voice page, then save the seed, prompt, cfg, etc... its like im
talking to 10 different women."*

### What is actually true

**Breeze holds no speaker state between calls.** Established by measurement, not inference:

- Same seed + same text → the same voice exactly (263.7 Hz twice). The seed is honoured.
- Same seed + *different* text → a different speaker. The seed does not pin identity.

A spoken turn is many segments of different text, each its own call. So a design preset re-casts
the voice on every segment, and a long reply genuinely does sound like several people. This is
what voice design *is*; no amount of pinning seed, cfg or prompt changes it.

### Three failed attempts, and one admission

The obvious fix is to anchor the turn with the model's own output — render segment 1, then feed
it back as the reference for segment 2, and so on. Built it, shipped it (`a172709`), Tony
reported no improvement, **reverted it** (`4ae0098`).

It was built on a measurement that was wrong. My autocorrelation pitch tracker reported a 142 Hz
spread between segments; 102.6 Hz is almost exactly half of 205 Hz, an **octave error**. The
end-to-end path showed only 23.9 Hz. I shipped a fix for a number that did not exist.

Worse, when Tony proposed freezing a render and reusing it, I dismissed it — using a test that
was confounded. My "freeze" test had used a 5.8 s clip in *direction* mode (instruction still
applied) and measured 39.8 Hz, while the real-reference comparison used a ~10 s clip as a *pure
clone*. Retested fairly, at ~11 s and as a pure clone, it measured 22.6 Hz / 0.526 — better than
design mode on both axes. **Tony's idea was right and my dismissal was wrong.**

### What shipped

| Setup | Pitch spread | Timbre distance |
|---|---|---|
| Design preset, unlocked | 23.9 Hz | 0.636 |
| **Locked render, pure clone** | **22.6 Hz** | **0.526** |
| A real recorded clip | 4.5 Hz | 0.418 |

`POST /api/voice/presets/[id]/lock` renders one canonical ~11 s passage (`LOCK_PASSAGE`) and
keeps the **audio**. The preset becomes reference-backed, and every later utterance — studio or
agent — clones that exact render instead of casting again.

Two decisions inside that are not obvious:

- **A locked preset is spoken as a PURE clone** — instruction dropped, `cfg_scale` forced to 1.
  The description is already expressed in the clip, and re-applying it pulls against the
  reference: the same clip with the instruction re-applied measured **39.8 Hz**, worse than not
  locking at all. An *uploaded* clip keeps its instruction, because steering delivery is the
  whole reason someone writes one against a voice they already chose. `ref_source` (migration
  0042) is what distinguishes the two, backfilled to `'upload'` for existing rows.
- **Unlock only ever clears a clip this app rendered.** A recording Tony supplied is his, and
  there is no undo here.

A real recording still anchors best by a wide margin. Locking is the answer when the voice only
ever existed as a description; uploading is still the answer when a specific person's voice is
the goal.

## The 503 when locking

Tony hit `503` locking a voice. Diagnosed rather than guessed at:

- The rig was healthy (`busy: false`, `watchdog_releases: 0`).
- The preset was **not** modified, so it failed before any DB write.
- Reproducing the exact lock sequence against the rig from inside LXC 114, bypassing the reverse
  proxy: **HTTP 200 in 12.7 s.** The endpoint is sound.

So the 503 is a busy rig: ~13 s of work plus up to ~22 s of backoff is ~35 s, long enough for the
edge proxy to give up. The message now says so in words instead of being a bare 503. Contributing
factor: the interim **Gradio UI is still running on rig port 7868**, competing for the single
inference slot.

That reproduction also exposed a real bug. `lock.post.ts` hand-rolled its calibration instead of
going through `ensureCalibrated`, so it only wrote `max_segment_chars` when the measured cap
*differed* from the existing one, and never wrote `calibrated_ref_key` at all — leaving a locked
row reading "never measured" and re-probing on every later save. This is **exactly** the defect
cycle 61's final review fixed on the upload path; a second copy of the logic found the same hole.
Fixed in `8f1db6a`.

> `bright-woman` in prod is currently locked **by that reproduction**, with an 11 920 ms
> reference. It works, but its row was written by the buggy code path, so its `calibrated_ref_key`
> is null. Unlock and re-lock it to get a properly calibrated row.

## Files worth knowing

| File | Why |
|---|---|
| `server/lib/voice/breeze.ts` | The only module that knows Breeze's wire format. Pre-flight validation for the two conditions that arrive as opaque 500s, the drain path, health/warmup. |
| `server/lib/voice/speak.ts` | Composes queue + Breeze + preset. `presetToRequest` is where `ref_source === 'locked'` becomes a pure clone. |
| `server/lib/voice/plan-segments.ts` | Quality vs realtime, and the prompt ceiling with its measurements. |
| `server/api/voice/presets/[id]/lock.post.ts` | `LOCK_PASSAGE` and the freeze. |
| `app/lib/voice/audio-context.ts` | `createAudioGate` (the autoplay fix) and `isRunawayRender`. |
| `app/lib/voice/studio.ts` | `lockState` / `lockHint`, `describeRenderPlan`, `toggleStarredSeed`, `draftIsDirty`. |

## Lessons

- **Confront the data before shipping the fix.** The chained-reference work was built on an
  octave error and cost a deploy, a user test, and a revert.
- **A confounded comparison is worse than no comparison.** It let me dismiss the correct idea
  with a number.
- **A ratio threshold is the wrong shape for a runaway detector.** 1200 chars landed at 2.92×
  expected, under a 3× threshold. Chars-per-second with a minimum length is the right test.
- **"More than one segment, each under the cap" is true of 20 segments.** Assert the property you
  actually want.
- **Duplicated logic duplicates its bugs.** The lock route re-implemented calibration and
  reproduced a defect that had already been found and fixed once.
