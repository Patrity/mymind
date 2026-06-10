// app/lib/viz/lightning.ts
// Neural "synapse firing" for the thinking state: short-lived jagged arcs between
// random points inside the particle core, with a small branch off each bolt.
// Pooled LineSegments, additive blending — bloom turns them into glowing lightning.
import * as THREE from 'three'
import { VIZ_TUNING } from './tuning'
import type { Directives } from './types'

const MAX_BOLTS = 14
const SEGS = 7 // main arc segments
const BRANCH_SEGS = 3
const PAIRS = SEGS + BRANCH_SEGS // line segments per bolt
const FLOATS = PAIRS * 2 * 3 // 2 verts/segment, 3 floats/vert

export function createLightning() {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(MAX_BOLTS * FLOATS)
  const col = new Float32Array(MAX_BOLTS * FLOATS)
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false

  const life = new Float32Array(MAX_BOLTS) // <= 0 means free slot
  const maxLife = new Float32Array(MAX_BOLTS)
  let acc = 0
  let spawned = false

  // random point on the (swirl-flattened) particle shell, like core.ts positions
  function endpoint(flat: number): [number, number, number] {
    const u = Math.random() * 2 - 1
    const th = Math.random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const r = 0.95 + Math.random() * 0.2
    return [s * Math.cos(th) * r, u * r * (1 - flat), s * Math.sin(th) * r]
  }

  function spawn(flat: number) {
    for (let b = 0; b < MAX_BOLTS; b++) {
      if (life[b]! > 0) continue
      const a = endpoint(flat)
      const z = endpoint(flat)
      const dist = Math.hypot(z[0] - a[0], z[1] - a[1], z[2] - a[2])
      const jag = dist * VIZ_TUNING.lightning.jag
      // jagged main path: SEGS+1 points from a to z with mid-weighted jitter
      const px: number[] = []
      const py: number[] = []
      const pz: number[] = []
      for (let i = 0; i <= SEGS; i++) {
        const f = i / SEGS
        const env = Math.sin(Math.PI * f) * jag // pinned at the endpoints
        px.push(a[0] + (z[0] - a[0]) * f + (Math.random() - 0.5) * 2 * env)
        py.push(a[1] + (z[1] - a[1]) * f + (Math.random() - 0.5) * 2 * env)
        pz.push(a[2] + (z[2] - a[2]) * f + (Math.random() - 0.5) * 2 * env)
      }
      let o = b * FLOATS
      for (let i = 0; i < SEGS; i++) {
        pos[o++] = px[i]!; pos[o++] = py[i]!; pos[o++] = pz[i]!
        pos[o++] = px[i + 1]!; pos[o++] = py[i + 1]!; pos[o++] = pz[i + 1]!
      }
      // short branch off a point ~1/3 along the bolt
      const bi = 2
      let bx = px[bi]!
      let by = py[bi]!
      let bz = pz[bi]!
      const dirx = (Math.random() - 0.5)
      const diry = (Math.random() - 0.5)
      const dirz = (Math.random() - 0.5)
      const step = (dist * 0.3) / BRANCH_SEGS
      for (let i = 0; i < BRANCH_SEGS; i++) {
        const nx = bx + dirx * step + (Math.random() - 0.5) * jag
        const ny = by + diry * step + (Math.random() - 0.5) * jag
        const nz = bz + dirz * step + (Math.random() - 0.5) * jag
        pos[o++] = bx; pos[o++] = by; pos[o++] = bz
        pos[o++] = nx; pos[o++] = ny; pos[o++] = nz
        bx = nx; by = ny; bz = nz
      }
      life[b] = maxLife[b] = 0.1 + Math.random() * 0.15
      spawned = true
      return
    }
  }

  return {
    object: lines,
    update(d: Directives, _t: number, dt: number) {
      const firing = d.firing
      if (firing > 0.05) {
        acc += dt * VIZ_TUNING.lightning.rate * firing
        while (acc >= 1) { acc -= 1; spawn(d.swirl * 0.75) }
      } else {
        acc = 0
      }
      for (let b = 0; b < MAX_BOLTS; b++) {
        if (life[b]! <= 0) continue
        life[b] = life[b]! - dt
        const k = Math.max(0, life[b]! / maxLife[b]!)
        // fast strike then decay, with a high-frequency flicker
        const br = k <= 0 ? 0 : Math.pow(k, 0.6) * (0.7 + 0.3 * Math.sin(k * 40 + b)) * VIZ_TUNING.lightning.brightness
        // electric tint: core color pushed toward white
        const r = (d.coreColor[0]! + (1 - d.coreColor[0]!) * 0.65) * br
        const g = (d.coreColor[1]! + (1 - d.coreColor[1]!) * 0.65) * br
        const bl = (d.coreColor[2]! + (1 - d.coreColor[2]!) * 0.65) * br
        for (let o = b * FLOATS; o < (b + 1) * FLOATS; o += 3) {
          col[o] = r; col[o + 1] = g; col[o + 2] = bl
        }
      }
      geo.attributes.color!.needsUpdate = true
      if (spawned) { geo.attributes.position!.needsUpdate = true; spawned = false }
    },
    dispose() { geo.dispose(); mat.dispose() },
  }
}
