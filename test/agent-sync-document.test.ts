// test/agent-sync-document.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashBody } from '../server/lib/agent/sync'

let rows: Record<string, { id: string, path: string, content: string }> = {}
const changes: string[] = []
// When true, the NEXT casUpdateContent call simulates a third party landing a write between the
// handler's pre-read and this write — i.e. a genuine mid-flight CAS race, not a stale hash the
// handler could have already seen. Reset every test in beforeEach.
let raceOnNextCas = false

const toRow = (r: { id: string, path: string, content: string }) => ({
  id: r.id, path: r.path, title: 'T', content: r.content, language: 'markdown',
  frontmatter: {}, project: null, domain: null, type: null, tags: [], topic: null,
  contentHash: hashBody(r.content), isPublic: false, publicSlug: null, ocrId: null,
  updatedAt: '2026-08-01T00:00:00.000Z'
})

vi.mock('../server/services/documents', () => ({
  findDocByPath: async (p: string) => {
    const r = Object.values(rows).find(x => x.path === p)
    return r ? { id: r.id, contentHash: hashBody(r.content) } : null
  },
  getDoc: async (id: string) => (rows[id] ? toRow(rows[id]!) : null),
  casUpdateContent: async (id: string, content: string, expected: string | null) => {
    if (raceOnNextCas) {
      raceOnNextCas = false
      const raced = rows[id]
      if (raced) raced.content = 'someone else got there first'
    }
    const r = rows[id]
    if (!r) return null
    if (expected !== null && hashBody(r.content) !== expected) return null
    r.content = content
    return toRow(r)
  },
  createDoc: async (input: { path: string, content?: string }) => {
    const id = 'new-' + Object.keys(rows).length
    rows[id] = { id, path: input.path, content: input.content ?? '' }
    return toRow(rows[id]!)
  },
  updateDoc: async (id: string) => (rows[id] ? toRow(rows[id]!) : null),
  moveDoc: async () => null, deleteDoc: async () => true, restoreDoc: async () => true,
  searchPassages: async () => [], listDocsSummary: async () => [],
  countDocs: async () => 0, searchDocsPage: async () => ({ items: [], total: 0 })
}))

vi.mock('../server/utils/live-bus', () => ({
  publishChange: (c: { action: string }) => { changes.push(c.action) }, publishActivity: () => {}
}))

const { agentTools } = await import('../server/lib/agent/tools')
const tool = agentTools.find(t => t.name === 'sync_document')!
// Full ToolExecution (result + summary + undo) — needed to exercise `undo` closures.
const runExec = async (args: Record<string, unknown>) => tool.handler(args, { signal: new AbortController().signal })
const run = async (args: Record<string, unknown>) => (await runExec(args)).result as Record<string, any>

beforeEach(() => {
  rows = { 'doc-1': { id: 'doc-1', path: '/projects/x/a.md', content: 'server body' } }
  changes.length = 0
  raceOnNextCas = false
})

describe('sync_document', () => {
  it('creates when the path matches nothing', async () => {
    const res = await run({ path: '/projects/x/new.md', content: 'fresh' })
    expect(res.ok).toBe(true)
    expect(res.action).toBe('created')
    expect(res.hash).toBe(hashBody('fresh'))
    expect(res).not.toHaveProperty('content')
    expect(changes).toEqual(['created'])
  })

  it('adopts a path match that already agrees, without writing', async () => {
    const res = await run({ path: '/projects/x/a.md', content: 'server body' })
    expect(res.action).toBe('adopted')
    expect(res.id).toBe('doc-1')
    expect(res.hash).toBe(hashBody('server body'))
    expect(changes).toEqual([])
  })

  it('refuses to adopt a divergent path match', async () => {
    const res = await run({ path: '/projects/x/a.md', content: 'local body' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('adopt_conflict')
    expect(res.server.hash).toBe(hashBody('server body'))
    expect(res.local.bytes).toBe('local body'.length)
    expect(res).not.toHaveProperty('content')
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('updates under a matching expected_hash', async () => {
    const res = await run({ id: 'doc-1', content: 'local body', expected_hash: hashBody('server body') })
    expect(res.action).toBe('updated')
    expect(res.hash).toBe(hashBody('local body'))
    expect(res.bytes).toEqual({ before: 'server body'.length, after: 'local body'.length })
    expect(changes).toEqual(['updated'])
  })

  it('reports unchanged without writing or emitting', async () => {
    const res = await run({ id: 'doc-1', content: 'server body', expected_hash: hashBody('server body') })
    expect(res.action).toBe('unchanged')
    expect(changes).toEqual([])
  })

  it('fails closed on a stale expected_hash', async () => {
    const res = await run({ id: 'doc-1', content: 'local body', expected_hash: hashBody('ancient') })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('hash_mismatch')
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('refuses an id-addressed write with no expected_hash', async () => {
    const res = await run({ id: 'doc-1', content: 'local body' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('expected_hash_required')
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('force overrides divergence', async () => {
    const res = await run({ id: 'doc-1', content: 'local body', force: true })
    expect(res.action).toBe('updated')
    expect(rows['doc-1']!.content).toBe('local body')
  })

  it('reports not_found for an unknown id', async () => {
    const res = await run({ id: 'nope', content: 'x', expected_hash: 'y' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_found')
  })

  it('requires a path when there is no id', async () => {
    const res = await run({ content: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('path_required')
  })

  it('loses the CAS race without corrupting anything', async () => {
    // The pre-read (getDoc/decideSync) sees the ORIGINAL hash and agrees to write — a third
    // party's write only lands inside casUpdateContent itself, between our read and our write,
    // so this exercises the CAS-loss branch in the handler (casUpdateContent returning null),
    // not the earlier stale-hash check in decideSync.
    raceOnNextCas = true
    const res = await run({ id: 'doc-1', content: 'local body', expected_hash: hashBody('server body') })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('hash_mismatch')
    expect(res.server.hash).toBe(hashBody('someone else got there first'))
    expect(changes).toEqual([])
    expect(rows['doc-1']!.content).toBe('someone else got there first')
  })

  it('undo restores the prior content when nobody wrote since the sync', async () => {
    const exec = await runExec({ id: 'doc-1', content: 'local body', expected_hash: hashBody('server body') })
    expect((exec.result as Record<string, any>).action).toBe('updated')
    expect(rows['doc-1']!.content).toBe('local body')
    changes.length = 0

    await exec.undo!()

    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual(['updated'])
  })

  it('undo is a no-op when a third party wrote after the sync', async () => {
    const exec = await runExec({ id: 'doc-1', content: 'local body', expected_hash: hashBody('server body') })
    expect((exec.result as Record<string, any>).action).toBe('updated')
    changes.length = 0

    // Someone edits the doc (e.g. in the UI) after the sync but before undo runs.
    rows['doc-1']!.content = 'someone else wrote this after the sync'

    await exec.undo!()

    expect(rows['doc-1']!.content).toBe('someone else wrote this after the sync')
    expect(changes).toEqual([])
  })
})
