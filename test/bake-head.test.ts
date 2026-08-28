import { describe, it, expect } from 'vitest'
import { Document, Accessor, Primitive } from '@gltf-transform/core'
import {
  jawWeight, regionWeights, mergeSceneGeometry, sampleSurface, sampleEdges, largestShell,
  computeNormalization, bakeHeadBuffer, FLOATS_PER_POINT, type HeadMetrics
} from '../scripts/bake-head'

// Small deterministic LCG, same shape as the one `main()` uses, so tests are reproducible.
function makeRng(seed = 12345): () => number {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
}

const M: HeadMetrics = {
  lipY: 0.0, chinY: -1.0, eyeY: 0.8, browY: 1.0,
  hingeInner: 0.3, hingeOuter: 0.9, faceHalfWidth: 1.0
}

describe('jawWeight neck falloff', () => {
  // With `neckY` set, influence must fade to nothing below the jawline. Without it the
  // ramp saturates at 1 forever past `chinY`, so the whole neck travelled with the chin
  // — 12% of head height on every syllable, the same class of artifact as the binary
  // region this weighting exists to avoid.
  const N: HeadMetrics = { ...M, neckY: -1.3 }

  it('is still full at the chin', () => {
    expect(jawWeight(N.chinY, 0, N)).toBeCloseTo(1, 5)
  })

  it('falls to zero at and below the neck line', () => {
    expect(jawWeight(N.neckY!, 0, N)).toBeCloseTo(0, 5)
    expect(jawWeight(-2, 0, N)).toBeCloseTo(0, 5)
  })

  it('decreases monotonically from the chin down to the neck', () => {
    const ys = [-1.0, -1.05, -1.1, -1.15, -1.2, -1.25, -1.3]
    const ws = ys.map(y => jawWeight(y, 0, N))
    for (let i = 1; i < ws.length; i++) expect(ws[i]!).toBeLessThanOrEqual(ws[i - 1]!)
  })

  it('leaves the lip-to-chin ramp unchanged', () => {
    // The falloff must not eat into the region that actually opens the mouth.
    for (const y of [0.0, -0.2, -0.5, -0.8, -1.0]) {
      expect(jawWeight(y, 0, N)).toBeCloseTo(jawWeight(y, 0, M), 5)
    }
  })

  it('omitting neckY preserves the old saturating behaviour', () => {
    expect(jawWeight(-2, 0, M)).toBeCloseTo(1, 5)
  })
})

