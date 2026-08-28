import { describe, it, expect } from 'vitest'
import { parseHeadBuffer, HeadBufferError, FLOATS_PER_POINT, STRIDE_BYTES } from './head-buffer'

/** Build a buffer in the exact layout scripts/bake-head.ts writes. */
function bake(points: number[][]): ArrayBuffer {
  const f = new Float32Array(points.length * FLOATS_PER_POINT)
  points.forEach((p, i) => f.set(p, i * FLOATS_PER_POINT))
  return f.buffer
}

describe('parseHeadBuffer', () => {
  it('splits the nine-float stride into position, normal and the three region weights', () => {
    // Deliberately distinct values per slot so a swapped pair (e.g. eyeW/browW) fails.
    const buf = bake([
      [1, 2, 3, 0, 1, 0, 0.1, 0.2, 0.3],
      [4, 5, 6, 1, 0, 0, 0.4, 0.5, 0.6]
    ])
    const h = parseHeadBuffer(buf)
    expect(h.count).toBe(2)
    expect([...h.position]).toEqual([1, 2, 3, 4, 5, 6])
    expect([...h.normal]).toEqual([0, 1, 0, 1, 0, 0])
    expect(h.jaw[0]).toBeCloseTo(0.1, 6)
    expect(h.jaw[1]).toBeCloseTo(0.4, 6)
    expect(h.eye[0]).toBeCloseTo(0.2, 6)
    expect(h.eye[1]).toBeCloseTo(0.5, 6)
    expect(h.brow[0]).toBeCloseTo(0.3, 6)
    expect(h.brow[1]).toBeCloseTo(0.6, 6)
  })

  it('computes the bounding box from the positions', () => {
    const h = parseHeadBuffer(bake([
      [-1, -2, -3, 0, 0, 1, 0, 0, 0],
      [4, 5, 6, 0, 0, 1, 0, 0, 0]
    ]))
    expect(h.bounds.min).toEqual([-1, -2, -3])
    expect(h.bounds.max).toEqual([4, 5, 6])
  })

  it('rejects an empty buffer', () => {
    expect(() => parseHeadBuffer(new ArrayBuffer(0))).toThrow(HeadBufferError)
  })

  it('rejects a truncated buffer that is not a whole number of points', () => {
    const full = bake([[1, 2, 3, 0, 0, 1, 0, 0, 0]])
    const cut = full.slice(0, STRIDE_BYTES - 4)
    expect(() => parseHeadBuffer(cut)).toThrow(/not a multiple/)
  })

  it('rejects an HTML document served in place of the asset', () => {
    // The SPA catch-all route rule means a missing static path can answer 200 with
    // HTML rather than 404 — that must not reach the GPU as geometry.
    const html = new TextEncoder().encode(
      '<!DOCTYPE html><html><head><title>MyMind</title></head><body><div id="__nuxt"></div></body></html>'
    )
    expect(html.byteLength % STRIDE_BYTES).not.toBe(0)
    expect(() => parseHeadBuffer(html.buffer as ArrayBuffer)).toThrow(HeadBufferError)
  })

  it('rejects a stride-aligned buffer whose positions are not finite', () => {
    const f = new Float32Array(FLOATS_PER_POINT)
    f[0] = NaN
    expect(() => parseHeadBuffer(f.buffer)).toThrow(/non-finite/)
  })

  it('clamps region weights into 0..1', () => {
    const h = parseHeadBuffer(bake([[0, 0, 0, 0, 0, 1, 5, -3, NaN]]))
    expect(h.jaw[0]).toBe(1)
    expect(h.eye[0]).toBe(0)
    expect(h.brow[0]).toBe(0)
  })

  it('derives outward normals when the bake wrote its constant placeholder', () => {
    // bake-head.ts writes (0,0,1) for every point; a constant normal cannot drive a
    // facing term, so the parser has to replace it.
    const h = parseHeadBuffer(bake([
      [2, 0, 0, 0, 0, 1, 0, 0, 0],
      [-2, 0, 0, 0, 0, 1, 0, 0, 0],
      [0, 2, 0, 0, 0, 1, 0, 0, 0],
      [0, -2, 0, 0, 0, 1, 0, 0, 0]
    ]))
    expect(h.derivedNormals).toBe(true)
    // centre is the origin here, so each normal points away from it
    expect([...h.normal.slice(0, 3)]).toEqual([1, 0, 0])
    expect([...h.normal.slice(3, 6)]).toEqual([-1, 0, 0])
    expect([...h.normal.slice(6, 9)]).toEqual([0, 1, 0])
    expect([...h.normal.slice(9, 12)]).toEqual([0, -1, 0])
  })

  it('keeps real baked normals and unit-normalizes them', () => {
    const h = parseHeadBuffer(bake([
      [0, 0, 0, 0, 0, 3, 0, 0, 0],
      [0, 0, 0, 0, 4, 0, 0, 0, 0]
    ]))
    expect(h.derivedNormals).toBe(false)
    expect([...h.normal.slice(0, 3)]).toEqual([0, 0, 1])
    expect([...h.normal.slice(3, 6)]).toEqual([0, 1, 0])
  })

  it('replaces a zero-length baked normal rather than emitting NaN', () => {
    const h = parseHeadBuffer(bake([
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 0, 0, 0]
    ]))
    expect([...h.normal.slice(0, 3)]).toEqual([0, 0, 1])
    expect([...h.normal].every(Number.isFinite)).toBe(true)
  })
})
