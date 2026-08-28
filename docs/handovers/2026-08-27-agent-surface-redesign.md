---
title: Agent surface — three-column rewrite, the voice pipeline, and Bridget's face (cycle 60)
cycle: 60
date: 2026-08-27
status: >
  BUILT, NOT MERGED. 16 of 18 tasks complete on `feat/agent-surface-redesign` (subagent-driven,
  per-task two-verdict review, 5 fix rounds). 23 build commits + this documentation commit.
  Two tasks are BLOCKED ON A HUMAN, not failed: Task 14's bake step needs a MakeHuman export that
  does not exist, and Task 17 (Orpheus) needs shell on the AI rig, which refused this session's key
  — so **Bridget currently renders her CSS fallback** and **the TTS model is unchanged**. Gates
  measured fresh at HEAD for this handover: **typecheck 0 errors / test 1445 passed (178 files) /
  build clean (exit 0)**, up from a 1364 baseline. Not pushed, not merged into `master`, not
  deployed; migration 0038 has run only against local dev.
branch: feat/agent-surface-redesign
spec: ../superpowers/specs/2026-08-27-agent-surface-redesign-design.md
plan: ../superpowers/plans/2026-08-27-agent-surface-redesign.md
docs:
  - ../wiki/agent.md (UI section fully rewritten; convergence table, conversation store, WS protocol and Deferred updated — mirrored to MyMind at /projects/mymind/wiki/agent.md)
  - ../wiki/voice-agent.md (new Speech-pipeline + mic-picker sections; the cycle-19 "Voice Visualizer" section rewritten as "Bridget's avatar"; frontend-files table rebuilt — mirrored to MyMind)
  - ../DEPLOYMENT.md (§12 — the `pnpm bake:head` rebuild gotcha and the committed-`.bin` rule; added to this task's scope mid-cycle, it was not in the plan's file list)
  - ../superpowers/plans/00-roadmap.md (cycle 60 row added)
  - ../BACKLOG.md (the six agent-page complaints struck; the two still-open items recorded)
tasks:
  - 31494f84-f556-4ea4-a9a2-ea2fb0f09cd9 (MyMind) — "Cycle 60 — Agent surface redesign" — STILL OPEN. This documentation task was explicitly instructed not to create or close MyMind tasks; task bookkeeping (closing this one, opening a follow-ups task for the items in "Deferred minors" below) is deliberately left to the controller.
shipped:
  - Voice pipeline — toSpeakable() sanitizer + a decimal/abbreviation-aware segmenter replacing SentenceChunker; sentenceMinChars 60→140
  - Three-column shell (threads / conversation / Bridget); the sub-1024px `hidden lg:flex` removed from the conversation panel; one toolbar instead of two duplicated copies
  - Chat — autoscroll with bottom pin and a "N new" release; multiline composer with Shift+Enter and a working Stop; per-message copy/retry/timestamp/token count; a real empty state
  - Conversations — a sidebar entry (the actual fix for "can't resume past conversations"), a permanent thread rail, the current thread's title in the toolbar, a delete confirmation
  - conversation_messages.usage jsonb (migration 0038) wired end to end, incl. includeUsage:true in resolve.ts
  - Microphone device picker persisted in the voice-settings cookie; a mic band with FFT bars AND a separate speech-probability track with the VAD threshold marked (the 96-bar ring is retired)
  - Avatar — the Avatar interface, a seeded event-scheduled choreographer, scripts/bake-head.ts, the ParticleHead renderer replacing Reactor.client.vue, and full-bleed voice mode with a markdown-rendered caption
deferred:
  - THE HEAD MESH (human step) — assets/source/bridget-head.glb does not exist; it must be generated in an official, unmodified MakeHuman build to keep the CC0 provenance. Until then /agent shows the CSS fallback.
  - ORPHEUS 3B (human step) — Task 17 never executed; needs shell on the AI rig at 192.168.2.25. Full serving recipe + landmines recorded below. App side is already pure configuration.
  - Per-row rename/delete context menu on the thread rail — a genuine gap in the plan (no task owned it); both actions live on /agent/history, which the sidebar now surfaces
  - VOICE_TUNING.tts.playbackRate 1.1→1.0 is INERT — see "A defect found while writing this handover"
  - 15 deferred minors + 2 unrecoverable Task-12 minors (full list below)
next_seam: >
  Two human steps unblock the remaining two workstreams and neither blocks the other: (1) export a
  head in an official MakeHuman build to assets/source/bridget-head.glb, run `pnpm bake:head`,
  commit app/assets/head-points.bin, then do a TUNING pass on exposure/density/proportions — the
  renderer is proven, but only against a scratch placeholder. (2) Stand Orpheus up on the rig per
  the recipe below, then swap it in at /settings (no code, no redeploy) and run the four-way
  comparison. Before any of that: decide whether to fix the inert playbackRate default. Merge and
  deploy authorization has not been requested or granted.
---

# Agent surface — three-column rewrite, the voice pipeline, and Bridget's face (cycle 60)

The `/agent` page was measured in a real browser on 2026-08-27, driving live turns. What the
measurement found is that the page's problems were not where they felt like they were: the
conversation was a 340 px sidebar that never scrolled (a reply rendered to `scrollHeight: 3338`
inside a `clientHeight: 879` box with `scrollTop: 0`), the page had **no chat at all** below
1024 px, history was complete but unreachable, and the voice complaints had three separate
deterministic causes with the model as the *last* of them.

This cycle rebuilt the surface as three columns, made the voice pipeline deterministic before
judging any model, gave the microphone a picker and a readout that answers "am I being heard",
and re-pointed the 50k-particle GPU core from a sphere at a head.

Current architecture lives in [`../wiki/agent.md`](../wiki/agent.md) and
[`../wiki/voice-agent.md`](../wiki/voice-agent.md); this document is how the cycle went, what was
decided on Tony's behalf, and what is still open.

## Read this first: the honest caveats

The controller's ledger (`.superpowers/sdd/2026-08-27-agent-surface-redesign/progress.md`) is the
authoritative record of the 17 build tasks; this is the 18th. These must not be quietly dropped.