describe('jawWeight', () => {
  it('is zero at and above the upper lip', () => {
    expect(jawWeight(M.lipY, 0, M)).toBe(0)
    expect(jawWeight(0.5, 0, M)).toBe(0)
  })

  it('is full at the chin', () => {
    expect(jawWeight(M.chinY, 0, M)).toBeCloseTo(1, 5)
  })

  it('increases monotonically from lip to chin', () => {
    const ys = [0.0, -0.2, -0.4, -0.6, -0.8, -1.0]
    const ws = ys.map(y => jawWeight(y, 0, M))
    for (let i = 1; i < ws.length; i++) expect(ws[i]!).toBeGreaterThanOrEqual(ws[i - 1]!)
  })

  it('moves the lower lip only a fraction of the chin travel', () => {
    // The whole point: a binary region translated as a block CLEAVES the head at the
    // lip line. The lower lip must trail the chin, not match it.
    const lowerLip = jawWeight(-0.15, 0, M)
    const chin = jawWeight(M.chinY, 0, M)
    expect(lowerLip).toBeGreaterThan(0)
    expect(lowerLip).toBeLessThan(chin * 0.45)
  })

  it('is reduced near the hinge so the jaw arcs', () => {
    const centre = jawWeight(M.chinY, 0, M)
    const hinge = jawWeight(M.chinY, 0.95, M)
    expect(hinge).toBeLessThan(centre)
    expect(hinge).toBeGreaterThan(0)
  })

  it('never exceeds 1 or drops below 0', () => {
    for (const y of [2, 1, 0, -1, -2]) {
      for (const x of [-2, -1, 0, 1, 2]) {
        const w = jawWeight(y, x, M)
        expect(w).toBeGreaterThanOrEqual(0)
        expect(w).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('regionWeights', () => {
  it('flags the eye band away from the midline', () => {
    expect(regionWeights({ x: 0.45, y: M.eyeY, z: 0.5 }, M).eye).toBeGreaterThan(0.5)
    expect(regionWeights({ x: 0.02, y: M.eyeY, z: 0.5 }, M).eye).toBeLessThan(0.5)
  })

  it('flags the brow band above the eyes', () => {
    expect(regionWeights({ x: 0.45, y: M.browY, z: 0.5 }, M).brow).toBeGreaterThan(0.5)
  })
})

// Builds a single triangle primitive (POSITION + indices) in memory, no fixture files.
function addTriangle(doc: Document, positions: [number, number, number][]): ReturnType<Document['createPrimitive']> {
  const flat = positions.flat()
  const posAccessor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(flat))
  const idxAccessor = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array([0, 1, 2]))
  return doc.createPrimitive().setAttribute('POSITION', posAccessor).setIndices(idxAccessor)
}

describe('mergeSceneGeometry', () => {
  it('merges two separate meshes, offsetting the second mesh\'s indices', () => {
    const doc = new Document()

    const meshA = doc.createMesh().addPrimitive(addTriangle(doc, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]))
    doc.createNode().setMesh(meshA)

    const meshB = doc.createMesh().addPrimitive(addTriangle(doc, [[10, 10, 10], [11, 10, 10], [10, 11, 10]]))
    doc.createNode().setMesh(meshB)

    const merged = mergeSceneGeometry(doc)

    expect(merged.positions.length).toBe(18) // 6 vertices * 3
    expect(merged.indices.length).toBe(6)

    // The second triangle's indices must be shifted by mesh A's vertex count (3), not raw 0-2.
    expect(Array.from(merged.indices.slice(3))).toEqual([3, 4, 5])

    // And they must still resolve to mesh B's own vertices, not mesh A's.
    const i0 = merged.indices[3]!
    expect(merged.positions[i0 * 3]).toBeCloseTo(10)
    expect(merged.positions[i0 * 3 + 1]).toBeCloseTo(10)
    expect(merged.positions[i0 * 3 + 2]).toBeCloseTo(10)
  })

  it('merges both primitives of a single mesh', () => {
    const doc = new Document()
    const mesh = doc.createMesh()
      .addPrimitive(addTriangle(doc, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]))
      .addPrimitive(addTriangle(doc, [[5, 5, 5], [6, 5, 5], [5, 6, 5]]))
    doc.createNode().setMesh(mesh)

    const merged = mergeSceneGeometry(doc)

    expect(merged.positions.length).toBe(18)
    expect(merged.indices.length).toBe(6)
    expect(Array.from(merged.indices.slice(3))).toEqual([3, 4, 5])
  })

  it('applies a node\'s non-identity translation to its mesh positions', () => {
    const doc = new Document()
    const mesh = doc.createMesh().addPrimitive(addTriangle(doc, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]))
    doc.createNode().setMesh(mesh).setTranslation([5, 2, -3])

    const merged = mergeSceneGeometry(doc)

    // Raw local position was (0,0,0) — the world position must reflect the node's translation.
    expect(merged.positions[0]).toBeCloseTo(5)
    expect(merged.positions[1]).toBeCloseTo(2)
    expect(merged.positions[2]).toBeCloseTo(-3)
    // Second vertex: local (1,0,0) + translation.
    expect(merged.positions[3]).toBeCloseTo(6)
    expect(merged.positions[4]).toBeCloseTo(2)
    expect(merged.positions[5]).toBeCloseTo(-3)
  })

  it('contributes once per node for a mesh instanced by multiple nodes, each with its own transform', () => {
    const doc = new Document()
    const mesh = doc.createMesh().addPrimitive(addTriangle(doc, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]))
    doc.createNode().setMesh(mesh).setTranslation([0, 0, 0])
    doc.createNode().setMesh(mesh).setTranslation([100, 0, 0])

    const merged = mergeSceneGeometry(doc)

    expect(merged.positions.length).toBe(18) // same mesh, two instances = 6 vertices
    expect(merged.indices.length).toBe(6)
    // First instance's first vertex is at the origin, second instance's is shifted by 100.
    expect(merged.positions[0]).toBeCloseTo(0)
    expect(merged.positions[9]).toBeCloseTo(100)
  })

  it('skips a primitive with no indices, no POSITION, or a non-triangle mode without throwing', () => {
    const doc = new Document()

    const noIndices = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    // no setIndices() call — leaves getIndices() null.

    const noPosition = doc.createPrimitive()
      .setIndices(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array([0, 1, 2])))
    // no setAttribute('POSITION', ...) call.

    const nonTriangle = addTriangle(doc, [[9, 9, 9], [8, 9, 9], [9, 8, 9]]).setMode(Primitive.Mode.LINE_STRIP)

    const valid = addTriangle(doc, [[1, 1, 1], [2, 1, 1], [1, 2, 1]])

    const mesh = doc.createMesh()
      .addPrimitive(noIndices)
      .addPrimitive(noPosition)
      .addPrimitive(nonTriangle)
      .addPrimitive(valid)
    doc.createNode().setMesh(mesh)

    expect(() => mergeSceneGeometry(doc)).not.toThrow()
    const merged = mergeSceneGeometry(doc)

    // Only the one valid triangle primitive should have made it through.
    expect(merged.positions.length).toBe(9)
    expect(merged.indices.length).toBe(3)
    expect(merged.positions[0]).toBeCloseTo(1)
  })

  it('produces a total triangle count equal to the sum of the input triangle counts', () => {
    const doc = new Document()

    const meshA = doc.createMesh()
      .addPrimitive(addTriangle(doc, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]))
      .addPrimitive(addTriangle(doc, [[2, 0, 0], [3, 0, 0], [2, 1, 0]]))
    doc.createNode().setMesh(meshA)

    const meshB = doc.createMesh().addPrimitive(addTriangle(doc, [[10, 10, 10], [11, 10, 10], [10, 11, 10]]))
    doc.createNode().setMesh(meshB)

    const merged = mergeSceneGeometry(doc)
    const inputTriangleCount = 3 // 2 from meshA + 1 from meshB
    expect(merged.indices.length / 3).toBe(inputTriangleCount)
  })
})

