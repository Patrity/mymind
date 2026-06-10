# Voice Visualizer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the placeholder voice reactor with a GPU-particle Three.js visualizer — particle sphere core (agent voice) + 96-bar mic frequency ring — with 7 choreographed visual states and event impulses (barge-in shatter, error shockwave, transcription sparks, connect assembly).

**Architecture:** All visualizer code lives in `app/lib/viz/` behind a hard boundary (*signals in → pixels out*). A pure-TS `choreographer` (no Three.js import, fully unit-tested) turns voice state + events + audio levels into a per-frame `Directives` object; `scene/core/ring/effects` render it. `useVoice` gains two states (`connecting`, `tool`) and a tiny event emitter; the server orchestrator gains a `tool` state emission. Spec: `docs/superpowers/specs/2026-06-09-voice-visualizer-redesign-design.md`.

**Tech Stack:** Nuxt 4, Three.js 0.184 (+`three/addons` postprocessing, `@types/three` already installed), custom GLSL ShaderMaterial, vitest, playwright-cli.

**Conventions that matter here:**
- All code under `app/lib/viz/` uses **relative imports only** (no `~/` alias, no Nuxt auto-imports) — there is no vitest config, so tests reach it via plain relative paths like `../app/lib/viz/choreographer`.
- The repo tsconfig has `noUncheckedIndexedAccess`-style strictness — index into arrays/records with `?? 0` fallbacks or `!` where provably present (matches existing `data[i] ?? 0` patterns).
- Raw hex colors are fine inside `lib/viz` (GL material colors, same exemption as the old Reactor); any **Vue template** styling must use semantic tokens (`bg-primary/30`, `text-muted`, …).
- Commit after every task. `pnpm test` / `pnpm typecheck` are the gates (lint is red repo-wide and not a gate).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/lib/viz/types.ts` | Create | `VizState`, `VizEvent`, `Directives`, `BAR_COUNT`, `PALETTE` |
| `app/lib/viz/emitter.ts` | Create | Generic tiny event emitter (used by `useVoice`) |
| `app/lib/viz/choreographer.ts` | Create | Pure-TS state machine: inputs+events → per-frame `Directives` |
| `app/lib/voice/messages.ts` | Create | Pure mapping of server WS messages → state/transcript/viz-events |
| `app/composables/useVoice.ts` | Modify | Add `connecting`/`tool` states, `onVizEvent` emitter, wire emissions |
| `server/lib/voice/orchestrator.ts` | Modify | Emit `state: 'tool'` on tool-start, back to `thinking` on tool-result |
| `app/lib/viz/scene.ts` | Create | Renderer, camera, bloom composer, quality tiers, degrade, dispose |
| `app/lib/viz/core.ts` | Create | GPU particle sphere (GLSL vertex-shader motion) |
| `app/lib/viz/ring.ts` | Create | 96 instanced mic-frequency bars + error shockwave coloring |
| `app/lib/viz/effects.ts` | Create | Tool pulse rings + transcription spark pool |
| `app/components/voice/Reactor.client.vue` | Rewrite | Thin mount: RAF loop, FFT sampling, watchdog, fallback, dispose |
| `app/pages/voice.vue` | Modify | Pass new props (both analysers, connected, onVizEvent) |
| `test/viz-emitter.test.ts` | Create | Emitter behavior |
| `test/viz-choreographer.test.ts` | Create | Transitions, impulses, smoothing, derived disconnected |
| `test/voice-messages.test.ts` | Create | Server message mapping |
| `test/orchestrator.test.ts` | Modify | Tool state emissions |
| `docs/wiki/voice-agent.md`, `docs/handovers/`, roadmap | Modify/Create | Docs in sync with shipped code |

---

### Task 1: Viz types, palette, and event emitter

**Files:**
- Create: `app/lib/viz/types.ts`
- Create: `app/lib/viz/emitter.ts`
- Test: `test/viz-emitter.test.ts`

- [x] **Step 1: Write the failing emitter test**

```ts
// test/viz-emitter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createEmitter } from '../app/lib/viz/emitter'

