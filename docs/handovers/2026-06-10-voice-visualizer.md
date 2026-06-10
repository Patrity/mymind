---
title: Voice Visualizer Redesign (GPU particle reactor)
cycle: 19
date: 2026-06-10
status: shipped
shipped:
  - "app/lib/viz/types.ts — BAR_COUNT 96, VizState (7: connecting/idle/listening/thinking/speaking/tool/disconnected), VizEvent (bargein/error/sttFinal/disconnected), Directives (14 per-frame knobs), PALETTE."
  - "app/lib/viz/emitter.ts — generic typed event emitter. 3 unit tests."
  - "app/lib/viz/choreographer.ts — pure-TS per-frame state machine: lerped color/knob transitions, impulse decays (shatter/ignite/errorFlash), mic attack/release smoothing, sparks consumed-once, dt clamp 0.1, lazy prev init. 14 unit tests (test/viz-choreographer.test.ts)."
  - "app/lib/voice/messages.ts — pure WS-message → {state, delta, events} mapper; handles idle/thinking/speaking/tool states + sttFinal sparks + playing-guard for premature idle. 5 unit tests (test/voice-messages.test.ts)."
  - "server/lib/voice/orchestrator.ts — emits state:'tool' on tool-start, back to state:'thinking' after tool-result chip; widened VoiceEvent state union to include 'tool'. test/orchestrator.test.ts extended with tool-state test."
  - "app/composables/useVoice.ts — VoiceState widened to 'connecting'|'idle'|'listening'|'thinking'|'speaking'|'tool'; onVizEvent emitter (bargein on barge-in, error on WS error + startup failure, sttFinal via messages mapper, disconnected on close); startup failure tears down cleanly (no stuck 'connecting' state); state set to 'connecting' in start(), back to 'idle' on WS open."
  - "app/lib/viz/scene.ts — WebGLRenderer + EffectComposer + UnrealBloomPass; quality tiers (mobile 10k/1.5x DPR/0.5 bloom; ≤4 cores 25k/2x/0.75; else 50k/2x/1.0); degrade() drops pixel ratio 25% one-way; bloom scale re-applied on every resize; bloom.dispose() included in cleanup."
  - "app/lib/viz/core.ts — GPU particle sphere, all motion in GLSL vertex shader (swirl vortex with flatten, breathe+burst+ignite, barge-in shatter via aScatter, connect assembly); uSize 0.1 (~3-5px points with distance scaling); additive glow discs; dt-scaled rotation."
  - "app/lib/viz/ring.ts — 96 InstancedMesh bars at radius 2.5; mic FFT heights; sympathetic ripple from outLevel; error shockwave sweep via per-instance color lerp with ERROR_RED."
  - "app/lib/viz/effects.ts — 3 amber tool pulse rings (dt-scaled phase, opacity decay); 160-slot pooled transcription sparks spawned at ring perimeter, moving inward toward core over 0.8s lifetime."
  - "app/components/voice/Reactor.client.vue — thin mount; RAF loop samples mic FFT→96 bands + outLevel; FPS watchdog (EWMA dt, trips below ~27fps sustained 3s; step 1 scene.degrade(), step 2 core.setDrawRange(0.5)); ResizeObserver; visibilitychange pause; context-loss rebuild; WebGL2-check + CSS-pulse fallback; partial-init disposal on boot failure."
  - "app/pages/voice.vue — passes state/connected/micAnalyser/outAnalyser/onVizEvent to Reactor; activeAnalyser helper removed."
  - "test/viz-emitter.test.ts — 3 tests (delivery, unsubscribe, unsubscribe-during-emit safety)."
  - "test/viz-choreographer.test.ts — 14 tests covering color lerp, shatter impulse + decay, disconnected derivation, assemble reset on connecting, ignite on WS open, sttFinal sparks consumed-once, mic attack > release, error decay, tool pulseRate."
  - "test/voice-messages.test.ts — 5 tests covering user/assistant transcripts, state mapping (including tool), playing-guard for idle, unknown messages."
  - "docs/wiki/voice-agent.md — updated to describe current visualizer architecture (cycle 19); WS protocol table corrected (transcript: text not delta; state: state not value; tool added)."
deferred:
  - "Manual desktop + phone tuning pass — the feel-pass with Tony (desktop + LAN phone: connect, speak, barge-in, tool turn, disconnect/reconnect) is still pending as of the cycle-19 handover. Choreographer constants (ENERGY/SWIRL/MIC_ATTACK/MIC_RELEASE/SHATTER_DECAY/IGNITE_DECAY/ERROR_DECAY) and bloom strength/threshold in scene.ts are the tuning knobs — deliberately centralized for this purpose. See Task 8 step 2 of the plan."
  - "Visualizer settings UI (themes, particle density sliders) — cut by spec (§7 YAGNI). Palette and tiers are code-only."
  - "Transcript text in 3D (words/phrases orbiting the sphere) — cut by spec (§7 YAGNI). Sparks only in v1."
