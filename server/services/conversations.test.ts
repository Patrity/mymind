import { describe, it, expect } from 'vitest'
import { rowToAgentMessage } from './conversations'

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
