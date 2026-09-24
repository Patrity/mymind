import { describe, it, expect, vi } from 'vitest'
import { assembleContext, synthesiseQuery } from '../server/lib/agent/assemble'
import { tier } from '../server/lib/agent/budget'
import type { MemoryDTO } from '../shared/types/memory'

const mem = (id: string, content: string, over: Partial<MemoryDTO> = {}): MemoryDTO => ({
  id, scope: 'user', content, tags: [], source: null, confidence: null, project: null,
  applicability: 'global', resident: false, sessionId: null, enrichedAt: null,
  reviewedAt: '2026-09-01T00:00:00.000Z', sourceDate: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...over
})

const deps = (over: Partial<Parameters<typeof assembleContext>[0]['deps']> = {}) => ({
  listResident: async () => [] as MemoryDTO[],
  search: async () => [] as MemoryDTO[],
  liveContext: async () => '',
  summary: async () => null as string | null,
  recordRetrievals: vi.fn(async () => {}),
  ...over
})

describe('assembleContext', () => {
  it('always includes resident memories, even with no user text', async () => {
    const r = await assembleContext({
      userText: '', budget: 4000,
      deps: deps({ listResident: async () => [mem('r1', 'Tony rejects time-based estimates', { resident: true })] })
    })
    expect(r.context).toContain('Tony rejects time-based estimates')
  })

  it('searches with the user text when there is one', async () => {
    const search = vi.fn(async () => [mem('m1', 'a retrieved fact')])
    await assembleContext({ userText: 'how long will this take', budget: 4000, deps: deps({ search }) })
    expect(search.mock.calls[0]![0]).toBe('how long will this take')
  })

  it('synthesises a query from state on a proactive turn', async () => {
    const search = vi.fn(async () => [] as MemoryDTO[])
    await assembleContext({
      // conversationId is required here: summaryOf is only called when there is one to look
      // up a summary FOR (see assemble.ts's `input.conversationId ? safe(() => summaryOf(...` — that
      // gate is correct production behaviour, not an oversight; without an id, this proactive
      // turn should fall back to live state alone).
      userText: '', budget: 4000, conversationId: 'c1',
      deps: deps({ search, summary: async () => 'Tony is debugging the deploy', liveContext: async () => 'Active projects: mymind.' })
    })
    expect(search).toHaveBeenCalled()
    expect(search.mock.calls[0]![0]).toContain('Tony is debugging the deploy')
  })

  it('does not search at all when there is neither user text nor state', async () => {
    const search = vi.fn(async () => [] as MemoryDTO[])
    await assembleContext({ userText: '', budget: 4000, deps: deps({ search }) })
    expect(search).not.toHaveBeenCalled()
  })

  it('records retrievals for the memories it actually kept, batched once', async () => {
    const recordRetrievals = vi.fn(async () => {})
    const r = await assembleContext({
      userText: 'q', budget: 4000,
      deps: deps({ search: async () => [mem('m1', 'kept one'), mem('m2', 'kept two')], recordRetrievals })
    })
    expect(recordRetrievals).toHaveBeenCalledTimes(1)
    expect(recordRetrievals.mock.calls[0]![0].sort()).toEqual(['m1', 'm2'])
    expect(r.usedMemoryIds.sort()).toEqual(['m1', 'm2'])
  })

  it('does not record a retrieval for a memory the budget evicted', async () => {
    const recordRetrievals = vi.fn(async () => {})
    const big = 'y'.repeat(40000)
    const r = await assembleContext({
      userText: 'q', budget: 200,
      deps: deps({ search: async () => [mem('m1', big)], recordRetrievals })
    })
    expect(r.usedMemoryIds).toEqual([])
    expect(recordRetrievals).not.toHaveBeenCalled()
  })

  it('never throws — a failing dependency degrades to whatever else assembled', async () => {
    const r = await assembleContext({
      userText: 'q', budget: 4000,
      deps: deps({
        search: async () => { throw new Error('pgvector down') },
        listResident: async () => [mem('r1', 'resident survives', { resident: true })]
      })
    })
    expect(r.context).toContain('resident survives')
  })

  it('never throws — a failing listResidentMemories degrades to whatever else assembled', async () => {
    const r = await assembleContext({
      userText: 'q', budget: 4000,
      deps: deps({
        listResident: async () => { throw new Error('db down') },
        liveContext: async () => 'Active projects: mymind.'
      })
    })
    expect(r.context).toContain('Active projects: mymind.')
  })

  it('does not duplicate a resident memory that search also returns', async () => {
    const r = await assembleContext({
      userText: 'q', budget: 4000,
      deps: deps({
        listResident: async () => [mem('r1', 'the resident fact', { resident: true })],
        search: async () => [mem('r1', 'the resident fact', { resident: true })]
      })
    })
    const occurrences = r.context.split('the resident fact').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('synthesiseQuery', () => {
  it('combines summary and live state', () => {
    expect(synthesiseQuery('debugging deploy', 'Active projects: mymind.')).toContain('debugging deploy')
    expect(synthesiseQuery('debugging deploy', 'Active projects: mymind.')).toContain('mymind')
  })

  it('returns empty when there is no state at all', () => {
    expect(synthesiseQuery(null, '')).toBe('')
  })
})

describe('budget estimate fidelity', () => {
  // Guards the heuristic against real usage. `MessageUsage.contextTokens` (cycle 65) records
  // what a turn ACTUALLY cost; if this drifts, the assembler overfills and the model truncates
  // with nothing in the logs. Update the fixture from a real turn, never the tolerance.
  //
  // SKIPPED: this task (cycle 70, task 4) was executed in a worktree with no reachable live
  // model to run a real turn against and read `contextTokens` off the emitted usage event —
  // there is no dev server / model chain available in this sandboxed session. Per the task
  // brief's explicit ruling, `actualTokens` must be a real measured value; it must never be
  // guessed, estimated, or back-calculated. To enable this test: run one real voice/text turn
  // against the live model, read `contextTokens` off the `{ type: 'usage' }` event (see
  // server/api/voice/ws.ts's `turnUsage` handling), and replace SAMPLES[0].actualTokens with
  // that measured number, then remove `.skip`.
  const SAMPLES: Array<{ text: string, actualTokens: number }> = [
    { text: 'Tony rejects time-based implementation estimates; prefers scoping by concrete work items.', actualTokens: 17 }
  ]

  it.skip('estimates within 25% of measured usage', () => {
    for (const s of SAMPLES) {
      const est = tier('sample', s.text).tokens
      const ratio = est / s.actualTokens
      expect(ratio).toBeGreaterThan(0.75)
      expect(ratio).toBeLessThan(1.25)
    }
  })
})
