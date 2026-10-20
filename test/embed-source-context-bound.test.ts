// Stack review 2026-10-19 (D1): chunkAndEmbedSource must never send the whole document per chunk.
// Bounds the <document> block that reaches the bulk model, and proves the short-document skip
// (no model call at all; the heading path is stored as the context, exactly as `contextual:false`
// already does). DB / embeddings / config are mocked; the chunker and window builder are real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { estimateTokens } from '@mymind/core/lib/chunking/chunk-markdown'

const chatMock = vi.fn(async () => 'One situating sentence.')
vi.mock('@mymind/core/lib/ai/chat', () => ({ chat: (...a: unknown[]) => chatMock(...a) }))

vi.mock('@mymind/core/lib/ai/embeddings', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2]))
}))

// A chainable stub: every method returns the same builder; awaiting it resolves to []. Records the
// rows handed to `.values()` so the test can read what would have been inserted.
const inserted: Record<string, unknown>[][] = []
function builder(): unknown {
  const b: Record<string, unknown> = {}
  const self = new Proxy(b, {
    get(_t, key) {
      if (key === 'then') return (res: (v: unknown) => void) => res([])
      if (key === 'values') {
        return (rows: Record<string, unknown>[]) => {
          inserted.push(rows)
          return self
        }
      }
      if (key === 'transaction') return async (fn: (tx: unknown) => Promise<void>) => fn(self)
      return () => self
    }
  })
  return self
}
vi.mock('@mymind/core/db', () => ({ useDb: () => builder() }))

const cfg = {
  contextual: true, targetTokens: 300, maxTokens: 512, overlapTokens: 32, embedBatch: 32,
  contextWindowTokens: 1500, contextNeighbours: 1, contextMinDocTokens: 800
}
vi.mock('../server/lib/chunking/config', () => ({ getChunkingConfig: async () => cfg }))

import { chunkAndEmbedSource } from '../server/lib/chunking/embed-source'

function makeDoc(n: number, paras = 3, words = 60): string {
  const out: string[] = []
  for (let s = 1; s <= n; s++) {
    out.push(`## Section ${s}`)
    for (let p = 1; p <= paras; p++) out.push(Array.from({ length: words }, (_, w) => `s${s}p${p}w${w}`).join(' '))
  }
  return out.join('\n\n')
}

/** The <document>…</document> block of a captured user message. */
function docBlock(call: unknown[]): string {
  const messages = call[1] as { role: string, content: string }[]
  const user = messages.find(m => m.role === 'user')!.content
  return /<document>\n([\s\S]*?)\n<\/document>/.exec(user)![1]!
}

beforeEach(() => {
  chatMock.mockClear()
  inserted.length = 0
})

describe('chunkAndEmbedSource — bounded contextualization', () => {
  it('sends at most contextWindowTokens of the document per chunk on a long document', async () => {
    const body = makeDoc(40)
    expect(estimateTokens(body)).toBeGreaterThan(cfg.contextWindowTokens * 5)
    const n = await chunkAndEmbedSource({ sourceType: 'document', sourceId: 'd1', title: 'Big Doc', body })
    expect(n).toBeGreaterThan(20)
    expect(chatMock).toHaveBeenCalledTimes(n)
    for (const call of chatMock.mock.calls) {
      expect(estimateTokens(docBlock(call))).toBeLessThanOrEqual(cfg.contextWindowTokens)
    }
  })

  it('still sends the whole document when it fits the window', async () => {
    const body = makeDoc(4, 2, 60) // ~1 K tokens: over the 800-token skip floor, under the 1,500-token window
    const title = 'Mid Doc'
    const full = `${title}\n\n${body}`
    expect(estimateTokens(full)).toBeLessThanOrEqual(cfg.contextWindowTokens)
    expect(estimateTokens(full)).toBeGreaterThanOrEqual(cfg.contextMinDocTokens)
    await chunkAndEmbedSource({ sourceType: 'document', sourceId: 'd2', title, body })
    expect(chatMock).toHaveBeenCalled()
    for (const call of chatMock.mock.calls) expect(docBlock(call)).toBe(full)
  })

  it('skips the model for a short document and stores the heading path as context', async () => {
    const n = await chunkAndEmbedSource({ sourceType: 'document', sourceId: 'd3', title: 'Note', body: 'A short note.\n\n## Part\n\nTwo lines.' })
    expect(n).toBeGreaterThanOrEqual(1)
    expect(chatMock).not.toHaveBeenCalled()
    const rows = inserted.at(-1)!
    for (const r of rows) expect(r.context).toBe(r.headingPath)
  })
})
