// test/agent-doc-receipts.test.ts
//
// Document write tools must answer with a small receipt, never an echo of the body.
// Echoing was a correctness bug, not just a cost one: a large doc pushed the response past
// the MCP host's tool-result cap, so a write that had already committed surfaced to the
// agent as an error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

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
    stored = BIG
    const res = await run('edit_document', { id: 'doc-1', old_string: 'x', new_string: 'y' })
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
