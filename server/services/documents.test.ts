import { describe, it, expect } from 'vitest'
import { toSummaryDTO } from './documents'

const row = {
  id: 'd1',
  path: '/projects/mymind/x.md',
  title: 'X',
  content: 'a'.repeat(50_000),
  language: 'markdown',
  frontmatter: {},
  project: 'mymind',
  domain: null,
  type: null,
  tags: ['a'],
  topic: null,
  isPublic: false,
  publicSlug: null,
  ocrId: null,
  updatedAt: new Date('2026-07-29T00:00:00Z')
}

describe('toSummaryDTO', () => {
  it('omits the document body entirely', () => {
    const s = toSummaryDTO(row as never)
    expect('content' in s).toBe(false)
    expect(JSON.stringify(s)).not.toContain('aaaa')
  })

  it('keeps the fields an agent needs to decide what to open', () => {
    expect(toSummaryDTO(row as never)).toEqual({
      id: 'd1',
      path: '/projects/mymind/x.md',
      title: 'X',
      project: 'mymind',
      type: null,
      tags: ['a'],
      updatedAt: '2026-07-29T00:00:00.000Z'
    })
  })
})
