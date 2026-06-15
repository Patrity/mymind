import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { generateToken, hashToken, tokenLastFour } from '../server/utils/api-token'

describe('generateToken', () => {
  it('produces an mm_-prefixed token', () => {
    const t = generateToken()
    expect(t).toMatch(/^mm_[A-Za-z0-9_-]{32}$/)
  })

  it('produces a unique token each call', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('hashToken', () => {
  it('is deterministic and 64 hex chars (sha256)', () => {
    const h = hashToken('mm_abc')
    expect(h).toBe(hashToken('mm_abc'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different inputs', () => {
    expect(hashToken('mm_a')).not.toBe(hashToken('mm_b'))
  })

  it('matches a known sha256 hex vector', () => {
    expect(hashToken('mm_test_vector')).toBe(createHash('sha256').update('mm_test_vector').digest('hex'))
  })
})

describe('tokenLastFour', () => {
  it('returns the last 4 characters', () => {
    expect(tokenLastFour('mm_abcdEFGH')).toBe('EFGH')
  })

  it('returns the whole string when shorter than 4', () => {
    expect(tokenLastFour('ab')).toBe('ab')
  })

  it('returns all 4 chars for a 4-char string', () => {
    expect(tokenLastFour('abcd')).toBe('abcd')
  })

  it('returns empty string for empty input', () => {
    expect(tokenLastFour('')).toBe('')
  })
})