1. **Bridget is not visible yet.** The head mesh is a human step (see below). Everything around it
   — the `Avatar` seam, the choreographer, the bake script, the renderer, the shader, the fallback,
   the tests — is built and green, and the renderer was validated in a browser against a
   **scratch-only placeholder buffer that was never committed** (`git ls-files` carries zero
   `.bin`/`.glb`/`.gltf`/`.obj`/`.fbx`). What that buys is a renderer proven against *geometry*, not
   against *her* proportions: expect a tuning pass on exposure, point density and framing once the
   real head lands. Exposure/density were left deliberately untuned, because tuning against a
   placeholder is tuning against a lie.
2. **The TTS model did not change.** Kokoro and Chatterbox still serve. The spec's ordering was
   deliberate — fix the pipeline, *then* judge a model — and the pipeline half shipped. The model
   half needs the rig.
3. **`playbackRate` 1.1 → 1.0 did not take effect.** See the dedicated section below; found while
   writing this handover, not by any task.
4. **One review gap was accepted, not closed.** Breaking `usage: turnUsage` at the `ws.ts` *call
   site* still leaves the test suite green. Closing it needs a crossws harness that exists for no
   part of `ws.ts` today; the seam *inside* `buildTurnPersistPayload` is red/green-verified, and
   Task 9's browser validation exercised the real path end to end. A future edit could silently stop
   feeding real usage into the payload and only a browser check would notice.
5. **The thread rail has no row context menu.** The spec asked for rename + delete on a rail row and
   the plan assigned it to no task. Deferred rather than grown into the largest task in the cycle;
   nothing is unreachable, since both live on `/agent/history`, which the sidebar now surfaces.
6. **The plan was wrong in three places, each caught by an implementer and each verified.** The
   autoscroll design (a `nextTick` watch) was genuinely broken and had to become a `ResizeObserver`;
   the plan asserted `runAgent` "already receives usage", which is true but it never *yielded* it;
   and the plan's shader snippet **inverted pitch for the third time in this project's history**.
   All three are documented below with the evidence that settled them.

## What shipped

### Voice pipeline — sanitize and segment before you blame the model

The chain was `deltas → SentenceChunker → synthesize`. It is now
`deltas → raw buffer → segment(raw) → toSpeakable(segment) → synthesize`.

**`server/lib/voice/speakable.ts`** — a pure, unit-tested markdown→speech normalizer. The prompt
*asks* the model not to emit markdown in speak mode; this **enforces** it, the same way cycle 37
stopped trusting the model with image URLs. Emphasis, headings, blockquotes, rules, bullets, links,
inline code, fenced blocks and tables are stripped or rewritten; dotted identifiers are expanded
(`192.168.2.25` → "one ninety two dot one sixty eight dot two dot twenty five", `v1.2` → "version
one point two"). Two fixes landed in review: IPv4 octets are spoken hundreds-digit-first (`192` →
"one ninety two", not "one hundred ninety two"), and the IPv4 rule is ordered *before* the version
rule, which otherwise mangled any 3+-part dotted number.

**`server/lib/voice/segment.ts`** — replaces `SentenceChunker`'s `/[^.!?]*[.!?]+(\s|$)/g`, which
split on **every** period, so `192.168.2.25` became four separate TTS calls with a seam and a network
round-trip between each. In an app whose agent talks about IPs, versions and dotted filenames
constantly, that regex *was* the "unnatural pause". `SpeechChunker` keeps the old `push`/`flush`
signature exactly, which is why the orchestrator's call sites were untouched.

The one genuinely hard case was the delta boundary. A period at end-of-buffer preceded by a digit is
ambiguous — `push('192.168.')` then `push('2.25…')` — so it is **held in the tail** rather than
judged, scoped to `next === undefined` only, with `flush()` catching a real final period. The first
implementation removed that guard as "dead and backwards"; review proved it reintroduced a
mid-number split at delta boundaries, and the re-review mutation-tested the restored guard and
confirmed `flush()` swallows nothing. The implementer also added fenced-code-block tracking that the
brief never asked for, and fixed the abbreviation walk-back so `e.g.` is collected as `e.g`.

**The invariant that matters:** `assistantText` — what is persisted and rendered by `<MdView>` —
stays **raw markdown**. `toSpeakable` output reaches only the synth. Verified end to end and
mutation-tested in both directions.

Tuning: `sentenceMinChars` **60 → 140**, breaking at the last clause boundary before the cap.

### Shell — three columns, and the sub-1024 px fix

`app/pages/agent/index.vue` is three `UDashboardPanel`s: `agent-threads` (resizable, ~14 %),
`agent-conversation` (resizable, ~58 %, `grow`), `agent-bridget` (fluid, clamped 240–420 px). Bridget
is the fluid one because Nuxt UI's resize handle only supports a sized panel to its **left**.

**The single highest-value line deleted this cycle** is the `hidden lg:flex` that sat on the
*conversation* panel: below 1024 px the composer measured `0×0` with `display: none`, i.e. the page
had no chat at all on a narrow laptop, tablet or phone. The implementer proved causality with a
**controlled probe** — checked out the old code (0×0), then the new (non-zero) — rather than
asserting it. Measured composer widths: 275×32 / 668×32 / 800×32 / 617×32 at 375 / 768 / 900 / 1440.

One `AgentToolbar.vue` replaces a navbar block that was duplicated **verbatim across two template
branches** of the old page. Gone from it: the `Visualizer` switch (and the `agent-canvas` cookie),
`History`, `New`, and the tiny `IDLE` debug state readout under the canvas.

Two shell findings came out of review with numbers attached:

- **`hidden sm:flex` on the wide controls is necessary, not cosmetic.** Without it, at 375 px the
  navbar is 430 px wide, the `h1` collapses to 0, and the full-screen + voice-settings buttons render
  **off-screen** — removing the only route to threads on a phone. Because hiding a *voice* agent's
  voice-replies toggle on a phone is unacceptable, the control was **mirrored into
  `VoiceSettingsSlideover`**, bound to the same `agent-speak` cookie ref (bidirectional sync
  re-verified with no drift).
