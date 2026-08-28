// scripts/bake-head.ts
// Build-time only. Reads a MakeHuman export, area-weighted-samples points across the
// surface, computes per-point region weights, and writes a packed Float32Array.
// The browser NEVER loads a mesh or a GLTF loader — only the resulting buffer.
//
// Layout per point (9 floats): x, y, z, nx, ny, nz, jawW, eyeW, browW.
import { writeFileSync } from 'node:fs'
import { NodeIO, Primitive, type Document, type mat4 } from '@gltf-transform/core'

export interface HeadMetrics {
  lipY: number
  chinY: number
  eyeY: number
  browY: number
  hingeInner: number
  hingeOuter: number
  faceHalfWidth: number
  /**
   * Height at which jaw influence has faded to zero, BELOW the chin. Optional: when
   * omitted the weight simply saturates past `chinY`, which is the old behaviour.
   *
   * This exists because `smoothstep` clamps to 1 past its upper bound, so every point
   * below `chinY` — the whole neck — was receiving FULL jaw weight. With
   * `jawTravel: 0.3` against a head spanning ~2.4 units, the neck dropped 12% of head
   * height on every spoken syllable: the face's whole lower half sliding down, which
   * is the same artifact class as the binary-region cleave this weighting exists to
   * prevent. The jaw's underside should move; the neck should not.
   */
  neckY?: number
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
  // Fade influence out below the jawline so the neck stays put. Without this the
  // ramp saturates at 1 forever below `chinY` and the neck travels with the chin.
  // Omitting `neckY` keeps the old saturating behaviour.
  const neck = m.neckY === undefined ? 1 : 1 - smoothstep(m.chinY, m.neckY, y)
  return Math.max(0, Math.min(1, vert * hinge * neck))
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

/**
 * Area-weighted surface sampling: pick a triangle proportional to its area, then a uniform
 * barycentric point inside it. Uniform-by-vertex would clump on dense regions.
 *
 * Normals are resolved with the SAME (u, v, w) barycentric weights used for position, so shading
 * and geometry stay consistent: where a triangle's vertices carry real NORMAL data (hasNormal),
 * the normal is smoothly interpolated and renormalized; otherwise it falls back to that
 * triangle's flat geometric face normal (the cross product already computed for area-weighting,
 * reused here rather than recomputed).
 */
/**
 * Samples points at EVEN ARC SPACING ALONG MESH EDGES rather than randomly across faces.
 *
 * This is what makes the cloud read as a face. Random surface sampling produces an
 * evenly-noisy shell with no structure: on a 6232-triangle head every feature — the eye
 * loops, the nostril rim, the lip line — dissolves into uniform speckle, and the result
 * looks like a smooth egg no matter how many points you throw at it.
 *
 * A modeller's topology already encodes the anatomy: edge loops crowd around the eyes,
 * nose and mouth and spread out across the cheeks and skull. Walking the edges at a
 * constant spacing therefore concentrates points exactly where the features are, and
 * reproduces the woven wireframe look of the reference image, which is a wireframe.
 *
 * Each undirected edge is walked once (deduplicated), so shared edges aren't
 * double-weighted. Normals are linearly interpolated along the edge.
 */
export function sampleEdges(
  positions: Float32Array,
  indices: Uint32Array,
  normals0: Float32Array,
  hasNormal: Uint8Array,
  count: number
): { x: number; y: number; z: number; nx: number; ny: number; nz: number }[] {
  // A vertex whose primitive carried no NORMAL attribute has a zeroed entry, and an edge
  // has no face of its own to fall back on. Accumulate adjacent face normals per vertex
  // first, so those vertices still get a usable direction — otherwise they emit a
  // zero-length normal, the shader's facing term degenerates, and those points render at
  // full brightness through the skull. `sampleSurface` gets this for free from the face
  // it sampled; edge walking has to build it.
  let normals = normals0
  const effNormals = new Float32Array(normals)
  {
    const needs = new Set<number>()
    for (let v = 0; v < hasNormal.length; v++) if (!hasNormal[v]) needs.add(v)
    if (needs.size) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!
        if (!needs.has(a) && !needs.has(b) && !needs.has(c)) continue
        const ax = positions[b * 3]! - positions[a * 3]!
        const ay = positions[b * 3 + 1]! - positions[a * 3 + 1]!
        const az = positions[b * 3 + 2]! - positions[a * 3 + 2]!
        const bx = positions[c * 3]! - positions[a * 3]!
        const by = positions[c * 3 + 1]! - positions[a * 3 + 1]!
        const bz = positions[c * 3 + 2]! - positions[a * 3 + 2]!
        // Not normalised: the cross product's magnitude is twice the triangle area, so
        // accumulating raw gives an area-weighted average, which is what you want.
        const fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx
        for (const v of [a, b, c]) {
          if (!needs.has(v)) continue
          effNormals[v * 3] += fx
          effNormals[v * 3 + 1] += fy
          effNormals[v * 3 + 2] += fz
        }
      }
      for (const v of needs) {
        const l = Math.hypot(effNormals[v * 3]!, effNormals[v * 3 + 1]!, effNormals[v * 3 + 2]!)
        if (l > 0) {
          effNormals[v * 3] /= l
          effNormals[v * 3 + 1] /= l
          effNormals[v * 3 + 2] /= l
        } else {
          // Fully degenerate (zero-area faces): any unit vector beats a zero one.
          effNormals[v * 3] = 0; effNormals[v * 3 + 1] = 0; effNormals[v * 3 + 2] = 1
        }
      }
    }
  }
  normals = effNormals

  // Unique undirected edges.
  const seen = new Set<number>()
  const edges: [number, number][] = []
  const key = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a)
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = key(u, v)
      if (!seen.has(k)) { seen.add(k); edges.push([u, v]) }
    }
  }
  if (!edges.length) return []

  const lengths = edges.map(([u, v]) => Math.hypot(
    positions[v * 3]! - positions[u * 3]!,
    positions[v * 3 + 1]! - positions[u * 3 + 1]!,
    positions[v * 3 + 2]! - positions[u * 3 + 2]!
  ))
  const total = lengths.reduce((s, l) => s + l, 0)
  if (total === 0) return []

  const out: { x: number; y: number; z: number; nx: number; ny: number; nz: number }[] = []
  const spacing = total / count
  let carry = 0
  for (let e = 0; e < edges.length && out.length < count; e++) {
    const [u, v] = edges[e]!
    const len = lengths[e]!
    if (len === 0) continue
    // Walk this edge, continuing the running arc position from the previous one so
    // spacing stays even across the whole mesh instead of restarting per edge.
    for (let d = spacing - carry; d < len && out.length < count; d += spacing) {
      const t = d / len
      const nx = normals[u * 3]! + (normals[v * 3]! - normals[u * 3]!) * t
      const ny = normals[u * 3 + 1]! + (normals[v * 3 + 1]! - normals[u * 3 + 1]!) * t
      const nz = normals[u * 3 + 2]! + (normals[v * 3 + 2]! - normals[u * 3 + 2]!) * t
      const nl = Math.hypot(nx, ny, nz) || 1
      out.push({
        x: positions[u * 3]! + (positions[v * 3]! - positions[u * 3]!) * t,
        y: positions[u * 3 + 1]! + (positions[v * 3 + 1]! - positions[u * 3 + 1]!) * t,
        z: positions[u * 3 + 2]! + (positions[v * 3 + 2]! - positions[u * 3 + 2]!) * t,
        nx: nx / nl, ny: ny / nl, nz: nz / nl
      })
    }
    carry = (carry + len) % spacing
  }
  return out
}

