import { describe, it, expect } from 'vitest'
import { messageText, toModelContent } from './run'
import type { AgentContentPart } from './run'

describe('messageText', () => {
  it('passes a string through', () => { expect(messageText('hi')).toBe('hi') })
  it('joins text parts and ignores image parts', () => {
    const parts: AgentContentPart[] = [
      { type: 'text', text: 'look at this' },
      { type: 'image', image: 'data:image/webp;base64,AAAA', mediaType: 'image/webp' }
    ]
    expect(messageText(parts)).toBe('look at this')
  })
})

describe('toModelContent', () => {
  it('maps parts to AI SDK shape (image preserved, text redaction applied for assistant)', () => {
    const out = toModelContent('assistant', [
      { type: 'text', text: 'see ![x](/api/images/y/raw)' },
      { type: 'image', image: 'data:image/webp;base64,AAAA', mediaType: 'image/webp' }
    ]) as AgentContentPart[]
    expect(out[0]).toEqual({ type: 'text', text: 'see [image]' })   // redaction on text part
    expect(out[1]).toMatchObject({ type: 'image' })
  })
  it('redacts a plain string assistant message', () => {
    expect(toModelContent('assistant', '![x](/api/images/y/raw)')).toBe('[image]')
  })
  it('does NOT redact a user text part', () => {
    const out = toModelContent('user', [{ type: 'text', text: 'see ![x](/api/images/y/raw)' }]) as AgentContentPart[]
    expect(out[0]).toEqual({ type: 'text', text: 'see ![x](/api/images/y/raw)' })
  })
})