- **A capped flex item freezes and leaves dead space.** Bridget's `max-width` left 196 px of dead
  space at 2560 and ~80 px at 1440 once the second handle was dragged left. The conversation panel
  now carries `grow` with a far smaller factor than hers, so she still takes the space first and the
  conversation only collects what her cap refuses. Confirmed 0 px gap at both widths.

Deviation, verified in the installed source: **`collapsible` is not a `UDashboardPanel` prop in
Nuxt UI 4.8.1** (same finding as cycle 59's), so it was dropped rather than left inert.

### Chat surface

- **Autoscroll.** Pinned to the bottom while streaming; scrolling up releases; a "↓ N new" chip
  re-pins. Reuses cycle 24's `isAtBottom`/`countNewSince`. **The plan's design was broken and the
  implementer proved it**: a `nextTick` watch measures a stale `scrollHeight` because MDC parses
  markdown asynchronously beyond a tick, so the pin falls behind mid-stream and *never recovers*
  (reviewer rebuilt the plan's version and reproduced `scrollTop 1717` / `scrollHeight 3102`,
  permanently behind). It is a `ResizeObserver` on the content wrapper instead. Two further
  deviations: a 100 ms `suppressScrollUntil` window against the browser's async scroll echo from our
  own `scrollTop` write, and a content-signature `hasNew`, because `countNewSince` can **never** fire
  for a no-tool-call reply (the text grows in the last entry in place; no new entry is pushed) — a
  real hole in the plan's design. Before/after: gap 2507 px → 0, pinned through streaming.
  *Disclosed honestly:* the suppression window covers ~76 % of wall-clock during heavy streaming; every
  real gesture registered first try, but the reviewer could not force a sub-100 ms swallow
  deterministically and said so rather than claiming it had.
- **Composer.** `UInput` → `UTextarea` (autogrow, 8 rows), Enter sends / Shift+Enter newlines,
  `isComposing` guards IME. **Stop** replaces Send while busy and sends the existing
  `{type:'interrupt'}` frame. Stop was verified two independent ways: client text plateaued for 5 s
  after the click across two runs (10 samples, 14625 → 14626 chars), and the *server* persistence gate
  never opened for the interrupted turn (zero messages persisted) while a control turn persisted both.
  The mic toggle moved here from the toolbar.
- **Messages.** Turn separation plus a hover row: copy, retry, timestamp, token count. Absent usage
  renders nothing, never a zero. **Retry** replaces in place (no fork); the walk-back/truncate logic
  was extracted to a tested `app/lib/agent/retry.ts` rather than inlined in the page.
- **Empty state.** Her name, what she can reach, four starters from the real tool surface. Mounted as
  a **sibling** of the ResizeObserver's content div so an empty transcript can't poison the
  observer's baseline. `?q=` verified to fire exactly once across four sequential starter clicks.

### Conversations — the reported bug was navigation

`app/layouts/default.vue` gained `Conversations → /agent/history`. **This is the actual fix for "no
ability to view past conversations."** The page was always complete — search, counts, relative dates,
delete, `?c=` deep-link resume — and simply had no entry in a sidebar listing fifteen destinations.
Reaching it meant opening `/agent`, finding "History" among seven navbar controls, opening a
slideover, and clicking "Browse all" at the bottom.

Also: a permanent thread rail (grouped Today / Yesterday / date, with search and New at its head),
the current thread's title in the toolbar, and a delete confirmation on `/agent/history` (Escape and
overlay dismissal both verified to clear the pending id). `HistorySlideover.vue` is deleted.

**A new WS frame was needed.** Nothing client-side could learn the id/title the server derives on a
new thread's first turn, so the toolbar read "Bridget" and no rail row highlighted until a reload.
`ws.ts` now sends a one-shot `{type:'conversation', conversationId, title}`; the new frame was
verified not to refire and not to leak a prior title.

### Token usage — built, and then actually made to work

`conversation_messages.usage jsonb` (nullable, additive; **migration `0038_bumpy_vance_astro.sql`** —
a single clean `ALTER TABLE`; the cycle-27 prod FK-drift hazard did **not** materialize).

The plan asserted `runAgent` "already receives usage." True — but it never **yielded** it: the
`fullStream` loop handled only text-delta and reasoning-delta and never read the AI SDK `finish`
part. Shipping that as planned would have given a permanently-NULL column and a token readout that
was dead code. Scope was extended to wire it end to end (`run.ts` → `orchestrator.ts` → `ws.ts`).

Then Task 9 found the second, larger half: **`resolve.ts` called `createOpenAICompatible()` without
`includeUsage: true`**, so the upstream never returned per-turn usage and the column would have
stayed NULL for every live turn regardless. Proved by hand-setting a DB row and watching the display
chain work correctly. The fix landed with the resolver's blast radius audited rather than assumed —
that resolver serves *every* AI usage, and a provider rejecting the added `stream_options` would have
broken all reasoning, not just a token count. Verified on **both** reasoning providers (self-hosted
vLLM and Claude-via-LiteLLM, forced through the model picker) with `activity_log` showing `attempt:0`
for each, explicitly ruling out the "failover masked a broken primary" pattern this repo has been
bitten by before. `createOpenAICompatible` appears exactly once; bulk/vision/embeddings/stt/tts/rerank
all use raw-fetch adapters and are untouched. Live result: a new message rendered 10.8k tok with the
DB row populated, no hand-editing; a re-nulled row renders nothing, not `0 tok`.

A review round also caught a **classic vacuous test**: the reviewer reverted the `ws.ts` wiring to
`usage: null` and all 1377 tests stayed green, because the test reimplemented the payload logic
locally instead of importing the shipped file. That is what produced `server/lib/voice/turn-persist.ts`.

### Microphone

A device picker in `SettingsSlideover.vue`, persisted as `micDeviceId` in the existing
`voice-settings` cookie; `useVoice` acquires the stream itself with a `deviceId: { exact: … }`
constraint. Device-list logic was extracted to a pure, tested `app/lib/voice/devices.ts`. The
`devicechange` listener re-enumerates; a vanished device resets to default proactively, and the
`OverconstrainedError` path resets + retries — while `NotAllowedError` is **rethrown**, not swallowed
into that fallback (confirmed).

