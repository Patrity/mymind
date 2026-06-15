import { describe, it, expect } from 'vitest'
import { truncate, sanitizeRequest, sanitizeResponse } from '../server/lib/observability/redact'

describe('truncate', () => {
  it('passes through short strings unchanged', () => {
    expect(truncate('hello', 100)).toBe('hello')
  })
  it('caps long strings and appends a marker', () => {
    const out = truncate('x'.repeat(50), 10)
    expect(out.startsWith('xxxxxxxxxx')).toBe(true)
    expect(out).toContain('…truncated')
    expect(out.length).toBeLessThan(50)
  })
})

describe('sanitizeRequest', () => {
  it('keeps chat messages but truncates oversize content', () => {
    const req = sanitizeRequest('model', { messages: [{ role: 'user', content: 'y'.repeat(20_000) }] }) as { messages: { content: string }[] }
    expect(req.messages[0]!.content).toContain('…truncated')
  })
  it('reduces an embeddings request to text + count, never the vectors', () => {
    const req = sanitizeRequest('attempt', { inputs: ['a', 'b', 'c'] }) as Record<string, unknown>
    expect(req.count).toBe(3)
    expect(JSON.stringify(req)).not.toContain('vector')
  })
  it('never includes an apiKey/authorization even if present', () => {
    const req = sanitizeRequest('model', { messages: [], apiKey: 'secret', authorization: 'Bearer secret' })
    expect(JSON.stringify(req)).not.toContain('secret')
  })
})

describe('sanitizeResponse', () => {
  it('drops embedding vectors, keeping dim + count', () => {
    const res = sanitizeResponse({ data: [[0.1, 0.2, 0.3]], usage: { total: 1 } }) as Record<string, unknown>
    expect(res.dim).toBe(3)
    expect(res.count).toBe(1)
    expect(JSON.stringify(res)).not.toContain('0.1')
  })
  it('truncates long assistant text', () => {
    const res = sanitizeResponse('z'.repeat(50_000)) as string
    expect(res).toContain('…truncated')
  })
})