describe('sampleSurface normals', () => {
  it('interpolates and renormalizes a NORMAL-bearing triangle, varying across the surface', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    // Deliberately non-unit and orthogonal per-vertex normals, so interpolation must both
    // renormalize AND actually vary depending on where within the triangle a point lands.
    const normals = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
    const hasNormal = new Uint8Array([1, 1, 1])

    const pts = sampleSurface(positions, indices, normals, hasNormal, 100, makeRng())

    for (const p of pts) expect(Math.hypot(p.nx, p.ny, p.nz)).toBeCloseTo(1, 5)

    const distinct = new Set(pts.map(p => `${p.nx.toFixed(3)},${p.ny.toFixed(3)},${p.nz.toFixed(3)}`))
    expect(distinct.size).toBeGreaterThan(1)
  })

  it('falls back to the flat geometric face normal when a primitive has no NORMAL', () => {
    // p0=(0,0,0), p1=(2,0,0), p2=(0,2,0): edges (2,0,0) and (0,2,0), cross = (0,0,4) -> (0,0,1).
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0])
    const indices = new Uint32Array([0, 1, 2])
    const normals = new Float32Array(9) // zero-filled — unused since hasNormal is all zero
    const hasNormal = new Uint8Array([0, 0, 0])

    const pts = sampleSurface(positions, indices, normals, hasNormal, 20, makeRng())

    for (const p of pts) {
      expect(p.nx).toBeCloseTo(0, 5)
      expect(p.ny).toBeCloseTo(0, 5)
      expect(p.nz).toBeCloseTo(1, 5)
    }
  })
})