export function sampleSurface(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
  hasNormal: Uint8Array,
  count: number,
  rng: () => number
): { x: number; y: number; z: number; nx: number; ny: number; nz: number }[] {
  const triCount = indices.length / 3
  const cumulative = new Float64Array(triCount)
  const faceNx = new Float64Array(triCount)
  const faceNy = new Float64Array(triCount)
  const faceNz = new Float64Array(triCount)
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
    const faceLen = Math.hypot(cx, cy, cz)
    total += 0.5 * faceLen
    cumulative[t] = total
    const invFaceLen = faceLen > 0 ? 1 / faceLen : 0
    faceNx[t] = cx * invFaceLen; faceNy[t] = cy * invFaceLen; faceNz[t] = cz * invFaceLen
  }

  const out: { x: number; y: number; z: number; nx: number; ny: number; nz: number }[] = []
  for (let n = 0; n < count; n++) {
    const target = rng() * total
    let lo = 0, hi = triCount - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid]! < target) lo = mid + 1; else hi = mid }
    const [i0, i1, i2] = [indices[lo * 3]!, indices[lo * 3 + 1]!, indices[lo * 3 + 2]!]
    let u = rng(), v = rng()
    if (u + v > 1) { u = 1 - u; v = 1 - v }
    const w = 1 - u - v

    let nx: number, ny: number, nz: number
    if (hasNormal[i0]) {
      nx = normals[i0 * 3]! * w + normals[i1 * 3]! * u + normals[i2 * 3]! * v
      ny = normals[i0 * 3 + 1]! * w + normals[i1 * 3 + 1]! * u + normals[i2 * 3 + 1]! * v
      nz = normals[i0 * 3 + 2]! * w + normals[i1 * 3 + 2]! * u + normals[i2 * 3 + 2]! * v
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len; ny /= len; nz /= len
    } else {
      nx = faceNx[lo]!; ny = faceNy[lo]!; nz = faceNz[lo]!
    }

    out.push({
      x: positions[i0 * 3]! * w + positions[i1 * 3]! * u + positions[i2 * 3]! * v,
      y: positions[i0 * 3 + 1]! * w + positions[i1 * 3 + 1]! * u + positions[i2 * 3 + 1]! * v,
      z: positions[i0 * 3 + 2]! * w + positions[i1 * 3 + 2]! * u + positions[i2 * 3 + 2]! * v,
      nx, ny, nz
    })
  }
  return out
}

