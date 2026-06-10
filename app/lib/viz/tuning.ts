// app/lib/viz/tuning.ts
// Every headline visual knob for the voice visualizer in one place.
// Motion/timing constants (lerp speeds, impulse decays, per-state energy/swirl/dim
// tables) live in choreographer.ts; quality tiers (particle counts, pixel-ratio
// caps) live in scene.ts detectTier().
import type { VizState } from './types'

export const VIZ_TUNING = {
  camera: {
    fov: 50,
    z: 9, // start distance — bigger = more zoomed out
    minZ: 4.5, // scroll-zoom clamp (closest)
    maxZ: 16, // scroll-zoom clamp (farthest)
    wheelSensitivity: 0.008, // world units per wheel deltaY pixel
  },
  bloom: {
    strength: 0.3, // >1 blows the additive core out to a white blob
    radius: 0.5,
    threshold: 0.3, // only the brightest pixels bloom
  },
  core: {
    pointSize: 0.085, // base gl_PointSize factor (≈2px at the default camera distance)
    alpha: 0.55, // global particle opacity — additive overlap whites out above ~0.7
  },
  ring: {
    radius: 2.5, // world units from center to the mic bars
  },
  lightning: {
    rate: 22, // bolts per second at full thinking intensity
    brightness: 1, // bolt color multiplier (additive — bloom amplifies it)
    jag: 0.18, // jitter amplitude as a fraction of arc length
  },
} as const

function hex(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
}

/** Core sphere + mic ring colors per visual state. */
export const PALETTE: Record<VizState, { core: [number, number, number]; ring: [number, number, number] }> = {
  connecting: { core: hex(0x27457a), ring: hex(0x16233f) },
  idle: { core: hex(0x3b82f6), ring: hex(0x1e3a5f) },
  listening: { core: hex(0x3b82f6), ring: hex(0x22d3ee) },
  thinking: { core: hex(0x8b5cf6), ring: hex(0x312e51) },
  speaking: { core: hex(0x22d3ee), ring: hex(0x155e75) },
  tool: { core: hex(0xf59e0b), ring: hex(0x78350f) },
  disconnected: { core: hex(0x475569), ring: hex(0x1e293b) },
}