The reka-ui empty-string `USelectMenu` value bug (which shipped once before, in cycle 45, past
typecheck, build *and* code review) was pinned by a **real click**: the cookie round-trips
`'' ↔ device id`, the popover reopens clean, 0 console errors. *Honest limit stated by the
implementer:* it cannot prove captured audio differs per physical device, because Chromium's fake
devices emit the same synthetic tone regardless of selection.

**The mic band** (`app/components/agent/MicBand.vue`) replaces the 96-bar ring, which was decorative
and could not tell you whether you were being picked up. It carries **two signals in different
units**, which is the correction to the brainstorm mockup: FFT amplitude bars, and a separate
speech-*probability* track with `positiveSpeechThreshold` marked — a threshold line drawn across
amplitude bars would have been meaningless. Verified live: threshold marker at exactly
`width × threshold` for 0.5 and 0.8; amber marker pixels confined to rows 46–54, never touching the
bars; the canvas bit-identical when disabled, proving "quiet" not "frozen".

One reviewer concern was resolved rather than deferred: `micAnalyser` is created **once** per
`connect()` and never reassigned by `enableMic`/`disableMic`/`applyVadSettings`/a device change
(new streams route into the same node), so a mid-session device switch does not silently freeze the
band. Proved live across a settings mic switch plus a disable/enable cycle; no code changed.

### Bridget

- **The seam.** `app/lib/avatar/types.ts` — `Avatar { setState, pushEvent, setAnalysers, resize,
  dispose }`. `ParticleHead` is the only implementation; a rigged mesh can replace it later without
  touching the orchestrator or `useVoice`. The cycle-19 boundary holds.
- **Choreography.** Pure, **seeded-RNG-injected**, entirely event-scheduled (nothing is a summed sine
  — the first sketch read as an obvious loop). Periodicity was proven from *sampled output series*,
  not from reading the code. The implementer found and fixed a real one-frame discontinuity the
  brief's tests never covered: `eyeGain` and `scan` were snapped rather than lerped on state exit, so
  `listening → idle` popped brightness and `tool → idle` cut the scan dead mid-sweep.
- **`typing` and `disconnected` got their own posture.** `VizState` has 8 values and `step()` handled
  6; `typing` fires on **every text turn**, so a neutral face there was a visible dead spot. Folded
  into the renderer task rather than raised as a follow-up, because the sibling `viz/choreographer.ts`
  handles every state explicitly via per-state tables — that is house style.
- **The bake.** `scripts/bake-head.ts` area-weighted-samples 50k points and writes 9 interleaved
  floats per point (`x,y,z,nx,ny,nz,jawW,eyeW,browW`). Area weighting was verified against a synthetic
  1-huge-vs-100-tiny-triangle mesh (density tracked **area** at 99.996 %; naive by-count would have
  been 99.88 %) and independently rebuilt by the reviewer with different geometry. A real NaN was
  found and fixed: `smoothstep`'s `(x-a)/(b-a)` divides by a zero-width band under degenerate metrics
  — exactly the symptom a flat or corrupt mesh would produce. Swept 1620 computations across 5
  degenerate metric sets: **244 NaN/out-of-range violations unguarded, 0 guarded.**
- **`jawW` is the fix for the cleave.** Measured trough row-density: 64.2 % idle / 56.7 % shipped
  smooth weight / **3.8 %** binary `>0.5` / **0.0 %** binary `>0.15`. The binary version *is* the
  cleave the brainstorm sketch exposed.
- **The pitch sign, settled structurally.** The brief's shader snippet inverted pitch — the **third**
  time this convention has bitten this project. `q.y*cp − q.z*sp` is a +X rotation carrying +Z toward
  −Y, which drops the nose. The reviewer refused to trust either the controller or the implementer and
  established ground truth from the format: **glTF 2.0 defines +Z as front** and `bake-head.ts` never
  reorients (it only divides by `maxX` and recentres Y), so the face is on +Z *by construction*, not by
  luck of one export. Shipped rotation: `d(centroid height)/d(pitch) = +0.70`; the brief's snippet
  gives −0.70. The flipped sign ships, and is pinned by a test.
- **Degradation is a first-class path.** No mesh / no WebGL / an unusable buffer → the CSS fallback,
  with exactly **one warning naming the missing file and the `pnpm bake:head` command**, never an
  error. `parseHeadBuffer` validates the 36-byte stride hard on purpose: a missing static asset does
  not reliably 404 here — the SPA catch-all can return a 200 with an HTML body.
- **Full-bleed voice mode** with a caption rendered through `<MdView>`. The old page interpolated
  `{{ caption.text }}` as plain text, so the most prominent text on the screen printed literal `#`
  and `**` — **the visible twin of the TTS-pronounces-asterisks bug**, fixed in the same cycle.
  Verified in the live DOM: real `<h2>`/`<ul>`/`<strong>`, `hasHash:false hasStars:false`. The caption
  is capped after a 375×700 check found an uncapped one pushing the mic band to y1344–1399 past a
  700 px viewport with no scroll path; capped, both stay on screen (y645–700).

## A defect found while writing this handover (reported, not fixed)

**`VOICE_TUNING.tts.playbackRate` has no reader, so the 1.1 → 1.0 change is inert.**

Task 3 changed `server/lib/voice/tuning.ts`'s `tts.playbackRate` from 1.1 to 1.0, the spec's stated
fix for "1.1 compresses whatever prosody the model produces", and the change reviewed clean. But
playback is driven **solely** by the client cookie: `useVoice.ts` reads
`settings.value.playbackRate`, and `VOICE_SETTINGS_DEFAULTS` in
`app/composables/useVoiceSettings.ts` is **still `1.1`**. `grep -rn "playbackRate" app server`
confirms `VOICE_TUNING.tts.playbackRate` is referenced nowhere outside its own declaration.