export interface MergedGeometry {
  positions: Float32Array
  indices: Uint32Array
  /** Per-vertex world-space normal, unit length where `hasNormal` is set; zero-filled otherwise
   *  (the sampler falls back to a flat face normal for those vertices instead of using this). */
  normals: Float32Array
  /** 1 where the source primitive carried a NORMAL attribute for this vertex, else 0. Uniform
   *  across a primitive's vertex range, since NORMAL presence is a per-primitive property. */
  hasNormal: Uint8Array
}

/**
 * Transforms a local-space point by a glTF node's world matrix. `mat4` is column-major
 * (gl-matrix convention) — this is the same math @gltf-transform/core's own internal
 * `transformMat4` helper uses (src/utils/get-bounds.ts, not publicly exported) to compute
 * mesh bounds from `Node.getWorldMatrix()`, verified by reading the installed package's
 * compiled output.
 */
function transformPosition(x: number, y: number, z: number, m: mat4): [number, number, number] {
  let w = m[3] * x + m[7] * y + m[11] * z + m[15]
  w = w || 1
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w
  ]
}

/**
 * Transforms a normal vector by a node's NORMAL matrix — the inverse-transpose of the
 * upper-left 3x3 of its world matrix, not the world matrix itself, so a non-uniform scale
 * doesn't skew the direction. Derived directly here via the adjugate/cofactor formula for a
 * 3x3 inverse (standard linear algebra, independently re-derivable, not a guessed library API):
 * for matrix [[a,b,c],[d,e,f],[g,h,i]], transpose(inverse) has rows
 *   [(ei-fh), (fg-di), (dh-eg)] / det,
 *   [(ch-bi), (ai-cg), (bg-ah)] / det,
 *   [(bf-ce), (cd-af), (ae-bd)] / det.
 * For a pure rotation (the common case — no non-uniform scale) this reduces to the rotation
 * itself, since a rotation matrix's inverse-transpose is the matrix.
 */
function transformNormal(x: number, y: number, z: number, m: mat4): [number, number, number] {
  const a = m[0], b = m[4], c = m[8]
  const d = m[1], e = m[5], f = m[9]
  const g = m[2], h = m[6], i = m[10]

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (det === 0) return [x, y, z] // degenerate transform (e.g. zero scale) — pass through unchanged

  const invDet = 1 / det
  const n00 = (e * i - f * h) * invDet, n01 = (f * g - d * i) * invDet, n02 = (d * h - e * g) * invDet
  const n10 = (c * h - b * i) * invDet, n11 = (a * i - c * g) * invDet, n12 = (b * g - a * h) * invDet
  const n20 = (b * f - c * e) * invDet, n21 = (c * d - a * f) * invDet, n22 = (a * e - b * d) * invDet

  return [
    n00 * x + n01 * y + n02 * z,
    n10 * x + n11 * y + n12 * z,
    n20 * x + n21 * y + n22 * z
  ]
}

