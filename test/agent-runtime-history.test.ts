import { describe, it, expect } from 'vitest'
import { groupTurns, turnTier, keepTrailingTurns, capToTokens } from '../server/lib/agent/runtime/history'
import { estimateTokens } from '../server/lib/chunking/chunk-markdown'
import type { AgentMessage } from '../server/lib/agent/run'

const u = (c: string): AgentMessage => ({ role: 'user', content: c })
const a = (c: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ role: 'assistant', content: c, ...extra } as AgentMessage)

describe('runtime history', () => {
  it('starts a turn at a user message after a non-user one; a steer (user after user) joins the turn', () => {
    const turns = groupTurns([u('q1'), a('a1'), u('q2'), u('steer'), a('a2')])
    expect(turns.map(t => t.map(m => m.content))).toEqual([['q1', 'a1'], ['q2', 'steer', 'a2']])
  })

  it('several steers stay in one turn, and the next question after a reply starts a new one', () => {
    const turns = groupTurns([u('q1'), u('s1'), u('s2'), a('a1'), u('q2'), a('a2')])
    expect(turns.map(t => t.map(m => m.content))).toEqual([['q1', 's1', 's2', 'a1'], ['q2', 'a2']])
  })

  it('a leading assistant message (history starting mid-turn after a summary) forms its own turn', () => {
    expect(groupTurns([a('tail'), u('q'), a('r')]).map(t => t.length)).toEqual([1, 2])
  })

  it('turnTier costs tool payloads, not just text', () => {
    const withTool = a('ok', { toolRecords: [{ callId: 'c', name: 'read_document', kind: 'read', args: { id: 'x' }, result: 'y'.repeat(4000), summary: 's' }] } as never)
    expect(turnTier([u('q'), withTool], 0).tokens).toBeGreaterThan(estimateTokens('q ok') + 500)
  })

  it('keepTrailingTurns keeps the newest N turns, flattened, and 0 keeps nothing', () => {
    const turns = groupTurns([u('q1'), a('a1'), u('q2'), a('a2')])
    expect(keepTrailingTurns(turns, 1).map(m => m.content)).toEqual(['q2', 'a2'])
    expect(keepTrailingTurns(turns, 0)).toEqual([])
    expect(keepTrailingTurns(turns, 9).length).toBe(4)
  })

  it('capToTokens never exceeds the cap', () => {
    const t = capToTokens('word '.repeat(5000), 300)
    expect(estimateTokens(t)).toBeLessThanOrEqual(300)
  })
})