So **the audible playback rate did not change for anyone** — not for a new user with no cookie, not
for an existing one. Only `sentenceMinChars` in that `tts` object is actually consumed (by
`orchestrator.ts`); `provider` was already documented as legacy and unused for routing.

Not fixed here, per this task's constraint against changing application code. The one-line fix is
`VOICE_SETTINGS_DEFAULTS.playbackRate: 1.0`, and it should be settled before anyone judges Orpheus
against Kokoro — a rate change is exactly the kind of variable that would confound that comparison.

## Blocked on a human (1 of 2): the head mesh

`assets/source/bridget-head.glb` **does not exist**, and neither does `app/assets/head-points.bin`.

**Why it has to be Tony.** The mesh must be generated and exported from an **official, unmodified
MakeHuman build**. That is what makes the export **CC0** — public domain, commercial use,
redistribution, no attribution required. A community fork or a modified build does not carry that
guarantee, so the provenance is the whole point of the constraint, not a preference.

**Rejected mesh sources, recorded so a future session does not reach for them:** **FLAME** and the
**Basel Face Model** are both *research-licence only*.

**The steps, once the export exists:**

1. Save the export to `assets/source/bridget-head.glb` and commit it, so the bake can be re-run.
2. `pnpm bake:head` → writes `app/assets/head-points.bin`.
3. **Commit the `.bin`.** It is deliberately **not** in `.gitignore`: production builds from source
   and cannot run MakeHuman, so an uncommitted buffer means prod renders the CSS fallback forever.
   It is a committed build artifact, by design.
4. Rebuild and redeploy — see the deployment gotcha below.
5. Expect a **tuning** pass (exposure, point density, framing, `VIZ_TUNING.head` proportions), not a
   rebuild. The renderer is proven; it has never seen her.

## Blocked on a human (2 of 2): Orpheus on the rig

**Task 17 was never executed.** Standing Orpheus up requires shell on the AI rig at
`192.168.2.25`, which refused this session's key (`Permission denied (publickey,password)`). This is
an access limit, not a judgement call, and it blocks exactly one workstream.

**The app side is already done — it is pure configuration.** The model registry accepts any
OpenAI-spec `/v1/audio/speech` endpoint, so the swap is a `/settings` change: no code, no redeploy.
The risk is the serving stack, not the integration.

**The serving recipe:**

- `vllm serve` the **Llama-3B backbone** → **SNAC decoder** (7-token frames, sliding window) → a
  **FastAPI wrapper exposing OpenAI-compatible `/v1/audio/speech`**. Use `Lex-au/Orpheus-FastAPI` or
  `NoCodingAi/Orpheus-TTS-FastAPI-server`.
- 🚩 **Do NOT use the `orpheus-speech` PyPI package.** It returns **HTTP 200 with an empty body** —
  the internal SNAC post-processing never emits bytes into the response. Independently reproduced at
  100-concurrent on an A100. This presents as "TTS silently returns nothing" and will burn a day.
- 🚩 **Core vLLM does not serve TTS.** Text-to-speech lives in the separate **`vllm-omni`**
  subproject. Reaching for core vLLM's TTS support is a dead end.
- 🚩 **The rig's installed Chatterbox is the ORIGINAL 0.5B, not Turbo** — independently benchmarked
  at **4 s TTFB at concurrency 1**, a non-starter for live conversation. It is *not* a shortcut.
  Chatterbox **Turbo** (350M, MIT) specifically fixes this; serve it via `devnen/Chatterbox-TTS-Server`
  v2.0, which dodges the `PerthImplicitWatermarker is None` load bug. All Chatterbox output carries
  inaudible PerTh watermarking.
- **Expect ~200–400 ms first-audio on a 3090** (Canopy measured 280 ms on A100 / 180 ms on H100; a
  community single-3090 FP8 build is documented). If it exceeds ~500 ms, drop to the Orpheus
  1B/400M variant. Orpheus 3B fits one 3090 at ~8–9 GB FP8 or ~16 GB FP16, leaving three cards for
  the Qwen3.6 35B-A3B reasoning model.

**The comparison, once it serves.** One fixed paragraph containing an IP address, a version number,
a list and a question, through each, back to back: (1) Orpheus 3B, (2) Chatterbox Turbo, (3)
CosyVoice2/3-0.5B (the only candidate with true bidirectional streaming, ~150 ms first-packet),
(4) Kokoro at `playbackRate: 1.0` as the control and the registry failover afterwards. **Settle the
inert `playbackRate` default first** or the control is not a control.

**No single-turn voice mixing** — routing the pre-tool filler through Kokoro and the reply through
Orpheus is rejected: the prompt emits that filler *inside* a single reply, and `tara` and `af_heart`
are different speakers, so the turn would be two people talking.

**Rejected on licence** (recorded so nobody re-litigates): Fish Audio S2 Pro, Voxtral TTS, F5-TTS
weights (CC BY-NC), Breeze TTS 2, XTTS v2 (CPML, and Coqui is defunct so no commercial licence can be
bought). **Rejected as non-streaming or immature:** Step Audio EditX, Qwen3-TTS-1.7B, Sesame CSM-1B,
Maya1.

The chosen model and voice — the thing the spec asked this handover to record — **cannot be recorded
yet.** Tony's ears on the rig decide.

## Deployment gotchas (write these down or they will bite someone)

Both are now also in [`../DEPLOYMENT.md`](../DEPLOYMENT.md) §12.

1. **`pnpm bake:head` only takes effect in a *built* artifact after a rebuild.** The renderer resolves
   the buffer with `import.meta.glob`, which Vite resolves at **build time** — so dropping a new
   `.bin` next to a running production build changes nothing, silently. Confirmed: **Vite dev *does*
   pick up a new `.bin` without a restart**, which is exactly what makes this easy to miss. Bake →
   commit → rebuild → redeploy.
2. **`app/assets/head-points.bin` is deliberately NOT gitignored.** Production builds from source and
   cannot run MakeHuman. If the baked buffer is not in the tree, prod renders the CSS fallback
   forever. Cost of the decision, stated plainly: a ~1.8 MB binary in git history.