describe('mergeSceneGeometry normal matrix', () => {
  it('transforms a normal by a node\'s rotation, not just its translation', () => {
    const doc = new Document()
    const posAccessor = doc.createAccessor().setType(Accessor.Type.VEC3)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    const normalAccessor = doc.createAccessor().setType(Accessor.Type.VEC3)
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])) // local +Z at every vertex
    const idxAccessor = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array([0, 1, 2]))
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', posAccessor)
      .setAttribute('NORMAL', normalAccessor)
      .setIndices(idxAccessor)
    const mesh = doc.createMesh().addPrimitive(prim)

    // 90 degrees about X: quaternion (sin45, 0, 0, cos45). For this rotation, the standard
    // quaternion->matrix formula gives R = [[1,0,0],[0,0,-1],[0,1,0]], which maps local +Z
    // (0,0,1) to world (0,-1,0) — independently re-derived (not copied from a library), and
    // cross-checked against transformPosition below for the same rotation-only node, since a
    // pure rotation's inverse-transpose (the normal matrix) equals the rotation matrix itself.
    const half = Math.sin(Math.PI / 4)
    doc.createNode().setMesh(mesh).setRotation([half, 0, 0, Math.cos(Math.PI / 4)])

    const merged = mergeSceneGeometry(doc)

    expect(merged.hasNormal[0]).toBe(1)
    expect(merged.normals[0]).toBeCloseTo(0, 4)
    expect(merged.normals[1]).toBeCloseTo(-1, 4)
    expect(merged.normals[2]).toBeCloseTo(0, 4)
    expect(Math.hypot(merged.normals[0]!, merged.normals[1]!, merged.normals[2]!)).toBeCloseTo(1, 5)
  })
})

describe('computeNormalization', () => {
  it('recentres Z the same way it recentres Y, leaving X as a pure scale', () => {
    // X spans -2..2 (scale = 1/2), Y spans 0..10 (midY = 5), Z spans 9..11 (midZ = 10) —
    // an asymmetric Z range, like the real MPFB2 export (z ~-0.48..1.48, centred near +0.5).
    const positions = new Float32Array([
      -2, 0, 9,
       2, 10, 11
    ])
    const n = computeNormalization(positions)
    expect(n.scale).toBeCloseTo(0.5, 5)
    expect(n.midY).toBeCloseTo(5, 5)
    expect(n.midZ).toBeCloseTo(10, 5)
  })
})

describe('bakeHeadBuffer', () => {
  // Two triangles forming a quad whose Z span (9..11) does not straddle zero before recentring,
  // and whose face-normal fallback (no NORMAL attribute) is unit length by construction —
  // exercises both the Z-recentre fix and the "every normal is unit length" requirement.
  function buildAsymmetricQuadDoc(): Document {
    const doc = new Document()
    const posAccessor = doc.createAccessor().setType(Accessor.Type.VEC3)
      .setArray(new Float32Array([-1, 0, 9, 1, 0, 9, -1, 0, 11, 1, 0, 11]))
    const idxAccessor = doc.createAccessor().setType(Accessor.Type.SCALAR)
      .setArray(new Uint32Array([0, 1, 2, 1, 3, 2]))
    const prim = doc.createPrimitive().setAttribute('POSITION', posAccessor).setIndices(idxAccessor)
    const mesh = doc.createMesh().addPrimitive(prim)
    doc.createNode().setMesh(mesh)
    return doc
  }

  it('centres the Z bounding box on ~0 after baking, where it used to sit at the raw midpoint', () => {
    const doc = buildAsymmetricQuadDoc()
    const count = 300
    const buf = bakeHeadBuffer(doc, count, makeRng())

    let sawNegativeZ = false, sawPositiveZ = false
    for (let i = 0; i < count; i++) {
      const z = buf[i * FLOATS_PER_POINT + 2]!
      if (z < -0.01) sawNegativeZ = true
      if (z > 0.01) sawPositiveZ = true
    }
    // Raw Z was entirely within [9, 11] — always positive after scaling. Only a genuine
    // recentre step can make sampled points land on both sides of zero.
    expect(sawNegativeZ).toBe(true)
    expect(sawPositiveZ).toBe(true)
  })

  it('produces a unit-length normal for every point in the output buffer', () => {
    const doc = buildAsymmetricQuadDoc()
    const count = 300
    const buf = bakeHeadBuffer(doc, count, makeRng())

    for (let i = 0; i < count; i++) {
      const o = i * FLOATS_PER_POINT
      const len = Math.hypot(buf[o + 3]!, buf[o + 4]!, buf[o + 5]!)
      expect(len).toBeCloseTo(1, 2)
    }
  })
})

