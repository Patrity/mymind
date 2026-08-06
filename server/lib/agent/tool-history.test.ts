import { describe, it, expect } from 'vitest'
import {
  capResult, applyHistoryPolicy, toolBlocksFor,
  READ_RESULT_CAP, type AgentToolRecord
} from './tool-history'

function rec(over: Partial<AgentToolRecord> = {}): AgentToolRecord {
  return {
    callId: 'call_1', name: 'web_search', kind: 'read',
    args: { query: 'x' }, result: { hits: ['a'] }, summary: 'searched',
    textOffset: 0, ...over
  }
}
const assistant = (records: AgentToolRecord[]) => ({ role: 'assistant', content: 'hi', toolRecords: records })

describe('capResult', () => {
  it('truncates an oversized result and marks it', () => {
    const out = capResult({ body: 'x'.repeat(5000) }, 100) as { truncated: boolean; preview: string }
    expect(out.truncated).toBe(true)
    expect(out.preview.length).toBeLessThanOrEqual(100)
  })

  it('returns small results untouched by identity', () => {
    const small = { ok: true, id: 'abc' }
    expect(capResult(small, 100)).toBe(small)
  })

  it('never throws on a circular result', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(capResult(circular, 100)).toEqual({ unserializable: true })
  })
})

describe('applyHistoryPolicy', () => {
  it('keeps results for the last 3 tool-bearing turns and elides older ones', () => {
    const msgs = [
      assistant([rec({ callId: 'old' })]),   // 4th newest -> elided
      assistant([rec({ callId: 'c3' })]),
      assistant([rec({ callId: 'c2' })]),
      assistant([rec({ callId: 'c1' })])     // newest -> kept
    ]
    const out = applyHistoryPolicy(msgs)
    expect(out[0]!.toolRecords![0]!.result).toEqual({ elided: true, bytes: expect.any(Number) })
    expect(out[3]!.toolRecords![0]!.result).toEqual({ hits: ['a'] })
  })

  it('ALWAYS keeps the call itself, however old', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => assistant([rec({ callId: `c${i}` })]))
    const out = applyHistoryPolicy(msgs)
    expect(out.every(m => m.toolRecords![0]!.callId)).toBe(true)
    expect(out.every(m => m.toolRecords![0]!.name === 'web_search')).toBe(true)
  })

  it('does not let plain chat turns consume the window', () => {
    const msgs = [
      assistant([rec({ callId: 'tool_turn' })]),
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' }, { role: 'assistant', content: 'f' }
    ]
    const out = applyHistoryPolicy(msgs as never[]) as typeof msgs
    expect((out[0] as { toolRecords?: AgentToolRecord[] }).toolRecords![0]!.result).toEqual({ hits: ['a'] })
  })

  it('caps read results but keeps write receipts whole', () => {
    const big = { body: 'y'.repeat(5000) }
    const out = applyHistoryPolicy([
      assistant([rec({ kind: 'read', result: big }), rec({ callId: 'w', kind: 'create', result: big })])
    ])
    expect((out[0]!.toolRecords![0]!.result as { truncated?: boolean }).truncated).toBe(true)
    expect(out[0]!.toolRecords![1]!.result).toBe(big)
  })

  it('leaves messages without toolRecords untouched by identity', () => {
    const plain = { role: 'assistant', content: 'no tools' }
    expect(applyHistoryPolicy([plain])[0]).toBe(plain)
  })
})

describe('toolBlocksFor', () => {
  it('pairs every tool-result with a preceding tool-call of the same id', () => {
    const blocks = toolBlocksFor([rec({ callId: 'a' }), rec({ callId: 'b', textOffset: 10 })])
    const callIds = blocks.filter(b => b.role === 'assistant')
      .flatMap(b => b.content as { toolCallId: string }[]).map(c => c.toolCallId)
    const resultIds = blocks.filter(b => b.role === 'tool')
      .flatMap(b => b.content as { toolCallId: string }[]).map(c => c.toolCallId)
    expect(resultIds.every(id => callIds.includes(id))).toBe(true)
    expect(resultIds).toEqual(['a', 'b'])
  })

  it('emits a tool message even when the result is elided (pairing must hold)', () => {
    const blocks = toolBlocksFor([rec({ result: { elided: true, bytes: 900 } })])
    expect(blocks.filter(b => b.role === 'tool')).toHaveLength(1)
  })

  it('groups calls sharing a textOffset into ONE block', () => {
    const blocks = toolBlocksFor([rec({ callId: 'a', textOffset: 0 }), rec({ callId: 'b', textOffset: 0 })])
    expect(blocks).toHaveLength(2)                       // one assistant + one tool
    expect(blocks[0]!.content).toHaveLength(2)
  })

  it('emits successive blocks for calls at different offsets', () => {
    const blocks = toolBlocksFor([rec({ callId: 'a', textOffset: 0 }), rec({ callId: 'b', textOffset: 40 })])
    expect(blocks).toHaveLength(4)                       // assistant,tool,assistant,tool
  })

  it('drops legacy records with no callId (shape-only, never unpaired)', () => {
    const legacy = { name: 'x', summary: 's' } as unknown as AgentToolRecord
    expect(toolBlocksFor([legacy])).toEqual([])
  })
})
