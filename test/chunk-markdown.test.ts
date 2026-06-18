import { describe, it, expect } from 'vitest'
import { chunkMarkdown, estimateTokens } from '../server/lib/chunking/chunk-markdown'

const long = (word: string, tokens: number) => Array(Math.ceil(tokens)).fill(word).join(' ')

describe('chunkMarkdown', () => {
  it('returns a single chunk for a short doc, breadcrumb = title', () => {
    const out = chunkMarkdown('Hello world.\n\nSecond paragraph.', { title: 'My Doc' })
    expect(out).toHaveLength(1)
    expect(out[0]!.ord).toBe(0)
    expect(out[0]!.headingPath).toBe('My Doc')
    expect(out[0]!.content).toContain('Hello world.')
  })

  it('splits by heading hierarchy with breadcrumbs', () => {
    const md = '# Intro\n\nalpha text.\n\n## Details\n\nbeta text.'
    const out = chunkMarkdown(md, { title: 'Guide' })
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.some(c => c.headingPath === 'Guide › Intro' && c.content.includes('alpha'))).toBe(true)
    expect(out.some(c => c.headingPath === 'Guide › Intro › Details' && c.content.includes('beta'))).toBe(true)
  })

  it('recursively splits an oversized section under the cap, ords are sequential', () => {
    const md = '# Big\n\n' + long('lorem', 1500)
    const out = chunkMarkdown(md, { title: 'T', targetTokens: 300, maxTokens: 512 })
    expect(out.length).toBeGreaterThan(2)
    for (const c of out) expect(c.tokenCount).toBeLessThanOrEqual(512)
    expect(out.map(c => c.ord)).toEqual(out.map((_, i) => i))
  })

  it('keeps a fenced code block atomic (does not split on its blank lines)', () => {
    const md = '# Code\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter.'
    const out = chunkMarkdown(md, { title: 'T' })
    const codeChunk = out.find(c => c.content.includes('const a = 1;'))
    expect(codeChunk!.content).toContain('const b = 2;') // same chunk, not split at the blank line
  })

  it('does not treat a heading-like line inside a code fence as a heading', () => {
    const md = '# Real\n\n```\n# not a heading\nbody\n```\n'
    const out = chunkMarkdown(md, { title: 'T' })
    expect(out.every(c => c.headingPath === 'T › Real')).toBe(true)
  })

  it('charStart/charEnd map back into the source', () => {
    const src = '# H\n\nhello body here.'
    const out = chunkMarkdown(src, { title: 'T' })
    const c = out[0]!
    expect(src.slice(c.charStart, c.charEnd)).toContain('hello body here.')
  })

  it('estimateTokens is monotonic and positive', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBeGreaterThan(0)
    expect(estimateTokens('a'.repeat(380))).toBeGreaterThan(estimateTokens('a'.repeat(38)))
  })

  it('assigns monotonic, non-collapsing char offsets on repetitive content', () => {
    const md = '# Big\n\n' + Array(1500).fill('alpha').join(' ')
    const out = chunkMarkdown(md, { title: 'T', targetTokens: 300, maxTokens: 512 })
    expect(out.length).toBeGreaterThan(2)
    const starts = out.map(c => c.charStart)
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!)
  })

  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkMarkdown('', { title: 'T' })).toEqual([])
    expect(chunkMarkdown('   \n\n  ', { title: 'T' })).toEqual([])
  })
})
