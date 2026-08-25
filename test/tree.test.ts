import { describe, it, expect } from 'vitest'
import { buildTree, applyFolderColors, type TreeNode } from '../server/services/tree'

const find = (nodes: TreeNode[], path: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.path === path) return n
    const hit = n.children ? find(n.children, path) : undefined
    if (hit) return hit
  }
  return undefined
}

describe('buildTree', () => {
  it('nests docs by path into folders', () => {
    const tree = buildTree([
      { id: '1', path: '/input/a.md', title: 'A' },
      { id: '2', path: '/projects/mymind/b.md', title: 'B' }
    ])
    expect(tree.map(n => n.name)).toEqual(['input', 'projects'])
    const projects = tree.find(n => n.name === 'projects')!
    expect(projects.type).toBe('folder')
    expect(projects.children![0].name).toBe('mymind')
    const b = projects.children![0].children![0]
    expect(b).toMatchObject({ type: 'file', name: 'b.md', id: '2' })
  })

  it('sorts folders before files, each group alphabetical', () => {
    const tree = buildTree([
      { id: '1', path: '/root/zebra.md', title: 'Z' },
      { id: '2', path: '/root/alpha/c.md', title: 'C' },
      { id: '3', path: '/root/apple.md', title: 'Apple' }
    ])
    const root = tree.find(n => n.name === 'root')!
    // folder 'alpha' must come before files 'apple.md' and 'zebra.md'
    expect(root.children![0].type).toBe('folder')
    expect(root.children![0].name).toBe('alpha')
    // files sorted alphabetically after folders
    expect(root.children![1].name).toBe('apple.md')
    expect(root.children![2].name).toBe('zebra.md')
  })
})

describe('buildTree with folder rows', () => {
  it('keeps a folder that has no documents left in it', () => {
    const tree = buildTree(
      [{ id: 'd1', path: '/input/note.md', title: 'note' }],
      [{ path: '/input' }, { path: '/archive' }]
    )
    expect(find(tree, '/archive')).toMatchObject({ type: 'folder', children: [] })
  })

  it('does not duplicate a folder that both a document and a row imply', () => {
    const tree = buildTree(
      [{ id: 'd1', path: '/input/note.md', title: 'note' }],
      [{ path: '/input' }]
    )
    expect(tree.filter(n => n.path === '/input')).toHaveLength(1)
  })

  it('still sorts folders before files, alphabetically', () => {
    const tree = buildTree(
      [{ id: 'd1', path: '/zebra.md', title: 'zebra' }],
      [{ path: '/alpha' }]
    )
    expect(tree.map(n => n.path)).toEqual(['/alpha', '/zebra.md'])
  })

  it("attaches a folder row's real id to its node, even when a document implied it first", () => {
    // The colour picker PATCHes `/api/folders/[id]` with this id — a folder's tree-item KEY
    // is its path (see Tree.vue), which is not a valid id for that route, so the real id has
    // to travel with the node. Both construction orders are covered: /projects/mymind is
    // implied by the document below AND has a registry row; /archive has only a row.
    const tree = buildTree(
      [{ id: 'd1', path: '/projects/mymind/note.md', title: 'note' }],
      [{ path: '/projects', id: 'f-projects' }, { path: '/projects/mymind', id: 'f-mymind' }, { path: '/archive', id: 'f-archive' }]
    )
    expect(find(tree, '/projects/mymind')).toMatchObject({ id: 'f-mymind' })
    expect(find(tree, '/archive')).toMatchObject({ id: 'f-archive' })
  })
})

describe('applyFolderColors', () => {
  const tree = () => buildTree([], [
    { path: '/projects' },
    { path: '/projects/mymind' },
    { path: '/projects/mymind/wiki' },
    { path: '/projects/mymind/specs' },
    { path: '/input' }
  ])

  it('seeds a project folder from the project colour', () => {
    const out = applyFolderColors(tree(), {
      own: new Map(),
      projects: new Map([['mymind', '#3b82f6']])
    })
    expect(find(out, '/projects/mymind')).toMatchObject({ color: '#3b82f6', colorSource: 'project' })
  })

  it('cascades a project colour to descendants as inherited', () => {
    const out = applyFolderColors(tree(), {
      own: new Map(),
      projects: new Map([['mymind', '#3b82f6']])
    })
    expect(find(out, '/projects/mymind/wiki')).toMatchObject({ color: '#3b82f6', colorSource: 'inherited' })
  })

  it('cascades an own colour to a further descendant (not just its immediate child) as inherited', () => {
    // Carried from Task 5's review: the project-colour cascade above is proven two levels
    // deep, but the SAME recursive line also carries an own-colour override — this closes
    // that gap. '/projects' sets its own colour; '/projects/mymind/wiki' is two levels below
    // it, with '/projects/mymind' in between contributing nothing of its own.
    const out = applyFolderColors(tree(), {
      own: new Map([['/projects', '#ec4899']]),
      projects: new Map()
    })
    expect(find(out, '/projects/mymind/wiki')).toMatchObject({ color: '#ec4899', colorSource: 'inherited' })
  })

  it("lets a folder's own colour beat the inherited one and cascade in turn", () => {
    const out = applyFolderColors(tree(), {
      own: new Map([['/projects/mymind/specs', '#ef4444']]),
      projects: new Map([['mymind', '#3b82f6']])
    })
    expect(find(out, '/projects/mymind/specs')).toMatchObject({ color: '#ef4444', colorSource: 'own' })
  })

  it('leaves a folder with no colour and no ancestor colour plain', () => {
    const out = applyFolderColors(tree(), { own: new Map(), projects: new Map() })
    expect(find(out, '/input')).toMatchObject({ color: null, colorSource: null })
  })

  it('does not colour files', () => {
    const out = applyFolderColors(
      buildTree([{ id: 'd1', path: '/projects/mymind/auth.md', title: 'auth' }], []),
      { own: new Map(), projects: new Map([['mymind', '#3b82f6']]) }
    )
    expect(find(out, '/projects/mymind/auth.md')?.color).toBeUndefined()
  })
})
