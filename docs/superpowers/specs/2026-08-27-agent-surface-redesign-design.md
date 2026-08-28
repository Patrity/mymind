---
title: Agent surface — three-column rewrite, the voice pipeline, and Bridget's face
cycle: 60
date: 2026-08-27
mymind_id: f1d110e7-f2d2-4397-beb1-e48e136f2172
mymind_hash: 69c2ae3081489cb62d9a25dc2264c7d62b9e0f49b779d1f383a96a681a02d2b5
status: spec — approved in brainstorm, not yet planned
related:
  - ../../wiki/agent.md (the surface this rewrites — convergence principle, conversation store, tool history)
  - ../../wiki/voice-agent.md (the self-hosted STT/TTS pipeline + the visualizer this replaces)
  - ../specs/2026-06-09-voice-visualizer-redesign-design.md (cycle 19 — the GPU particle core being re-pointed)
  - ../specs/2026-06-17-agent-surface-chat-design.md (cycle 28 — the /voice + /agent merge)
  - ../specs/2026-06-16-sessions-ux-sse-design.md (cycle 24 — the autoscroll/live-tail pattern to reuse)
  - ../../wiki/ai-providers.md (the model registry the TTS bake-off swaps through)
closes:
  - "Agent-page UX complaints raised 2026-08-27 (chat UX, no history/resume, TTS speaks markdown, TTS cadence, voice quality, the 3D should be a face)"
  - "Task 3201e7a4 — /agent renders blank in dev (superseded: the page renders; the dev DB was down)"
---

# Agent surface — three-column rewrite, the voice pipeline, and Bridget's face (cycle 60)

## Why

The `/agent` page was measured in a real browser on 2026-08-27, driving live turns through the
running agent. What it found is that the page's problems are not where they felt like they were.

**The conversation is a sidebar that never scrolls.** At 1600 px the canvas panel takes 1030 px and
the transcript gets 340. A 12-point checklist rendered to `scrollHeight: 3338` inside a
`clientHeight: 879` box with `scrollTop: 0` — 2,459 px of reply streamed in below the fold and the
view never moved. There is no scroll handling in `Transcript.vue`, `useVoice.ts`, or the page.
`/sessions` solved exactly this in cycle 24; the agent never got it.

**Below 1024 px the page has no chat at all.** The transcript panel carries `hidden lg:flex`
(`app/pages/agent/index.vue:207`). On a 900 px window the composer measures 0×0 with
`display: none`. The mic needs a secure context, so on a narrow laptop, tablet or phone the page is
a particle sphere with no way to talk to it.

**History exists and is unreachable.** `/agent/history` is complete — search, message counts,
relative dates, delete, and `?c=` deep-link resume all work. The sidebar lists fifteen destinations
and this is not one of them (`app/layouts/default.vue:64`). Reaching it means opening `/agent`,
finding "History" among seven navbar controls, opening a slideover, and clicking "Browse all" at the
bottom. The reported symptom was "no ability to view past conversations"; the defect is navigation.

**The voice complaints have three separate deterministic causes, and the model is the last of them.**
Nothing sanitizes model output before it reaches TTS — the prompt asks for no markdown when `speak`
is on and nothing enforces it, so an asterisk gets pronounced. The same defect is visible in the
text UI: the caption over the canvas interpolates `{{ caption.text }}` as plain text while the
transcript beside it renders the same string through `<MdView>`, so the most prominent text on the
page displays raw `#` and `**`. Separately, `SentenceChunker`'s split regex is
`/[^.!?]*[.!?]+(\s|$)/g`, which fragments `192.168.2.25`, `Qwen 3.6` and `v1.2` into several
synth calls each, with a seam and a round-trip between them — in an app whose agent talks about
exactly those strings. Only after those two is the model itself a factor: Kokoro-82M is the smallest
serious TTS in use, with flat prosody and no intonation continuity across independently-synthesized
chunks. And `playbackRate: 1.1` compresses whatever prosody it does produce.

**The visualizer is a beautiful void.** The particle sphere fills about a third of its 1030 px panel;
the rest is black. It is 50k GPU particles, a tested pure-TS choreographer, quality tiers and an FPS
watchdog — spent on a ball.

