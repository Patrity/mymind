import { describe, it, expect } from 'vitest'
import { parseMemories } from '../server/lib/ai/memory-extract'

describe('parseMemories', () => {
  it('parses {"memories":[...]} envelope', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 'MyMind uses Drizzle ORM with Postgres.', tags: ['drizzle', 'postgres'], confidence: 0.9 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].scope).toBe('agent')
    expect(result[0].content).toBe('MyMind uses Drizzle ORM with Postgres.')
    expect(result[0].tags).toEqual(['drizzle', 'postgres'])
    expect(result[0].confidence).toBeCloseTo(0.9)
  })

  it('parses a bare array', () => {
    const raw = JSON.stringify([
      { scope: 'user', content: 'Tony prefers pnpm over npm.', tags: ['tooling'], confidence: 0.85 }
    ])
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].scope).toBe('user')
    expect(result[0].content).toBe('Tony prefers pnpm over npm.')
  })

  it('parses JSON wrapped in ```json fences', () => {
    const obj = {
      memories: [
        { scope: 'world', content: 'pgvector supports HNSW cosine indexes.', tags: ['pgvector'], confidence: 0.8 }
      ]
    }
    const raw = '```json\n' + JSON.stringify(obj) + '\n```'
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].scope).toBe('world')
    expect(result[0].content).toBe('pgvector supports HNSW cosine indexes.')
  })

  it('parses JSON wrapped in prose (prose-wrapped)', () => {
    const obj = {
      memories: [
        { scope: 'agent', content: 'Embeddings are 2560-dimensional.', tags: ['embeddings'], confidence: 0.95 }
      ]
    }
    const raw = `Here are the extracted memories:\n${JSON.stringify(obj)}\nLet me know if you need more.`
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Embeddings are 2560-dimensional.')
  })

  it('defaults missing/invalid scope to "agent"', () => {
    const raw = JSON.stringify({
      memories: [
        { content: 'No scope field here.', confidence: 0.7 },
        { scope: 'invalid-scope', content: 'Bad scope value.', confidence: 0.6 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(2)
    expect(result[0].scope).toBe('agent')
    expect(result[1].scope).toBe('agent')
  })

  it('drops items without content', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: '' },
        { scope: 'agent' },
        { scope: 'user', content: 'Valid memory.', confidence: 0.8 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Valid memory.')
  })

  it('drops items where content is not a string', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 42 },
        { scope: 'user', content: 'Real memory.', confidence: 0.75 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Real memory.')
  })

  it('returns [] for total garbage', () => {
    expect(parseMemories('this is not JSON at all')).toEqual([])
    expect(parseMemories('')).toEqual([])
    expect(parseMemories('   ')).toEqual([])
    expect(parseMemories('{ broken json }')).toEqual([])
  })

  it('clamps confidence below 0 to 0 (and then drops since 0 < 0.3 threshold)', () => {
    const raw = JSON.stringify({
      memories: [{ scope: 'agent', content: 'Clamped low.', confidence: -0.5 }]
    })
    // -0.5 is clamped to 0, which is below the 0.3 drop threshold → dropped
    const result = parseMemories(raw)
    expect(result).toHaveLength(0)
  })

  it('clamps confidence above 1 to 1', () => {
    const raw = JSON.stringify({
      memories: [{ scope: 'user', content: 'Clamped high.', confidence: 1.5 }]
    })
    const result = parseMemories(raw)
    expect(result[0].confidence).toBe(1)
  })

  it('coerces tags that is a single string into an array', () => {
    const raw = JSON.stringify({
      memories: [{ scope: 'agent', content: 'Single tag test.', tags: 'single-tag', confidence: 0.8 }]
    })
    const result = parseMemories(raw)
    expect(result[0].tags).toEqual(['single-tag'])
  })

  it('coerces non-string tag items to strings', () => {
    const raw = JSON.stringify({
      memories: [{ scope: 'agent', content: 'Mixed tags.', tags: ['valid', 42, null], confidence: 0.8 }]
    })
    const result = parseMemories(raw)
    // non-string items are filtered out
    expect(result[0].tags).toEqual(['valid'])
  })

  it('handles undefined tags gracefully', () => {
    const raw = JSON.stringify({
      memories: [{ scope: 'agent', content: 'No tags here.', confidence: 0.8 }]
    })
    const result = parseMemories(raw)
    expect(result[0].tags).toBeUndefined()
  })

  it('handles multiple valid items in one response', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 'First fact.', tags: ['a'], confidence: 0.9 },
        { scope: 'user', content: 'Second fact.', tags: ['b'], confidence: 0.8 },
        { scope: 'world', content: 'Third fact.', tags: ['c'], confidence: 0.7 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(3)
    expect(result[0].scope).toBe('agent')
    expect(result[1].scope).toBe('user')
    expect(result[2].scope).toBe('world')
  })

  it('parses provenance fields: evidence_msg_ids, quote, reasoning', () => {
    const raw = JSON.stringify({
      memories: [
        {
          scope: 'agent',
          content: 'MyMind uses Drizzle ORM.',
          confidence: 0.9,
          evidence_msg_ids: ['msg-1', 'msg-2'],
          quote: 'We use Drizzle for all DB access.',
          reasoning: 'Explicitly stated in the conversation.'
        }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].evidenceMsgIds).toEqual(['msg-1', 'msg-2'])
    expect(result[0].quote).toBe('We use Drizzle for all DB access.')
    expect(result[0].reasoning).toBe('Explicitly stated in the conversation.')
  })

  it('filters non-string items from evidence_msg_ids', () => {
    const raw = JSON.stringify({
      memories: [
        {
          scope: 'agent',
          content: 'Some fact.',
          confidence: 0.8,
          evidence_msg_ids: ['msg-1', 42, null, 'msg-3']
        }
      ]
    })
    const result = parseMemories(raw)
    expect(result[0].evidenceMsgIds).toEqual(['msg-1', 'msg-3'])
  })

  it('slices quote to 280 chars and reasoning to 500 chars', () => {
    const longQuote = 'q'.repeat(400)
    const longReasoning = 'r'.repeat(600)
    const raw = JSON.stringify({
      memories: [
        {
          scope: 'agent',
          content: 'Some fact.',
          confidence: 0.8,
          quote: longQuote,
          reasoning: longReasoning
        }
      ]
    })
    const result = parseMemories(raw)
    expect(result[0].quote).toHaveLength(280)
    expect(result[0].reasoning).toHaveLength(500)
  })

  it('drops candidate with confidence 0.2 (below 0.3 threshold)', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 'Low confidence fact.', confidence: 0.2 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(0)
  })

  it('keeps candidate with confidence exactly 0.3', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 'Exactly at threshold.', confidence: 0.3 }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBeCloseTo(0.3)
  })

  it('keeps candidate with no confidence field (manual-style)', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 'No confidence provided.' }
      ]
    })
    const result = parseMemories(raw)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBeUndefined()
  })

  it('omits provenance fields when not present in source', () => {
    const raw = JSON.stringify({
      memories: [
        { scope: 'agent', content: 'Plain fact.', confidence: 0.8 }
      ]
    })
    const result = parseMemories(raw)
    expect(result[0].evidenceMsgIds).toBeUndefined()
    expect(result[0].quote).toBeUndefined()
    expect(result[0].reasoning).toBeUndefined()
  })
})
