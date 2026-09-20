import { describe, it, expect } from 'vitest'
import { encodeCursor, decodeCursor } from './session-cursor'

describe('session cursor', () => {
  it('round-trips a cursor', () => {
    const c = { createdAt: '2026-09-19T12:34:56.789Z', id: '6f1e7b4a-0000-4000-8000-000000000001' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('is opaque — the raw value is not the id', () => {
    const c = { createdAt: '2026-09-19T12:34:56.789Z', id: '6f1e7b4a-0000-4000-8000-000000000001' }
    expect(encodeCursor(c)).not.toContain(c.id)
  })

  it('rejects malformed input rather than coercing it', () => {
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(btoa('only-one-part'))).toBeNull()
    expect(decodeCursor(btoa('2026-09-19T12:34:56.789Z|'))).toBeNull()
    expect(decodeCursor(btoa('|6f1e7b4a-0000-4000-8000-000000000001'))).toBeNull()
    expect(decodeCursor(btoa('nonsense-date|6f1e7b4a-0000-4000-8000-000000000001'))).toBeNull()
  })
})
