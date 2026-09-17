---
title: One owner for the reference clip, and waveform tracks in both studio panes (cycle 63)
cycle: 63
date: 2026-09-17
status: >
  SHIPPED AND DEPLOYED, BROWSER-VALIDATED AGAINST THE LIVE RIG. Two pieces, one deployment.
  (1) **The reference tuple has one owner.** Tony reported that uploading a clip, removing it,
  then locking on the description left a preset reading as `direction` with no way back. Root
  cause was a single seam, not three glitches: `ref_source` was written only by the lock/unlock
  routes while the clip fields were written only by Save, so a save could change WHETHER a preset
  has a clip without changing WHAT KIND it is — and nothing in the app had ever written 'upload'
  at all. Three broken shapes were reachable and all three had occurred. The four fields are now
  one tuple, lock/unlock resync it, and migration 0043 repairs the existing rows and makes the
  broken pair unconstructable. `bright-woman` in prod is repaired and calibrated.
  (2) **Waveform tracks + replay.** Levels over time and a duration on both the read-aloud render
  and the reference clip, a Play-again that costs no rig slot, and the first way to HEAR an
  attached clip at all. Gates at HEAD: typecheck 0 / test 1826 passed (196 files) / db-test 203
  passed / build clean.
branch: master
spec: none — two bounded changes, designed in chat and approved
plan: none
docs:
  - ../wiki/voice-studio.md (UPDATED — "The reference tuple has one owner" with the three broken shapes and the new CHECKs, the save-before-lock behaviour, a "The waveform, and playing a render again" section, the reference GET route, four new files; frontmatter bumped to cycle 63)
tasks:
  - 9f81e8c5 (MyMind) — cycle 62 follow-ups. Item 2 (re-lock bright-woman) is now MOOT: migration 0043 repaired it in place.
shipped:
  - ReferenceFields — the clip and its provenance written as one tuple, with three constructors
  - Migration 0043 — repair + `voice_presets_ref_source_pairs_with_clip` + `voice_presets_ref_source_known`
  - lock/unlock resync the draft; `lockState()` requires the clip, not the label
  - Lock saves a dirty draft first, closing the "clear it first — I just did" dead end
  - createPreset no longer drops `ref_source` and `starred_seeds`; Duplicate copies the source
  - `app/lib/voice/peaks.ts` — windowed-max envelope, resampling, normalisation, duration format
  - `VoiceWaveformTrack` on the read-aloud pane and the Reference tab
  - Play again — replays the last render from retained samples, no rig call
  - `useClipPlayer` + `GET /api/voice/presets/[id]/reference` — hear an attached clip
outstanding:
  - The retention cap and replay wiring are browser-validated but not unit-tested; the testable logic was deliberately pushed down into peaks.ts, which is.
  - Interim Gradio UI on rig port 7868 still competes for the single inference slot (task 9f81e8c5).
---

# One owner for the reference clip, and waveform tracks

## 1. The state bug

> *"uploading a reference, then trying to remove it, then lock it on a description instead... it
> gets caught up in state... more concerned with how it ended up in a weird state."*

### Root cause

**The reference clip had two owners that never reconciled.**

- The **draft** owned `refStorageKey` / `refText` / `refDurationMs` and wrote them on Save.
- The **lock/unlock routes** owned `ref_source` *and* those same three fields, server-side.
- `draftToBody` never sent `refSource`. **Nothing in the app had ever written `'upload'`** —
  migration 0042 backfilled it once and nothing maintained it.
- The draft only resyncs when the preset **id** changes (`DesignPane.vue`), and lock/unlock keep
  the same id.

Three broken shapes were reachable:

| Flow | Row afterwards | Symptom |
|---|---|---|
| Upload a clip, Save | clip, `ref_source` NULL | badge reads `direction`; spoken with the instruction re-applied over a reference that already contains it — the configuration measured at 39.8 Hz, worse than not locking at all |
| Clear a clip on a locked preset, Save | no clip, `ref_source` `'locked'` | `lockState()` tested the source first: a locked voice with nothing frozen, and Lock never came back |
| **Unlock, then Save** | the cleared clip written back with no source | the draft still held it |

The third is what produced the row Tony saw. Prod confirmed it: `bright-woman` carried the **lock
passage** as its `ref_text` — so the clip was a lock render — with `ref_source` NULL.

### Fix

