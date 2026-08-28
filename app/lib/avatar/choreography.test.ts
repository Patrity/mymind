import { describe, it, expect } from 'vitest'
import { createChoreographer } from './choreography'

/** Deterministic RNG so scheduled events are assertable. */
function seeded(seed = 1) {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
}

function run(state: Parameters<ReturnType<typeof createChoreographer>['step']>[0], frames: number, out = 0) {
  const c = createChoreographer(seeded())
  const poses = []
  for (let i = 0; i < frames; i++) poses.push({ ...c.step(state, 1 / 60, out) })
  return poses
}

describe('choreography', () => {
  it('thinking looks UP — positive pitch', () => {
    const poses = run('thinking', 240)
    const settled = poses.slice(120)
    expect(Math.max(...settled.map(p => p.pitch))).toBeGreaterThan(0.1)
    expect(settled.every(p => p.pitch > -0.05)).toBe(true)
  })

  it('thinking saccades — the gaze holds, then jumps, and does not sweep smoothly', () => {
    const yaws = run('thinking', 600).map(p => p.yaw)
    const deltas = yaws.slice(1).map((y, i) => Math.abs(y - yaws[i]!))
    const big = deltas.filter(d => d > 0.004).length
    // A smooth sine sweep moves on nearly every frame; saccades move on a minority.
    expect(big).toBeGreaterThan(5)
    expect(big).toBeLessThan(yaws.length * 0.5)
  })

  it('listening turns toward the viewer and holds', () => {
    const poses = run('listening', 300).slice(150)
    expect(Math.min(...poses.map(p => p.yaw))).toBeGreaterThan(0.1)
  })

  it('listening nods DOWN — negative pitch excursions', () => {
    const poses = run('listening', 900)
    expect(Math.min(...poses.map(p => p.pitch))).toBeLessThan(-0.03)
  })

  it('speaking drives the jaw from the output level and rests between phrases', () => {
    const poses = run('speaking', 600, 0.8)
    const jaws = poses.map(p => p.jaw)
    expect(Math.max(...jaws)).toBeGreaterThan(0.3)
    expect(Math.min(...jaws)).toBeLessThan(0.05)
  })

  it('speaking does not repeat: two different seeds diverge', () => {
    const a = createChoreographer(seeded(1))
    const b = createChoreographer(seeded(99))
    const ja: number[] = []; const jb: number[] = []
    for (let i = 0; i < 400; i++) { ja.push(a.step('speaking', 1 / 60, 0.8).jaw); jb.push(b.step('speaking', 1 / 60, 0.8).jaw) }
    expect(ja.join(',')).not.toBe(jb.join(','))
  })

  it('is deterministic for a given seed', () => {
    const one = run('thinking', 200).map(p => p.yaw.toFixed(4)).join(',')
    const two = run('thinking', 200).map(p => p.yaw.toFixed(4)).join(',')
    expect(one).toBe(two)
  })

  it('connecting ramps assemble from 0 toward 1', () => {
    const poses = run('connecting', 300)
    expect(poses[0]!.assemble).toBeLessThan(0.1)
    expect(poses[poses.length - 1]!.assemble).toBeGreaterThan(0.9)
  })

  it('idle keeps the head near neutral', () => {
    const poses = run('idle', 600)
    expect(Math.max(...poses.map(p => Math.abs(p.yaw)))).toBeLessThan(0.15)
  })

  it('tool sweeps a scan value across the face', () => {
    const scans = run('tool', 300).map(p => p.scan)
    expect(Math.max(...scans)).toBeGreaterThan(0.5)
  })

  // Mid-motion state changes must ease out, never pop. A renderer painting eye
  // brightness or the tool scan directly off these values would show a visible
  // flash/snap on a single-frame discontinuity.
  it('leaving listening mid-nod fades eyeGain instead of snapping it', () => {
    const c = createChoreographer(seeded())
    let before = { eyeGain: 1 }
    for (let i = 0; i < 120; i++) before = c.step('listening', 1 / 60, 0)
    expect(before.eyeGain).toBeCloseTo(2.0, 1)
    const after = c.step('idle', 1 / 60, 0)
    expect(Math.abs(after.eyeGain - before.eyeGain)).toBeLessThan(0.1)
  })

  it('leaving tool mid-sweep fades scan toward 0 instead of snapping it', () => {
    const c = createChoreographer(seeded())
    let before = { scan: 0 }
    for (let i = 0; i < 30; i++) before = c.step('tool', 1 / 60, 0)
    expect(before.scan).toBeGreaterThan(0.1)
    const after = c.step('idle', 1 / 60, 0)
    expect(Math.abs(after.scan - before.scan)).toBeLessThan(0.1)
    // and it does eventually settle at 0 rather than getting stuck
    let last = after
    for (let i = 0; i < 60; i++) last = c.step('idle', 1 / 60, 0)
    expect(last.scan).toBeCloseTo(0, 2)
  })

  it('leaving thinking mid-saccade does not jump yaw/pitch by more than one frame\'s worth of easing', () => {
    const c = createChoreographer(seeded())
    let before = { yaw: 0, pitch: 0 }
    for (let i = 0; i < 45; i++) before = c.step('thinking', 1 / 60, 0)
    const after = c.step('idle', 1 / 60, 0)
    // ease constants in this module cap movement per-frame; nothing should teleport.
    expect(Math.abs(after.yaw - before.yaw)).toBeLessThan(0.3)
    expect(Math.abs(after.pitch - before.pitch)).toBeLessThan(0.3)
  })

  it('leaving speaking mid-syllable decays the jaw rather than leaving it stuck open', () => {
    const c = createChoreographer(seeded())
    let before = { jaw: 0 }
    for (let i = 0; i < 20; i++) before = c.step('speaking', 1 / 60, 0.9)
    const after = c.step('listening', 1 / 60, 0)
    expect(after.jaw).toBeLessThanOrEqual(before.jaw)
    let last = after
    for (let i = 0; i < 60; i++) last = c.step('listening', 1 / 60, 0)
    expect(last.jaw).toBeCloseTo(0, 2)
  })
})
