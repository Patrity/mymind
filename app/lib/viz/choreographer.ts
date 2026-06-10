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
