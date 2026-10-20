// D3 A4 (2026-10-20): save_memory is a direct insert path (agent + MCP). It gates its content like
// quick_capture: flagged ⇒ redacted text, `needs-review:secret` tag, held for review (reviewed_at
// NULL via createMemory's holdForReview). The gate is mocked (test/secret-gate.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toolByName } from './tools'
import { createMemory } from '../../services/memory'
import { SECRET_REVIEW_TAG } from '../memory/secret-gate'

const gateMock = vi.fn()
vi.mock('../memory/secret-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memory/secret-gate')>()
  return { ...actual, gateSecret: (...a: unknown[]) => gateMock(...a) }
})
// Every name any module in tools.ts's graph imports from the memory service (tools.ts:4, assemble.ts:4).
vi.mock('../../services/memory', () => ({
  searchMemories: vi.fn(), listMemories: vi.fn(), archiveMemory: vi.fn(), unarchiveMemory: vi.fn(),
  listResidentMemories: vi.fn(), recordRetrievals: vi.fn(),
  createMemory: vi.fn(async (input: Record<string, unknown>) => ({ id: 'mem-1', ...input }))
}))
vi.mock('../../utils/live-bus', () => ({ publishChange: vi.fn() }))

const RAW = 'The BlueBubbles API password is Copenflagen11 on every request.'
const SAFE = 'The BlueBubbles API password is «redacted» on every request.'
const ctx = {} as never

beforeEach(() => {
  gateMock.mockReset()
  vi.mocked(createMemory).mockClear()
})

describe('save_memory — secret gate', () => {
  it('stores the redacted text, tags it and holds it for review when flagged', async () => {
    gateMock.mockResolvedValue({ outcome: 'flagged', flagged: true, score: 0.9, text: SAFE, redactions: 1 })
    const out = await toolByName('save_memory')!.handler({ content: RAW, scope: 'user', tags: ['homelab'], confidence: 0.9 }, ctx)
    expect(gateMock).toHaveBeenCalledWith(RAW)
    const input = vi.mocked(createMemory).mock.calls[0]![0]
    expect(input.content).toBe(SAFE)
    expect(input.tags).toEqual(['homelab', SECRET_REVIEW_TAG])
    expect(input.holdForReview).toBe(true)
    expect(input.confidence).toBe(0.9) // provenance kept; the hold is separate from confidence
    expect(out.summary).toMatch(/redacted/)
  })

  it('stores exactly as before when the gate is clear', async () => {
    gateMock.mockResolvedValue({ outcome: 'clear', flagged: false, score: 0.1, text: RAW, redactions: 0 })
    await toolByName('save_memory')!.handler({ content: RAW, scope: 'user', tags: ['homelab'] }, ctx)
    const input = vi.mocked(createMemory).mock.calls[0]![0]
    expect(input.content).toBe(RAW)
    expect(input.tags).toEqual(['homelab'])
    expect(input.holdForReview).toBeUndefined()
  })
})