## What this builds

A three-column agent surface where the conversation is the page, threads are a permanent rail,
and Bridget is a persistent presence with a face rather than a sphere. Underneath: a sanitizer and a
segmenter that make the voice pipeline deterministic before any model is judged, a microphone picker,
and a mic readout that answers "am I being heard".

### Decisions locked in the brainstorm

| Decision | Choice | Why |
|---|---|---|
| Layout | Three columns: threads / conversation / Bridget | User picked "thread corner" but rejected a small avatar — she is "a core part of the personality of the app". A column carries that; a 62 px chip does not. |
| Column widths | ~200 / fluid ~830 / 320 at 1600 px | Conversation gains 2.4×. What it reclaims is the void, not her. |
| Avatar tech | Reshape the **existing** GPU particle core | Same shaders, same choreographer, same quality tiers. The reference image is a point-cloud head; the pipeline is already the right one. |
| Head mesh | Generated in **MakeHuman**, exported CC0 | Exports from an official build are public domain — commercial use, redistribution, no attribution. Full control of her look, unambiguous licence. |
| Rejected mesh sources | FLAME, Basel Face Model | Both research-licence only. Recorded so a future session does not reach for them. |
| Lip-sync | Amplitude-driven jaw, **not** visemes | Neither Kokoro nor Chatterbox returns phoneme timings. Real visemes need a forced-aligner pass per chunk. Gets the rhythm right, not the shapes. |
| Mic readout | Baseline band at the foot of her column | Replaces the 96-bar ring, which the user dislikes and which cannot tell you whether you are being picked up. |
| TTS | Stay self-hosted. Replace Kokoro with **Orpheus 3B**, **after** the pipeline is fixed | Kokoro is non-autoregressive and structurally incapable of emotion or paralinguistics — no setting fixes it. Judging a new synth on mangled input proves nothing, so ordering matters. |
| Scope | One cycle, five workstreams | User's explicit call. Quick fixes roll into the rewrite rather than landing ahead of it. |

## Layout and shell

`app/pages/agent/index.vue` is rewritten. Three `UDashboardPanel`s:

| Panel | Sizing | Contents |
|---|---|---|
| `agent-threads` | sized, resizable, collapsible; default ~13% | Conversation list, grouped by day, searchable |
| `agent-conversation` | sized, resizable; carries the second handle | Transcript + composer |
| `agent-bridget` | fluid, CSS `min-width`/`max-width` clamped | Avatar + mic band |

**Why Bridget is the fluid panel.** Nuxt UI's resize handle only supports a sized panel to its
*left* (recorded in `wiki/voice-agent.md` — it is why the canvas, not the transcript, carried
`resizable` in the old layout). With three panels the second handle sits between the conversation
and Bridget, so the conversation must be the sized one. Resizing the conversation therefore resizes
her column implicitly, and a `max-width` on her content stops her ballooning on an ultrawide.

**Responsive.** `hidden lg:flex` comes off the conversation panel — this is the fix for the page
being unusable below 1024 px. Under `lg` both side panels collapse: threads become a slideover
reached from the toolbar, Bridget is reached through the voice toggle (full-bleed). The conversation
and composer take the full width. This must be verified at 375 / 768 / 900 / 1440 px.

**One toolbar, one copy.** The current navbar block is duplicated verbatim across two template
branches (lines 160–200 and 218–258) — two copies of one toolbar that will drift. The rewrite has a
single `AgentToolbar.vue`: conversation title, voice toggle, model selector, settings. The
`Visualizer` switch, the `History` button and the `New` button leave the toolbar — the visualizer is
now a column, history is now a rail, and New belongs at the top of that rail.

**Delete the debug readout.** The `IDLE` state enum rendered in tiny caps at the bottom of the canvas
goes. State is carried by her face.

## Chat surface

### Autoscroll

The single highest-impact fix on the page. `app/utils/transcript-scroll.ts` already exports the
helpers cycle 24 built for `SessionTranscript.vue`; reuse them rather than writing a second
implementation.

