// Review M1 (cycle 88): the summary tier must not walk the whole thread a SECOND time per turn.
// The runner already loaded the active path for history and threads its `summaryApplies` into
// assembleContext; loadSummary then reads only the summary column (or nothing at all).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadActivePath = vi.fn(async () => ({ rows: [], branches: new Map(), summaryApplies: true }))
const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ summary: 'S' }] }) }) }))
vi.mock('@mymind/core/services/conversation-path', () => ({ loadActivePath }))
vi.mock('@mymind/core/db', () => ({ useDb: () => ({ select }) }))

const { loadSummary, assembleContext } = await import('@mymind/core/lib/agent/assemble')

beforeEach(() => { loadActivePath.mockClear(); select.mockClear() })

describe('loadSummary(conversationId, summaryApplies)', () => {
  it('true → the summary, with no path walk', async () => {
    expect(await loadSummary('c', true)).toBe('S')
    expect(loadActivePath).not.toHaveBeenCalled()
  })
  it('false → null, with no DB read at all', async () => {
    expect(await loadSummary('c', false)).toBeNull()
    expect(select).not.toHaveBeenCalled()
    expect(loadActivePath).not.toHaveBeenCalled()
  })
  it('omitted → walks the path itself (callers without a loaded path)', async () => {
    expect(await loadSummary('c')).toBe('S')
    expect(loadActivePath).toHaveBeenCalledTimes(1)
  })
  it('assembleContext hands the caller\'s summaryApplies to the summary tier', async () => {
    const r = await assembleContext({
      userText: '', conversationId: 'c', summaryApplies: true, budget: 4000,
      deps: { listResident: async () => [], search: async () => [], liveContext: async () => '', recordRetrievals: async () => {} }
    })
    expect(r.context).toContain('S')
    expect(loadActivePath).not.toHaveBeenCalled()
  })
})
