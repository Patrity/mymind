import { describe, it, expect } from 'vitest'
import {
  ancestorFolderPaths, folderChainPaths, isUnder, rewritePrefix, escapeLikeLiteral
} from './folders'

describe('folderChainPaths', () => {
  it('returns the folder itself plus every ancestor, root-first', () => {
    expect(folderChainPaths('/projects/mymind/wiki')).toEqual([
      '/projects', '/projects/mymind', '/projects/mymind/wiki'
    ])
  })

  it('returns a single-element chain for a top-level folder', () => {
    expect(folderChainPaths('/projects')).toEqual(['/projects'])
  })

  it('returns nothing for the root', () => {
    expect(folderChainPaths('/')).toEqual([])
  })

  it('tolerates duplicate and trailing slashes', () => {
    expect(folderChainPaths('//projects//mymind/')).toEqual(['/projects', '/projects/mymind'])
  })
})

describe('ancestorFolderPaths', () => {
  it('returns every ancestor folder root-first, without the filename', () => {
    expect(ancestorFolderPaths('/projects/mymind/wiki/auth.md')).toEqual([
      '/projects', '/projects/mymind', '/projects/mymind/wiki'
    ])
  })

  it('returns nothing for a document at the root — the root is not a row', () => {
    expect(ancestorFolderPaths('/notes.md')).toEqual([])
  })

  it('tolerates duplicate and trailing slashes', () => {
    expect(ancestorFolderPaths('//input//note.md')).toEqual(['/input'])
  })

  // R8: the folders table has a CHECK constraint (`^/`, no trailing `/`, no `//`) — a
  // malformed path is now a hard DB failure, not bad data. This proves ensureFolders can
  // never trip it even when the input path is itself malformed.
  it('collapses a doubled internal slash so no malformed path reaches the folders CHECK constraint', () => {
    expect(ancestorFolderPaths('/projects//mymind/foo.md')).toEqual(['/projects', '/projects/mymind'])
  })
})

describe('isUnder', () => {
  it('matches descendants at any depth', () => {
    expect(isUnder('/a/b/c.md', '/a')).toBe(true)
    expect(isUnder('/a/b', '/a')).toBe(true)
  })

  it('does not match the folder itself', () => {
    expect(isUnder('/a', '/a')).toBe(false)
  })

  it('does not match a sibling with a shared prefix', () => {
    // The bug a naive startsWith() would have: '/archive' is not under '/arch'.
    expect(isUnder('/archive/x.md', '/arch')).toBe(false)
  })
})

describe('rewritePrefix', () => {
  it('swaps the leading folder and leaves the rest alone', () => {
    expect(rewritePrefix('/a/b/c.md', '/a', '/z')).toBe('/z/b/c.md')
  })

  it('rewrites the folder path itself', () => {
    expect(rewritePrefix('/a', '/a', '/z/a')).toBe('/z/a')
  })

  it('leaves an unrelated path untouched', () => {
    expect(rewritePrefix('/other/x.md', '/a', '/z')).toBe('/other/x.md')
  })

  it('leaves a sibling that merely shares a textual prefix untouched', () => {
    expect(rewritePrefix('/archive/x.md', '/arch', '/z')).toBe('/archive/x.md')
  })
})

// R2. `_` is a SINGLE-CHARACTER WILDCARD in SQL LIKE and is ordinary in real paths
// ('/projects/my_project'), so an unescaped prefix pattern silently reaches rows OUTSIDE the
// folder being operated on. For deleteFolder that means soft-deleting documents that were
// never in the folder; for moveFolder it means sweeping siblings into the batch it reports as
// moved. Every path-prefix predicate in this service goes through this helper.
describe('escapeLikeLiteral', () => {
  it('escapes the single-character wildcard', () => {
    expect(escapeLikeLiteral('/a_b')).toBe('/a\\_b')
  })

  it('escapes the multi-character wildcard', () => {
    expect(escapeLikeLiteral('/100%done')).toBe('/100\\%done')
  })

  it('escapes a literal backslash so it cannot swallow the character after it', () => {
    const BS = '\\'
    expect(escapeLikeLiteral(`/a${BS}_b`)).toBe(`/a${BS}${BS}${BS}_b`)
  })

  it('leaves an ordinary path untouched', () => {
    expect(escapeLikeLiteral('/projects/mymind/wiki')).toBe('/projects/mymind/wiki')
  })
})
