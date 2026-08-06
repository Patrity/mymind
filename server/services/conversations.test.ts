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
    expect(JSON.stringify(out)).not.toMatch(/\[image\]|\[attachment\]/)
  })
})