## Gate numbers (measured fresh for this handover, this run)

```
$ pnpm typecheck
✔ (0 errors)

$ pnpm test
 Test Files  178 passed (178)
      Tests  1445 passed (1445)

$ pnpm build
✨ exit 0 (clean; only the pre-existing @tailwindcss/vite sourcemap warnings)
```

Baseline at `94c4cf4` was **1364**; the cycle added **81** tests. `pnpm test:db` was not re-run for
this handover — no task in this cycle touched a DB-integration surface beyond migration 0038, whose
`test:db` count was verified unchanged at **176** when that migration landed.

## Browser validation performed during the cycle

Each of the spec's acceptance measurements was re-measured by the task that shipped it and again by
its reviewer, with `playwright-cli` (per the project rule, not the MCP):

- transcript `scrollTop` tracks `scrollHeight − clientHeight` while a long reply streams (gap 2507 → 0);
- the "↓ new" chip appears on scroll-up and re-pins on click;
- the composer is visible and usable at 375 / 768 / 900 / 1440 px (0×0 on the old code, proven by a
  controlled checkout);
- Conversations appears in the sidebar and resolves to the history page;
- a thread resumes from the rail with tool chips in the correct inline positions;
- **Stop halts a running turn** — client-side plateau *and* server-side non-persistence;
- delete prompts before destroying a conversation (plus Escape and overlay dismissal);
- the caption renders no raw `#` or `**`;
- the mic band's canvas animates, the threshold marker lands at `width × threshold`, and the canvas
  is bit-identical when the mic is off;
- the avatar degrades to a CSS fallback with 0 errors and exactly 1 warning naming the missing file;
- context-loss rebuild works, and 4 nav round-trips leave exactly 2 canvases (no leak).

**Live voice E2E on the rigs was NOT performed** — it belongs to Task 17, which never ran.

> Reusable gotcha found in review: forcing real transcript overflow in a browser test needs a
> **markdown ordered list**. Plain newline-separated text collapses into a single `<p>` that never
> overflows, so an autoscroll check against it proves nothing.

## Every ruling made on Tony's behalf

Twenty-one decisions were taken during planning and execution. They are recorded in full so any can
be overruled. (The controller's dispatch summarised these as "13"; the ledger carries 21 — six
pre-flight, fifteen during execution.)

### Pre-flight (from the conflict scan)

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| R1 | **No worktree** — execute on `feat/agent-surface-redesign` in the main working directory | The branch is already isolated; the dev server + `mymind-db` are wired to this directory; a worktree needs its own dev server on a spare port and blocks compound Bash | A concurrent session in this directory shares HEAD and could move the branch |
| R2 | **Task 6 wires the shell to the APIs that exist AT Task 6**; later tasks swap their own upgrades in | Every task must leave typecheck and build green; the plan's T6 template was written against the finished state | A little rework in T8/T9/T12/T15 |
| R3 | **Task 3 deletes `test/chunker.test.ts`**, not the `server/lib/voice/chunker.test.ts` the plan named (which does not exist) | Verified by grep — it was the only other importer of `SentenceChunker`; deleting only the named path leaves a broken import | None; coverage superseded by `segment.test.ts` |
| R4 | **Task 6 keeps `<VoiceSettingsSlideover :voice>` self-contained**; no `v-model:open`, no `@settings` | The component takes only `{ voice }` and renders its own cog trigger; an `open` model is scope the spec never asked for | The settings trigger sits in the toolbar rather than being page-controlled — cosmetic |
| R5 | **The mic toggle stays in the Toolbar from T6; T8 moves it into the composer and removes it from the Toolbar in the same task** | Otherwise there is no way to enable the microphone between T6 and T8 | One extra edit to `Toolbar.vue` |
| R6 | **Task 12's ring removal is scoped to the render path only** — delete `ring.ts` and its construct/update/dispose calls; `BAR_COUNT`, `ringLevels`, `ringColor`, `PALETTE.*.ring`, `VIZ_TUNING.ring` stay unless typecheck proves them dead | `choreographer.ts` is unit-tested against those fields and `effects.ts` uses `RING_RADIUS` to place tool-pulse rings, which the spec keeps | Some dead fields survive to the T15 rewrite, which is where they'd naturally be cleaned up |

### During execution