/**
 * Merges every triangle primitive of every mesh-instancing node in the document into one
 * position/index set, in world space.
 *
 * MPFB2 (the Blender addon this pipeline exports from) produces the body, hair and eyes as
 * separate objects, each of which may carry multiple materials/primitives, and hair/eyes are
 * routinely offset from the origin by their node's transform. Reading only the first mesh's
 * first primitive (the old behaviour) silently drops everything else and bakes a valid-looking
 * but wrong buffer. This walks `doc.getRoot().listNodes()` (the scene graph) rather than
 * `listMeshes()`, so every node's `getWorldMatrix()` — which composes the full parent chain,
 * per the compiled implementation — is applied to that node's mesh data. A mesh instanced by
 * multiple nodes contributes once per node, each with its own transform.
 *
 * Primitives with no POSITION attribute, no indices, or a non-triangle topology are skipped
 * rather than throwing, since the downstream sampler assumes an indexed triangle list.
 */
export function mergeSceneGeometry(doc: Document): MergedGeometry {
  const positionChunks: Float32Array[] = []
  const indexChunks: Uint32Array[] = []
  const normalChunks: Float32Array[] = []
  const hasNormalChunks: Uint8Array[] = []
  let vertexOffset = 0

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const worldMatrix = node.getWorldMatrix()

    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue

      const positionAttr = prim.getAttribute('POSITION')
      const indicesAttr = prim.getIndices()
      if (!positionAttr || !indicesAttr) continue

      const localPositions = positionAttr.getArray() as Float32Array | null
      const localIndices = indicesAttr.getArray()
      if (!localPositions || !localIndices || localPositions.length === 0 || localIndices.length === 0) continue

      const vertexCount = localPositions.length / 3
      const worldPositions = new Float32Array(localPositions.length)

      const normalAttr = prim.getAttribute('NORMAL')
      const localNormals = normalAttr ? (normalAttr.getArray() as Float32Array | null) : null
      const primHasNormal = !!(localNormals && localNormals.length === localPositions.length)
      const worldNormals = new Float32Array(localPositions.length) // zero-filled when primHasNormal is false
      const hasNormalChunk = new Uint8Array(vertexCount)
      if (primHasNormal) hasNormalChunk.fill(1)

      for (let v = 0; v < vertexCount; v++) {
        const [wx, wy, wz] = transformPosition(
          localPositions[v * 3]!, localPositions[v * 3 + 1]!, localPositions[v * 3 + 2]!, worldMatrix
        )
        worldPositions[v * 3] = wx
        worldPositions[v * 3 + 1] = wy
        worldPositions[v * 3 + 2] = wz

        if (primHasNormal) {
          const [nx, ny, nz] = transformNormal(
            localNormals![v * 3]!, localNormals![v * 3 + 1]!, localNormals![v * 3 + 2]!, worldMatrix
          )
          const len = Math.hypot(nx, ny, nz) || 1
          worldNormals[v * 3] = nx / len
          worldNormals[v * 3 + 1] = ny / len
          worldNormals[v * 3 + 2] = nz / len
        }
      }
      positionChunks.push(worldPositions)
      normalChunks.push(worldNormals)
      hasNormalChunks.push(hasNormalChunk)
      indexChunks.push(Uint32Array.from(localIndices, i => i + vertexOffset))
      vertexOffset += vertexCount
    }
  }

  const positions = new Float32Array(positionChunks.reduce((n, c) => n + c.length, 0))
  const indices = new Uint32Array(indexChunks.reduce((n, c) => n + c.length, 0))
  const normals = new Float32Array(normalChunks.reduce((n, c) => n + c.length, 0))
  const hasNormal = new Uint8Array(hasNormalChunks.reduce((n, c) => n + c.length, 0))
  let po = 0, io = 0, no = 0, ho = 0
  for (const c of positionChunks) { positions.set(c, po); po += c.length }
  for (const c of indexChunks) { indices.set(c, io); io += c.length }
  for (const c of normalChunks) { normals.set(c, no); no += c.length }
  for (const c of hasNormalChunks) { hasNormal.set(c, ho); ho += c.length }
  return { positions, indices, normals, hasNormal }
}

