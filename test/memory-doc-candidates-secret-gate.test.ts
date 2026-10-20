// D3 A4 (2026-10-20): fileDocCandidate files extracted doc-worthy text "exactly like quick_capture /
// POST /api/capture/note" — both of which run the write-time secret gate — so it must too. A session
// transcript that contains a pasted key can surface as a doc candidate rather than a memory; without
// the gate that key landed raw in /input/ with no tag. The gate itself is mocked (test/secret-gate.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const gateMock = vi.fn()
vi.mock('@mymind/core/lib/memory/secret-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mymind/core/lib/memory/secret-gate')>()
  return { ...actual, gateSecret: (...a: unknown[]) => gateMock(...a) }
})
vi.mock('@mymind/core/db', () => ({ useDb: () => ({}) }))
vi.mock('@mymind/core/services/documents', () => ({
  createDoc: vi.fn(async (input: { path: string, title: string | null, content: string, tags?: string[] }) => ({ id: 'doc-1', ...input }))
}))
vi.mock('@mymind/core/services/triage', () => ({
  nearestDocument: vi.fn(async () => null),
  triageCapture: vi.fn(async () => undefined)
}))
vi.mock('@mymind/core/utils/live-bus', () => ({ publishChange: vi.fn() }))

import { createDoc } from '@mymind/core/services/documents'
import { SECRET_REVIEW_TAG } from '@mymind/core/lib/memory/secret-gate'
import { fileDocCandidate } from '../server/services/memory-doc-candidates'

const RAW = 'LiteLLM gateway key is sk-e6uNWBc8fzgPjPUtUeBfsg, used by Frigate.'
const SAFE = 'LiteLLM gateway key is «redacted», used by Frigate.'
const candidate = { text: RAW, project: 'homelab', targetDocHint: 'litellm' } as Parameters<typeof fileDocCandidate>[0]

beforeEach(() => {
  gateMock.mockReset()
  vi.mocked(createDoc).mockClear()
})

describe('fileDocCandidate — secret gate', () => {
  it('files the redacted text and tags the capture when flagged', async () => {
    gateMock.mockResolvedValue({ outcome: 'flagged', flagged: true, score: 0.91, text: SAFE, redactions: 1 })
    const out = await fileDocCandidate(candidate, { sessionId: 's1' })
    expect(out).toEqual({ docId: 'doc-1' })
    expect(gateMock).toHaveBeenCalledWith(RAW)
    const input = vi.mocked(createDoc).mock.calls[0]![0]
    expect(input.content).toContain(SAFE)
    expect(input.content).not.toContain('sk-e6uN')
    expect(input.tags).toEqual([SECRET_REVIEW_TAG])
  })

  it('files exactly as before when the gate is clear', async () => {
    gateMock.mockResolvedValue({ outcome: 'clear', flagged: false, score: 0.02, text: RAW, redactions: 0 })
    await fileDocCandidate(candidate, { sessionId: 's1' })
    const input = vi.mocked(createDoc).mock.calls[0]![0]
    expect(input.content).toContain(RAW)
    expect(input).not.toHaveProperty('tags')
  })

  it('files exactly as before when the gate is unavailable (fail open)', async () => {
    gateMock.mockResolvedValue({ outcome: 'unavailable', flagged: false, score: null, text: RAW, redactions: 0 })
    await fileDocCandidate(candidate, { sessionId: 's1' })
    expect(vi.mocked(createDoc).mock.calls[0]![0].content).toContain(RAW)
  })
})
