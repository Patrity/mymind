// Stack review 2026-10-19 (D1): quick_capture is the other write path a pasted credential reaches
// (the note becomes a memory via triage). The tool gates the text before createDoc: a flagged
// note is stored redacted and tagged `needs-review:secret`; a clear or unavailable gate changes
// nothing. The gate itself is mocked (see test/secret-gate.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toolByName } from './tools'
import { createDoc } from '../../services/documents'
import { SECRET_REVIEW_TAG } from '../memory/secret-gate'

const gateMock = vi.fn()
vi.mock('../memory/secret-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memory/secret-gate')>()
  return { ...actual, gateSecret: (...a: unknown[]) => gateMock(...a) }
})

// The mock must export EVERY name tools.ts imports (see tools.ts:5) or the module fails to load.
vi.mock('../../services/documents', () => ({
  searchPassages: vi.fn(), getDoc: vi.fn(async () => null),
  createDoc: vi.fn(async (input: { path: string, title: string | null, content: string, tags?: string[] }) => ({
    id: 'doc-1', path: input.path, title: input.title, content: input.content, tags: input.tags ?? [],
    frontmatter: {}, project: null, projectId: null, hash: 'h', createdAt: new Date(), updatedAt: new Date()
  })),
  deleteDoc: vi.fn(), updateDoc: vi.fn(), moveDoc: vi.fn(), restoreDoc: vi.fn(),
  listDocsSummary: vi.fn(), countDocs: vi.fn(), searchDocsPage: vi.fn(),
  findDocByPath: vi.fn(), casUpdateContent: vi.fn()
}))

const RAW = 'rig key: sk-e6uNWBc8fzgPjPUtUeBfsg for LiteLLM'
const SAFE = 'rig key: «redacted» for LiteLLM'
const ctx = {} as never

beforeEach(() => {
  gateMock.mockReset()
  vi.mocked(createDoc).mockClear()
})

describe('quick_capture — secret gate', () => {
  it('stores the redacted text and tags the note when flagged', async () => {
    gateMock.mockResolvedValue({ outcome: 'flagged', flagged: true, score: 0.93, text: SAFE, redactions: 1 })
    const out = await toolByName('quick_capture')!.handler({ text: RAW, title: 'LiteLLM key' }, ctx)
    expect(gateMock).toHaveBeenCalledWith(RAW)
    const input = vi.mocked(createDoc).mock.calls[0]![0]
    expect(input.content).toBe(SAFE)
    expect(input.tags).toEqual([SECRET_REVIEW_TAG])
    expect(out.summary).toMatch(/redacted/i)
    expect((out.result as { secretFlagged?: boolean }).secretFlagged).toBe(true)
  })

  it('stores the text verbatim with no tags when the gate is clear', async () => {
    gateMock.mockResolvedValue({ outcome: 'clear', flagged: false, score: 0.02, text: RAW, redactions: 0 })
    const out = await toolByName('quick_capture')!.handler({ text: RAW }, ctx)
    const input = vi.mocked(createDoc).mock.calls[0]![0]
    expect(input.content).toBe(RAW)
    expect(input.tags).toBeUndefined()
    expect(out.summary).not.toMatch(/redacted/i)
  })

  it('stores the text verbatim when the gate is unavailable (fail open)', async () => {
    gateMock.mockResolvedValue({ outcome: 'unavailable', flagged: false, score: null, text: RAW, redactions: 0 })
    await toolByName('quick_capture')!.handler({ text: RAW }, ctx)
    expect(vi.mocked(createDoc).mock.calls[0]![0].content).toBe(RAW)
  })
})