/**
 * Keeps only the largest connected shell, discarding every other island.
 *
 * A MakeHuman/MPFB2 head export is NOT one surface. The real export had **66**
 * connected components: the skin (3203 verts / 6232 tris) plus eyeballs, teeth, a
 * tongue, the mouth cavity, eyelashes, and MakeHuman's clothes/hair *helper* ribbons —
 * thin 18-vertex strips spanning the full height of the head, slightly WIDER than the
 * skin. Those helpers are invisible inside MakeHuman but are exported anyway.
 *
 * Together they were **40% of all triangles**, and because sampling is area-weighted,
 * ~40% of every baked point landed on geometry that must never be seen: the eyeballs
 * rendered as dark discs where eyes should be, the teeth/tongue/cavity as a bright blob
 * at the mouth, and the helper ribbons as "hair" that swung with the jaw because they
 * span the whole head and so pick up jaw weight.
 *
 * The skin is always by far the largest shell, so "keep the biggest island" is a
 * reliable rule for a head export and needs no per-export configuration.
 */
export function largestShell(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
  hasNormal: Uint8Array
): { positions: Float32Array; indices: Uint32Array; normals: Float32Array; hasNormal: Uint8Array; shells: number; keptTris: number; droppedTris: number } {
  const vertexCount = positions.length / 3
  const parent = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) parent[i] = i
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]!; a = parent[a]! } return a }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i + 2 < indices.length; i += 3) {
    union(indices[i]!, indices[i + 1]!)
    union(indices[i + 1]!, indices[i + 2]!)
  }

  // Pick the root owning the most TRIANGLES (not vertices): a dense but tiny island
  // shouldn't outrank the skin.
  const triCount = new Map<number, number>()
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const r = find(indices[i]!)
    triCount.set(r, (triCount.get(r) ?? 0) + 1)
  }
  let best = -1, bestTris = -1
  for (const [root, n] of triCount) if (n > bestTris) { bestTris = n; best = root }
  const totalTris = indices.length / 3
  if (best < 0) return { positions, indices, normals, hasNormal, shells: 0, keptTris: 0, droppedTris: 0 }

  // Compact the kept vertices, remapping indices.
  const remap = new Int32Array(vertexCount).fill(-1)
  let kept = 0
  for (let v = 0; v < vertexCount; v++) if (find(v) === best) remap[v] = kept++

  const outPos = new Float32Array(kept * 3)
  const outNrm = new Float32Array(kept * 3)
  const outHas = new Uint8Array(kept)
  for (let v = 0; v < vertexCount; v++) {
    const d = remap[v]!
    if (d < 0) continue
    for (let k = 0; k < 3; k++) {
      outPos[d * 3 + k] = positions[v * 3 + k]!
      outNrm[d * 3 + k] = normals[v * 3 + k]!
    }
    outHas[d] = hasNormal[v]!
  }
  const outIdx: number[] = []
  for (let i = 0; i + 2 < indices.length; i += 3) {
    if (find(indices[i]!) !== best) continue
    outIdx.push(remap[indices[i]!]!, remap[indices[i + 1]!]!, remap[indices[i + 2]!]!)
  }

  return {
    positions: outPos,
    indices: Uint32Array.from(outIdx),
    normals: outNrm,
    hasNormal: outHas,
    shells: triCount.size,
    keptTris: bestTris,
    droppedTris: totalTris - bestTris
  }
}

export interface Normalization {
  scale: number
  midY: number
  midZ: number
}

/**
 * Computes the head-local normalization: origin between the eyes (midY recentred, midZ
 * recentred the same way), unit ~= head half-width (scale = 1 / maxX). Z was previously left
 * un-recentred, which offset the render pivot (`VIZ_TUNING.head.pivotZ`) — a real MPFB2 export
 * spans z ~-0.48..1.48 with its centre near +0.5, not 0, so every "look up" rotation swung
 * about the wrong point.
 */
export function computeNormalization(positions: Float32Array): Normalization {
  let minY = Infinity, maxY = -Infinity, maxX = 0
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!)
    maxX = Math.max(maxX, Math.abs(positions[i]!))
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!)
  }
  return { scale: 1 / maxX, midY: (minY + maxY) / 2, midZ: (minZ + maxZ) / 2 }
}

/**
 * Full bake pipeline over an already-loaded document: merge every node's triangle geometry,
 * normalize into head-local space, area-weighted-sample the surface, and pack the result into
 * the (x,y,z, nx,ny,nz, jawW,eyeW,browW) buffer. Kept separate from `main()` so it stays
 * importable/testable without touching the filesystem.
 */
