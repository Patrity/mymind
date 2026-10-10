import { describe, it, expect } from 'vitest'
import { groupTurns, turnTier, costTurns, keepTrailingTurns, capToTokens, RUNTIME_CONTEXT_BUDGET } from '@mymind/core/lib/agent/runtime/history'
import { fitBudget, tier } from '@mymind/core/lib/agent/budget'
import { estimateTokens } from '@mymind/core/lib/chunking/chunk-markdown'
import type { AgentMessage } from '@mymind/core/lib/agent/run'

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

  // Final review C2 — the reviewer's shape: 5 short turns, then one turn with 8 web_fetch
  // results of 8000 chars, under a 4k fixed tier.
  describe('a tool-heavy newest turn', () => {
    const fetches = Array.from({ length: 8 }, (_, i) => ({
      callId: `c${i}`, name: 'web_fetch', kind: 'read', args: { url: `https://example.com/${i}` },
      result: { content: 'z'.repeat(8000) }, summary: 'fetched', textOffset: 0
    }))
    const history = [
      ...Array.from({ length: 5 }, (_, i) => [u(`question ${i}`), a(`answer ${i}`)]).flat(),
      u('read these'), a('here is what they say', { toolRecords: fetches } as never)
    ]
    const fixed = [tier('resident', 'r'.repeat(4000 * 3.8))]

    it('costs turns from the post-policy representation, so older turns survive', () => {
      const turns = groupTurns(history)
      const fit = fitBudget({ fixed, turns: costTurns(turns), retrieved: [], budget: RUNTIME_CONTEXT_BUDGET })
      expect(fit.kept.turns.length).toBeGreaterThan(1)
      expect(fit.droppedTurns).toBe(0)
    })

    it('always keeps the newest turn, even when it alone exceeds the ceiling', () => {
      const turns = groupTurns(history)
      // Raw (pre-policy) pricing of the heavy turn is past the ceiling on its own.
      const raw = turns.map(turnTier)
      expect(raw[raw.length - 1]!.tokens).toBeGreaterThan(RUNTIME_CONTEXT_BUDGET - fixed[0]!.tokens)
      const fit = fitBudget({ fixed, turns: raw, retrieved: [], budget: RUNTIME_CONTEXT_BUDGET })
      expect(fit.kept.turns.map(t => t.name)).toEqual([`turn:${turns.length - 1}`])
    })
  })
})