| # | Ruling | Why | Cost if wrong |
|---|---|---|---|
| 7 | **Task 4's scope extended** to wire usage end to end (`run.ts` → `orchestrator.ts` → `ws.ts`) rather than shipping a permanently-null column | The plan asserted `runAgent` "already receives usage" — true, but it never *yields* it. Controller's defect, not the implementer's; a null column makes Task 9's readout dead code | Task 4 grows past its brief's file list; larger review surface |
| 8 | **Accept the disclosed residual gap** — breaking `usage: turnUsage` at the `ws.ts` call site still leaves the suite green | Closing it needs a crossws harness that exists for no part of `ws.ts` today: a pre-existing structural gap, not one this task introduced. Task 9's browser validation exercises the real path | A future edit could silently stop feeding real usage; only a browser check would notice |
| 9 | **Carry three project rules into every remaining UI dispatch** (T6–T16): (a) installed Nuxt UI is **v4, not v3** as the plan says — invoke `nuxt-ui-docs` before using a component; (b) **semantic colour tokens only** (`text-muted`, `bg-elevated`, `color="primary"`) — the plan's `bg-black` must become a token; (c) every mutation `publishChange`s, reads use vue-query | The plan's code samples predate reading `.claude/rules` and would fail review on style grounds | None — these are the repo's own standing rules |
| 10 | **Defer the rail's per-row rename/delete context menu** (a spec item the plan assigned to no task) | The implementer caught a genuine plan gap. Deletion and search are already reachable on `/agent/history`, which the sidebar now surfaces; the cycle is already large | Managing a thread needs a second page visit instead of a right-click |
| 11 | **Keep `hidden sm:flex`, but relocate voice-replies into `VoiceSettingsSlideover`** driving the same `agent-speak` cookie | The reviewer verified the overflow independently: without it, at 375 px the navbar is 430 px wide, the `h1` collapses to 0 and Full-screen + Voice-settings render off-screen, removing the only route to threads on a phone. But a *voice* agent must not hide its voice toggle on a phone | One more control in the slideover than strictly needed |
| 12 | **Wiki updates consolidate in Task 18**, despite CLAUDE.md's same-change rule | Intermediate wiki states would document arrangements that exist for one or two tasks (e.g. `VoiceReactor`, replaced in T15) and would be wrong by cycle end; the branch does not merge before T18 | The wiki is stale *on the branch* mid-cycle — only matters if read off an unmerged branch |
| 13 | *(operational)* **Every subagent gets a unique scratch subdirectory** | The T6 implementer found its probe script overwritten mid-run by another agent sharing the session scratchpad, producing bogus measurements. It caught this and re-measured; a less careful agent would have reported the bogus numbers as evidence | None — strictly safer |
| 14 | **Task 9's scope extended** to land the `includeUsage: true` fix in `resolve.ts` | Without it the usage column, the WS frame, the persistence seam and the UI are all inert — a feature that is built, tested and permanently blank, which is worse than not building it | `resolve.ts` is a SHARED resolver serving every AI usage and both providers; a provider rejecting `stream_options` would break ALL reasoning. (Mitigated: both providers verified with `attempt:0`) |
| 15 | **Resolve** the reviewer's "cannot verify" analyser-lifecycle item rather than defer it | Task 11 had just added device switching, which tears down the stream and could create a new `AnalyserNode` — that would silently freeze the band while the visualizer beside it kept animating | Either a defensive change obscuring the real lifecycle, or a band that freezes after a device switch. (Resolved as **no-bug with evidence**; no code changed) |
| 16 | **Fold `typing`/`disconnected` handling into Task 15** (the renderer) rather than raising a follow-up | The sibling `viz/choreographer.ts` handles every `VizState` explicitly via per-state tables — house style — and `typing` fires on EVERY text turn, so the renderer author must decide what her face does while you type anyway | T15 grows slightly; the alternative is shipping a state that visibly does nothing |
| 17 | *(planned in advance)* **Build the renderer WITHOUT the mesh** rather than blocking Task 15 — it must handle a missing `.bin` gracefully (a real requirement anyway) and be validated against a placeholder generated in the agent's scratch directory and never committed | The renderer is real work that does not depend on which head the buffer describes; blocking would idle the last three tasks behind a human step | The renderer is proven against placeholder geometry, so proportions/tuning need a second pass — a tuning pass, not a rebuild |
| 18 | **Reaffirm ruling 12** (wiki consolidation) when a second reviewer flagged it, but require T18's dispatch to **name every stale item explicitly** | Reason unchanged and still sound; but the stale-docs list had grown long enough to be a real risk of omission | T18 misses one and a wiki page lies about a deleted file |
| 19 | **Add `DEPLOYMENT.md` to Task 18's scope** for the `bake:head` rebuild gotcha | `import.meta.glob` resolves at build time, so a baked buffer is invisible to a running built artifact. Vite dev *does* pick it up, which makes it an invisible deploy-only trap. T18 previously covered only wiki/roadmap/BACKLOG/handover | The gotcha goes unwritten and someone loses a day to "I baked it and nothing happened" |
| 20 | **`app/assets/head-points.bin` stays OUT of `.gitignore`** — committing it is intentional | Prod builds from source and cannot run MakeHuman, so the buffer must be in the tree or prod renders the fallback forever | A ~1.8 MB binary in git history |
| 21 | **Task 17 is BLOCKED ON TONY and cannot be executed** | The rig at `192.168.2.25` refuses this session's key, verified. Everything app-side is already configuration | None — an access limit, not a judgement call |

## Deferred minors

None block the shipped work. Carried from the ledger, ordered by task:

1. **T1** — `toSpeakable`'s `**`-specific regex is redundant with the `[*_]{1,3}` catch-all, so no test pins that line.
2. **T1** — a 4-part dotted number that is not a real IP (`1.2.3.4`) is still matched by the IPv4 rule (no 0–255 validation) and spoken as an address. Deliberate for this domain.
3. **T2** — a single giant delta far exceeding `minChars` in ONE `push` shows length pile-up; not covered by any test, not reachable with realistic small deltas.
4. **T2** *(process)* — the reviewer trusted the implementer's full-suite count rather than re-running it. Closed by this handover's fresh gates.
5. **T4** *(closed)* — `shared/types/conversation.ts` declared `usage?:` while sibling fields are required `| null`; folded into the fix round, not outstanding.
6. **T5** — an untitled conversation renders the delete-confirm text as a quoted lowercase "this conversation".
7. **T6** — `resume()`'s failure toast shows a raw `Server Error` `statusMessage` for a 404 rather than something actionable.
8. **T8** — no unit tests for `stop()`, `busy`, or the composer keydown handler, despite all three being unit-testable.
9. **T8** — IME composition (`e.isComposing`) is unverifiable in the headless browser: no CJK IME available.
10. **T10** *(no code defect)* — the task report cited the wrong path for the `exec` tool; it lives in `tools/exec.ts` wired via `profile.ts`, deliberately outside `agentTools`. The claim holds, the citation was wrong.
11. **T11** — **pre-existing, not introduced here**: `toggleMic` in `app/pages/agent/index.vue` sets `micOn = true` unconditionally after `enableMic()` even when it throws, so after a `NotAllowedError` the button reads "Disable microphone" while the alert reads "Permission denied". Two-line fix.
12. **T12** — the review logged **2 Minors** that neither the ledger nor the task report itemized. **They are not recoverable from the repo**; recorded here as a known gap in the record rather than silently dropped.
13. **T13** — flattening the syllable **envelope shape** fails no test: the 14 tests assert only gross jaw min/max and seed divergence. Inherited from the brief's tests. A real coverage gap if envelope shaping becomes load-bearing.
14. **T14** *(polish, not defects)* — three undisclosed non-logic improvements in the bake script, including silently fixing the brief's self-contradictory "8 floats / 9th float" header comment. Not itemized as deviations at the time.
15. **T15** — `createCore`'s sphere path is now unreached dead code, and `app/lib/viz` has zero test files. The reviewer recommends deletion; git history preserves it.
16. **T15** — `Avatar.client.vue` polls the analysers every 250 ms, so a mic enabled at a turn boundary can miss up to a quarter-second of drive.

