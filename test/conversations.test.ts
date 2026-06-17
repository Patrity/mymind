import { describe, it, expect } from 'vitest'
import { deriveTitle } from '../server/services/conversations'

describe('deriveTitle', () => {
  it('trims + collapses whitespace and caps length', () => {
    expect(deriveTitle('  hey   Bridget\n what is up ')).toBe('hey Bridget what is up')
    expect(deriveTitle('x'.repeat(80))).toHaveLength(60)
    expect(deriveTitle('x'.repeat(80)).endsWith('…')).toBe(true)
  })
  it('falls back for empty input', () => {
    expect(deriveTitle('')).toBe('New conversation')
    expect(deriveTitle('   ')).toBe('New conversation')
  })
})
