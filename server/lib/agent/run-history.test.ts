import { describe, it, expect } from 'vitest'
import { buildModelMessages, type AgentMessage } from './run'
import type { AgentToolRecord } from './tool-history'
import { rowToAgentMessage } from '../../services/conversations'

const rec = (o: Partial<AgentToolRecord> = {}): AgentToolRecord => ({
  callId: 'c1', name: 'web_search', kind: 'read', args: { q: 'x' },
  result: { hits: 1 }, summary: 's', textOffset: 0, ...o
})

describe('buildModelMessages', () => {
  it('expands a tool turn into paired call/result messages plus the text', () => {
    const out = buildModelMessages([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: 'Found it.', toolRecords: [rec()] }
    ]) as { role: string; content: unknown }[]

    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(out.at(-1)!.content).toBe('Found it.')
  })

  it('WIRING: stale results are elided by the time they reach the model', () => {
    const history: AgentMessage[] = []
    for (let i = 0; i < 5; i++) {
      history.push({ role: 'user', content: `q${i}` })
      history.push({ role: 'assistant', content: `a${i}`, toolRecords: [rec({ callId: `c${i}`, result: { big: 'z'.repeat(3000) } })] })
    }
    const out = buildModelMessages(history) as { role: string; content: { output?: { value?: unknown } }[] }[]
    const firstToolMsg = out.find(m => m.role === 'tool')!
    expect(firstToolMsg.content[0]!.output!.value).toEqual({ elided: true, bytes: expect.any(Number) })
  })

  it('WIRING: an oversized args payload never reaches the model at full size', () => {
    // A 60 KB save_document body used to be replayed verbatim on EVERY later turn (args were
    // capped nowhere) — context overflow, and un-elidable because only results decayed.
    const body = 'y'.repeat(60_000)
    const out = buildModelMessages([
      { role: 'user', content: 'save it' },
      { role: 'assistant', content: 'Saved.', toolRecords: [rec({ name: 'save_document', kind: 'create', args: { path: '/a.md', content: body } })] }
    ]) as { role: string; content: unknown }[]

    const callMsg = out.find(m => m.role === 'assistant' && Array.isArray(m.content))!
    const serialized = JSON.stringify(callMsg.content)
    expect(serialized).not.toContain(body)
    expect(serialized.length).toBeLessThan(2000)
    // …and the call itself still survives, which is the whole anti-fabrication signal.
    expect((callMsg.content as { toolCallId: string; toolName: string }[])[0]).toMatchObject({ toolCallId: 'c1', toolName: 'save_document' })
  })

  it('legacy records produce no unpaired tool message', () => {
    const out = buildModelMessages([
      { role: 'assistant', content: 'old turn', toolRecords: [{ name: 'x', summary: 's' } as unknown as AgentToolRecord] }
    ]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['assistant'])
  })

  it('a malformed record survives the whole pipeline without throwing', () => {
    // /api/agent/chat.post.ts readBody<{messages}>s with no validation and hands the array
    // straight to runAgent, so a `[null]` element must degrade, not 500 the turn.
    const out = buildModelMessages([
      { role: 'assistant', content: 'x', toolRecords: [null as unknown as AgentToolRecord] }
    ]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['assistant'])
  })

  it('drops system messages, as before', () => {
    const out = buildModelMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }]) as { role: string }[]
    expect(out.map(m => m.role)).toEqual(['user'])
  })

  it('PARITY: a resumed conversation yields identical model messages to the live one', () => {
    // Two calls at different textOffsets so the round-trip exercises block-splitting,
    // not just a single call/result pair (see task-6 report: a single-call fixture
    // cannot detect textOffset corruption — toolBlocksFor only reads textOffset to
    // decide where a turn's calls split into separate replay steps).
    const live: AgentMessage[] = [
      { role: 'user', content: 'find x' },
      {
        role: 'assistant',
        content: 'Found it. Then more.',
        toolRecords: [rec({ callId: 'c1', textOffset: 0 }), rec({ callId: 'c2', textOffset: 10 })]
      }
    ]

    // The same turns as they come back out of Postgres.
    const resumed = [
      { role: 'user', content: 'find x', toolCalls: null, attachments: null },
      {
        role: 'assistant',
        content: 'Found it. Then more.',
        toolCalls: [rec({ callId: 'c1', textOffset: 0 }), rec({ callId: 'c2', textOffset: 10 })],
        attachments: null
      }
    ].map(rowToAgentMessage)

    expect(buildModelMessages(resumed)).toEqual(buildModelMessages(live))
  })
})