Behaviour: the transcript is pinned to the bottom while streaming. Scrolling up releases the pin.
A "↓ N new" chip appears while released and re-pins on click. `isAtBottom` uses a viewport-sized
threshold, as it does on `/sessions`.

### Composer

`app/components/voice/Composer.vue` keeps its attachment handling (paste, drag-drop, file picker,
the 4-file/20 MB caps, the allowed-MIME logic) — that part is sound. Changes:

- `UInput` → `UTextarea` with autogrow, capped at ~8 rows.
- Enter sends, Shift+Enter inserts a newline.
- A **Stop** button replaces Send while a turn is running, sending the existing `{type:'interrupt'}`
  WS frame. The frame already exists and is handled; its only caller today is the VAD barge-in path
  (`useVoice.ts:280`).

### Messages

`Transcript.vue` gets a real treatment: turn separation, a role avatar, and a hover affordance row
carrying copy, retry, timestamp and token count. Assistant replies keep rendering through `<MdView>`
with the per-entry `cache-key` — **this is load-bearing** and must not be touched (cycle 41: streamed
replies sharing a first delta collide on MDC's hash-of-value key and mirror each other's content).

Inline tool chips keep their current position semantics, live and on resume, including the
`textOffset` reconstruction in `app/lib/agent/transcript.ts`.

**Token count needs a column.** `conversation_messages` has no usage field. Migration adds
`usage jsonb` (nullable, additive). `runAgent` already receives usage from `streamText`; the WS
`emit` closure — the same seam that collects `tool_calls` and `reasoning` — persists it on the
assistant row. If usage is absent the affordance row omits the count rather than showing a zero.

**Retry** re-sends the preceding user turn through `sendText` and replaces the assistant turn in
place. It does not fork — `parent_id` branching stays deferred, as it has since cycle 28.

### Empty state

A fresh thread currently shows the word "Transcript" over a blank column. It gets: her name, one line
on what she can reach, and three or four starter prompts drawn from the real tool surface (search the
brain, research something, check open tasks, run a command). Not decorative — the page today gives no
indication that 20 tools, skills and subagents sit behind it.

## Conversations

- **Sidebar entry.** `app/layouts/default.vue` gains `{ label: 'Conversations', icon: 'i-lucide-messages-square', to: '/agent/history' }`. This is the actual fix for the reported complaint.
- **Thread rail.** The `HistorySlideover` content becomes the permanent left rail, grouped by day (Today / Yesterday / date), with the existing search from `/agent/history` and a New button at its head. `/agent/history` survives as the full browse view.
- **Current thread title** renders in the toolbar. Today nothing indicates which conversation you are in, or that you are in a resumed one.
- **Delete confirms.** `history.vue:169` hard-deletes a conversation and all its messages on one click of a hover-revealed trash icon. It gets the same confirm dialog every other destructive path in this app uses. The rail gets delete and rename on a row context menu.

## Voice pipeline

### Ordering: sanitize, then segment, then synthesize

The current chain is `deltas → SentenceChunker → synthesize`. The new chain is
`deltas → raw buffer → segment(raw) → toSpeakable(segment) → synthesize`.

**Segmentation happens on the raw buffer, sanitization on each completed segment.** This ordering is
deliberate and the reverse does not work: markdown markers span deltas (`**`, `bold`, `**` can arrive
as three), so sanitizing per-delta sees half-markers, and sanitizing the accumulated buffer then
segmenting it means mapping sanitized offsets back to raw to know what to retain. Segmenting first
and sanitizing complete segments avoids both problems — a partial marker simply stays in the retained
tail until it completes, and `flush()` sanitizes whatever is left at end of stream.

**Sanitization must not leak into the transcript.** `assistantText` — what is persisted to
`conversation_messages.content` and rendered by `<MdView>` — stays raw markdown. `toSpeakable` output
is consumed only by the synth. This is the same separation the display/model split already makes for
`reasoning`.

### `server/lib/voice/speakable.ts` — `toSpeakable(text): string`

Pure, no I/O, unit tested. Strips or rewrites:

