import { describe, it, expect } from 'vitest'
import { validateRelationInput } from './memory-relations'

describe('validateRelationInput', () => {
  it('rejects self-links', () => { expect(() => validateRelationInput({ fromId: 'a', toId: 'a', type: 'supersedes' })).toThrow() })
  it('rejects unknown types', () => { expect(() => validateRelationInput({ fromId: 'a', toId: 'b', type: 'x' as any })).toThrow() })
  it('accepts a valid supersedes/contradicts edge', () => {
    expect(validateRelationInput({ fromId: 'a', toId: 'b', type: 'contradicts' })).toEqual({ fromId: 'a', toId: 'b', type: 'contradicts' })
  })
})
