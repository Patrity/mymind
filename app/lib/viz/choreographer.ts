// Pure TS (no Three.js): consumes voice state + events + audio levels and
// produces per-frame Directives. State changes are lerped (one deliberate hard cut: assemble resets to 0 when entering connecting).
import { BAR_COUNT } from './types'
import { PALETTE } from './tuning'
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
const TOOL_PULSE_RATE = 1.2 // pulses per second while a tool runs
const SPARKS_BASE = 8
const SPARKS_PER_CHAR = 0.25
const SPARKS_MAX = 40

const ENERGY: Record<VizState, number> = {
  connecting: 0.2, idle: 0.15, listening: 0.3, thinking: 0.4,
  speaking: 0.35, tool: 0.3, disconnected: 0.05, typing: 0.3,
}
const SWIRL: Record<VizState, number> = {
  connecting: 0, idle: 0, listening: 0, thinking: 1, speaking: 0, tool: 0.6, disconnected: 0, typing: 0,
}
const DIM: Record<VizState, number> = {
  connecting: 0.3, idle: 0.35, listening: 0, thinking: 0, speaking: 0, tool: 0, disconnected: 1, typing: 0,
}
// neural lightning: full storm while reasoning, a simmer while a tool runs, steady composing glow while typing
const FIRING: Record<VizState, number> = {
  connecting: 0, idle: 0, listening: 0, thinking: 1, speaking: 0, tool: 0.35, disconnected: 0, typing: 0.5,
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
    errorFlash: 0, firing: 0, sparks: 0, pulseRate: 0, dim: 0,
  }
  let prev: VizState | null = null
  let pendingSparks = 0

  function handleEvent(e: VizEvent) {
    if (e.type === 'bargein') d.shatter = 1
    else if (e.type === 'error') d.errorFlash = 1
    else if (e.type === 'sttFinal') pendingSparks += Math.min(SPARKS_MAX, SPARKS_BASE + Math.floor(e.chars * SPARKS_PER_CHAR))
    // 'disconnected' is derived from inputs.connected; the event needs no impulse
  }

  /**
   * Returns the SAME Directives object every frame, mutated in place (zero
   * per-frame allocation). Consumers must read it immediately — never retain
   * it (or ringLevels) across frames.
   */
  function update(inp: VizInputs, dt: number): Directives {
    dt = Math.min(dt, 0.1) // rAF can hand us seconds after a background tab — don't swallow impulses
    const s: VizState = !inp.connected && inp.state !== 'connecting' ? 'disconnected' : inp.state
    if (prev === null) prev = s
    if (s !== prev) {
      if (s === 'connecting') d.assemble = 0                          // hard cut by design: scatter, then build
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
    d.firing = approach(d.firing, FIRING[s], KNOB_SPEED, dt)
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

    d.pulseRate = s === 'tool' ? TOOL_PULSE_RATE : 0
    d.sparks = pendingSparks
    pendingSparks = 0
    return d
  }

  return { handleEvent, update }
}