describe('largestShell', () => {
  // A MakeHuman head export is 66 separate shells: skin, eyeballs, teeth, tongue, mouth
  // cavity, eyelashes, and clothes-fitting helper ribbons. Sampling all of them put 40%
  // of every baked point on geometry that must never be seen.
  function twoShells() {
    // shell A: 2 triangles (larger). shell B: 1 triangle, disconnected, offset in x.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, // A
      10, 0, 0, 11, 0, 0, 10, 1, 0        // B
    ])
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2, 4, 5, 6])
    const normals = new Float32Array(7 * 3).fill(0)
    for (let i = 0; i < 7; i++) normals[i * 3 + 2] = 1
    return { positions, indices, normals, hasNormal: new Uint8Array(7).fill(1) }
  }

  it('keeps only the largest shell and reports what it dropped', () => {
    const g = twoShells()
    const r = largestShell(g.positions, g.indices, g.normals, g.hasNormal)
    expect(r.shells).toBe(2)
    expect(r.keptTris).toBe(2)
    expect(r.droppedTris).toBe(1)
    expect(r.indices.length / 3).toBe(2)
  })

  it('drops the far shell entirely — no vertex survives at its position', () => {
    const g = twoShells()
    const r = largestShell(g.positions, g.indices, g.normals, g.hasNormal)
    for (let i = 0; i < r.positions.length; i += 3) expect(r.positions[i]!).toBeLessThan(5)
  })

  it('remaps indices so surviving triangles still reference their own vertices', () => {
    const g = twoShells()
    const r = largestShell(g.positions, g.indices, g.normals, g.hasNormal)
    const vertexCount = r.positions.length / 3
    for (const i of r.indices) expect(i).toBeLessThan(vertexCount)
  })

  it('is a no-op on a single-shell mesh', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
    const r = largestShell(positions, indices, normals, new Uint8Array(3).fill(1))
    expect(r.shells).toBe(1)
    expect(r.droppedTris).toBe(0)
    expect(r.indices.length).toBe(3)
  })
})

describe('sampleEdges', () => {
  // Random surface sampling dissolves the eye/nose/mouth edge loops into uniform
  // speckle — the head renders as a smooth egg. Walking edges keeps the topology,
  // which is where the anatomy actually lives.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint32Array([0, 1, 2])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
  const hasNormal = new Uint8Array(3).fill(1)

  it('returns points that lie on the triangle plane', () => {
    const pts = sampleEdges(positions, indices, normals, hasNormal, 50)
    expect(pts.length).toBeGreaterThan(0)
    for (const p of pts) expect(Math.abs(p.z)).toBeLessThan(1e-6)
  })

  it('places points ON edges, never in the face interior', () => {
    // Every point of a triangle's edges satisfies x==0, y==0, or x+y==1.
    for (const p of sampleEdges(positions, indices, normals, hasNormal, 60)) {
      const onEdge = Math.abs(p.x) < 1e-6 || Math.abs(p.y) < 1e-6 || Math.abs(p.x + p.y - 1) < 1e-6
      expect(onEdge).toBe(true)
    }
  })

  it('emits unit-length normals', () => {
    for (const p of sampleEdges(positions, indices, normals, hasNormal, 30)) {
      expect(Math.hypot(p.nx, p.ny, p.nz)).toBeCloseTo(1, 5)
    }
  })

  it('never exceeds the requested count', () => {
    expect(sampleEdges(positions, indices, normals, hasNormal, 10).length).toBeLessThanOrEqual(10)
  })

  it('is deterministic — no RNG involved', () => {
    const a = sampleEdges(positions, indices, normals, hasNormal, 40)
    const b = sampleEdges(positions, indices, normals, hasNormal, 40)
    expect(a.map(p => `${p.x},${p.y}`).join('|')).toBe(b.map(p => `${p.x},${p.y}`).join('|'))
  })

  it('returns nothing for degenerate geometry rather than throwing', () => {
    const z = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(() => sampleEdges(z, indices, normals, hasNormal, 10)).not.toThrow()
    expect(sampleEdges(z, indices, normals, hasNormal, 10)).toEqual([])
  })
})
