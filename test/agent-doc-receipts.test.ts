// test/agent-doc-receipts.test.ts
//
// Document write tools must answer with a small receipt, never an echo of the body.
// Echoing was a correctness bug, not just a cost one: a large doc pushed the response past
// the MCP host's tool-result cap, so a write that had already committed surfaced to the
// agent as an error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { divergenceReport } from '../server/lib/agent/receipt'
import type { DocumentDTO } from '../shared/types/documents'

const BIG = 'x'.repeat(120_000)
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex')

let stored = ''
/** Simulates the row being deleted between getDoc and the write landing. */
let vanished = false

function docRow(content: string) {
  return {
    id: 'doc-1',
    path: '/projects/homelab/timeline.md',
    title: 'Timeline',
    content,
    language: 'markdown',
    frontmatter: {},
    project: 'homelab',
    domain: null,
    type: null,
    tags: ['ops'],
    topic: null,
    contentHash: hashOf(content),
    isPublic: false,
    publicSlug: null,
    ocrId: null,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

vi.mock('../server/services/documents', () => ({
  getDoc: async () => docRow(stored),
  createDoc: async (input: { content?: string }) => { stored = input.content ?? ''; return docRow(stored) },
  updateDoc: async (_id: string, input: { content?: string }) => {
    if (vanished) return null
    if (input.content !== undefined) stored = input.content
    return docRow(stored)
  },
  moveDoc: async () => (vanished ? null : docRow(stored)),
  deleteDoc: async () => true,
  restoreDoc: async () => true,
  searchPassages: async () => [],
  listDocsSummary: async () => [],
  countDocs: async () => 0,
  searchDocsPage: async () => ({ items: [], total: 0 }),
}))

vi.mock('../server/utils/live-bus', () => ({ publishChange: () => {}, publishActivity: () => {} }))

const { agentTools } = await import('../server/lib/agent/tools')
const tool = (n: string) => agentTools.find(t => t.name === n)!
const run = async (n: string, args: Record<string, unknown>) =>
  (await tool(n).handler(args, { signal: new AbortController().signal })).result as Record<string, any>

beforeEach(() => { stored = BIG; vanished = false })

describe('document write receipts', () => {
  it('edit_document returns a receipt without the document body', async () => {
    const res = await run('edit_document', { id: 'doc-1', old_string: 'x'.repeat(120_000), new_string: 'small' })
    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('content')
    expect(res.id).toBe('doc-1')
    expect(res.path).toBe('/projects/homelab/timeline.md')
    expect(res.replacements).toBe(1)
    expect(res.bytes).toEqual({ before: 120_000, after: 5 })
    expect(res.hash).toBe(hashOf('small'))
  })

  it('keeps the receipt small even when the document is enormous', async () => {
    // Regression: the original version of this test used old_string: 'x' against a document
    // that is 120,000 'x' characters — every single character matches, so applyReplace returns
    // ambiguous_match (120,000 matches, no replace_all) and no receipt is ever built. The
    // assertion below was silently measuring a ~392-byte ERROR object, not a receipt, so the
    // branch's headline claim (a write to a huge document returns a small receipt) was asserted
    // nowhere. Fixed by giving the huge document one genuinely unique marker to replace, so the
    // write actually succeeds and a real receipt comes back.
    const marker = 'UNIQUE_MARKER'
    const big = 'x'.repeat(60_000) + marker + 'x'.repeat(60_000)
    stored = big
    const res = await run('edit_document', { id: 'doc-1', old_string: marker, new_string: 'y' })
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(typeof res.hash).toBe('string')
    expect(res.bytes).toEqual({ before: big.length, after: big.length - marker.length + 1 })
    expect(JSON.stringify(res).length).toBeLessThan(600)
  })

  it('surfaces a typed ambiguous_match with candidate lines instead of writing', async () => {
    stored = ['alpha TODO', 'beta', 'gamma TODO'].join('\n')
    const res = await run('edit_document', { id: 'doc-1', old_string: 'TODO', new_string: 'DONE' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('ambiguous_match')
    expect(res.matches).toBe(2)
    expect(res.candidates).toEqual([{ line: 1, text: 'alpha TODO' }, { line: 3, text: 'gamma TODO' }])
    expect(stored).toContain('TODO') // nothing was written
  })

  it('surfaces a typed no_match', async () => {
    stored = 'nothing here'
    const res = await run('edit_document', { id: 'doc-1', old_string: 'zzz', new_string: 'q' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('no_match')
    expect(res.matches).toBe(0)
  })

  it('update_document returns a receipt without the body', async () => {
    const res = await run('update_document', { id: 'doc-1', content: 'replaced' })
    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('content')
    expect(res.bytes).toEqual({ before: 120_000, after: 8 })
    expect(res.hash).toBe(hashOf('replaced'))
  })

  it('edit_section returns a receipt without the body', async () => {
    stored = '# T\n\n## A\nbody'
    const res = await run('edit_section', { id: 'doc-1', mode: 'append', text: 'more' })
    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('content')
    expect(res.hash).toBe(hashOf(stored))
  })

  it('save_document returns a receipt without the body', async () => {
    const res = await run('save_document', { content: 'brand new', title: 'New Doc' })
    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('content')
    expect(res.id).toBe('doc-1')
    expect(res.hash).toBe(hashOf('brand new'))
  })

  it('move_document returns a receipt without the body', async () => {
    const res = await run('move_document', { id: 'doc-1', path: '/projects/homelab/moved.md' })
    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('content')
  })

  it('quick_capture returns a receipt without the body', async () => {
    const res = await run('quick_capture', { text: 'a note' })
    expect(res.ok).toBe(true)
    expect(res).not.toHaveProperty('content')
  })

  it('reports not_found instead of throwing when the doc is deleted mid-write', async () => {
    // getDoc succeeds, then the row disappears before updateDoc lands → updateDoc returns null.
    vanished = true
    for (const [name, args] of [
      ['edit_document', { id: 'doc-1', old_string: 'x', new_string: 'y', replace_all: true }],
      ['edit_section', { id: 'doc-1', mode: 'append', text: 'more' }],
      ['move_document', { id: 'doc-1', path: '/input/gone.md' }],
    ] as const) {
      const res = await run(name, args as Record<string, unknown>)
      expect(res.ok, name).toBe(false)
      expect(res.error, name).toBe('not_found')
    }
  })

  it('get_document still returns the full body — reads are unchanged', async () => {
    stored = 'the whole thing'
    const res = await run('get_document', { id: 'doc-1' })
    expect(res.content).toBe('the whole thing')
  })
})

// divergenceReport is the other body-free response builder alongside docReceipt (used on a
// refused sync_document write). Its `server.headings` used to be unbounded per-entry text —
// a measured pathological document (very long heading lines) produced a ~200 KB refusal
// payload, defeating the entire point of a body-free response. Tested directly against the
// pure function (no DB/tool plumbing needed) so the assertion isolates the exact bug.
describe('divergenceReport heading clipping', () => {
  const baseDoc: DocumentDTO = {
    id: 'doc-1', path: '/projects/homelab/timeline.md', title: 'Timeline',
    content: '', language: 'markdown', frontmatter: {}, project: 'homelab', domain: null,
    type: null, tags: [], topic: null, isPublic: false, publicSlug: null, ocrId: null,
    contentHash: 'deadbeef', updatedAt: '2026-08-01T00:00:00.000Z'
  }

  it('bounds the refusal payload even with many pathologically long headings', () => {
    // 40 headings (more than the 25-entry cap) each ~10,000 chars (far past the 200-char clip)
    // — unclipped this reproduces the measured ~200 KB payload.
    const pathological = Array.from({ length: 40 }, (_, i) => `# ${'H'.repeat(10_000)}${i}`).join('\n\n')
    const report = divergenceReport('adopt_conflict', { ...baseDoc, content: pathological }, 'local content')

    expect(report.server.headings.length).toBeLessThanOrEqual(25)
    for (const heading of report.server.headings) expect(heading.length).toBeLessThanOrEqual(201) // 200 + '…'
    // Concrete byte ceiling: unclipped, this payload would be ~400KB (40 headings * ~10KB);
    // even just the un-sliced-first map/slice bug alone would keep it in the hundreds of KB.
    expect(JSON.stringify(report).length).toBeLessThan(8_000)
  })
})
