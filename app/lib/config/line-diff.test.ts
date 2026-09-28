import { describe, it, expect } from 'vitest'
import { lineDiff, LINE_DIFF_MAX_CELLS } from './line-diff'

const render = (before: string, after: string) =>
  lineDiff(before, after).map(l => (l.kind === 'same' ? ' ' : l.kind === 'add' ? '+' : '-') + l.text)

describe('lineDiff', () => {
  it('marks identical content as all same', () => {
    expect(render('a\nb', 'a\nb')).toEqual([' a', ' b'])
  })

  it('shows a changed middle line as del then add, keeping the context', () => {
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c'])
  })

  it('handles pure insertions and deletions', () => {
    expect(render('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c'])
    expect(render('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c'])
  })

  it('treats empty strings as zero lines', () => {
    expect(render('', 'x')).toEqual(['+x'])
    expect(render('x', '')).toEqual(['-x'])
    expect(render('', '')).toEqual([])
  })

  it('keeps the longest common run instead of rewriting everything', () => {
    const out = lineDiff('x\na\nb\nc', 'a\nb\nc\ny')
    expect(out.filter(l => l.kind === 'same').map(l => l.text)).toEqual(['a', 'b', 'c'])
    expect(out.filter(l => l.kind !== 'same')).toEqual([{ kind: 'del', text: 'x' }, { kind: 'add', text: 'y' }])
  })

  it('normalises CRLF', () => {
    expect(render('a\r\nb', 'a\nb')).toEqual([' a', ' b'])
  })

  it('falls back to all-del-then-all-add past the cell budget', () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(LINE_DIFF_MAX_CELLS)) + 1 }, (_, i) => `l${i}`).join('\n')
    const out = lineDiff(big, big)
    expect(out[0]!.kind).toBe('del')
    expect(out.at(-1)!.kind).toBe('add')
  })
})
