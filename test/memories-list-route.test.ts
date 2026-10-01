// test/memories-list-route.test.ts
//
// Handler test (service mocked) for GET /api/memories' cycle-77 score params: they reach
// listMemories, search gets the filters but never `sort`, and an unknown value is a 400.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getQuery', (e: { query: Record<string, string> }) => e.query)

const listMemories = vi.fn(async (_o: unknown) => [])
const searchMemories = vi.fn(async (_q: string, _o: unknown) => [])
vi.mock('../server/services/memory', () => ({ listMemories, searchMemories }))

type H = (e: unknown) => Promise<unknown>
const handler = (await import('../server/api/memories/index.get')).default as H
const call = (query: Record<string, string>) => handler({ query })

beforeEach(() => {
  listMemories.mockClear()
  searchMemories.mockClear()
})

describe('GET /api/memories score params', () => {
  it('passes verdict, scored, disagree and sort to listMemories', async () => {
    await call({ verdict: 'transient', scored: 'yes', disagree: '1', sort: 'disagreement' })
    expect(listMemories).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'transient', scored: 'yes', disagree: true, sort: 'disagreement'
    }))
  })

  it('omitted params stay undefined', async () => {
    await call({})
    expect(listMemories).toHaveBeenCalledWith(expect.objectContaining({
      verdict: undefined, scored: undefined, disagree: undefined, sort: undefined
    }))
  })

  it('search gets the filters but not the sort (relevance order is kept)', async () => {
    await call({ q: 'hello', verdict: 'keep', disagree: '1', sort: 'jev' })
    expect(listMemories).not.toHaveBeenCalled()
    const opts = searchMemories.mock.calls[0]![1] as Record<string, unknown>
    expect(opts).toMatchObject({ verdict: 'keep', disagree: true })
    expect(opts).not.toHaveProperty('sort')
  })

  it.each([
    [{ verdict: 'junk' }],
    [{ scored: 'maybe' }],
    [{ disagree: 'true' }],
    [{ sort: 'random' }]
  ])('an unknown value is a 400: %o', async (query) => {
    await expect(call(query)).rejects.toMatchObject({ statusCode: 400 })
    expect(listMemories).not.toHaveBeenCalled()
  })
})
