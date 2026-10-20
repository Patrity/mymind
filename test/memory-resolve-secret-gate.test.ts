// Stack review 2026-10-19 (D1): the enrichment insert path (resolveEnrichedMemory → insertFresh)
// runs the secret gate first. A flagged memory is stored REDACTED, tagged `needs-review:secret`,
// and left unreviewed (reviewed_at NULL) so it surfaces in /review as a memory-unreviewed card —
// never silently dropped. The gate itself is mocked here; its behaviour is in secret-gate.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const gateMock = vi.fn()
vi.mock('@mymind/core/lib/memory/secret-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mymind/core/lib/memory/secret-gate')>()
  return { ...actual, gateSecret: (...a: unknown[]) => gateMock(...a) }
})
vi.mock('@mymind/core/lib/ai/embeddings', () => ({ embedOne: vi.fn(async () => [0.1, 0.2, 0.3]) }))
vi.mock('@mymind/core/lib/ai/memory-judge', () => ({ judgeRelations: vi.fn(async () => []) }))

// Chainable DB stub: every awaited query resolves to the next queued result; `.values()` records.
const results: unknown[][] = []
const inserted: Record<string, unknown>[] = []
function builder(): unknown {
  const self: unknown = new Proxy({}, {
    get(_t, key) {
      if (key === 'then') return (res: (v: unknown) => void) => res(results.shift() ?? [])
      if (key === 'values') {
        return (row: Record<string, unknown>) => {
          inserted.push(row)
          return self
        }
      }
      return () => self
    }
  })
  return self
}
vi.mock('@mymind/core/db', () => ({ useDb: () => builder() }))

import { resolveEnrichedMemory } from '../server/services/memory-resolve'
import { SECRET_REVIEW_TAG } from '@mymind/core/lib/memory/secret-gate'

const RAW = 'The BlueBubbles API password is Copenflagen11 on every request.'
const SAFE = 'The BlueBubbles API password is «redacted» on every request.'

beforeEach(() => {
  gateMock.mockReset()
  inserted.length = 0
  results.length = 0
  vi.stubGlobal('useRuntimeConfig', () => ({ memoryAutoReviewThreshold: 0.75, memoryDuplicateThreshold: 0.92 }))
  // exact-hash lookup → none; nearest-neighbour search → none; insert … returning → the new row
  results.push([], [], [{ id: 'mem-1' }])
})

describe('resolveEnrichedMemory — secret gate', () => {
  it('stores the redacted text, tags it and holds it for review when flagged', async () => {
    gateMock.mockResolvedValue({ outcome: 'flagged', flagged: true, score: 0.9, text: SAFE, redactions: 1 })
    const plan = await resolveEnrichedMemory({ content: RAW, tags: ['homelab'], scope: 'world' })
    expect(plan.action).toBe('insert')
    expect(gateMock).toHaveBeenCalledWith(RAW)
    const row = inserted[0]!
    expect(row.content).toBe(SAFE)
    expect(row.tags).toEqual(['homelab', SECRET_REVIEW_TAG])
    expect(row.reviewedAt).toBeNull()
  })

  // D3 A3: enrichment's evidence[0].quote is the verbatim transcript line — the one with the value.
  it('redacts the evidence quote/reasoning too when flagged, so the raw value is nowhere in the row', async () => {
    gateMock.mockResolvedValue({ outcome: 'flagged', flagged: true, score: 0.9, text: SAFE, redactions: 1 })
    await resolveEnrichedMemory({
      content: RAW, tags: [], scope: 'world',
      evidence: [{ sessionId: 's1', msgIds: ['m1'], quote: RAW, reasoning: 'he gave the password Copenflagen11 here', mergedAt: 'x' }]
    })
    const evidence = inserted[0]!.evidence as Array<Record<string, unknown>>
    expect(JSON.stringify(evidence)).not.toContain('Copenflagen11')
    expect(evidence[0]!.quote).toContain('«redacted»')
    expect(evidence[0]!.sessionId).toBe('s1')
    expect(evidence[0]!.msgIds).toEqual(['m1'])
  })

  it('leaves the evidence verbatim when the gate is clear', async () => {
    gateMock.mockResolvedValue({ outcome: 'clear', flagged: false, score: 0.05, text: RAW, redactions: 0 })
    const evidence = [{ sessionId: 's1', quote: RAW }]
    await resolveEnrichedMemory({ content: RAW, scope: 'world', evidence })
    expect(inserted[0]!.evidence).toEqual(evidence)
  })

  it('inserts exactly as before when the gate is clear', async () => {
    gateMock.mockResolvedValue({ outcome: 'clear', flagged: false, score: 0.05, text: RAW, redactions: 0 })
    await resolveEnrichedMemory({ content: RAW, tags: ['homelab'], scope: 'world' })
    const row = inserted[0]!
    expect(row.content).toBe(RAW)
    expect(row.tags).toEqual(['homelab'])
    expect(row.reviewedAt).toBeInstanceOf(Date)
  })

  it('inserts exactly as before when the gate is unavailable (fail open)', async () => {
    gateMock.mockResolvedValue({ outcome: 'unavailable', flagged: false, score: null, text: RAW, redactions: 0 })
    await resolveEnrichedMemory({ content: RAW, scope: 'world' })
    const row = inserted[0]!
    expect(row.content).toBe(RAW)
    expect(row.tags).toEqual([])
    expect(row.reviewedAt).toBeInstanceOf(Date)
  })
})
