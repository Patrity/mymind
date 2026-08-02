// test/agent-sync-document.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashBody } from '../server/lib/agent/sync'

type Row = {
  id: string, path: string, content: string,
  tags?: string[], type?: string | null, frontmatter?: Record<string, unknown>
}
let rows: Record<string, Row> = {}
const changes: string[] = []
// When true, the NEXT casUpdateContent call simulates a third party landing a write between the
// handler's pre-read and this write — i.e. a genuine mid-flight CAS race, not a stale hash the
// handler could have already seen. Reset every test in beforeEach.
let raceOnNextCas = false

const toRow = (r: Row) => ({
  id: r.id, path: r.path, title: 'T', content: r.content, language: 'markdown',
  frontmatter: r.frontmatter ?? {}, project: null, domain: null, type: r.type ?? null,
  tags: r.tags ?? [], topic: null,
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
  createDoc: async (input: { path: string, content?: string, tags?: string[], type?: string, frontmatter?: Record<string, unknown> }) => {
    const id = 'new-' + Object.keys(rows).length
    // Mirrors the real createDoc (server/services/documents.ts): tags/type/frontmatter are
    // genuinely recorded here, not dropped — otherwise a test asserting they persisted on
    // create would pass even if the handler never forwarded them to createDoc at all.
    rows[id] = { id, path: input.path, content: input.content ?? '', tags: input.tags, type: input.type, frontmatter: input.frontmatter }
    return toRow(rows[id]!)
  },
  updateDoc: async (id: string, patch: { path?: string, tags?: string[], type?: string, frontmatter?: Record<string, unknown> }) => {
    const r = rows[id]
    if (!r) return null
    if (patch.path !== undefined) r.path = patch.path
    if (patch.tags !== undefined) r.tags = patch.tags
    if (patch.type !== undefined) r.type = patch.type
    if (patch.frontmatter !== undefined) r.frontmatter = patch.frontmatter
    return toRow(r)
  },
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

  // Regression: the create branch used to call createDoc({ path, content, title }) only,
  // silently dropping tags/type/frontmatter on a sync that creates a new document (they were
  // only ever forwarded on the update/adopt paths via applySyncMeta). Caught in review of the
  // task-7 wiki, which claimed metadata passthrough applied unconditionally.
  it('persists tags, type, and frontmatter when the sync creates a new document', async () => {
    const res = await run({
      path: '/projects/x/new-with-meta.md', content: 'fresh',
      tags: ['x', 'y'], type: 'note', frontmatter: { foo: 'bar' }
    })
    expect(res.ok).toBe(true)
    expect(res.action).toBe('created')
    expect(res.tags).toEqual(['x', 'y'])
    expect(res.type).toBe('note')
    const created = Object.values(rows).find(r => r.path === '/projects/x/new-with-meta.md')!
    expect(created.tags).toEqual(['x', 'y'])
    expect(created.type).toBe('note')
    expect(created.frontmatter).toEqual({ foo: 'bar' })
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

describe('sync_document metadata and relocation', () => {
  it('relocates the document when path is passed alongside id', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/renamed.md',
      content: 'local body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('updated')
    expect(res.path).toBe('/projects/x/renamed.md')
    expect(rows['doc-1']!.path).toBe('/projects/x/renamed.md')
  })

  it('relocates even when the body is unchanged', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/moved.md',
      content: 'server body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('unchanged')
    expect(rows['doc-1']!.path).toBe('/projects/x/moved.md')
  })

  it('does not relocate when path already matches', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/a.md',
      content: 'server body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('unchanged')
    expect(rows['doc-1']!.path).toBe('/projects/x/a.md')
  })

  it('never relocates or updates metadata on a refused write', async () => {
    // No expected_hash with an existing id + differing content => refused (expected_hash_required).
    // path/tags/type/frontmatter are all passed to prove applySyncMeta genuinely never runs on
    // the error branch — not merely that the mock happens to leave them alone.
    const res = await run({
      id: 'doc-1', path: '/projects/x/nope.md', content: 'local body',
      tags: ['nope'], type: 'nope-type', frontmatter: { nope: true }
    })
    expect(res.ok).toBe(false)
    expect(rows['doc-1']!.path).toBe('/projects/x/a.md')
    expect(rows['doc-1']!.tags).toBeUndefined()
    expect(rows['doc-1']!.type).toBeUndefined()
    expect(rows['doc-1']!.frontmatter).toBeUndefined()
  })

  it('applies tags, type, and frontmatter alongside a successful write', async () => {
    const res = await run({
      id: 'doc-1', content: 'local body', expected_hash: hashBody('server body'),
      tags: ['x', 'y'], type: 'note', frontmatter: { foo: 'bar' }
    })
    expect(res.action).toBe('updated')
    expect(res.tags).toEqual(['x', 'y'])
    expect(res.type).toBe('note')
    expect(rows['doc-1']!.tags).toEqual(['x', 'y'])
    expect(rows['doc-1']!.type).toBe('note')
    expect(rows['doc-1']!.frontmatter).toEqual({ foo: 'bar' })
  })

  it('applies metadata-only changes on the unchanged branch (no content write)', async () => {
    const res = await run({
      id: 'doc-1', content: 'server body', expected_hash: hashBody('server body'),
      tags: ['z']
    })
    expect(res.action).toBe('unchanged')
    expect(res.tags).toEqual(['z'])
    expect(rows['doc-1']!.tags).toEqual(['z'])
    expect(changes).toEqual(['updated'])
  })

  // Double-emit guard: applySyncMeta itself never calls publishChange (see tools.ts) — each
  // handler branch emits at most once, even when both a content write AND a relocation/metadata
  // change happen in the same call.
  it('emits exactly one change event when a write also relocates the path', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/renamed2.md',
      content: 'local body 2', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('updated')
    expect(res.path).toBe('/projects/x/renamed2.md')
    expect(changes.length).toBe(1)
    expect(changes).toEqual(['updated'])
  })

  // "adopt-with-relocation": the combined adopt/unchanged branch (decision.kind is 'unchanged'
  // here, since an id was passed and content matches — true 'adopt' only fires with no id, and
  // in that case path is the lookup key so it can never itself diverge) still relocates and
  // must emit exactly once.
  it('an unchanged-content sync that relocates the path emits exactly one change event', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/moved-unchanged2.md',
      content: 'server body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('unchanged')
    expect(res.path).toBe('/projects/x/moved-unchanged2.md')
    expect(changes.length).toBe(1)
    expect(changes).toEqual(['updated'])
  })

  // "adopt-without-relocation": a true adopt (no id) where the matched path already equals the
  // requested path and no other metadata is passed — nothing changed, so nothing is emitted.
  it('a plain adopt with no metadata changes emits no change event', async () => {
    const res = await run({ path: '/projects/x/a.md', content: 'server body' })
    expect(res.action).toBe('adopted')
    expect(changes).toEqual([])
  })
})

describe('sync_document probe mode', () => {
  it('confirms agreement without transferring a body', async () => {
    const res = await run({ id: 'doc-1', local_hash: hashBody('server body') })
    expect(res).toEqual({ ok: true, in_sync: true, server_hash: hashBody('server body'), id: 'doc-1' })
    expect(changes).toEqual([])
  })

  it('reports divergence without writing', async () => {
    const res = await run({ id: 'doc-1', local_hash: hashBody('local body') })
    expect(res.ok).toBe(true)
    expect(res.in_sync).toBe(false)
    expect(res.server_hash).toBe(hashBody('server body'))
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('probes by path too', async () => {
    const res = await run({ path: '/projects/x/a.md', local_hash: hashBody('server body') })
    expect(res.in_sync).toBe(true)
  })

  it('reports not_found when probing an unknown target', async () => {
    const res = await run({ id: 'nope', local_hash: 'abc' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_found')
  })

  it('rejects a call with neither content nor local_hash', async () => {
    const res = await run({ id: 'doc-1' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('content_required')
  })
})
