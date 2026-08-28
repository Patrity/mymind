import type { VizState, VizEvent } from '../viz/types'

/**
 * State in, pixels out. The renderer sits behind this so a rigged-mesh
 * implementation can replace ParticleHead later without touching the
 * orchestrator or useVoice. The cycle-19 boundary still holds: useVoice never
 * imports Three.js, and nothing under lib/avatar touches the WebSocket.
 */
export interface Avatar {
  setState(s: VizState): void
  pushEvent(e: VizEvent): void
  setAnalysers(mic: AnalyserNode | null, out: AnalyserNode | null): void
  resize(w: number, h: number): void
  dispose(): void
}

export interface Pose {
  /** Radians. Positive = turned toward the viewer's right. */
  yaw: number
  /** Radians. POSITIVE = LOOKING UP. Inverting this is what made "thinking" stare down. */
  pitch: number
  /** 0..1, drives the baked jawW displacement. */
  jaw: number
  /** 0..1, brow lift on stressed syllables. */
  brow: number
  /** Multiplier on eye-region brightness. */
  eyeGain: number
  /** 0..1 assembly progress for the connecting intro. */
  assemble: number
  /** 0..1 vertical position of the amber tool scan; 0 = inactive. */
  scan: number
}