describe('createEmitter', () => {
  it('delivers events to subscribers', () => {
    const em = createEmitter<{ type: string }>()
    const cb = vi.fn()
    em.on(cb)
    em.emit({ type: 'bargein' })
    expect(cb).toHaveBeenCalledWith({ type: 'bargein' })
  })

  it('unsubscribe stops delivery', () => {
    const em = createEmitter<number>()
    const cb = vi.fn()
    const off = em.on(cb)
    off()
    em.emit(1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('a subscriber unsubscribing during emit does not break other subscribers', () => {
    const em = createEmitter<number>()
    const calls: string[] = []
    const offA = em.on(() => { calls.push('a'); offA() })
    em.on(() => calls.push('b'))
    em.emit(1)
    expect(calls).toEqual(['a', 'b'])
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/viz-emitter.test.ts`
Expected: FAIL — `Cannot find module '../app/lib/viz/emitter'`

- [x] **Step 3: Write types.ts and emitter.ts**

```ts
// app/lib/viz/emitter.ts
export interface Emitter<E> {
  on: (cb: (e: E) => void) => () => void
  emit: (e: E) => void
}

export function createEmitter<E>(): Emitter<E> {
  const subs = new Set<(e: E) => void>()
  return {
    on(cb) { subs.add(cb); return () => { subs.delete(cb) } },
    // copy so unsubscribing mid-emit can't skip a subscriber
    emit(e) { for (const cb of [...subs]) cb(e) },
  }
}
```

```ts
// app/lib/viz/types.ts
// Shared contracts for the voice visualizer. Pure TS — no Three.js imports here.

export const BAR_COUNT = 96

export type VizState =
  | 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool'
  | 'disconnected' // derived by the choreographer from connected === false

export type VizEvent =
  | { type: 'bargein' }
  | { type: 'error' }
  | { type: 'sttFinal'; chars: number }
  | { type: 'disconnected' }

/** Per-frame render knobs produced by the choreographer, consumed by scene units. */
export interface Directives {
  vizState: VizState
  coreColor: [number, number, number]
  ringColor: [number, number, number]
  energy: number       // core amplitude 0..~1.5 (breathing/burst)
  swirl: number        // 0..1 thinking vortex
  shatter: number      // barge-in impulse, decays to 0
  ignite: number       // connect "ignition" impulse, decays to 0
  assemble: number     // 0 scattered .. 1 formed sphere
  micMix: number       // 0..1 how much the ring shows the live mic
  ringLevels: Float32Array // BAR_COUNT smoothed 0..1 FFT bands
  outLevel: number     // smoothed playback amplitude 0..1
  errorFlash: number   // error impulse, decays to 0
  sparks: number       // spark particles to spawn THIS frame (consumed)
  pulseRate: number    // tool pulses per second (0 = off)
  dim: number          // 0..1 overall dimming (idle/disconnected)
}

function hex(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
}

export const PALETTE: Record<VizState, { core: [number, number, number]; ring: [number, number, number] }> = {
  connecting: { core: hex(0x27457a), ring: hex(0x16233f) },
  idle: { core: hex(0x3b82f6), ring: hex(0x1e3a5f) },
  listening: { core: hex(0x3b82f6), ring: hex(0x22d3ee) },
  thinking: { core: hex(0x8b5cf6), ring: hex(0x312e51) },
  speaking: { core: hex(0x22d3ee), ring: hex(0x155e75) },
  tool: { core: hex(0xf59e0b), ring: hex(0x78350f) },
  disconnected: { core: hex(0x475569), ring: hex(0x1e293b) },
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/viz-emitter.test.ts`
Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add app/lib/viz/types.ts app/lib/viz/emitter.ts test/viz-emitter.test.ts
git commit -m "feat(viz): types, palette, event emitter for visualizer redesign"
```

---

### Task 2: Choreographer (pure TS state machine)

**Files:**
- Create: `app/lib/viz/choreographer.ts`
- Test: `test/viz-choreographer.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// test/viz-choreographer.test.ts
import { describe, it, expect } from 'vitest'
import { createChoreographer, type VizInputs } from '../app/lib/viz/choreographer'
import { BAR_COUNT, PALETTE } from '../app/lib/viz/types'

const DT = 1 / 60

function inputs(over: Partial<VizInputs> = {}): VizInputs {
  return { state: 'idle', connected: true, micLevels: new Float32Array(BAR_COUNT), outLevel: 0, ...over }
}

function run(c: ReturnType<typeof createChoreographer>, inp: VizInputs, frames: number) {
  let d = c.update(inp, DT)
  for (let i = 1; i < frames; i++) d = c.update(inp, DT)
  return d
}

describe('choreographer', () => {
  it('lerps core color toward the active state palette', () => {
    const c = createChoreographer()
    const d = run(c, inputs({ state: 'speaking' }), 120)
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(d.coreColor[i]! - PALETTE.speaking.core[i]!)).toBeLessThan(0.05)
    }
  })

  it('bargein spikes shatter, which decays back near zero', () => {
    const c = createChoreographer()
    run(c, inputs({ state: 'speaking' }), 10)
    c.handleEvent({ type: 'bargein' })
    const d1 = c.update(inputs({ state: 'listening' }), DT)
    expect(d1.shatter).toBeGreaterThan(0.9)
    const d2 = run(c, inputs({ state: 'listening' }), 120)
    expect(d2.shatter).toBeLessThan(0.05)
  })

  it('derives disconnected from connected=false, except while connecting', () => {
    const c = createChoreographer()
    expect(c.update(inputs({ connected: false }), DT).vizState).toBe('disconnected')
    expect(c.update(inputs({ state: 'connecting', connected: false }), DT).vizState).toBe('connecting')
  })

  it('assemble resets on entering connecting, then builds back up', () => {
    const c = createChoreographer()
    const settled = run(c, inputs(), 300)
    expect(settled.assemble).toBeGreaterThan(0.9)
    const d1 = c.update(inputs({ state: 'connecting', connected: false }), DT)
    expect(d1.assemble).toBeLessThan(0.1)
    const d2 = run(c, inputs({ state: 'connecting', connected: false }), 300)
    expect(d2.assemble).toBeGreaterThan(0.9)
  })

  it('fires ignite when leaving connecting (WS opened)', () => {
    const c = createChoreographer()
    run(c, inputs({ state: 'connecting', connected: false }), 30)
    const d = c.update(inputs({ state: 'idle' }), DT)
    expect(d.ignite).toBeGreaterThan(0.8)
  })

  it('sttFinal sparks scale with length, are consumed after one frame', () => {
    const c = createChoreographer()
    c.handleEvent({ type: 'sttFinal', chars: 100 })
    expect(c.update(inputs(), DT).sparks).toBe(33) // min(40, 8 + floor(100/4))
    expect(c.update(inputs(), DT).sparks).toBe(0)
  })

  it('mic levels attack faster than they release', () => {
    const c = createChoreographer()
    const hot = new Float32Array(BAR_COUNT).fill(1)
    const before = c.update(inputs({ state: 'listening' }), DT).ringLevels[0]!
    const peak = c.update(inputs({ state: 'listening', micLevels: hot }), DT).ringLevels[0]!
    const after = c.update(inputs({ state: 'listening' }), DT).ringLevels[0]!
    expect(peak - before).toBeGreaterThan(peak - after) // rise step > fall step
    expect(after).toBeGreaterThan(0) // slow release, not a hard cut
  })

  it('error flash decays below 0.05 within ~1.2s', () => {
    const c = createChoreographer()
    c.handleEvent({ type: 'error' })
    const d = run(c, inputs(), 72)
    expect(d.errorFlash).toBeLessThan(0.05)
  })

  it('tool state turns pulses on, others off', () => {
    const c = createChoreographer()
    expect(c.update(inputs({ state: 'tool' }), DT).pulseRate).toBeGreaterThan(0)
    expect(c.update(inputs({ state: 'idle' }), DT).pulseRate).toBe(0)
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/viz-choreographer.test.ts`
Expected: FAIL — `Cannot find module '../app/lib/viz/choreographer'`

- [x] **Step 3: Implement the choreographer**

```ts
// app/lib/viz/choreographer.ts
// Pure TS (no Three.js): consumes voice state + events + audio levels and
// produces per-frame Directives. Every state change is a lerp — no hard cuts.
import { BAR_COUNT, PALETTE } from './types'
import type { VizState, VizEvent, Directives } from './types'

export interface VizInputs {
  state: Exclude<VizState, 'disconnected'>
  connected: boolean
  micLevels: Float32Array // BAR_COUNT raw 0..1 FFT bands
  outLevel: number        // raw 0..1 playback amplitude
}

// Speeds are per-second: lerp factor = 1 - exp(-speed * dt)
const COLOR_SPEED = 5
const KNOB_SPEED = 4
const ASSEMBLE_SPEED = 0.9 // slow build while connecting
const SHATTER_DECAY = 2.2
const IGNITE_DECAY = 2.8
const ERROR_DECAY = 3.4    // visible ~700ms
const MIC_ATTACK = 26
const MIC_RELEASE = 6
const OUT_ATTACK = 30
const OUT_RELEASE = 8

const ENERGY: Record<VizState, number> = {
  connecting: 0.2, idle: 0.15, listening: 0.3, thinking: 0.4,
  speaking: 0.35, tool: 0.3, disconnected: 0.05,
}
const SWIRL: Record<VizState, number> = {
  connecting: 0, idle: 0, listening: 0, thinking: 1, speaking: 0, tool: 0.6, disconnected: 0,
}
const DIM: Record<VizState, number> = {
  connecting: 0.3, idle: 0.35, listening: 0, thinking: 0, speaking: 0, tool: 0, disconnected: 1,
}

function approach(current: number, target: number, speed: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-speed * dt))
}

function micAverage(levels: Float32Array): number {
  let sum = 0
  for (let i = 0; i < levels.length; i++) sum += levels[i] ?? 0
  return levels.length ? sum / levels.length : 0
}

export function createChoreographer() {
  const d: Directives = {
    vizState: 'connecting',
    coreColor: [...PALETTE.connecting.core],
    ringColor: [...PALETTE.connecting.ring],
    energy: 0, swirl: 0, shatter: 0, ignite: 0, assemble: 0,
    micMix: 0, ringLevels: new Float32Array(BAR_COUNT), outLevel: 0,
    errorFlash: 0, sparks: 0, pulseRate: 0, dim: 0,
  }
  let prev: VizState = 'connecting'
  let pendingSparks = 0

  function handleEvent(e: VizEvent) {
    if (e.type === 'bargein') d.shatter = 1
    else if (e.type === 'error') d.errorFlash = 1
    else if (e.type === 'sttFinal') pendingSparks += Math.min(40, 8 + Math.floor(e.chars / 4))
    // 'disconnected' is derived from inputs.connected; the event needs no impulse
  }

  function update(inp: VizInputs, dt: number): Directives {
    const s: VizState = !inp.connected && inp.state !== 'connecting' ? 'disconnected' : inp.state
    if (s !== prev) {
      if (s === 'connecting') d.assemble = 0                          // scatter, then build
      if (prev === 'connecting' && s !== 'disconnected') d.ignite = 1 // WS opened
      prev = s
    }
    d.vizState = s

    const pal = PALETTE[s]
    for (let i = 0; i < 3; i++) {
      d.coreColor[i] = approach(d.coreColor[i]!, pal.core[i]!, COLOR_SPEED, dt)
      d.ringColor[i] = approach(d.ringColor[i]!, pal.ring[i]!, COLOR_SPEED, dt)
    }

    d.outLevel = approach(d.outLevel, inp.outLevel, inp.outLevel > d.outLevel ? OUT_ATTACK : OUT_RELEASE, dt)

    const energyTarget = ENERGY[s]
      + (s === 'speaking' ? d.outLevel : 0)
      + (s === 'listening' ? micAverage(inp.micLevels) * 0.3 : 0)
    d.energy = approach(d.energy, energyTarget, KNOB_SPEED, dt)
    d.swirl = approach(d.swirl, SWIRL[s], KNOB_SPEED, dt)
    d.dim = approach(d.dim, DIM[s], KNOB_SPEED, dt)
    d.micMix = approach(d.micMix, s === 'listening' ? 1 : 0, KNOB_SPEED, dt)
    d.assemble = approach(
      d.assemble,
      s === 'disconnected' ? 0.5 : 1, // disconnected: half-sagged sphere
      s === 'connecting' ? ASSEMBLE_SPEED : KNOB_SPEED,
      dt
    )

    for (let i = 0; i < BAR_COUNT; i++) {
      const raw = inp.micLevels[i] ?? 0
      const cur = d.ringLevels[i] ?? 0
      d.ringLevels[i] = approach(cur, raw, raw > cur ? MIC_ATTACK : MIC_RELEASE, dt)
    }

    d.shatter *= Math.exp(-SHATTER_DECAY * dt)
    d.ignite *= Math.exp(-IGNITE_DECAY * dt)
    d.errorFlash *= Math.exp(-ERROR_DECAY * dt)
    if (d.shatter < 0.001) d.shatter = 0
    if (d.ignite < 0.001) d.ignite = 0
    if (d.errorFlash < 0.001) d.errorFlash = 0

    d.pulseRate = s === 'tool' ? 1.2 : 0
    d.sparks = pendingSparks
    pendingSparks = 0
    return d
  }

  return { handleEvent, update }
}
```

Note on UX: before the user ever clicks Connect, `state='idle'` + `connected=false` renders as `disconnected` (dim, sagged sphere). This is intended — the sphere "wakes up" through connecting → ignite when they connect.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/viz-choreographer.test.ts`
Expected: PASS (9 tests)

- [x] **Step 5: Commit**

```bash
git add app/lib/viz/choreographer.ts test/viz-choreographer.test.ts
git commit -m "feat(viz): choreographer state machine (lerped transitions, event impulses)"
```

---

### Task 3: Server-message mapping helper

**Files:**
- Create: `app/lib/voice/messages.ts`
- Test: `test/voice-messages.test.ts`

This extracts the WS-message → state/transcript/event logic out of `useVoice.onmessage` so it's unit-testable (the spec's "useVoice event emission" coverage — the composable itself needs WebSocket/AudioContext/VAD mocks, so we test the pure mapping instead and keep the composable wiring trivial).

- [x] **Step 1: Write the failing tests**

```ts
// test/voice-messages.test.ts
import { describe, it, expect } from 'vitest'
import { mapServerMessage } from '../app/lib/voice/messages'

describe('mapServerMessage', () => {
  it('user transcript → delta + sttFinal event with char count', () => {
    const fx = mapServerMessage({ type: 'transcript', role: 'user', text: 'hello world' }, false)
    expect(fx.delta).toEqual({ role: 'user', text: 'hello world' })
    expect(fx.events).toEqual([{ type: 'sttFinal', chars: 11 }])
  })

  it('assistant transcript → delta, no events', () => {
    const fx = mapServerMessage({ type: 'transcript', role: 'assistant', text: 'hi' }, false)
    expect(fx.delta).toEqual({ role: 'assistant', text: 'hi' })
    expect(fx.events).toEqual([])
  })

  it('maps state messages, including tool', () => {
    expect(mapServerMessage({ type: 'state', state: 'speaking' }, false).state).toBe('speaking')
    expect(mapServerMessage({ type: 'state', state: 'thinking' }, false).state).toBe('thinking')
    expect(mapServerMessage({ type: 'state', state: 'tool' }, false).state).toBe('tool')
  })

  it('ignores premature idle while audio is still playing', () => {
    expect(mapServerMessage({ type: 'state', state: 'idle' }, true).state).toBeUndefined()
    expect(mapServerMessage({ type: 'state', state: 'idle' }, false).state).toBe('idle')
  })

  it('unknown messages are inert', () => {
    const fx = mapServerMessage({ type: 'tool', text: 'x' }, false)
    expect(fx.state).toBeUndefined()
    expect(fx.delta).toBeUndefined()
    expect(fx.events).toEqual([])
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/voice-messages.test.ts`
Expected: FAIL — `Cannot find module '../app/lib/voice/messages'`

- [x] **Step 3: Implement**

```ts
// app/lib/voice/messages.ts
// Pure mapping of server WS JSON messages onto client effects. Kept out of
// useVoice so the logic is testable without WebSocket/AudioContext mocks.
import type { VizEvent } from '../viz/types'

export interface ServerMsg { type: string; role?: 'user' | 'assistant'; text?: string; state?: string }

export interface MsgEffect {
  state?: 'idle' | 'thinking' | 'speaking' | 'tool'
  delta?: { role: 'user' | 'assistant'; text: string }
  events: VizEvent[]
}

export function mapServerMessage(m: ServerMsg, isPlaying: boolean): MsgEffect {
  const events: VizEvent[] = []
  if (m.type === 'transcript' && m.role && m.text) {
    if (m.role === 'user') events.push({ type: 'sttFinal', chars: m.text.length })
    return { delta: { role: m.role, text: m.text }, events }
  }
  if (m.type === 'state') {
    if (m.state === 'speaking') return { state: 'speaking', events }
    if (m.state === 'thinking') return { state: 'thinking', events }
    if (m.state === 'tool') return { state: 'tool', events }
    // Server says idle the moment generation ends, but audio may still be
    // buffered ahead — playback drain flips to idle in that case (useVoice).
    return isPlaying ? { events } : { state: 'idle', events }
  }
  return { events }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/voice-messages.test.ts`
Expected: PASS (5 tests)

- [x] **Step 5: Commit**

```bash
git add app/lib/voice/messages.ts test/voice-messages.test.ts
git commit -m "feat(voice): pure server-message mapping (state/transcript/viz events)"
```

---

### Task 4: Orchestrator emits the tool state

**Files:**
- Modify: `server/lib/voice/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

The agent loop already yields `tool-start` events (`server/lib/agent/run.ts:14`, surfaced via `buildAiTools.onEvent`); the orchestrator currently drops them. `server/api/voice/ws.ts` forwards every non-audio event as JSON, so no transport change is needed.

- [x] **Step 1: Add the failing test**

Append to `test/orchestrator.test.ts` (a second fake with a `tool-start` yield; the existing test and fake stay untouched):

```ts
const runAgentWithTool = (async function* () {
  yield { type: 'text-delta', text: 'Let me check. ' }
  yield { type: 'tool-start', name: 'search_tasks', args: {} }
  yield { type: 'tool-result', name: 'search_tasks', summary: 'listed tasks (2)', undoToken: undefined }
  yield { type: 'text-delta', text: 'You have two tasks.' }
  yield { type: 'done' }
}) as never

it('emits state:tool on tool-start and returns to thinking on tool-result', async () => {
  const events: any[] = []
  await handleUtterance(new Uint8Array([1]), [], {
    stt, tts, voice: 'af_heart', runAgent: runAgentWithTool, signal: new AbortController().signal,
    emit: e => events.push(e)
  })
  const states = events.filter(e => e.type === 'state').map(e => e.state)
  const toolIdx = states.indexOf('tool')
  expect(toolIdx).toBeGreaterThan(-1)
  expect(states[toolIdx + 1]).toBe('thinking')
  // the tool chip event still flows
  expect(events.some(e => e.type === 'tool' && e.name === 'search_tasks')).toBe(true)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/orchestrator.test.ts`
Expected: FAIL — `toolIdx` is `-1` (no `state: 'tool'` emitted)

- [x] **Step 3: Implement**

In `server/lib/voice/orchestrator.ts`, widen the state union and handle `tool-start`:

```ts
// VoiceEvent: widen the state member
| { type: 'state'; state: 'thinking' | 'speaking' | 'tool' | 'idle' }
```

In the `for await (const ev of run(...))` loop, replace the `tool-result` branch with:

```ts
    } else if (ev.type === 'tool-start') {
      deps.emit({ type: 'state', state: 'tool' })
    } else if (ev.type === 'tool-result') {
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken })
      deps.emit({ type: 'state', state: 'thinking' })
    }
```

- [x] **Step 4: Run the orchestrator tests**

Run: `pnpm vitest run test/orchestrator.test.ts`
Expected: PASS (both tests)

- [x] **Step 5: Commit**

```bash
git add server/lib/voice/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(voice): emit tool state over the voice WS during tool execution"
```

---

### Task 5: useVoice signal surface (states + events)

**Files:**
- Modify: `app/composables/useVoice.ts`

All changes are wiring — logic was tested in Tasks 1–3. After this task the old `Reactor.client.vue` still compiles (its `VoiceState` import only gained members, and `PALETTE` there is keyed per state — it will briefly miss `connecting`/`tool` keys, which TypeScript flags). To keep typecheck green mid-stream, add the two missing keys to the old component's `PALETTE` in this task (it gets deleted in Task 7):

```ts
// app/components/voice/Reactor.client.vue — temporary, deleted in Task 7
const PALETTE: Record<VoiceState, number> = {
  idle: 0x3b82f6, listening: 0x06b6d4, thinking: 0xf59e0b, speaking: 0x22d3ee,
  connecting: 0x27457a, tool: 0xf59e0b
}
```

- [x] **Step 1: Apply the useVoice edits**

1. Imports (top of file):

```ts
import { createEmitter } from '../lib/viz/emitter'
import { mapServerMessage } from '../lib/voice/messages'
import type { VizEvent } from '../lib/viz/types'
```

2. Widen the state type:

```ts
export type VoiceState = 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool'
```

3. Inside `useVoice()`, next to the existing refs:

```ts
  const events = createEmitter<VizEvent>()
```

4. In `start()`, right after `error.value = null`:

```ts
    state.value = 'connecting'
```

5. `ws.onopen` — add `state.value = 'idle'` (connected; idle until speech):

```ts
    ws.onopen = () => {
      connected.value = true
      state.value = 'idle'
      if (desiredVoice) ws!.send(JSON.stringify({ type: 'voice', ...desiredVoice }))
    }
```

6. `ws.onclose` / `ws.onerror`:

```ts
    ws.onclose = () => { connected.value = false; state.value = 'idle'; events.emit({ type: 'disconnected' }) }
    ws.onerror = () => { error.value = 'WebSocket error'; events.emit({ type: 'error' }) }
```

7. Replace the JSON branch of `ws.onmessage` with the mapper:

```ts
      } else {
        const fx = mapServerMessage(JSON.parse(e.data as string), isPlaying())
        if (fx.delta) pushDelta(fx.delta.role, fx.delta.text)
        if (fx.state) state.value = fx.state
        for (const ev of fx.events) events.emit(ev)
      }
```

8. In `onSpeechStart`, emit on the barge-in branch:

```ts
      onSpeechStart: () => {
        if (TUNING.bargeInEnabled && isPlaying()) {
          stopPlayback()
          ws?.send(JSON.stringify({ type: 'interrupt' }))
          events.emit({ type: 'bargein' })
        }
        state.value = 'listening'
      },
```

9. Expose the subscription in the return object:

```ts
    onVizEvent: events.on,
```

- [x] **Step 2: Apply the temporary PALETTE patch to the old Reactor (shown above)**

- [x] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: both pass (no behavior change is covered by existing tests; this is wiring)

- [x] **Step 4: Commit**

```bash
git add app/composables/useVoice.ts app/components/voice/Reactor.client.vue
git commit -m "feat(voice): connecting/tool states + viz event emitter in useVoice"
```

---

### Task 6: Scene, core, ring, effects (the Three.js units)

**Files:**
- Create: `app/lib/viz/scene.ts`
- Create: `app/lib/viz/core.ts`
- Create: `app/lib/viz/ring.ts`
- Create: `app/lib/viz/effects.ts`

No unit tests (WebGL); the gate is `pnpm typecheck` + the E2E/manual pass in Task 8. Keep imports relative.

- [x] **Step 1: scene.ts — renderer, bloom, tiers, degrade**

```ts
// app/lib/viz/scene.ts
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

export interface QualityTier { particles: number; pixelRatioCap: number; bloomScale: number }

export function detectTier(): QualityTier {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  const cores = navigator.hardwareConcurrency ?? 4
  if (mobile) return { particles: 10_000, pixelRatioCap: 1.5, bloomScale: 0.5 }
  if (cores <= 4) return { particles: 25_000, pixelRatioCap: 2, bloomScale: 0.75 }
  return { particles: 50_000, pixelRatioCap: 2, bloomScale: 1 }
}

export interface VizScene {
  scene: THREE.Scene
  render: () => void
  setSize: (w: number, h: number) => void
  /** One-way quality step: drops render resolution 25%. */
  degrade: () => void
  onContextLost: (cb: () => void) => void
  dispose: () => void
}

export function createScene(el: HTMLElement, tier: QualityTier): VizScene {
  // The flex cell may not have laid out on the first frame — avoid NaN aspect.
  const w = el.clientWidth || 320
  const h = el.clientHeight || 320
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100)
  camera.position.set(0, 0.6, 6.2)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' })
  let ratio = Math.min(devicePixelRatio, tier.pixelRatioCap)
  renderer.setPixelRatio(ratio)
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(ratio)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w * tier.bloomScale, h * tier.bloomScale),
    1.1,  // strength
    0.55, // radius
    0.12  // threshold — particles are dim-ish; let most of them bloom
  )
  composer.addPass(bloom)

  let lostCb: (() => void) | null = null
  const onLost = (e: Event) => { e.preventDefault(); lostCb?.() }
  renderer.domElement.addEventListener('webglcontextlost', onLost)

  return {
    scene,
    render: () => composer.render(),
    setSize: (nw, nh) => {
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      composer.setSize(nw, nh)
    },
    degrade: () => {
      ratio = Math.max(0.75, ratio * 0.75)
      renderer.setPixelRatio(ratio)
      composer.setPixelRatio(ratio)
      composer.setSize(el.clientWidth || w, el.clientHeight || h)
    },
    onContextLost: (cb) => { lostCb = cb },
    dispose: () => {
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      composer.dispose()
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    },
  }
}
```

- [x] **Step 2: core.ts — GPU particle sphere**

All per-particle motion runs in the vertex shader; the CPU only sets ~10 uniforms per frame. `position` doubles as the formed-sphere location; `aScatter` is each particle's "exploded" location (used by both barge-in shatter and connect assembly); `aSeed` carries per-particle randomness. Note `flat` is a reserved GLSL word — the flatten variable must not use it.

```ts
// app/lib/viz/core.ts
import * as THREE from 'three'
import type { Directives } from './types'

const VERT = /* glsl */ `
uniform float uTime;
uniform float uEnergy;
uniform float uSwirl;
uniform float uShatter;
uniform float uAssemble;
uniform float uIgnite;
uniform float uDim;
uniform float uSize;
attribute vec3 aScatter;
attribute vec4 aSeed;
varying float vAlpha;

void main() {
  vec3 p = position;

  // thinking vortex: flatten toward a disc and swirl per-particle
  float flatten = uSwirl * 0.75;
  p.y *= (1.0 - flatten);
  float ang = uSwirl * (2.0 + aSeed.x * 4.0) + uTime * uSwirl * (0.6 + aSeed.y);
  float ca = cos(ang); float sa = sin(ang);
  p = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);

  // breathing + voice burst + connect ignition
  float breathe = 1.0 + 0.05 * sin(uTime * 1.4 + aSeed.x * 6.2831);
  float burst = 1.0 + uEnergy * (0.25 + aSeed.y * 0.9) + uIgnite * aSeed.z * 0.9;
  p *= breathe * burst;

  // barge-in shatter: fly out toward the per-particle scatter point
  p = mix(p, aScatter * (1.2 + aSeed.z), uShatter);
  // connect assembly: from the scatter cloud into place
  p = mix(aScatter, p, uAssemble);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + aSeed.w) * (1.0 + uEnergy * 0.7) * (220.0 / -mv.z);
  vAlpha = (1.0 - uDim * 0.75) * (0.3 + 0.7 * aSeed.w);
}
`

const FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uErrorFlash;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float glow = smoothstep(0.25, 0.0, r2);
  vec3 col = mix(uColor, vec3(1.0, 0.3, 0.3), uErrorFlash * 0.8);
  gl_FragColor = vec4(col, glow * vAlpha);
}
`

export function createCore(particles: number) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(particles * 3)
  const scatter = new Float32Array(particles * 3)
  const seed = new Float32Array(particles * 4)
  for (let i = 0; i < particles; i++) {
    // uniform point on a slightly fuzzed unit sphere
    const u = Math.random() * 2 - 1
    const th = Math.random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const r = 1.0 + Math.random() * 0.15
    pos[i * 3] = s * Math.cos(th) * r
    pos[i * 3 + 1] = u * r
    pos[i * 3 + 2] = s * Math.sin(th) * r
    // scatter target: random direction, 3–6 units out
    const su = Math.random() * 2 - 1
    const sth = Math.random() * Math.PI * 2
    const ss = Math.sqrt(1 - su * su)
    const sr = 3 + Math.random() * 3
    scatter[i * 3] = ss * Math.cos(sth) * sr
    scatter[i * 3 + 1] = su * sr
    scatter[i * 3 + 2] = ss * Math.sin(sth) * sr
    seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random()
    seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4))

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uEnergy: { value: 0 }, uSwirl: { value: 0 },
      uShatter: { value: 0 }, uAssemble: { value: 0 }, uIgnite: { value: 0 },
      uDim: { value: 0 }, uSize: { value: 9 },
      uColor: { value: new THREE.Color() }, uErrorFlash: { value: 0 },
    },
  })
  const points = new THREE.Points(geo, mat)
  points.rotation.x = 0.15

  return {
    object: points,
    update(d: Directives, t: number) {
      const u = mat.uniforms
      u.uTime!.value = t
      u.uEnergy!.value = d.energy
      u.uSwirl!.value = d.swirl
      u.uShatter!.value = d.shatter
      u.uAssemble!.value = d.assemble
      u.uIgnite!.value = d.ignite
      u.uDim!.value = d.dim
      u.uErrorFlash!.value = d.errorFlash
      ;(u.uColor!.value as THREE.Color).setRGB(d.coreColor[0]!, d.coreColor[1]!, d.coreColor[2]!)
      points.rotation.y += 0.0015 + d.energy * 0.004 + d.swirl * 0.01
    },
    /** One-way perf step: draw only the first `frac` of the particles. */
    setDrawRange(frac: number) { geo.setDrawRange(0, Math.floor(particles * frac)) },
    dispose() { geo.dispose(); mat.dispose() },
  }
}
```

- [x] **Step 3: ring.ts — instanced mic-frequency bars**

```ts
// app/lib/viz/ring.ts
import * as THREE from 'three'
import { BAR_COUNT } from './types'
import type { Directives } from './types'

const RADIUS = 2.5
const ERROR_RED = new THREE.Color(1, 0.25, 0.25)

export function createRing() {
  const geo = new THREE.BoxGeometry(0.035, 1, 0.035)
  geo.translate(0, 0.5, 0) // grow upward from the base when y-scaled
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, BAR_COUNT)
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BAR_COUNT * 3), 3)
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()

  return {
    object: mesh,
    update(d: Directives, t: number) {
      for (let i = 0; i < BAR_COUNT; i++) {
        const th = (i / BAR_COUNT) * Math.PI * 2
        const ambient = 0.05 + 0.03 * Math.sin(i * 0.7 + t * 1.5)
        const mic = (d.ringLevels[i] ?? 0) * 1.1 * d.micMix
        const ripple = d.outLevel * 0.18 * Math.abs(Math.sin(i * 0.5 + t * 2.0))
        const h = Math.max(0.04, ambient + mic + ripple) * (1 - d.dim * 0.8)
        dummy.position.set(Math.cos(th) * RADIUS, 0, Math.sin(th) * RADIUS)
        dummy.rotation.set(0, -th, 0)
        dummy.scale.set(1, h, 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)

        // error shockwave: a red front sweeps once around as the flash decays
        color.setRGB(d.ringColor[0]!, d.ringColor[1]!, d.ringColor[2]!)
        if (d.errorFlash > 0.01) {
          const front = (1 - d.errorFlash) * Math.PI * 2
          const dist = Math.abs(((th - front + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
          color.lerp(ERROR_RED, Math.max(0, 1 - dist / 0.6) * d.errorFlash)
        }
        mesh.setColorAt(i, color)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.rotation.y += 0.0006 + d.micMix * 0.002
    },
    dispose() { geo.dispose(); mat.dispose() },
  }
}
```

- [x] **Step 4: effects.ts — tool pulses + transcription sparks**

```ts
// app/lib/viz/effects.ts
import * as THREE from 'three'
import type { Directives } from './types'

const PULSES = 3
const MAX_SPARKS = 160
const SPARK_LIFE = 0.8
const RING_RADIUS = 2.5

export function createEffects() {
  const group = new THREE.Group()

  // tool pulse rings, radiating outward while a tool runs
  const pulseGeo = new THREE.RingGeometry(0.98, 1.0, 64)
  const pulseMats: THREE.MeshBasicMaterial[] = []
  const pulseMeshes: THREE.Mesh[] = []
  for (let i = 0; i < PULSES; i++) {
    const m = new THREE.MeshBasicMaterial({
      color: 0xf59e0b, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    })
    const mesh = new THREE.Mesh(pulseGeo, m)
    mesh.rotation.x = -Math.PI / 2
    group.add(mesh)
    pulseMats.push(m)
    pulseMeshes.push(mesh)
  }
  let pulsePhase = 0

  // transcription sparks: pooled points streaming from the ring into the core
  const sparkGeo = new THREE.BufferGeometry()
  const sparkPos = new Float32Array(MAX_SPARKS * 3)
  sparkPos.fill(9999) // park everything offscreen until spawned
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3))
  const sparkMat = new THREE.PointsMaterial({
    color: 0x67e8f9, size: 0.06, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const sparks = new THREE.Points(sparkGeo, sparkMat)
  sparks.frustumCulled = false
  group.add(sparks)
  const life = new Float32Array(MAX_SPARKS) // <= 0 means free slot
  const vel = new Float32Array(MAX_SPARKS * 3)

  function spawnSpark() {
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (life[i]! > 0) continue
      const th = Math.random() * Math.PI * 2
      const x = Math.cos(th) * RING_RADIUS
      const z = Math.sin(th) * RING_RADIUS
      sparkPos[i * 3] = x
      sparkPos[i * 3 + 1] = (Math.random() - 0.5) * 0.2
      sparkPos[i * 3 + 2] = z
      // head inward toward the core over one lifetime, with jitter
      vel[i * 3] = (-x / SPARK_LIFE) * (0.9 + Math.random() * 0.3)
      vel[i * 3 + 1] = (Math.random() - 0.5) * 0.4
      vel[i * 3 + 2] = (-z / SPARK_LIFE) * (0.9 + Math.random() * 0.3)
      life[i] = SPARK_LIFE
      return
    }
  }

  return {
    object: group,
    update(d: Directives, _t: number, dt: number) {
      if (d.pulseRate > 0) pulsePhase = (pulsePhase + dt * d.pulseRate) % 1
      for (let i = 0; i < PULSES; i++) {
        const ph = (pulsePhase + i / PULSES) % 1
        pulseMeshes[i]!.scale.setScalar(1 + ph * 2.6)
        pulseMats[i]!.opacity = d.pulseRate > 0 ? (1 - ph) * 0.4 : pulseMats[i]!.opacity * 0.9
      }

      for (let n = 0; n < d.sparks; n++) spawnSpark()
      for (let i = 0; i < MAX_SPARKS; i++) {
        if (life[i]! <= 0) continue
        life[i] = life[i]! - dt
        if (life[i]! <= 0) { sparkPos[i * 3 + 1] = 9999; continue } // park
        sparkPos[i * 3] = sparkPos[i * 3]! + vel[i * 3]! * dt
        sparkPos[i * 3 + 1] = sparkPos[i * 3 + 1]! + vel[i * 3 + 1]! * dt
        sparkPos[i * 3 + 2] = sparkPos[i * 3 + 2]! + vel[i * 3 + 2]! * dt
      }
      sparkGeo.attributes.position!.needsUpdate = true
    },
    dispose() {
      pulseGeo.dispose()
      pulseMats.forEach(m => m.dispose())
      sparkGeo.dispose()
      sparkMat.dispose()
    },
  }
}
```

- [x] **Step 5: Verify and commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add app/lib/viz/scene.ts app/lib/viz/core.ts app/lib/viz/ring.ts app/lib/viz/effects.ts
git commit -m "feat(viz): Three.js scene units — bloom scene, GPU particle core, mic ring, effects"
```

---

### Task 7: Rewrite Reactor.client.vue + wire voice.vue

**Files:**
- Rewrite: `app/components/voice/Reactor.client.vue`
- Modify: `app/pages/voice.vue:7-9` (drop `activeAnalyser`) and `:61-64` (new props)

- [x] **Step 1: Rewrite the component**

Full replacement of `app/components/voice/Reactor.client.vue`:

```vue
<!-- app/components/voice/Reactor.client.vue -->
<script setup lang="ts">
import { createScene, detectTier } from '../../lib/viz/scene'
import { createCore } from '../../lib/viz/core'
import { createRing } from '../../lib/viz/ring'
import { createEffects } from '../../lib/viz/effects'
import { createChoreographer } from '../../lib/viz/choreographer'
import { BAR_COUNT } from '../../lib/viz/types'
import type { VizEvent } from '../../lib/viz/types'
import type { VoiceState } from '../../composables/useVoice'

const props = defineProps<{
  state: VoiceState
  connected: boolean
  micAnalyser: () => AnalyserNode | null
  outAnalyser: () => AnalyserNode | null
  onVizEvent: (cb: (e: VizEvent) => void) => () => void
}>()

const host = ref<HTMLDivElement | null>(null)
const webglOk = ref(true)
let raf = 0
let cancelled = false
let teardown: (() => void) | null = null

function boot(el: HTMLDivElement) {
  let scene: ReturnType<typeof createScene>
  let core: ReturnType<typeof createCore>
  let ring: ReturnType<typeof createRing>
  let fx: ReturnType<typeof createEffects>
  try {
    const tier = detectTier()
    scene = createScene(el, tier)
    core = createCore(tier.particles)
    ring = createRing()
    fx = createEffects()
    scene.scene.add(core.object, ring.object, fx.object)
  } catch (err) {
    // The visualizer is decorative — never let it take the voice page down.
    console.error('[viz] init failed', err)
    webglOk.value = false
    return
  }

  const choreo = createChoreographer()
  const offEvents = props.onVizEvent(e => choreo.handleEvent(e))

  const micData = new Uint8Array(128) // analyser fftSize 256 → 128 bins
  const outData = new Uint8Array(128)
  const micLevels = new Float32Array(BAR_COUNT)

  // FPS watchdog: sustained slow frames trigger two one-way quality steps.
  let degradeStep = 0
  let slowSince = 0

  let last = performance.now()
  let t = 0
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    t += dt

    const mic = props.micAnalyser()
    if (mic) {
      mic.getByteFrequencyData(micData as Uint8Array<ArrayBuffer>)
      for (let i = 0; i < BAR_COUNT; i++) {
        micLevels[i] = (micData[Math.floor(i * micData.length / BAR_COUNT)] ?? 0) / 255
      }
    } else {
      micLevels.fill(0)
    }
    let outLevel = 0
    const out = props.outAnalyser()
    if (out) {
      out.getByteFrequencyData(outData as Uint8Array<ArrayBuffer>)
      let sum = 0
      for (let i = 0; i < outData.length; i++) sum += outData[i] ?? 0
      outLevel = sum / outData.length / 255
    }

    const d = choreo.update({ state: props.state, connected: props.connected, micLevels, outLevel }, dt)
    core.update(d, t)
    ring.update(d, t)
    fx.update(d, t, dt)
    scene.render()

    if (dt > 1 / 45) { if (!slowSince) slowSince = now }
    else slowSince = 0
    if (slowSince && now - slowSince > 3000 && degradeStep < 2) {
      degradeStep++
      if (degradeStep === 1) scene.degrade()
      else core.setDrawRange(0.5)
      slowSince = 0
    }
  }
  raf = requestAnimationFrame(frame)

  const ro = new ResizeObserver(() => {
    scene.setSize(el.clientWidth || 320, el.clientHeight || 320)
  })
  ro.observe(el)

  const onVis = () => {
    cancelAnimationFrame(raf)
    if (!document.hidden && !cancelled) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
  }
  document.addEventListener('visibilitychange', onVis)

  scene.onContextLost(() => {
    // GPU reset (driver hiccup, mobile background) — rebuild the whole scene.
    teardown?.()
    if (!cancelled && host.value) boot(host.value)
  })

  teardown = () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    document.removeEventListener('visibilitychange', onVis)
    offEvents()
    core.dispose()
    ring.dispose()
    fx.dispose()
    scene.dispose()
    teardown = null
  }
}

onMounted(() => {
  // The template ref can be null on the first tick under the client-component
  // wrapper; poll a few frames rather than throwing on `host.value!`.
  let tries = 0
  const wait = () => {
    if (cancelled) return
    const el = host.value
    if (el) {
      if (!document.createElement('canvas').getContext('webgl2')) { webglOk.value = false; return }
      boot(el)
      return
    }
    if (tries++ < 120) raf = requestAnimationFrame(wait)
  }
  wait()
})

onUnmounted(() => {
  cancelled = true
  cancelAnimationFrame(raf)
  teardown?.()
})
</script>

<template>
  <div ref="host" class="relative size-full min-h-[320px]">
    <!-- No-WebGL fallback: a quiet pulse so the page still reads as alive -->
    <div v-if="!webglOk" class="absolute inset-0 flex items-center justify-center">
      <div class="size-24 animate-pulse rounded-full bg-primary/30" />
    </div>
  </div>
</template>
```

- [x] **Step 2: Wire voice.vue**

In `app/pages/voice.vue`, delete the `activeAnalyser` helper (lines 7–9) and update the `<VoiceReactor>` usage:

```vue
          <VoiceReactor
            :state="voice.state.value"
            :connected="voice.connected.value"
            :mic-analyser="voice.micAnalyser"
            :out-analyser="voice.outAnalyser"
            :on-viz-event="voice.onVizEvent"
          />
```

(The `{{ voice.state.value }}` label underneath now also shows `connecting`/`tool` — intended.)

- [x] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass

- [x] **Step 4: Commit**

```bash
git add app/components/voice/Reactor.client.vue app/pages/voice.vue
git commit -m "feat(viz): new Reactor — GPU particle core + mic ring, watchdog, fallback"
```

---

### Task 8: E2E + manual verification

**Files:** none (verification)

- [x] **Step 1: E2E with playwright-cli**

Start the dev server (`pnpm dev`, background). Then with `playwright-cli` (per project rules — not the MCP; create/reuse a test account if auth blocks you):

1. Navigate to `http://localhost:3000/voice` (log in first if redirected).
2. Assert the reactor canvas mounted: evaluate `!!document.querySelector('#voice canvas')` → `true`.
3. Assert a live WebGL2 context: evaluate `document.querySelector('#voice canvas').getContext('webgl2') !== null` → `true`.
4. Check the browser console for errors — expect none from `[viz]`.
5. Screenshot the page for the record.

Expected: canvas present, WebGL2 context live, no console errors. (Pre-connect the sphere renders in the dim `disconnected` look — correct per design.)

- [x] **Step 2: Manual pass (the human gate)**

On desktop **and** phone (LAN): connect, speak, interrupt mid-reply, trigger a tool turn ("what are my tasks"), kill the connection (stop the dev server) to see the disconnected sag, reconnect to see assembly + ignition. Judge: does it feel impressive? Tune choreographer constants (`ENERGY`/`SWIRL`/decays) and bloom strength/threshold in `scene.ts` as needed — they are deliberately centralized.

> **(manual feel-pass pending — see handover `docs/handovers/2026-06-10-voice-visualizer.md`)**

- [x] **Step 3: Commit any tuning**

```bash
git add -A app/lib/viz
git commit -m "feat(viz): tuning pass after manual review"
```

---

### Task 9: Docs — wiki, handover, roadmap

**Files:**
- Modify: `docs/wiki/voice-agent.md` (visualizer section: replace the icosahedron description with the new architecture — `lib/viz/` units, 7 states, events, quality tiers)
- Create: `docs/handovers/2026-06-09-voice-visualizer.md` with accurate frontmatter (`title`, `cycle`, `date: 2026-06-09`, `status: shipped`, `shipped:` list of every file from this plan, `deferred:` anything cut during build) — follow the structure of `docs/handovers/2026-06-09-voice-v2.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (mark the visualizer redesign shipped)

- [x] **Step 1: Update the three docs (wiki page must describe *current* behavior, not the old reactor)**
- [x] **Step 2: Commit**

```bash
git add docs/wiki/voice-agent.md docs/handovers/2026-06-09-voice-visualizer.md docs/superpowers/plans/00-roadmap.md
git commit -m "docs(voice): visualizer redesign — wiki, handover, roadmap"
```

---

## Self-Review Notes

- **Spec coverage:** types/emitter (T1), choreographer + 7 states + impulses (T2), useVoice signal surface (T3+T5), orchestrator tool state (T4), scene/bloom/tiers + core GLSL + ring + effects (T6), thin component + watchdog + context-loss + fallback + voice.vue (T7), E2E/manual (T8), docs (T9). Sparks/error/barge-in/assembly all present in shaders + effects.
- **Type consistency:** `Directives` field names match between choreographer writes and core/ring/effects reads (`energy`, `swirl`, `shatter`, `ignite`, `assemble`, `micMix`, `ringLevels`, `outLevel`, `errorFlash`, `sparks`, `pulseRate`, `dim`, `coreColor`, `ringColor`, `vizState`). `VizInputs.state` excludes `disconnected`; `VoiceState` (6 members) is assignable to it. `onVizEvent` signature identical in useVoice return, Reactor props, and voice.vue binding.
- **Known judgment calls:** mic FFT maps 128 bins → 96 bars linearly (high bins are quiet for voice — gives a natural taper); pre-connect renders as `disconnected` (intended UX); old Reactor gets a 2-line temporary palette patch in T5 to keep typecheck green until its deletion in T7.
