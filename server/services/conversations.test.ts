import { describe, it, expect } from 'vitest'
import { rowToAgentMessage, hydrateAttachments } from './conversations'

describe('rowToAgentMessage', () => {
  it('rebuilds tool records from a modern row', () => {
    const m = rowToAgentMessage({
      role: 'assistant', content: 'hi',
      toolCalls: [{ callId: 'c1', name: 'web_search', kind: 'read', args: { q: 'x' }, result: { hits: 1 }, summary: 's', textOffset: 3 }],
      attachments: null
    })
    expect((m as { toolRecords?: unknown[] }).toolRecords).toHaveLength(1)
  })

  it('tolerates a LEGACY row with no callId', () => {
    const m = rowToAgentMessage({
      role: 'assistant', content: 'hi',
      toolCalls: [{ name: 'web_search', summary: 's' }], attachments: null
    })
    expect((m as { toolRecords?: { callId?: string }[] }).toolRecords![0]!.callId).toBeUndefined()
  })

  it('never throws on malformed tool_calls jsonb', () => {
    expect(() => rowToAgentMessage({ role: 'assistant', content: 'hi', toolCalls: 'garbage' as never, attachments: null })).not.toThrow()
    expect(rowToAgentMessage({ role: 'assistant', content: 'hi', toolCalls: 'garbage' as never, attachments: null }))
      .toEqual({ role: 'assistant', content: 'hi' })
  })
})

describe('hydrateAttachments', () => {
  it('rehydrates attachments only for the most recent turns, and never leaves a text marker', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      role: 'user', content: `q${i}`,
      toolCalls: null, attachments: [{ id: `img${i}`, kind: 'image', mime: 'image/webp' }]
    }))
    const out = await hydrateAttachments(
      rows.map(rowToAgentMessage),
      rows,
      async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' })
    )

    expect(Array.isArray(out.at(-1)!.content)).toBe(true)         // newest: real image parts
    expect(out[0]!.content).toBe('q0')                            // oldest: plain text, no marker
    // NOTE: `[attachment\]` (no trailing text) never matches the real marker text emitted by
    // buildUserMessageParts, which is `[attachment unavailable...]` — corrected below so this
    // assertion can actually catch a leaked marker, not just the out-of-window (never-called)
    // case which was already guaranteed marker-free by construction.
    expect(JSON.stringify(out)).not.toMatch(/\[image\]|\[attachment unavailable/)
  })

  it('drops the unavailable-marker for a failed within-window read (readBytes resolves null), keeping the turn\'s other real content', async () => {
    const rows = [{
      role: 'user', content: 'q0', toolCalls: null,
      attachments: [
        { id: 'ok', kind: 'image', mime: 'image/webp' },
        { id: 'missing', kind: 'image', mime: 'image/webp' }
      ]
    }]
    const out = await hydrateAttachments(
      rows.map(rowToAgentMessage),
      rows,
      async (a) => (a.id === 'ok' ? { bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' } : null)
    )

    expect(JSON.stringify(out)).not.toMatch(/\[attachment unavailable/)
    // usable: the successfully-read image is still present, not just dropped along with the marker
    expect(Array.isArray(out[0]!.content)).toBe(true)
    const parts = out[0]!.content as { type: string }[]
    expect(parts.some(p => p.type === 'image')).toBe(true)
  })

  it('falls back to the plain text (not an empty parts array) when readBytes throws and nothing else survives the strip', async () => {
    const rows = [{
      role: 'user', content: '', toolCalls: null,
      attachments: [{ id: 'missing', kind: 'image', mime: 'image/webp' }]
    }]
    const out = await hydrateAttachments(
      rows.map(rowToAgentMessage),
      rows,
      async () => { throw new Error('missing blob') }
    )

    expect(JSON.stringify(out)).not.toMatch(/\[attachment unavailable/)
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('')   // fallback to plain text, never an empty [] parts array
  })
})
