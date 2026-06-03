import { describe, it, expect } from 'vitest'
import { hashToken, generateToken } from '../server/utils/api-token'

describe('api-token', () => {
  it('generates a token and a stable sha256 hash', () => {
    const t = generateToken()
    expect(t).toMatch(/^mm_[A-Za-z0-9_-]{32,}$/)
    expect(hashToken(t)).toEqual(hashToken(t))
    expect(hashToken(t)).toHaveLength(64)
  })
  it('different tokens hash differently', () => {
    expect(hashToken(generateToken())).not.toEqual(hashToken(generateToken()))
  })
})