- emphasis (`**`, `__`, `*`, `_`), headings (`#`), blockquotes, horizontal rules
- list bullets and numbering — a leading `- ` becomes nothing, an ordered item keeps its number
- links `[label](url)` → `label`; bare URLs → a short spoken form or dropped
- inline code and fenced code blocks → dropped or replaced with a brief spoken marker; a fenced block
  is never read aloud
- tables → dropped
- dotted identifiers and numbers expanded rather than spelled: `192.168.2.25` →
  "one ninety two dot one sixty eight dot two dot twenty five"; `/agent` → "the agent page"; `v1.2`
  → "version one point two"

The cycle-37 precedent is explicit here: the model is not asked to behave, the choke point enforces
it. The `speak`-mode prompt guidance stays as a hint but is no longer the mechanism.

### `server/lib/voice/segment.ts` — replaces `SentenceChunker`'s regex

Pure, unit tested. Splits on `.!?` **except** when the period is:

- between digits (`3.5`, `192.168.2.25`, `v1.2`)
- part of a known abbreviation (`Dr.`, `e.g.`, `i.e.`, `etc.`, `vs.`, `approx.`, `St.`)
- inside a dotted identifier with word characters on both sides and no following space
- a file extension, or part of an ellipsis

Newlines are hard boundaries. The `minChars` fallback rises from 60 to ~140, and when it fires it
breaks at the last clause boundary (`,` `;` `—` `:`) before the cap rather than mid-word, falling back
to the last space. Where the TTS provider supports it, a short tail of the previous segment is passed
as context so intonation carries across the seam.

### Tuning

`VOICE_TUNING.tts.playbackRate` 1.1 → 1.0. It is already user-tunable through `useVoiceSettings`;
only the default changes.

### Model replacement

**Kokoro cannot be tuned into expressiveness — the model has to change.** Kokoro-82M is a
non-autoregressive StyleTTS 2 + ISTFTNet model with 54 fixed voices, no emotion control and no
cloning. Paralinguistics (laughs, sighs, inline emotion) require an autoregressive speech-LLM that
emits audio tokens. No setting closes that gap. The pipeline fixes above make the input clean; they
cannot make this model expressive.

**Target: Orpheus 3B (Canopy Labs, Apache 2.0 / Llama-3.2 base).** Eight fixed voices, emotion tags
(`<laugh>`, `<sigh>`, `<chuckle>`, `<gasp>`…), token-by-token streaming, commercial-safe licence.
4.22 MOS against Sesame CSM's 4.10 with a 53.2%/34.0% A/B preference (ASTRA study, arXiv 2606.18319)
— the strongest conversational-quality evidence for an openly-licensed model. Fits one 3090 at
~8–9 GB FP8 or ~16 GB FP16, leaving three cards for the Qwen3.6 35B-A3B reasoning model.

**Rig prerequisite (a human step, like the mesh).** Orpheus must be stood up on the rig before this
workstream can be validated:

- `vllm serve` the Llama-3B backbone → **SNAC decoder** (7-token frames, sliding window) → a FastAPI
  wrapper exposing OpenAI-compatible `/v1/audio/speech`. Use `Lex-au/Orpheus-FastAPI` or
  `NoCodingAi/Orpheus-TTS-FastAPI-server`.
- **Do NOT use the `orpheus-speech` PyPI package.** It returns HTTP 200 with an empty body — the
  internal SNAC post-processing never emits bytes into the response. Independently reproduced at
  100-concurrent on an A100. This would present as "TTS silently returns nothing" and burn a day.
- **Core vLLM does not serve TTS.** Text-to-speech lives in the separate `vllm-omni` subproject.
- Expect ~200–400 ms first-audio on a 3090 (Canopy measured 280 ms on A100 / 180 ms on H100;
  a community single-3090 FP8 build is documented). If it exceeds ~500 ms, drop to the Orpheus
  1B/400M variant.

**Comparison, once Orpheus is up.** One fixed paragraph containing an IP address, a version number,
a list and a question, synthesized through each and listened to back-to-back:

