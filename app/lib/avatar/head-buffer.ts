// Pure parsing of the baked head point buffer. No Three.js, no DOM — the renderer
// composes this, and it stays unit-testable on its own.
//
// The layout is the contract with scripts/bake-head.ts: 9 interleaved floats per
// point, in order x, y, z, nx, ny, nz, jawW, eyeW, browW.

export const FLOATS_PER_POINT = 9
export const STRIDE_BYTES = FLOATS_PER_POINT * 4

export interface HeadPoints {
  count: number
  /** 3 floats per point. */
  position: Float32Array
  /** 3 floats per point, unit length. */
  normal: Float32Array
  /** 1 float per point. */
  jaw: Float32Array
  eye: Float32Array
  brow: Float32Array
  /** True when the .bin carried placeholder normals and outward ones were derived here. */
  derivedNormals: boolean
  bounds: { min: [number, number, number]; max: [number, number, number] }
}

/** Thrown for every "there is no usable head buffer" condition, so the caller can tell
 *  that apart from a genuine renderer fault and drop to the CSS fallback quietly. */
export class HeadBufferError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeadBufferError'
  }
}

/**
 * Split the interleaved buffer into the attributes the geometry binds.
 *
 * Validates the stride hard on purpose: a missing static asset does NOT reliably
 * 404 in this app — the SPA catch-all route rule means an unknown path can come
 * back as a 200 with an HTML document body. An HTML page is essentially never a
 * multiple of the 36-byte stride, and when it is, the finite-value check below
 * catches it. Silently rendering garbage geometry is the failure this prevents.
 */
export function parseHeadBuffer(data: ArrayBuffer): HeadPoints {
  if (data.byteLength === 0) throw new HeadBufferError('head buffer is empty')
  if (data.byteLength % STRIDE_BYTES !== 0) {
    throw new HeadBufferError(
      `head buffer is ${data.byteLength} bytes, not a multiple of the ${STRIDE_BYTES}-byte point stride `
      + '(truncated download, or an HTML response served in place of the asset)'
    )
  }

  const src = new Float32Array(data)
  const count = src.length / FLOATS_PER_POINT

  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  const jaw = new Float32Array(count)
  const eye = new Float32Array(count)
  const brow = new Float32Array(count)

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let nVariance = 0
  const n0x = src[3]!, n0y = src[4]!, n0z = src[5]!

  for (let i = 0; i < count; i++) {
    const o = i * FLOATS_PER_POINT
    const x = src[o]!, y = src[o + 1]!, z = src[o + 2]!
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new HeadBufferError(`head buffer point ${i} has a non-finite position`)
    }
    position[i * 3] = x; position[i * 3 + 1] = y; position[i * 3 + 2] = z
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z

    const nx = src[o + 3]!, ny = src[o + 4]!, nz = src[o + 5]!
    normal[i * 3] = nx; normal[i * 3 + 1] = ny; normal[i * 3 + 2] = nz
    nVariance += Math.abs(nx - n0x) + Math.abs(ny - n0y) + Math.abs(nz - n0z)

    // Region weights are consumed as 0..1 multipliers in the shader; a corrupt or
    // out-of-range weight would translate the jaw off the head rather than open it.
    jaw[i] = clamp01(src[o + 6]!)
    eye[i] = clamp01(src[o + 7]!)
    brow[i] = clamp01(src[o + 8]!)
  }

  // scripts/bake-head.ts writes (0, 0, 1) for every normal — "normals filled by the
  // renderer if needed". A constant normal is useless for the facing term, so derive
  // outward normals from the point cloud's own centre when the baked ones are constant.
  const derivedNormals = nVariance < 1e-6
  if (derivedNormals) deriveOutwardNormals(position, normal, count, min, max)
  else normalizeInPlace(normal, count)

  return { count, position, normal, jaw, eye, brow, derivedNormals, bounds: { min, max } }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

function normalizeInPlace(normal: Float32Array, count: number) {
  for (let i = 0; i < count; i++) {
    const o = i * 3
    const len = Math.hypot(normal[o]!, normal[o + 1]!, normal[o + 2]!)
    if (len < 1e-6) { normal[o] = 0; normal[o + 1] = 0; normal[o + 2] = 1; continue }
    normal[o] = normal[o]! / len
    normal[o + 1] = normal[o + 1]! / len
    normal[o + 2] = normal[o + 2]! / len
  }
}

function deriveOutwardNormals(
  position: Float32Array,
  normal: Float32Array,
  count: number,
  min: [number, number, number],
  max: [number, number, number]
) {
  const cx = (min[0] + max[0]) / 2
  const cy = (min[1] + max[1]) / 2
  const cz = (min[2] + max[2]) / 2
  for (let i = 0; i < count; i++) {
    const o = i * 3
    const dx = position[o]! - cx
    const dy = position[o + 1]! - cy
    const dz = position[o + 2]! - cz
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) { normal[o] = 0; normal[o + 1] = 0; normal[o + 2] = 1; continue }
    normal[o] = dx / len
    normal[o + 1] = dy / len
    normal[o + 2] = dz / len
  }
}