`ReferenceFields` in `studio.ts`: four fields, three constructors (`attachedReference`,
`noReference`, `referenceFieldsOf`), and no member assigned on its own. Lock and unlock resync the
tuple from the row they just wrote. `lockState()` requires the clip rather than the label. The
`lock` computed reads the draft throughout instead of mixing the saved row's source with the
form's clip.

Then migration **0043**: repair first, constraints second. A lock render is identifiable by its
transcript, so the repair distinguishes the two kinds rather than guessing — and guessing
`'upload'` would have been the damaging direction. Rehearsed inside a transaction against copies
of all three broken shapes before it went near prod.

> **Two more instances of the same omission surfaced once the constraint was in.** Duplicate
> copied the clip without its source, and `createPreset`'s explicit allow-list dropped **both**
> `ref_source` and `starred_seeds` — it was never updated when 0041 and 0042 added the columns, so
> duplicating a voice had also been quietly losing its kept seeds. Neither would have been found
> without the constraint; both would have 500'd in prod.

### One more dead end, found only in the browser

Walking Tony's exact sequence with `playwright-cli` turned up the half the unit tests could not
see. Lock is a write to the **row**, but the pane offers it against the **draft** — so a clip
removed on screen and not yet saved made the server refuse with *"This voice already has a
reference clip. Clear it first"*, which is exactly what the user had just done. Lock now saves a
dirty draft first. It already committed the draft's voice settings, so this is the same write
rather than a new kind of one.

## 2. Waveforms and replay

`app/lib/voice/peaks.ts` holds everything that decides what a bar means; `VoiceWaveformTrack`
owns pixels only.

- **Max, never mean** — windowed max per 1024 samples (~43 ms), and the resample to bar count is
  max too. Averaging removes exactly the transients a waveform exists to show.
- **Built while the audio streams**, from arbitrarily-sized chunks. That is the kind of code that
  quietly depends on how the network split the body, so there is a test asserting the envelope is
  identical however it was chunked.
- **Near-silence stays silent.** The pane's other job is to show that *nothing came back*; a
  truncated render normalised to full scale would hide the failure it exists to reveal.

**Play again** keeps the decoded samples (capped at three minutes, ~17 MB). Past the cap the
envelope still draws and only the button is withdrawn — a partial render replayed as if it were
the whole one is worse than no button — and a cancelled render is never replayable for the same
reason. Progress rides the AudioContext clock, not a timer.

The Reference tab had **no way to hear a clip at all**. It now decodes the local file for an
unsaved upload and fetches a saved one from `GET /api/voice/presets/[id]/reference` — addressed by
preset, not by storage key, because keys are content hashes and a key-addressed route would serve
any blob in the bucket to anyone who could name one.

## Browser validation (live rig, dev on :3010)

| Step | Result |
|---|---|
| Drop a WAV on the Reference tab | waveform drew 16 distinct bar heights across 40 sampled columns; **3.0s** from the local decode, before Save |
| Lock button with an unsaved upload | correctly **disabled**, hint "already clones a clip you provided" — the draft-sourced fix |
| Play the reference clip | playhead advanced 63 → 124 columns in 1.2 s; button toggled to Stop |
| Save | row came back **`ref_source: 'upload'`** — the value nothing had ever written |
| Remove the clip | Lock re-enabled immediately with the right hint |
| Lock from a dirty draft | `ref_source: 'locked'`, 12 880 ms, cap 100, **calibrated**; rail badge reads `locked`; Save goes quiet because the draft resynced |
| Unlock | clean row, badge back to `design`, Save still quiet — **the corruption path closed** |
| Speak | 4.0 s track, TTFA 129 ms |
| Play again | playhead advanced, **speak-call counter still 1** — no rig call |

## Prod after deploy

```
 name           | src    | clip | dur_ms | cap | calib
 bright-woman   | locked | t    |  11920 | 200 | t      <- repaired by 0043
 funny-chinaman | locked | t    |  13200 | 100 | t
 warm-woman     | locked | t    |  16160 | 100 | t
```

## Lessons

- **Two writers for one concept is the bug, not the three symptoms it produces.** Fixing any one
  shape would have left the other two.
- **A constraint finds the callers you forgot.** Duplicate and `createPreset` were both silently
  wrong; adding the CHECK surfaced them within minutes.
- **An explicit allow-list is a maintenance obligation.** `createPreset` listed its columns and
  drifted two migrations behind without a single test noticing.
- **Walk the user's literal sequence in a browser.** The save-before-lock dead end was invisible
  to every unit test and to the code reading, because it only exists where the draft and the row
  disagree.
