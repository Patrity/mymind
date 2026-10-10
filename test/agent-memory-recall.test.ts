// Final review M3: the agent/MCP recall tools (search_memories, get_recent_memories) return
// memories WITHOUT the cycle-77 score fields — those are for /memories and the analysis only.
import { describe, it, expect, vi } from 'vitest'
import type { MemoryDTO } from '@mymind/core/shared/types/memory'

const scored: MemoryDTO = {
  id: 'm1', scope: 'agent', content: 'MyMind runs natively in LXC 114.', tags: ['deploy'], source: null,
  confidence: 0.9, jevScore: 0.4, jevAnswers: { transient: 0.7 }, auditKeep: 0.2, auditVerdict: 'transient',
  auditReason: 'Point-in-time state.', auditPromptVersion: 'audit-v2', extractPromptVersion: 'extract-v3',
  project: 'mymind', applicability: 'project', resident: false, sessionId: null, enrichedAt: null,
  reviewedAt: '2026-10-01T00:00:00.000Z', sourceDate: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', relevance: 0.8
}

vi.mock('@mymind/core/services/memory', () => ({
  searchMemories: vi.fn(async () => [scored]),
  listMemories: vi.fn(async () => [scored]),
  createMemory: vi.fn(), archiveMemory: vi.fn(), unarchiveMemory: vi.fn()
}))

const { toolByName } = await import('@mymind/core/lib/agent/tools')

const SCORE_FIELDS = ['jevScore', 'jevAnswers', 'auditKeep', 'auditVerdict', 'auditReason', 'auditPromptVersion', 'extractPromptVersion']

describe.each(['search_memories', 'get_recent_memories'])('%s', (name) => {
  it('returns the memory without the score fields', async () => {
    const out = await toolByName(name)!.handler({ query: 'lxc' }, {} as never) as { result: Record<string, unknown>[] }
    expect(out.result).toHaveLength(1)
    const m = out.result[0]!
    for (const f of SCORE_FIELDS) expect(m, f).not.toHaveProperty(f)
    expect(m).toMatchObject({ id: 'm1', content: scored.content, confidence: 0.9, project: 'mymind', relevance: 0.8 })
  })
})
