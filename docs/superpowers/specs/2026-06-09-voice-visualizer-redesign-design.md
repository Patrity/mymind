# Voice Visualizer Redesign — Design Spec

**Date:** 2026-06-09
**Status:** approved design, pre-plan
**Replaces:** the v1 reactor (`app/components/voice/Reactor.client.vue` — wireframe icosahedron + 48-point ring)

## 1. Goal

Replace the placeholder voice reactor with an impressive, fully reactive Three.js visualizer:
a **GPU particle sphere** representing the agent's voice, surrounded by a **mic frequency ring**
reacting to the user's input, with rich state choreography and event-driven moments (barge-in,
errors, transcription, connection lifecycle). Validated interactively with the user via live
mockups (concept locked: particle core + frequency ring).

## 2. Approach (chosen: custom GLSL scene + small event bus)

Hand-built Three.js scene — no new dependencies beyond the already-installed `three`:

- Particle core as a custom `ShaderMaterial`: per-particle motion (swirl, burst, shatter,
  assemble) computed in the vertex shader from uniforms, so 50k particles are cheap.
- Instanced mic-ring bars fed by real FFT data.
- `EffectComposer` + `UnrealBloomPass` for real glow.
- Adaptive quality for desktop + phone.

Rejected: TresJS (dependency stack, awkward for custom shader passes); preset/audio-viz libraries
(generic, can't do state choreography or custom moments).

## 3. Architecture

New directory `app/lib/viz/` — hard boundary: *signals in → pixels out*.

| Unit | Purpose |
|---|---|
| `types.ts` | `VizState`, `VizEvent`, `Directives` (the full set of per-frame knobs) |
| `choreographer.ts` | **Pure TS, no Three.js import.** State machine consuming voice state, events, and two amplitude/FFT samplers; outputs per-frame `Directives` (core energy, swirl, shatter impulse, palette target, ring band levels, pulse/spark triggers). All transitions lerped here — no hard cuts. Unit-testable without WebGL. |
| `scene.ts` | Renderer, camera, composer + bloom, resize, quality manager, dispose |
| `core.ts` | GPU particle sphere (custom `ShaderMaterial`; attributes: base position, seed; uniforms: time, energy, swirl, shatter, assemble, color) |
| `ring.ts` | 96 instanced frequency bars fed mic FFT bands |
| `effects.ts` | Tool pulse rings, error shockwave, transcription sparks (small pooled CPU particles) |

`Reactor.client.vue` becomes a thin mount: create scene + choreographer, wire props, dispose on
unmount.

### useVoice changes (only change outside `lib/viz/`)

- `VoiceState` adds `'connecting'` and `'tool'`.
  - `connecting` set while the WS dials; cleared on open.
  - `tool` driven by a server tool signal over the voice WS. If the orchestrator does not yet
    emit one, add a one-line emit server-side (confirm exact seam during planning).
- New tiny event emitter on the composable: `bargein` (fired in the existing barge-in branch in
  `onSpeechStart`), `error`, `sttFinal` (final user transcript landed), `disconnected`.
- `micAnalyser` / `outAnalyser` accessors stay as-is.

Data flow: `useVoice` state + events → **choreographer** → directives → **scene** (core / ring /
effects consume them). The visualizer never touches the WebSocket; `useVoice` never imports
Three.js.

## 4. Choreography

Seven visual states, all reached by lerped transitions (300–600 ms). The first six map 1:1 to
`VoiceState`; `disconnected` is a `VizState` the choreographer derives from `connected === false`
(it is not added to `VoiceState`):

| State | Core (agent sphere) | Ring (mic bars) | Color |
|---|---|---|---|
| `connecting` | Particles assemble from scattered cloud into the sphere; soft "ignition" swell on WS open | Flat, dim | Dim blue → blue |
| `idle` | Slow breathing, dim, lazy rotation | Near-flat shimmer | Blue |
| `listening` | Calm, slightly brighter | Full FFT dance with the user's mic | Cyan ring, blue core |
| `thinking` | Collapses into fast swirling vortex | Quiet | Violet |
| `speaking` | Erupts/scatters with TTS amplitude (per-particle GPU burst) | Faint sympathetic ripple | Bright cyan |
| `tool` | Vortex at lower energy | Quiet | Amber + radiating pulse rings |
| disconnected | Sphere sags and dims, slow irregular flicker until reconnect | Off | Desaturated gray-blue |

Event moments are **impulses layered on the active state** (they decay; they are not states):

- **Barge-in:** shatter impulse — particles fly outward with velocity + drag, then re-form as the
  state snaps to `listening`. The re-formation is the acknowledgment.
- **Error flash:** red shockwave around the ring + brief red tint pulse through the core (~700 ms),
  then palette lerps back.
- **Transcription sparks:** on `sttFinal`, spark particles stream from the ring inward to the core.
  Scales subtly with transcript length, capped.

Amplitude sources: mic `AnalyserNode` FFT → ring bands + listening energy; output `AnalyserNode` →
speaking burst energy. Both smoothed in the choreographer (fast attack, slow release).

## 5. Performance & resilience

- **Device tiers** (decided at mount): desktop ≈ 50k particles, pixel-ratio cap 2, full-res bloom;
  phone ≈ 8–12k particles, cap 1.5, half-res bloom. Tier from mobile UA + `hardwareConcurrency`.
- **FPS watchdog:** if average FPS < ~45 for a few seconds, step down — bloom resolution first,
  then particle draw range. One-way steps per session (no oscillation).
- RAF pauses when the tab is hidden. Full geometry/material/composer dispose on unmount.
- WebGL context-loss listener → rebuild scene automatically.
- No WebGL → static CSS pulse fallback; `/voice` still works.
- **Visualizer failures never break voice:** errors inside `lib/viz/` are caught and logged; audio
  keeps flowing.

## 6. Testing

- **Vitest** (existing `test/` setup): choreographer unit tests — transition lerps, impulse decay,
  barge-in forces listening, smoothing math; plus `useVoice` event-emission tests.
- **Playwright E2E** (`playwright-cli`): `/voice` renders, canvas mounts with a WebGL context, no
  console errors.
- **Manual:** full voice loop on desktop + phone — judging "impressive" is human work.

## 7. Scope / YAGNI

- No visualizer settings UI (themes, particle density sliders) — palette and tiers are code.
- No transcript-text-in-3D (words orbiting the core) — sparks only, v1.
- No changes to voice transport, VAD tuning, or providers; this cycle is presentation + the small
  signal-surface additions in §3.
