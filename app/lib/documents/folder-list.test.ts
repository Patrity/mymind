import { describe, it, expect } from 'vitest'
import { collectFolderPaths, dirnameOf } from './folder-list'
import type { TreeNode } from '~~/server/services/tree'

const f = (name: string, path: string, children: TreeNode[] = []): TreeNode =>
  ({ name, path, type: 'folder', children })
const d = (name: string, path: string): TreeNode =>
  ({ name, path, type: 'file', id: `id-${name}` })

describe('collectFolderPaths', () => {
  it('always offers the root first so a doc can be created at the top level', () => {
    expect(collectFolderPaths([])).toEqual(['/'])
  })

  it('walks nested folders depth-first and ignores files', () => {
    const tree = [
      f('projects', '/projects', [
        f('mymind', '/projects/mymind', [d('auth.md', '/projects/mymind/auth.md')]),
        f('portfolio', '/projects/portfolio')
      ]),
      f('input', '/input', [d('note.md', '/input/note.md')])
    ]
    expect(collectFolderPaths(tree)).toEqual([
      '/', '/projects', '/projects/mymind', '/projects/portfolio', '/input'
    ])
  })

  it('never emits a duplicate even if the tree repeats a path', () => {
    const tree = [f('input', '/input'), f('input', '/input')]
    expect(collectFolderPaths(tree)).toEqual(['/', '/input'])
  })
})

describe('dirnameOf', () => {
  it('returns the containing folder of a nested path', () => {
    expect(dirnameOf('/projects/mymind/auth.md')).toBe('/projects/mymind')
  })

  it('returns root for a file at the top level', () => {
    expect(dirnameOf('/untitled.md')).toBe('/')
  })

  it('ignores duplicate slashes', () => {
    expect(dirnameOf('//input//note.md')).toBe('/input')
  })
})
