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
