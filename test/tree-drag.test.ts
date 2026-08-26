import { describe, it, expect } from 'vitest'
import {
  destinationPathFor,
  isSelfOrDescendant,
  canDropInto,
  isNoOpDrop,
  prunePathsUnderFolders
} from '../app/lib/documents/tree-drag'

describe('destinationPathFor', () => {
  it('rehomes a file under the destination folder', () => {
    expect(destinationPathFor('/a/b.md', '/x')).toBe('/x/b.md')
  })

  it('drops to the root without doubling the slash', () => {
    expect(destinationPathFor('/a/b.md', '/')).toBe('/b.md')
  })

  it('rehomes a folder by its own last segment', () => {
    expect(destinationPathFor('/projects/mymind/wiki', '/archive')).toBe('/archive/wiki')
  })
})

describe('isSelfOrDescendant', () => {
  it('counts the path itself', () => {
    expect(isSelfOrDescendant('/a', '/a')).toBe(true)
  })

  it('counts anything underneath', () => {
    expect(isSelfOrDescendant('/a/b/c', '/a')).toBe(true)
  })

  it('does not match a sibling that merely shares a prefix', () => {
    // The bug this guards: a naive startsWith('/a') would call '/ab' a child of '/a'.
    expect(isSelfOrDescendant('/ab', '/a')).toBe(false)
  })

  it('treats the root as an ancestor of everything without doubling the slash', () => {
    expect(isSelfOrDescendant('/a', '/')).toBe(true)
  })
})

describe('canDropInto', () => {
  it('lets a file go anywhere', () => {
    expect(canDropInto({ path: '/a/b.md', nodeType: 'file' }, '/a/b')).toBe(true)
  })

  it('refuses a folder into itself', () => {
    expect(canDropInto({ path: '/a', nodeType: 'folder' }, '/a')).toBe(false)
  })

  it('refuses a folder into its own descendant', () => {
    expect(canDropInto({ path: '/a', nodeType: 'folder' }, '/a/b/c')).toBe(false)
  })

  it('allows a folder into an unrelated folder', () => {
    expect(canDropInto({ path: '/a', nodeType: 'folder' }, '/z')).toBe(true)
  })
})

describe('isNoOpDrop', () => {
  it('is a no-op when the item already lives in that folder', () => {
    expect(isNoOpDrop('/a/b.md', '/a')).toBe(true)
  })

  it('is not a no-op for a different folder', () => {
    expect(isNoOpDrop('/a/b.md', '/z')).toBe(false)
  })

  it('handles root-level items', () => {
    expect(isNoOpDrop('/b.md', '/')).toBe(true)
  })
})

describe('prunePathsUnderFolders', () => {
  const types: Record<string, 'file' | 'folder'> = {
    '/a': 'folder',
    '/a/b.md': 'file',
    '/a/sub': 'folder',
    '/a/sub/c.md': 'file',
    '/z.md': 'file'
  }
  const nodeTypeOf = (p: string) => types[p]

  it('drops children already covered by a selected folder', () => {
    expect(prunePathsUnderFolders(['/a', '/a/b.md', '/a/sub', '/a/sub/c.md'], nodeTypeOf)).toEqual(['/a'])
  })

  it('keeps siblings that no selected folder covers', () => {
    expect(prunePathsUnderFolders(['/a', '/z.md'], nodeTypeOf)).toEqual(['/a', '/z.md'])
  })

  it('leaves a plain file selection untouched', () => {
    expect(prunePathsUnderFolders(['/a/b.md', '/z.md'], nodeTypeOf)).toEqual(['/a/b.md', '/z.md'])
  })
})