Plus the two items promoted out of this list because they are more than minor: the **inert
`playbackRate`** default (above) and the **missing rail context menu** (ruling 10).

## Commits (23, oldest first)

```
5dd42eb feat(voice): add toSpeakable, a deterministic markdown-to-speech normalizer
bd66c5a fix(voice): handle IPv4 octets with leading zeros and prevent version regex from mangling 3+ part numbers
85ad85a feat(voice): add a decimal- and abbreviation-aware speech segmenter
e8f609a fix(voice): hold a digit-adjacent period at end of buffer instead of guessing
1a14d0b feat(voice): route TTS through the sanitizing segmenter, drop SentenceChunker
9a8edad feat(agent): persist per-message model usage for the transcript token readout
6c292f3 feat(agent): wire real per-turn token usage into the transcript readout
962576f fix(agent): extract the assistant-row persist payload so usage wiring is actually tested
15ed562 feat(agent): surface Conversations in the sidebar and confirm before deleting one
9615ebc feat(agent): three-column shell with a permanent thread rail and one toolbar
6890e44 fix(agent): identify a new thread live, and stop the capped Bridget column leaving a gap
5c5a962 feat(agent): pin the transcript to the bottom while streaming, with a new-message release
12bc5f5 feat(agent): multiline composer with shift-enter and a working stop button
26fbf92 feat(agent): turn separation plus copy, retry, timestamp and token count per message
827a5ea fix(ai): request stream usage from the reasoning chain so token counts populate
c78f22b feat(agent): a real empty state naming Bridget and what she can reach
00222d4 feat(voice): microphone device picker persisted with the other voice settings
5870213 feat(agent): mic band with FFT bars and a VAD probability track; retire the mic ring
dc6eb05 feat(avatar): Avatar interface plus a seeded, event-scheduled choreographer
9191738 feat(avatar): bake a MakeHuman head to a point buffer with smooth jaw weights
cdd0bd5 feat(avatar): give typing and disconnected their own posture
73b0bd6 feat(avatar): ParticleHead renderer with smooth-weight jaw and pivoted pitch
e74752a feat(agent): full-bleed voice mode with a properly rendered caption
```

## Deleted this cycle (so no doc claims they still exist)

`app/components/voice/Reactor.client.vue` · `app/components/agent/HistorySlideover.vue` ·
`app/lib/viz/ring.ts` · `server/lib/voice/chunker.ts` · `test/chunker.test.ts` · the `Visualizer`
toggle and its `agent-canvas` cookie · the `IDLE` debug state readout.

## Tracking docs reconciled

- [`../wiki/agent.md`](../wiki/agent.md) — the `UI` section rewritten end to end; the convergence
  table's `canvas` flag struck; `conversation_messages.usage` + migration 0038 added; the WS
  server→client frames extended with `usage` and `conversation`; the usage plumbing and the
  `turn-persist.ts` seam documented, including the accepted gap; `HistorySlideover` removed;
  token-cost struck from Deferred and the rail context menu added to it.
- [`../wiki/voice-agent.md`](../wiki/voice-agent.md) — new **Speech pipeline (cycle 60)** section;
  new **Microphone device picker** section; the Tuning block corrected (140 / 1.0) with the inert-
  constant warning; the WS server→client table extended; the **Frontend files** table rebuilt (it
  listed four files that no longer exist); the cycle-19 **Voice Visualizer** section rewritten as
  **Bridget's avatar (cycle 60)**; the VAD-asset caveat corrected (it described a CDN fetch the app
  stopped doing); the stale cycle-18 `runAgent` section marked superseded rather than left
  contradicting `agent.md`.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — §12 gained the two avatar deployment gotchas.
- [`../superpowers/plans/00-roadmap.md`](../superpowers/plans/00-roadmap.md) — cycle 60 row added.
- [`../BACKLOG.md`](../BACKLOG.md) — the agent-page complaints struck; the two human-blocked items
  and the inert `playbackRate` recorded as open.
- **MyMind mirrors** — both wiki pages are mirrored under `/projects/mymind/wiki/`, and the returned
  ids and hashes are written back into each file's frontmatter (`agent.md` →
  `b780bc2c-df0e-465f-acc0-ed83da00da0f`, `voice-agent.md` → `34c1de13-ab16-4662-a177-0f8ac99f478e`).
  **Verified rather than assumed:** the sha256 of each local file body matches the hash MyMind
  returned, so both mirrors are byte-identical to the repo. Two findings worth knowing: the **agent
  wiki page had never been mirrored in full** — only a cycle-45 partial-update note existed — and the
  voice-agent mirror was living at the old flat path `/projects/mymind/wiki-voice-agent.md`, so it was
  **updated in place and then moved** to the canonical `/projects/mymind/wiki/` path rather than
  duplicated. There is no stale second copy.

## What to check before merging

- The branch is **27 commits ahead of `master`** — 24 from this cycle's own base `94c4cf4` (23 build
  + this documentation commit), plus the 3 spec/plan commits (`213c601`, `69bc7da`, `94c4cf4`) that opened it —
  **not pushed, not merged, not deployed.** No merge/deploy authorization was requested or granted — that decision
  is Tony's, as in cycles 58 and 59.
- **Migration 0038** (`conversation_messages.usage jsonb`) has run only against local dev. It is a
  single additive nullable column with no backfill, so it is about as safe as a migration gets — but
  it has not run on production's corpus.
- **Bridget will render the CSS fallback in production** until the mesh exists and a rebuild has
  happened. That is deliberate and warns once in the console; it is not a broken deploy.
- Settle the **inert `playbackRate`** before running the TTS comparison.
- The MyMind task for this cycle (`31494f84`) is **still open**, and no follow-ups task has been
  created — deliberately, per this task's instructions.