export function bakeHeadBuffer(doc: Document, count: number, rng: () => number): Float32Array {
  const all = mergeSceneGeometry(doc)
  // Discard eyeballs, teeth, tongue, mouth cavity, eyelashes and MakeHuman's helper
  // ribbons — 40% of the real export's triangles, none of which should ever be seen.
  const merged = largestShell(all.positions, all.indices, all.normals, all.hasNormal)
  if (merged.shells > 1) {
    console.log(`shells: ${merged.shells} found, kept the largest (${merged.keptTris} tris), dropped ${merged.droppedTris}`)
  }
  const { scale, midY, midZ } = computeNormalization(merged.positions)

  // Proportions MEASURED from the real export. The geometry this bake DISCARDS is what
  // locates them: a MakeHuman head ships the eyeballs, teeth, tongue and mouth cavity as
  // separate shells sitting exactly on the features they belong to, so their bounding
  // boxes are ground truth.
  //
  //   eyeballs (2 symmetric shells, 308v each) ....... mid y = -0.05  -> eyeY
  //   upper teeth (68v, centred) ..................... y -0.82..-0.56
  //   lower teeth (68v, centred) ..................... y -1.03..-0.69
  //   the two meet at the bite line .................. y ~= -0.72     -> lipY
  //
  // Cross-checking both against standard facial proportions (eyes at 50% chin->crown,
  // mouth at 25%) independently puts the chin at ~-1.40; the skin ends at -1.33, i.e.
  // this export is cropped at the jaw with essentially no neck.
  //
  // The earlier values (eyeY 0.15, lipY -0.47, chinY -0.89) were measured BEFORE the
  // non-skin shells were filtered out, so they were derived from a point cloud that was
  // 40% eyeballs, teeth, tongue and helper ribbons. They put the jaw region up around
  // the NOSE — which is why the talking animation moved the wrong half of the face.
  //
  // If the mesh is ever re-exported, re-derive these from the discarded shells rather
  // than guessing; the bake is cheap, so tune against the render and re-run.
  const m: HeadMetrics = {
    browY: 0.10, eyeY: -0.05, lipY: -0.72, chinY: -1.33,
    hingeInner: 0.30, hingeOuter: 0.90, faceHalfWidth: 1.0,
    // The export is cropped at the jaw — the skin ends at y -1.33 and the derived chin
    // sits at ~-1.40, so there is effectively NO neck below the jawline. The falloff is
    // parked below the mesh so the whole lower jaw moves, which is correct here; it
    // still guards a future export that keeps more neck.
    neckY: -1.60
  }

  // Edges first — they carry the anatomy (see sampleEdges). Any shortfall is topped up
  // with surface points so the skull still reads as a solid volume rather than a cage.
  const edgePts = sampleEdges(merged.positions, merged.indices, merged.normals, merged.hasNormal, count)
  const pts = edgePts.length >= count
    ? edgePts.slice(0, count)
    : [...edgePts, ...sampleSurface(merged.positions, merged.indices, merged.normals, merged.hasNormal, count - edgePts.length, rng)]
  const buf = new Float32Array(count * FLOATS_PER_POINT)

  pts.forEach((raw, i) => {
    const p = { x: raw.x * scale, y: (raw.y - midY) * scale, z: (raw.z - midZ) * scale }
    const w = regionWeights(p, m)
    const o = i * FLOATS_PER_POINT
    buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z
    buf[o + 3] = raw.nx; buf[o + 4] = raw.ny; buf[o + 5] = raw.nz
    buf[o + 6] = w.jaw; buf[o + 7] = w.eye; buf[o + 8] = w.brow
  })

  return buf
}

async function main() {
  const src = process.argv[2] ?? 'assets/source/bridget-head.glb'
  const dst = process.argv[3] ?? 'app/assets/head-points.bin'
  const COUNT = 50_000   // matches the existing desktop quality tier

  const io = new NodeIO()
  const doc = await io.read(src)

  let seed = 12345
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

  const buf = bakeHeadBuffer(doc, COUNT, rng)

  writeFileSync(dst, Buffer.from(buf.buffer))
  console.log(`baked ${COUNT} points -> ${dst} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`)
}

// Only run when invoked directly, so the pure functions above stay importable by tests.
if (process.argv[1]?.endsWith('bake-head.ts')) void main()
