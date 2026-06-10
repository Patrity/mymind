// Shared contracts for the voice visualizer. Pure TS — no Three.js imports here.

export const BAR_COUNT = 96

export type VizState =
  | 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool'
  | 'disconnected' // derived by the choreographer from connected === false

export type VizEvent =
  | { type: 'bargein' }
  | { type: 'error' }
  | { type: 'sttFinal'; chars: number }
  // NOTE: the choreographer ignores this event — the disconnected VISUAL state is
  // derived structurally from VizInputs.connected. Emitted for future consumers only.
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
  firing: number       // 0..1 neural-lightning intensity (thinking/tool)
  sparks: number       // spark particles to spawn THIS frame (consumed)
  pulseRate: number    // tool pulses per second (0 = off)
  dim: number          // 0..1 overall dimming (idle/disconnected)
}

// State colors (PALETTE) and all other visual knobs live in ./tuning.ts.