1. **Orpheus 3B** — the expected winner.
2. **Chatterbox Turbo** (350M, MIT) — the fallback if Orpheus latency disappoints. Note the rig
   currently runs the **original** Chatterbox, which independent 100-concurrent benchmarking found
   at **4 s TTFB at concurrency 1** — a non-starter for live conversation, and the reason the
   installed copy is not a shortcut. Turbo specifically fixes this. Serve via
   `devnen/Chatterbox-TTS-Server` v2.0 (dodges the `PerthImplicitWatermarker is None` load bug).
   All Chatterbox output carries inaudible PerTh watermarking.
3. **CosyVoice2/3-0.5B** (Apache 2.0) — the only candidate with true *bidirectional* streaming
   (text in, audio out) at ~150 ms first-packet. Worth a look if turn-taking still feels slow after
   Orpheus.
4. **Kokoro at `playbackRate: 1.0`** — the control, and the registry failover afterwards.

**Rejected on licence** (recorded so a future session does not reach for them): Fish Audio S2 Pro
(Fish Audio Research License), Voxtral TTS and F5-TTS weights (CC BY-NC), Breeze TTS 2 (research),
XTTS v2 (CPML, and Coqui is defunct so no commercial licence can be bought). **Rejected as
non-streaming or immature for live use:** Step Audio EditX (a clip editor, <30 s), Qwen3-TTS-1.7B
(~33 s per request, no streaming decoder), Sesame CSM-1B, Maya1 (inconsistent emotion tags, spoken
tag names, ~1.8× real-time even on an A100).

