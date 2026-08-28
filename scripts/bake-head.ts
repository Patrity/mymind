// scripts/bake-head.ts
// Build-time only. Reads a MakeHuman export, area-weighted-samples points across the
// surface, computes per-point region weights, and writes a packed Float32Array.
// The browser NEVER loads a mesh or a GLTF loader — only the resulting buffer.
//
// Layout per point (9 floats): x, y, z, nx, ny, nz, jawW, eyeW, browW.
import { writeFileSync } from 'node:fs'
import { NodeIO } from '@gltf-transform/core'

export interface HeadMetrics {
  lipY: number
  chinY: number
  eyeY: number
  browY: number
  hingeInner: number
  hingeOuter: number
  faceHalfWidth: number
}

export const FLOATS_PER_POINT = 9

function smoothstep(a: number, b: number, x: number): number {
  // Guard a degenerate zero-width band (a === b): a plain (x-a)/(b-a) is 0/0 = NaN
  // exactly at x === a. Falls back to a hard step so region weights stay in [0,1]
  // even for degenerate metrics (e.g. faceHalfWidth === 0 from a corrupt/flat mesh).
  const denom = b - a
  const t = denom === 0 ? (x < a ? 0 : 1) : Math.max(0, Math.min(1, (x - a) / denom))
  return t * t * (3 - 2 * t)
}

/**
 * Smooth jaw weight. Zero at the upper lip, full at the chin, reduced toward the
 * hinge so the jaw ARCS. A binary region translated as a block visibly cleaves the
 * head at the lip line — that was the defect the brainstorm sketch exposed.
 * The ** 0.6 curve lifts the low end so the lower lip trails the chin (~25%)
 * instead of barely moving, which is what makes the mouth read as opening.
 */
export function jawWeight(y: number, x: number, m: HeadMetrics): number {
  const vert = Math.pow(smoothstep(m.lipY, m.chinY, y), 0.6)
  const hinge = 1 - 0.6 * smoothstep(m.hingeInner, m.hingeOuter, Math.abs(x))
  return Math.max(0, Math.min(1, vert * hinge))
}

export function regionWeights(
  p: { x: number; y: number; z: number },
  m: HeadMetrics
): { jaw: number; eye: number; brow: number } {
  const band = (centre: number, halfHeight: number) => 1 - smoothstep(0, halfHeight, Math.abs(p.y - centre))
  // Away from the midline (the nose bridge is not an eye) and inside the face width.
  const lateral = smoothstep(0.10, 0.28, Math.abs(p.x)) * (1 - smoothstep(m.faceHalfWidth * 0.75, m.faceHalfWidth, Math.abs(p.x)))
  return {
    jaw: jawWeight(p.y, p.x, m),
    eye: band(m.eyeY, 0.12) * lateral,
    brow: band(m.browY, 0.09) * lateral
  }
}

/** Area-weighted surface sampling: pick a triangle proportional to its area, then a
 *  uniform barycentric point inside it. Uniform-by-vertex would clump on dense regions. */
export function sampleSurface(
  positions: Float32Array,
  indices: Uint32Array,
  count: number,
  rng: () => number
): { x: number; y: number; z: number }[] {
  const triCount = indices.length / 3
  const cumulative = new Float64Array(triCount)
  let total = 0
  for (let t = 0; t < triCount; t++) {
    const [i0, i1, i2] = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!]
    const ax = positions[i1 * 3]! - positions[i0 * 3]!
    const ay = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!
    const az = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!
    const bx = positions[i2 * 3]! - positions[i0 * 3]!
    const by = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!
    const bz = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
    total += 0.5 * Math.hypot(cx, cy, cz)
    cumulative[t] = total
  }

  const out: { x: number; y: number; z: number }[] = []
  for (let n = 0; n < count; n++) {
    const target = rng() * total
    let lo = 0, hi = triCount - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid]! < target) lo = mid + 1; else hi = mid }
    const [i0, i1, i2] = [indices[lo * 3]!, indices[lo * 3 + 1]!, indices[lo * 3 + 2]!]
    let u = rng(), v = rng()
    if (u + v > 1) { u = 1 - u; v = 1 - v }
    const w = 1 - u - v
    out.push({
      x: positions[i0 * 3]! * w + positions[i1 * 3]! * u + positions[i2 * 3]! * v,
      y: positions[i0 * 3 + 1]! * w + positions[i1 * 3 + 1]! * u + positions[i2 * 3 + 1]! * v,
      z: positions[i0 * 3 + 2]! * w + positions[i1 * 3 + 2]! * u + positions[i2 * 3 + 2]! * v
    })
  }
  return out
}

async function main() {
  const src = process.argv[2] ?? 'assets/source/bridget-head.glb'
  const dst = process.argv[3] ?? 'app/assets/head-points.bin'
  const COUNT = 50_000   // matches the existing desktop quality tier

  const io = new NodeIO()
  const doc = await io.read(src)
  const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
  const positions = prim.getAttribute('POSITION')!.getArray() as Float32Array
  const indices = Uint32Array.from(prim.getIndices()!.getArray()!)

  // Normalize into head-local space: origin between the eyes, unit ~= head half-width.
  let minY = Infinity, maxY = -Infinity, maxX = 0
  for (let i = 0; i < positions.length; i += 3) {
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!)
    maxX = Math.max(maxX, Math.abs(positions[i]!))
  }
  const scale = 1 / maxX
  const midY = (minY + maxY) / 2

  // Proportions as fractions of the normalized head. Tune by eye against the render
  // and re-run — the bake is cheap.
  const m: HeadMetrics = {
    browY: 0.30, eyeY: 0.16, lipY: -0.42, chinY: -0.95,
    hingeInner: 0.30, hingeOuter: 0.90, faceHalfWidth: 1.0
  }

  let seed = 12345
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

  const pts = sampleSurface(positions, indices, COUNT, rng)
  const buf = new Float32Array(COUNT * FLOATS_PER_POINT)

  pts.forEach((raw, i) => {
    const p = { x: raw.x * scale, y: (raw.y - midY) * scale, z: raw.z * scale }
    const w = regionWeights(p, m)
    const o = i * FLOATS_PER_POINT
    buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z
    buf[o + 3] = 0; buf[o + 4] = 0; buf[o + 5] = 1   // normals filled by the renderer if needed
    buf[o + 6] = w.jaw; buf[o + 7] = w.eye; buf[o + 8] = w.brow
  })

  writeFileSync(dst, Buffer.from(buf.buffer))
  console.log(`baked ${COUNT} points -> ${dst} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`)
}

// Only run when invoked directly, so the pure functions above stay importable by tests.
if (process.argv[1]?.endsWith('bake-head.ts')) void main()
