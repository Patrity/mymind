import { describe, it, expect } from 'vitest'
import { parseVisionResponse } from '../server/lib/ai/vision'

describe('parseVisionResponse', () => {
  it('parses summary, ocrText, and tags from clean JSON', () => {
    const raw = '{"summary":"A dog on a couch","ocrText":"","tags":["dog","couch"]}'
    expect(parseVisionResponse(raw)).toEqual({ summary: 'A dog on a couch', ocrText: '', tags: ['dog', 'couch'] })
  })
  it('strips markdown fences', () => {
    const raw = '```json\n{"summary":"x","ocrText":"hi","tags":[]}\n```'
    expect(parseVisionResponse(raw)).toEqual({ summary: 'x', ocrText: 'hi', tags: [] })
  })
  it('coerces missing/invalid fields to empty', () => {
    expect(parseVisionResponse('{"tags":"nope"}')).toEqual({ summary: '', ocrText: '', tags: [] })
  })
  it('returns all-empty on unparseable input', () => {
    expect(parseVisionResponse('not json')).toEqual({ summary: '', ocrText: '', tags: [] })
  })
  it('caps tags at 10', () => {
    const tags = Array.from({ length: 15 }, (_, i) => `t${i}`)
    expect(parseVisionResponse(JSON.stringify({ summary: '', ocrText: '', tags })).tags.length).toBe(10)
  })
})