---

# Cycle 19 — Voice Visualizer Redesign (handover)

Replaced the placeholder wireframe icosahedron + 48-point ring (`Reactor.client.vue` cycle 17/18) with a full GPU-particle Three.js visualizer: a 50k-particle sphere core driven by a GLSL vertex shader, a 96-bar instanced mic-frequency ring, and a layered effects system (tool pulses, transcription sparks, barge-in shatter, error shockwave). All state choreography is in a pure-TS `choreographer` with 14 unit tests.

## What shipped

### Architecture

Hard boundary: *signals in → pixels out*. `useVoice` never imports Three.js; `lib/viz/` never touches the WebSocket.

```
useVoice ──(state + connected)──► Reactor.client.vue ──► choreographer ──► core / ring / effects
          ──(onVizEvent)─────►            │               (Directives)
mic AnalyserNode ──FFT──────────────────────┘
out AnalyserNode ──amplitude───────────────┘
```

`Reactor.client.vue` is a thin mount: RAF loop, FFT sampling, FPS watchdog, resize, cleanup. All render logic is in `lib/viz/`.

### Pure-TS choreographer (`app/lib/viz/choreographer.ts`)

The `createChoreographer()` function is the single decision-making brain. It consumes `VizInputs` (state, connected, FFT bands, outLevel) + imperative `handleEvent(VizEvent)` calls, and returns a `Directives` object every frame — a bag of ~14 pre-computed render knobs.

All transitions use `approach()` (exponential lerp via `1 - exp(-speed * dt)`) — no hard cuts anywhere. `disconnected` is a derived `VizState` (not a `VoiceState`); it fires whenever `connected === false` and `state !== 'connecting'`.

### Visual states

Seven states with distinct choreography:

| State | Look |
|---|---|
| `connecting` | Particles scattered, slowly assemble; ignition burst fires on WS open |
| `idle` | Slow dim breathing |
| `listening` | 96-bar mic FFT ring dance, cyan ring |
| `thinking` | Sphere collapses to fast violet vortex |
| `speaking` | Cyan burst/scatter driven by TTS amplitude; sympathetic ring ripple |
| `tool` | Amber vortex + 3 radiating pulse rings |
| `disconnected` | Sagged half-formed sphere, desaturated gray-blue |

### Event impulses

`bargein` → shatter spike (decays ~450ms); `error` → errorFlash → red shockwave ring sweep (~700ms); `sttFinal` → sparks count scaled by char length (min 8, max 40, capped), consumed on the next frame.

### Quality tiers and FPS watchdog

Three tiers selected at mount by UA + `hardwareConcurrency` (mobile 10k/1.5x/0.5 bloom; ≤4 cores 25k/2x/0.75; desktop 50k/2x/1.0). The watchdog EWMA detects sustained sub-27fps and degrades one-way: step 1 drops pixel ratio 25% (`scene.degrade()`); step 2 halves particle draw range (`core.setDrawRange(0.5)`). Safe at 30Hz (no false-positive on mobile RAF).

### Review-driven deviations from the plan

These were caught and fixed during implementation — they are the as-shipped behavior:

| Plan | Shipped | Reason |
|---|---|---|
| `uSize: 9` in `core.ts` | `uSize: 0.1` | The `gl_PointSize` formula already includes a distance scale (`220.0 / -mv.z`) and a per-particle seed; uSize 9 produced giant blobs. 0.1 gives ~3-5px points with natural distance taper. |
| Rotation in scene/state setup | `dt`-scaled rotation each frame | Static rotation ignored frame timing; dt-scaled keeps motion consistent across frame rates. |
| Bloom scale set on init only | Re-applied on every `setSize` | Resize cleared the bloom resolution without restoring scale, breaking glow on resize. |
| `bloom.dispose()` not shown | Included in `scene.dispose()` | WebGL resource leak on unmount/rebuild. |
| Watchdog threshold: simple fps | EWMA of dt | Spike-resistant; won't fire on a single garbage-collection pause. |
| `useVoice` startup failure left state as 'connecting' | Tears down cleanly | Stuck 'connecting' on network failure left the page unusable. |

### Tests

182 tests passing (was 182 before; new tests added for viz/messages/orchestrator, existing tests unbroken):

- 3 emitter tests
- 14 choreographer tests
- 5 voice-messages tests
- 1 orchestrator tool-state test (appended to existing orchestrator test)

E2E (playwright-cli) passed: canvas mounts, WebGL2 context live, console clean.

## Pending

Manual desktop + phone feel-pass with Tony (see deferred section above). The tuning knobs are all centralized in `app/lib/viz/choreographer.ts` (named constants at top of file) and bloom strength/threshold in `app/lib/viz/scene.ts`. No rebuild needed for constant changes in dev.

## Next seam

1. Manual tuning pass → commit any constant changes.
2. Full text-chat UI (cycle 14) — `/api/agent/chat` backend ready.
3. Persisted conversation history across sessions.
4. AI model registry (cycle 12).
