import { describe, it, expect } from 'vitest'
import {
  moveNodeInTree,
  removeNodeFromTree,
  setFolderColorInTree,
  insertDocumentInTree,
  insertFolderInTree
} from './tree-mutate'
import type { TreeNode } from '~~/server/services/tree'

const f = (name: string, path: string, children: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode =>
  ({ name, path, type: 'folder', children, ...extra })
const d = (name: string, path: string, id = `id-${name}`): TreeNode =>
  ({ name, path, type: 'file', id, title: null })

describe('moveNodeInTree', () => {
  it('renames a file in place (same parent, new name)', () => {
    const tree = [f('notes', '/notes', [d('todo.md', '/notes/todo.md')])]
    const next = moveNodeInTree(tree, '/notes/todo.md', '/notes/done.md')
    expect(next[0]!.children).toEqual([{ ...d('done.md', '/notes/done.md', 'id-todo.md') }])
  })

  it('moves a file into a different folder', () => {
    const tree = [
      f('a', '/a', [d('x.md', '/a/x.md')]),
      f('b', '/b')
    ]
    const next = moveNodeInTree(tree, '/a/x.md', '/b/x.md')
    const a = next.find(n => n.path === '/a')!
    const b = next.find(n => n.path === '/b')!
    expect(a.children).toEqual([])
    expect(b.children).toEqual([d('x.md', '/b/x.md')])
  })

  it('moves a file to the top level', () => {
    const tree = [f('a', '/a', [d('x.md', '/a/x.md')])]
    const next = moveNodeInTree(tree, '/a/x.md', '/x.md')
    expect(next.find(n => n.path === '/a')!.children).toEqual([])
    expect(next.find(n => n.path === '/x.md')).toEqual(d('x.md', '/x.md'))
  })

  it('renames a folder and rewrites every descendant path prefix', () => {
    const tree = [
      f('old', '/old', [
        d('a.md', '/old/a.md'),
        f('sub', '/old/sub', [d('b.md', '/old/sub/b.md')])
      ], { id: 'folder-1', color: '#fff' })
    ]
    const next = moveNodeInTree(tree, '/old', '/renamed')
    const renamed = next.find(n => n.path === '/renamed')!
    expect(renamed.id).toBe('folder-1')
    expect(renamed.color).toBe('#fff')
    expect(renamed.children).toEqual([
      d('a.md', '/renamed/a.md'),
      f('sub', '/renamed/sub', [d('b.md', '/renamed/sub/b.md')])
    ])
  })

  it('moves a folder (with subtree) into another folder', () => {
    const tree = [
      f('src', '/src', [d('a.md', '/src/a.md')]),
      f('dest', '/dest')
    ]
    const next = moveNodeInTree(tree, '/src', '/dest/src')
    expect(next.find(n => n.path === '/src')).toBeUndefined()
    const dest = next.find(n => n.path === '/dest')!
    expect(dest.children).toEqual([f('src', '/dest/src', [d('a.md', '/dest/src/a.md')])])
  })

  it('is a no-op when old and new path are identical', () => {
    const tree = [f('a', '/a', [d('x.md', '/a/x.md')])]
    expect(moveNodeInTree(tree, '/a/x.md', '/a/x.md')).toBe(tree)
  })

  it('leaves the tree untouched when the path is not found (nothing safe to guess)', () => {
    const tree = [f('a', '/a')]
    expect(moveNodeInTree(tree, '/missing.md', '/elsewhere.md')).toBe(tree)
  })
})

describe('removeNodeFromTree', () => {
  it('removes a file', () => {
    const tree = [f('a', '/a', [d('x.md', '/a/x.md'), d('y.md', '/a/y.md')])]
    const next = removeNodeFromTree(tree, '/a/x.md')
    expect(next[0]!.children).toEqual([d('y.md', '/a/y.md')])
  })

  it('removes a folder and its whole subtree', () => {
    const tree = [
      f('a', '/a', [d('x.md', '/a/x.md')]),
      f('b', '/b')
    ]
    const next = removeNodeFromTree(tree, '/a')
    expect(next).toEqual([f('b', '/b')])
  })
})

describe('setFolderColorInTree', () => {
  it('sets a folder colour by id, marking it as an own override', () => {
    const tree = [f('a', '/a', [], { id: 'folder-1', color: null, colorSource: null })]
    const next = setFolderColorInTree(tree, 'folder-1', '#ef4444')
    expect(next[0]).toMatchObject({ color: '#ef4444', colorSource: 'own' })
  })

  it('clears a folder colour back toward inheriting', () => {
    const tree = [f('a', '/a', [], { id: 'folder-1', color: '#ef4444', colorSource: 'own' })]
    const next = setFolderColorInTree(tree, 'folder-1', null)
    expect(next[0]).toMatchObject({ color: null, colorSource: null })
  })

  it('does not touch other folders', () => {
    const tree = [
      f('a', '/a', [], { id: 'folder-1', color: null }),
      f('b', '/b', [], { id: 'folder-2', color: '#000' })
    ]
    const next = setFolderColorInTree(tree, 'folder-1', '#fff')
    expect(next[1]).toMatchObject({ color: '#000' })
  })
})

describe('insertDocumentInTree', () => {
  it('inserts a file into an existing folder, sorted alongside siblings', () => {
    const tree = [f('a', '/a', [d('m.md', '/a/m.md')])]
    const next = insertDocumentInTree(tree, 'temp-1', '/a/b.md')
    expect(next[0]!.children).toEqual([
      d('b.md', '/a/b.md', 'temp-1'),
      d('m.md', '/a/m.md')
    ])
  })

  it('inserts at the top level', () => {
    const next = insertDocumentInTree([], 'temp-1', '/note.md')
    expect(next).toEqual([d('note.md', '/note.md', 'temp-1')])
  })
})

describe('insertFolderInTree', () => {
  it('inserts an empty folder, sorted before files in the same parent', () => {
    const tree = [d('a.md', '/a.md')]
    const next = insertFolderInTree(tree, 'temp-1', '/newfolder')
    expect(next).toEqual([
      f('newfolder', '/newfolder', [], { id: 'temp-1', color: null, colorSource: null }),
      d('a.md', '/a.md')
    ])
  })
})
