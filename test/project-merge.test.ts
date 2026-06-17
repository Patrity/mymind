import { describe, it, expect } from 'vitest'
import { uniquifyPath, mergeStringArrays } from '../server/services/project-merge'

// ---------------------------------------------------------------------------
// uniquifyPath
// ---------------------------------------------------------------------------
describe('uniquifyPath', () => {
  it('returns target unchanged when not in taken set', () => {
    expect(uniquifyPath('/projects/w/foo.md', new Set())).toBe('/projects/w/foo.md')
  })

  it('inserts -2 before extension when target is taken', () => {
    expect(uniquifyPath('/projects/w/foo.md', new Set(['/projects/w/foo.md']))).toBe('/projects/w/foo-2.md')
  })

  it('increments to -3 when -2 is also taken', () => {
    expect(uniquifyPath('foo.md', new Set(['foo.md', 'foo-2.md']))).toBe('foo-3.md')
  })

  it('handles paths with no extension', () => {
    expect(uniquifyPath('/projects/w/readme', new Set(['/projects/w/readme']))).toBe('/projects/w/readme-2')
  })
})

// ---------------------------------------------------------------------------
// mergeStringArrays
// ---------------------------------------------------------------------------
describe('mergeStringArrays', () => {
  it('dedupes and preserves a\'s order first, then new items from b', () => {
    expect(mergeStringArrays(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('returns empty array when both inputs are empty', () => {
    expect(mergeStringArrays([], [])).toEqual([])
  })

  it('returns a when b is empty', () => {
    expect(mergeStringArrays(['x', 'y'], [])).toEqual(['x', 'y'])
  })

  it('returns items from b when a is empty', () => {
    expect(mergeStringArrays([], ['p', 'q'])).toEqual(['p', 'q'])
  })
})
