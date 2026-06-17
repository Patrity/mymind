import { describe, it, expect } from 'vitest'
import { uniquifyPath, mergeStringArrays, computeDocTargetPaths } from '../server/services/project-merge'

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

// ---------------------------------------------------------------------------
// computeDocTargetPaths — pure path-collision logic used by mergeProjects
// ---------------------------------------------------------------------------
describe('computeDocTargetPaths', () => {
  it('rewrites loser paths under /projects/<loser>/ to /projects/<winner>/', () => {
    const loserDocs = [{ id: '1', path: '/projects/l/a.md' }]
    const taken = new Set<string>(['/projects/l/a.md'])
    const result = computeDocTargetPaths(loserDocs, taken, 'l', 'w')
    expect(result.get('1')).toBe('/projects/w/a.md')
  })

  it('uniquifies when winner already has the target path', () => {
    const loserDocs = [
      { id: '1', path: '/projects/l/a.md' },
      { id: '2', path: '/projects/l/b.md' }
    ]
    // Winner already owns /projects/w/a.md; /projects/w/b.md is free
    const taken = new Set<string>([
      '/projects/l/a.md',
      '/projects/l/b.md',
      '/projects/w/a.md'
    ])
    const result = computeDocTargetPaths(loserDocs, taken, 'l', 'w')
    expect(result.get('1')).toBe('/projects/w/a-2.md')
    expect(result.get('2')).toBe('/projects/w/b.md')
  })

  it('sequential collision: first doc avoids taken winner path; second gets unique suffix', () => {
    // l/a.md → rewrites to w/a.md → taken → becomes w/a-2.md (also taken) → w/a-3.md
    // l/b.md → rewrites to w/b.md → taken → becomes w/b-2.md
    const loserDocs = [
      { id: '1', path: '/projects/l/a.md' },
      { id: '2', path: '/projects/l/b.md' }
    ]
    const taken = new Set<string>([
      '/projects/l/a.md',
      '/projects/l/b.md',
      '/projects/w/a.md',   // winner already has a.md
      '/projects/w/a-2.md', // winner already has a-2.md
      '/projects/w/b.md'    // winner already has b.md
    ])
    const result = computeDocTargetPaths(loserDocs, taken, 'l', 'w')
    expect(result.get('1')).toBe('/projects/w/a-3.md')
    expect(result.get('2')).toBe('/projects/w/b-2.md')
  })

  it('does not collide a doc with its own old path (self-free)', () => {
    // loser's path /projects/l/a.md rewrites to /projects/w/a.md
    // but /projects/w/a.md is NOT in taken; /projects/l/a.md IS
    // The doc should NOT collide with its own old path after rewrite.
    const loserDocs = [{ id: '1', path: '/projects/l/a.md' }]
    const taken = new Set<string>(['/projects/l/a.md'])
    const result = computeDocTargetPaths(loserDocs, taken, 'l', 'w')
    // /projects/l/a.md is freed, rewritten to /projects/w/a.md, which is free
    expect(result.get('1')).toBe('/projects/w/a.md')
  })

  it('leaves non-project paths unchanged (path not under /projects/<loser>/)', () => {
    const loserDocs = [{ id: '1', path: '/docs/readme.md' }]
    const taken = new Set<string>(['/docs/readme.md'])
    const result = computeDocTargetPaths(loserDocs, taken, 'l', 'w')
    // path not under /projects/l/ so rewriteProjectPathPrefix returns unchanged;
    // old path freed, no collision → stays /docs/readme.md
    expect(result.get('1')).toBe('/docs/readme.md')
  })
})
