import { describe, it, expect } from 'vitest'
import { buildTree } from '../server/services/tree'

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
