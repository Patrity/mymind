import { describe, expect, it } from 'vitest'
import { buildTree, fenced, formatBytes, viewKind } from './display'

describe('workspace display helpers (cycle 82 Task 3)', () => {
  it('nests a flat listing and sums directory sizes (skipped dirs show none)', () => {
    const t = buildTree([
      { path: 'node_modules', type: 'dir', bytes: null, skipped: true },
      { path: 'src', type: 'dir', bytes: null },
      { path: 'src/deep', type: 'dir', bytes: null },
      { path: 'src/deep/a.ts', type: 'file', bytes: 10 },
      { path: 'src/b.ts', type: 'file', bytes: 5 },
      { path: 'link', type: 'link', bytes: 11, target: '/etc/passwd' },
      { path: 'README.md', type: 'file', bytes: 3 }
    ])
    expect(t.map(n => n.label)).toEqual(['node_modules', 'src', 'link', 'README.md'])
    expect(t[0]!.bytes).toBeNull()
    expect(t[1]!.bytes).toBe(15)
    expect(t[1]!.children!.map(n => n.label)).toEqual(['deep', 'b.ts'])
    expect(t[1]!.children![0]!.bytes).toBe(10)
    expect(t[2]!.target).toBe('/etc/passwd')
  })
  it('a fence the content cannot close early', () => {
    const f = fenced('a ```` b', 'ts')
    expect(f.startsWith('`````ts\n')).toBe(true)
    expect(f.endsWith('\n`````')).toBe(true)
    expect(fenced('x', 'py')).toBe('```py\nx\n```')
  })
  it('kinds and sizes', () => {
    expect(viewKind('docs/x.MD')).toEqual({ kind: 'markdown' })
    expect(viewKind('a/b.py')).toEqual({ kind: 'code', lang: 'python' })
    expect(viewKind('Dockerfile')).toEqual({ kind: 'code', lang: 'dockerfile' })
    expect(viewKind('notes.txt')).toEqual({ kind: 'text' })
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(null)).toBe('')
  })
})