**No single-turn voice mixing.** A tempting optimisation — route the pre-tool filler ("let me
check…") through Kokoro at 40 ms and the substantive reply through Orpheus — is rejected. The prompt
emits that filler *inside* a single reply, and Orpheus's `tara` and Kokoro's `af_heart` are different
speakers, so the turn would be two people talking. Kokoro stays as the chain failover only, where a
voice change during a real outage is acceptable.

Every swap is a `/settings` change through the model registry; no app code and no redeploy. Published
comparisons for these models are largely vendor-run or single-source (the only rigorous 3090-specific
first-audio figures come from one benchmark vendor), and the Speech Arena leaderboard measures
single-utterance naturalness, which disadvantages dialogue models. Treat the shortlist as directional.
Tony's ears on the rig decide, and the chosen model and voice are recorded in the handover.

## Microphone

### Device picker

`useVoice.ts:264` already calls `getUserMedia` with explicit constraints, so the change is small:

- `navigator.mediaDevices.enumerateDevices()` filtered to `audioinput`, surfaced in
  `SettingsSlideover.vue` beside the voice picker.
- The selected `deviceId` persists in the `voice-settings` cookie alongside the existing settings.
- We acquire the stream ourselves with the `deviceId` constraint and hand it to `MicVAD.new`, which
  also keeps the analyser wiring explicit.
- **Device labels are empty until microphone permission has been granted at least once** — a browser
  privacy rule, not a bug. Before first grant the picker shows positional names ("Microphone 1"); it
  re-enumerates and shows real labels after. A `devicechange` listener refreshes the list when
  hardware is plugged or unplugged, and a vanished selected device falls back to default with a toast.

### Mic band

A new `app/components/agent/MicBand.vue`, fed by the existing `micAnalyser` (`fftSize: 256`, so 128
bins — ample for ~56 log-spaced bars). It sits at the foot of Bridget's column and along the bottom
edge in full-bleed. The 96-bar ring in `app/lib/viz/ring.ts` is retired.

**One correction to what the brainstorm mockup implied.** The mockup drew a single "VAD threshold"
line across the spectrum bars. That is not honest: the bars are FFT amplitude, while the VAD triggers
on Silero's per-frame speech *probability* — different units, and a threshold line on the amplitude
bars would be meaningless. The band therefore carries **two** signals:

- the FFT bars, showing what is coming in;
- a thin probability track along the bottom edge with `positiveSpeechThreshold` marked, driven by the
  `speechProb` ref `useVoice` already maintains via `onFrameProcessed` — the same unit the settings
  slideover's sensitivity meter already uses.

Bars go accent-coloured when the VAD reports speech. Together they answer "am I being heard", which
is the job the ring could not do.

## Bridget

### The `Avatar` seam

A small interface so the renderer can be replaced without touching the orchestrator or `useVoice`:

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

`ParticleHead` is the only implementation this cycle. The existing `app/lib/viz/*` modules become its
internals. The hard boundary cycle 19 established holds: `useVoice` never imports Three.js, and the
avatar never touches the WebSocket.

This seam is also the cut line. The avatar is the workstream with an external dependency and the most
unknowns; if the cycle runs long, this is what gets deferred, and the interface is what makes that
cheap.

### Mesh → point buffer

A build-time script, not a runtime loader:

1. Tony generates a female head in MakeHuman (official build) and exports it. The export is CC0.
2. `scripts/bake-head.ts` reads it, area-weighted-samples 50k points across the surface, computes
   per-point region weights (below), and writes a packed `Float32Array` to
   `app/assets/head-points.bin`.
3. At runtime the binary is fetched and uploaded straight into the existing `BufferGeometry`.

The browser never loads a mesh, a GLTF loader, or three.js's loader chain — just the buffer. 50k
matches the existing desktop tier, and the existing `setDrawRange` degrade path covers the 25k and
10k tiers unchanged, as does the FPS watchdog.

### Baked per-point attributes

Computed once at bake time in head-local space, uploaded as vertex attributes:

| Attribute | Purpose |
|---|---|
| `jawW` | vertical ramp × hinge falloff (formula below) |
| `eyeW` | eye region — brightens on listening/thinking, dims on blink |
| `browW` | brow region — lifts on stressed syllables |

```
jawW = smoothstep(lipY, chinY, y) ** 0.6
     * (1 - 0.6 * smoothstep(hingeInner, hingeOuter, abs(x)))
```

**`jawW` is the fix for the defect the brainstorm sketch exposed.** The first pass used a binary jaw
region and translated it as a block, which visibly cleaved the head at the lip line. A smooth weight
that is zero at the upper lip, ramps to full at the chin, and falls off toward the hinge makes the
chin arc, the lower lip trail it at roughly a quarter of the travel, and the upper lip and cheeks not
move at all.

### Pose

Jaw displacement and pose rotation happen in the vertex shader, driven by uniforms from the
choreographer — consistent with cycle 19, where all core motion is already GLSL.

**Pitch rotates about a pivot behind and below the face**, near the base of the skull, not about the
mesh origin. The brainstorm sketch needed an ellipsoid depth approximation because a 2D point cloud
has no z; the real mesh has genuine depth, so this is free — but the pivot still matters. Rotating
about the mesh origin translates the face up the screen instead of rotating it. Positive pitch is
looking **up** (the first sketch had this sign inverted, which is how "thinking" ended up looking at
the floor).

### Choreography

`app/lib/avatar/choreography.ts`, pure TS in the style of the existing tested `choreographer.ts`.
It takes `(state, dt, rng)` and returns pose and brightness directives. **The RNG is injected**, so
tests seed it and assert deterministic sequences while production gets real randomness.

Everything is event-scheduled. Nothing is a periodic function — the first sketch used summed sines
throughout and read as an obvious loop.

| State | Behaviour |
|---|---|
| `connecting` | Points arrive from all directions, staggered, converging into the head. One ignition per session — the intro Tony asked for, on the existing `connecting` state. |
| `idle` | Breathing drift, micro-saccades at random intervals, blinks at irregular intervals. |
| `listening` | Turns ~15° toward the viewer and holds. Nods at random intervals with random depth; roughly a third are double-nods. Eye points brighten. |
| `thinking` | Chin lifts ~15°. Gaze **saccades** — jumps to a random target and holds for a random interval, which is how eyes actually behave when thinking. Not a smooth sweep. |
| `speaking` | Faces the viewer. Jaw driven by a syllable-and-phrase envelope from the TTS output analyser: randomised peak and duration per syllable, grouped into phrases with pauses between them. Brows lift on stressed syllables; small head shift at phrase boundaries. |
| `tool` | Amber scan sweeps down the face. Existing pulse rings, repositioned. |
| `error` | The face fractures outward and re-forms — the existing shatter impulse, now with something to shatter. |

### Two presentations

- **Column** (default): her column, ~320 px, with the mic band at her feet.
- **Full-bleed**: the voice toggle or clicking her drops the chat furniture — her, the band, and the
  current line as a caption. Escape returns. This caption renders through `<MdView>` or a plain-text
  sanitized form; it must never interpolate raw model text the way the current one does.

## Testing

**Unit (vitest).** `toSpeakable` — emphasis, headings, bullets, links, inline and fenced code,
tables, IPs, versions, paths. `segment` — decimals, IPs, abbreviations, dotted identifiers, file
extensions, ellipses, newline boundaries, the clause-aware fallback. `choreography` with a seeded
RNG — state transitions, nod and saccade scheduling, syllable envelope shape, and that pitch is
positive for `thinking`. Bake-script region weights — `jawW` is 0 above the upper lip, monotonic to
the chin, and reduced at the hinge.

**Browser (`playwright-cli`, per the project rule — not the MCP).** Every claim in the Why section
has a measurement, and each one is re-measured as the acceptance test:

- transcript `scrollTop` tracks `scrollHeight − clientHeight` while a long reply streams;
- the "↓ new" chip appears on scroll-up and re-pins on click;
- the composer is visible and usable at 375 / 768 / 900 / 1440 px;
- Conversations appears in the sidebar and resolves to the history page;
- a thread resumes from the rail with tool chips in the correct inline positions;
- Stop halts a running turn;
- delete prompts before destroying a conversation;
- the caption renders no raw `#` or `**`.

**Live voice E2E on the rigs.** A spoken turn containing an IP address and a markdown-heavy reply,
listened to: no pronounced asterisks, no mid-clause seam at the 60-character mark, no fragmentation
on the IP.

## Migration and rollout

One additive migration: `conversation_messages.usage jsonb` (nullable). No backfill — messages
without usage omit the count.

`app/assets/head-points.bin` is a committed build artifact. The MakeHuman source export is committed
alongside it under `assets/source/` so the bake can be re-run, with its CC0 provenance recorded in the
handover.

## Out of scope

- **Real viseme lip-sync.** Needs phoneme timings no current provider returns.
- **A rigged mesh implementation** of `Avatar`. The interface exists so this is cheap later; it is not
  built now.
- **Conversation branching.** `parent_id` remains linear, as since cycle 28.
- **Semantic conversation search.** `summary_embedding` stays reserved; keyword search continues.
- **Hosted TTS.** Explicitly ruled out — self-hosted only.
- **Storing voice audio.** Transcript text only, unchanged.

## Risks

**The cycle is large.** A layout rewrite, a pipeline rewrite, a new rendering mode and two new
features in one cycle. Raised in the brainstorm and confirmed as the user's call. The mitigation is
the `Avatar` interface: the avatar workstream is the one with an external dependency and the most
unknowns, and it is the designated cut line.

**Two human steps gate two workstreams.** The bake script cannot run until a MakeHuman export exists,
and the voice comparison cannot run until Orpheus is serving on the rig. Both are outside the app and
outside the plan's control, and both block exactly one workstream each — the rest of the cycle is
independent of them. The app side of the TTS change is *already* config: the registry means any
OpenAI-compatible `/v1/audio/speech` endpoint drops in without code. The risk is the serving stack,
not the integration, and the `orpheus-speech` package failure mode (HTTP 200, empty body) is the
specific trap to avoid.

**Nuxt UI's resize handle constraint** (sized panel must sit left of the handle) shapes the three
column layout. If resizing the conversation to size Bridget feels wrong in the browser, the fallback
is a custom handle — decide in the browser, not in the plan.

**A markdown sanitizer can over-strip.** Anything it drops is silently unspoken. The unit tests carry
real assistant replies from the conversation store as fixtures, and the transcript keeps raw markdown
so nothing is lost from the record — only from the audio.

**`<MdView>`'s per-entry `cache-key` is load-bearing.** Cycle 41 traced three distinct replies all
rendering as the first one to a shared MDC parse-cache key. The transcript rewrite must preserve the
stable per-entry id keying both the `v-for` and the cache key.
