import { describe, it, expect } from 'vitest'
import { ancestorFolderPaths, folderChainPaths } from './folders'

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
