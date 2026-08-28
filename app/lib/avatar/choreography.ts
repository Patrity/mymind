// Pure pose state machine. EVERY motion is event-scheduled against an injected RNG —
// nothing is a periodic function. The first sketch used summed sines throughout and
// read as an obvious loop, which is the specific thing this file exists to avoid.
import type { VizState } from '../viz/types'
import type { Pose } from './types'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function createChoreographer(rng: () => number = Math.random) {
  const rand = (a: number, b: number) => a + rng() * (b - a)

  let yaw = 0, pitch = 0, jaw = 0, brow = 0, assemble = 0, scan = 0, eyeGain = 1
  let t = 0

  // thinking: saccade targets held for a random interval
  let gazeYaw = 0, gazePitch = 0.24, gazeHold = 0
  // listening: nods at random intervals, sometimes doubled
  let nodTimer = rand(1.0, 2.6), nodPhase = 0, nodDepth = 0.11, nodDouble = false
  // idle: micro-saccades
  let idleYaw = 0, idleTimer = rand(1.2, 3.5)
  // speaking: syllables grouped into phrases with pauses
  let sylLeft = 0, sylLen = 0, sylPeak = 0, gapLeft = 0
  let phraseLeft = Math.round(rand(5, 12)), pauseLeft = 0, phraseNudge = 0

  /** Syllable-and-phrase envelope. Scaled by the live TTS output level so a quiet
   *  passage does not drive a wide-open jaw. */
  function speechEnvelope(dt: number, outLevel: number): number {
    let target: number
    if (pauseLeft > 0) { pauseLeft -= dt; target = 0 }
    else if (gapLeft > 0) { gapLeft -= dt; target = 0.04 }
    else if (sylLeft > 0) {
      const p = 1 - sylLeft / sylLen
      const env = p < 0.28 ? p / 0.28 : 1 - (p - 0.28) / 0.72
      target = sylPeak * Math.max(0, env)
      sylLeft -= dt
    } else {
      sylLen = sylLeft = rand(0.10, 0.25)
      sylPeak = rand(0.32, 1)
      gapLeft = rand(0.02, 0.12)
      if (--phraseLeft <= 0) {
        pauseLeft = rand(0.30, 0.78)
        phraseLeft = Math.round(rand(5, 12))
        phraseNudge = rand(-1, 1)
      }
      target = 0
    }
    return target * Math.max(0.25, Math.min(1, outLevel || 0.75))
  }

  function step(state: VizState, dt: number, outLevel = 0): Pose {
    t += dt
    assemble = state === 'connecting'
      ? Math.min(1, assemble + dt * 0.55)
      : Math.min(1, assemble + dt * 1.2)

    let tYaw = 0, tPitch = 0, ease = 3.0
    let tEyeGain = 1

    if (state === 'idle') {
      if ((idleTimer -= dt) <= 0) { idleYaw = rand(-0.07, 0.07); idleTimer = rand(1.2, 3.6) }
      tYaw = idleYaw
      tPitch = 0
    }
    else if (state === 'listening') {
      if ((nodTimer -= dt) <= 0) {
        nodPhase = 1; nodDepth = rand(0.08, 0.16)
        nodDouble = rng() < 0.34
        nodTimer = rand(1.6, 3.8)
      }
      if (nodPhase > 0) nodPhase = Math.max(0, nodPhase - dt * 1.6)
      // NEGATIVE pitch = chin down = a nod.
      tPitch = nodPhase > 0 ? -Math.sin((1 - nodPhase) * Math.PI * (nodDouble ? 2 : 1)) * nodDepth : 0
      tYaw = 0.24
      ease = 5.0
      tEyeGain = 2.0
    }
    else if (state === 'thinking') {
      if ((gazeHold -= dt) <= 0) {
        gazeYaw = rand(-0.34, 0.34)
        gazePitch = rand(0.18, 0.34)      // POSITIVE = looking up
        gazeHold = rand(0.5, 2.0)
      }
      tYaw = gazeYaw; tPitch = gazePitch
      ease = 7.0                           // saccades snap
      tEyeGain = 1.5
    }
    else if (state === 'speaking') {
      const target = speechEnvelope(dt, outLevel)
      jaw = lerp(jaw, target, Math.min(1, dt * 18))
      brow = lerp(brow, jaw > 0.55 ? 1 : 0, Math.min(1, dt * 8))
      tYaw = phraseNudge * 0.05
      tPitch = -jaw * 0.03
      ease = 4.5
    }
    else if (state === 'tool') {
      scan = (scan + dt * 0.55) % 1.35
    }

    if (state !== 'speaking') {
      jaw = lerp(jaw, 0, Math.min(1, dt * 10))
      brow = lerp(brow, 0, Math.min(1, dt * 6))
    }
    // Leaving tool mid-sweep fades the scan out instead of popping it to 0 —
    // a hard reset here is visible as an instant snap in the renderer.
    if (state !== 'tool') scan = lerp(scan, 0, Math.min(1, dt * 8))

    yaw = lerp(yaw, tYaw, Math.min(1, dt * ease))
    pitch = lerp(pitch, tPitch, Math.min(1, dt * ease))
    // eyeGain is a per-frame target above (tEyeGain); smoothed here so a state
    // switch (e.g. listening -> idle) fades brightness instead of popping it.
    eyeGain = lerp(eyeGain, tEyeGain, Math.min(1, dt * 6))

    return { yaw, pitch, jaw, brow, eyeGain, assemble, scan }
  }

  return { step }
}
