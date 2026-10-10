// test/memory-doc-candidates.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// Two independent things are under test here, both cycle 77 Task 6:
//   1. fileDocCandidate — files a doc-worthy extraction as a /input/ capture. Its own
//      fire-and-forget triageCapture call is stubbed to a deterministic no-op (see
//      `triageGate` below) so these tests only ever assert on the ONE document they create,
//      never race a background triage run, and never leave a stray review_queue row behind.
//   2. The mirror guard in server/services/triage.ts (resolveAppendTarget / isValidAppendTarget):
//      a triage append that resolves to a repo-mirrored doc (/projects/*/wiki/,
//      /projects/*/handovers/) must degrade to a note instead of mutating the mirror. That
//      test flips `triageGate.real = true` to run the REAL triageCapture -> applyAppend ->
//      resolveAppendTarget chain synchronously (awaited, not fire-and-forget) against a real
//      document + real chunk row, with only the model classify() call stubbed.
process.loadEnvFile('.env')
import { describe, it, expect, vi, afterEach } from 'vitest'

let triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  triageAppendSimilarityFloor: 0.75,
  get triageThresholds() { return triageThresholds }
}))

// embedOne's $fetch stub (see test/triage-actuators.db.test.ts for the full reasoning): a
// fixed, deterministic vector regardless of input text. Only exercised by the mirror-guard
// describe block below (the only place `triageGate.real` is flipped on), but stubbing it
// unconditionally keeps this file consistent with every other triage DB test and costs nothing.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

// vi.hoisted, not a bare module-level `let`: vi.mock's factory is hoisted above module-level
// declarations, so a factory closing over a plain `let` captures it before initialization.
// `triageGate.real` defaults false, so memory-doc-candidates.ts's fire-and-forget
// triageCapture(doc.id) call resolves immediately and touches nothing — fileDocCandidate's own
// tests only care about the document it creates. The mirror-guard test flips it on to drive
// the REAL triageCapture (and therefore the real applyAppend / resolveAppendTarget) directly.
const { triageGate } = vi.hoisted(() => ({ triageGate: { real: false } }))
// The duplicate guard's nearest-document lookup. Default: nothing similar (null), so every other
// test files its capture; the duplicate tests set it per test.
const { nearestGate } = vi.hoisted(() => ({ nearestGate: { value: null as null | { id: string, path: string, similarity: number } } }))
vi.mock('@mymind/core/services/triage', async (orig) => {
  const actual = await orig<typeof import('@mymind/core/services/triage')>()
  return {
    ...actual,
    nearestDocument: vi.fn(async () => nearestGate.value),
    triageCapture: vi.fn((docId: string) =>
      triageGate.real
        ? actual.triageCapture(docId)
        : Promise.resolve({ docId, applied: [], queued: false }))
  }
})

// Stub the model — this file is about doc-candidate filing and the mirror guard, not
// classification quality. Default stub never auto-applies anything; the mirror-guard test
// overrides it once via mockResolvedValueOnce to force an 'append' proposal.
vi.mock('@mymind/core/lib/ai/triage', async (orig) => ({
  ...(await orig<typeof import('@mymind/core/lib/ai/triage')>()),
  classify: vi.fn(async () => ({
    primary: { kind: 'task' as const, confidence: 0.1, title: 'Stub' }, secondary: [], reasoning: 'stub'
  }))
}))

const { fileDocCandidate, sessionWroteDocs, isDocWriteToolCall, DOC_CANDIDATE_DUP_FLOOR } = await import('../server/services/memory-doc-candidates')
const { isRepoMirrorPath } = await import('@mymind/core/lib/documents/mirror')
const { triageCapture } = await import('@mymind/core/services/triage')
const { classify } = await import('@mymind/core/lib/ai/triage')

import { createDoc, getDoc, deleteDoc } from '@mymind/core/services/documents'
import { useDb } from '@mymind/core/db'
import { chunks, toolEvents } from '@mymind/core/db/schema'
import { eq, inArray } from 'drizzle-orm'

const tag = () => Math.random().toString(36).slice(2, 10)

afterEach(() => {
  triageGate.real = false
  nearestGate.value = null
  triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
  vi.clearAllMocks()
})

describe('isRepoMirrorPath', () => {
  it('matches a wiki mirror path', () => {
    expect(isRepoMirrorPath('/projects/mymind/wiki/triage.md')).toBe(true)
  })

  it('matches a handovers mirror path', () => {
    expect(isRepoMirrorPath('/projects/mymind/handovers/2026-09-01-cycle-77.md')).toBe(true)
  })

  it('does not match a non-mirror doc under the same project', () => {
    expect(isRepoMirrorPath('/projects/mymind/notes/foo.md')).toBe(false)
  })

  it('does not match a path outside /projects/', () => {
    expect(isRepoMirrorPath('/notes/wiki/foo.md')).toBe(false)
  })

  it('does not match when the project slug segment is itself missing (wiki directly under /projects/)', () => {
    expect(isRepoMirrorPath('/projects/wiki/foo.md')).toBe(false)
  })

  it('does not match an extra path segment between the project slug and wiki/handovers', () => {
    // the project slug is exactly ONE path segment ([^/]+) — an extra segment before
    // "wiki" must not match.
    expect(isRepoMirrorPath('/projects/mymind/sub/wiki/foo.md')).toBe(false)
  })
})

describe('fileDocCandidate', () => {
  it('creates a /input/ capture whose body embeds the text, project, and doc hint', async () => {
    const t = tag()
    const r = await fileDocCandidate(
      {
        text: `ingest skips poisoned rows one at a time (${t})`,
        project: 'mymind',
        targetDocHint: `wiki: ingest pipeline ${t}`
      },
      { sessionId: `sess-${t}` }
    )
    expect(r).not.toBeNull()
    try {
      const doc = await getDoc(r!.docId)
      expect(doc).not.toBeNull()
      expect(doc!.path.startsWith('/input/')).toBe(true)
      expect(doc!.content).toBe(
        `ingest skips poisoned rows one at a time (${t})\n\n— From memory extraction (project: mymind; suggested doc: wiki: ingest pipeline ${t})`
      )
      // Titled by the text's first line, not the (often generic) hint.
      expect(doc!.title).toBe(`ingest skips poisoned rows one at a time (${t})`)
    } finally {
      await deleteDoc(r!.docId)
    }
  })

  // Review Focus 4: the v3 extractor can emit a doc_candidate with no project and no hint.
  // A capture is still created, and its text says "(no project)" — nothing crashes.
  it('says "(no project)" and "none" when the candidate has neither project nor hint', async () => {
    const t = tag()
    const r = await fileDocCandidate(
      { text: `a detail worth documenting (${t})`, project: null, targetDocHint: null },
      { conversationId: `conv-${t}` }
    )
    expect(r).not.toBeNull()
    try {
      const doc = await getDoc(r!.docId)
      expect(doc!.content).toBe(
        `a detail worth documenting (${t})\n\n— From memory extraction (project: (no project); suggested doc: none)`
      )
      // No hint to derive a slug from — falls back to a random filename, same as
      // quick_capture's untitled-capture path (server/lib/agent/tools.ts).
      expect(doc!.path).toMatch(/^\/input\/[\w-]+\.md$/)
    } finally {
      await deleteDoc(r!.docId)
    }
  })

  // Final review I3: hints are generic ("handover") and an untriaged capture stays live in
  // /input/, so a second candidate with the same hint hits documents_path_live_uidx. It must
  // still be filed (suffixed slug), never silently dropped.
  it('a second candidate with the same hint is still filed, under a suffixed slug', async () => {
    const hint = `handover ${tag()}`
    const a = await fileDocCandidate({ text: 'first detail', project: null, targetDocHint: hint }, {})
    const b = await fileDocCandidate({ text: 'second detail', project: null, targetDocHint: hint }, {})
    try {
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      const [docA, docB] = await Promise.all([getDoc(a!.docId), getDoc(b!.docId)])
      expect(docA!.path).toBe(`/input/${hint.replace(' ', '-')}.md`)
      expect(docB!.path).toMatch(new RegExp(`^/input/${hint.replace(' ', '-')}-[\\w-]{6}\\.md$`))
      expect(docB!.content.startsWith('second detail')).toBe(true)
      expect(triageCapture).toHaveBeenCalledWith(b!.docId)
    } finally {
      if (a) await deleteDoc(a.docId)
      if (b) await deleteDoc(b.docId)
    }
  })

  it('never throws and never auto-triages — filing is independent of what triage later does', async () => {
    const r = await fileDocCandidate(
      { text: `independent of triage (${tag()})`, project: null, targetDocHint: null },
      {}
    )
    expect(r).not.toBeNull()
    try {
      // triageGate.real is false (default) — the stubbed triageCapture above resolves
      // immediately without touching classify() or claiming the document.
      expect(classify).not.toHaveBeenCalled()
      expect(triageCapture).toHaveBeenCalledWith(r!.docId)
    } finally {
      await deleteDoc(r!.docId)
    }
  })
})

// Mirror guard: documents under /projects/*/wiki/ or /projects/*/handovers/ are synced
// one-way from the git repo (the wiki-mirror flow) and overwritten whole on their next sync,
// so a triage append into one is silently lost. This drives the REAL triageCapture ->
// applyAppend -> resolveAppendTarget chain (triageGate.real = true) against a real document
// with a real chunk row crafted to be the unbeatable nearest-neighbor match (see
// test/triage-actuators.db.test.ts's EXACT_MATCH_VECTOR, same technique) — proving the guard
// fires through the production wiring, not just as a unit check on isRepoMirrorPath.
describe('mirror guard — a triage append resolving to a repo-mirrored doc becomes a note', () => {
  const EXACT_MATCH_VECTOR = Array(2560).fill(0.01)

  it('degrades to a note and leaves the mirrored doc untouched', async () => {
    triageGate.real = true
    triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 0 } // force auto-apply

    const t = tag()
    const mirrorTarget = await createDoc({
      path: `/projects/mdc-scratch-${t}/wiki/guard.md`,
      content: '# Mirrored wiki page\n\nSynced from the repo. Must not be edited by triage.'
    })
    await useDb().insert(chunks).values({
      sourceType: 'document', sourceId: mirrorTarget.id, ord: 0, content: 'probe', embedding: EXACT_MATCH_VECTOR
    })

    vi.mocked(classify).mockResolvedValueOnce({
      primary: { kind: 'append' as const, confidence: 0.9, content: `a fact that would otherwise land in the wiki (${t})` },
      secondary: [], reasoning: 'stub append'
    })

    const captureDoc = await createDoc({
      path: `/input/mdc-guard-${t}.md`, content: `a fact that would otherwise land in the wiki (${t})`
    })

    try {
      await triageCapture(captureDoc.id)

      // The mirrored doc was never mutated.
      const mirrorAfter = await getDoc(mirrorTarget.id)
      expect(mirrorAfter!.content).toBe('# Mirrored wiki page\n\nSynced from the repo. Must not be edited by triage.')

      // The courier survived (applyNote never deletes its courier) and was moved out of
      // /input — proof the degrade-to-note path ran rather than the capture being dropped.
      const courierAfter = await getDoc(captureDoc.id)
      expect(courierAfter).not.toBeNull()
      expect(courierAfter!.path.startsWith('/input/')).toBe(false)
    } finally {
      await Promise.all([
        deleteDoc(mirrorTarget.id),
        useDb().delete(chunks).where(eq(chunks.sourceId, mirrorTarget.id))
      ])
      const leftoverCourier = await getDoc(captureDoc.id)
      if (leftoverCourier) await deleteDoc(leftoverCourier.id)
    }
  })
})

describe('doc-candidate duplicate guards (2026-10-02)', () => {
  it('skips a candidate an existing document already covers, and files nothing', async () => {
    const t = tag()
    nearestGate.value = { id: 'd1', path: '/projects/mymind/handovers/x.md', similarity: DOC_CANDIDATE_DUP_FLOOR }
    const r = await fileDocCandidate({ text: `restated handover (${t})`, project: 'mymind', targetDocHint: `dup ${t}` }, { sessionId: `s-${t}` })
    const { documents } = await import('@mymind/core/db/schema')
    const { like } = await import('drizzle-orm')
    const rows = await useDb().select({ id: documents.id }).from(documents).where(like(documents.content, `%restated handover (${t})%`))
    // Clean up before asserting: a regression files a real capture into the shared dev DB.
    for (const row of rows) await useDb().delete(documents).where(eq(documents.id, row.id))
    expect(r).toEqual({ skipped: 'duplicate', nearestPath: '/projects/mymind/handovers/x.md', similarity: DOC_CANDIDATE_DUP_FLOOR })
    expect(rows).toHaveLength(0)
  })

  it('files a candidate just below the floor', async () => {
    const t = tag()
    nearestGate.value = { id: 'd1', path: '/projects/mymind/notes/y.md', similarity: DOC_CANDIDATE_DUP_FLOOR - 0.01 }
    const r = await fileDocCandidate({ text: `genuinely new detail (${t})`, project: null, targetDocHint: null }, { sessionId: `s-${t}` })
    expect(r && 'docId' in r).toBe(true)
    await deleteDoc((r as { docId: string }).docId)
  })

  it('isDocWriteToolCall: repo docs + MyMind doc tools only', () => {
    expect(isDocWriteToolCall('Write', { file_path: '/Users/t/repo/docs/handovers/2026-10-02-x.md' })).toBe(true)
    expect(isDocWriteToolCall('Edit', { file_path: 'docs/wiki/memory.md' })).toBe(true)
    expect(isDocWriteToolCall('MultiEdit', { file_path: '/r/docs/superpowers/specs/a.md' })).toBe(true)
    expect(isDocWriteToolCall('mcp__mymind__sync_document', {})).toBe(true)
    expect(isDocWriteToolCall('mcp__mymind__edit_section', {})).toBe(true)
    expect(isDocWriteToolCall('Edit', { file_path: '/r/server/services/x.ts' })).toBe(false)
    expect(isDocWriteToolCall('Read', { file_path: '/r/docs/wiki/memory.md' })).toBe(false)
    expect(isDocWriteToolCall('Write', { file_path: '/r/docs/BACKLOG.md' })).toBe(false)
    expect(isDocWriteToolCall('mcp__mymind__read_document', {})).toBe(false)
  })

  it('sessionWroteDocs agrees with isDocWriteToolCall against real tool_events rows', async () => {
    const db = useDb()
    const wrote = crypto.randomUUID()
    const mcp = crypto.randomUUID()
    const codeOnly = crypto.randomUUID()
    try {
      await db.insert(toolEvents).values([
        { sessionId: wrote, toolName: 'Edit', args: { file_path: '/r/docs/wiki/memory.md' }, toolUseId: `a-${wrote}` },
        { sessionId: mcp, toolName: 'mcp__mymind__save_document', args: {}, toolUseId: `b-${mcp}` },
        { sessionId: codeOnly, toolName: 'Edit', args: { file_path: '/r/server/x.ts' }, toolUseId: `c-${codeOnly}` },
        { sessionId: codeOnly, toolName: 'Read', args: { file_path: '/r/docs/wiki/memory.md' }, toolUseId: `d-${codeOnly}` }
      ])
      expect(await sessionWroteDocs(wrote)).toBe(true)
      expect(await sessionWroteDocs(mcp)).toBe(true)
      expect(await sessionWroteDocs(codeOnly)).toBe(false)
    } finally {
      await db.delete(toolEvents).where(inArray(toolEvents.sessionId, [wrote, mcp, codeOnly]))
    }
  })
})

describe('queued append — target picked at queue time, shown in the review feed (2026-10-02)', () => {
  const EXACT_MATCH_VECTOR = Array(2560).fill(0.01)

  it('stores targetDocId on the queued append, and listReviewFeed carries source + target', async () => {
    triageGate.real = true
    triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 } // force queueing
    const t = tag()
    const target = await createDoc({ path: `/projects/mdc-scratch-${t}/notes/target.md`, title: `Target ${t}`, content: '# Target\n\nExisting.' })
    await useDb().insert(chunks).values({ sourceType: 'document', sourceId: target.id, ord: 0, content: 'probe', embedding: EXACT_MATCH_VECTOR })
    vi.mocked(classify).mockResolvedValueOnce({
      primary: { kind: 'append' as const, confidence: 0.5, content: `a related fact (${t})` }, secondary: [], reasoning: 'stub append'
    })
    const capture = await createDoc({ path: `/input/queued-append-${t}.md`, title: `Capture ${t}`, content: `a related fact (${t})` })
    const { reviewQueue } = await import('@mymind/core/db/schema')
    try {
      const out = await triageCapture(capture.id)
      expect(out.queued).toBe(true)
      const [row] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.targetId, capture.id))
      const queued = (row!.proposed as { queued: { kind: string, targetDocId?: string }[] }).queued
      expect(queued[0]).toMatchObject({ kind: 'append', targetDocId: target.id })

      const { listReviewFeed } = await import('@mymind/core/services/review')
      const item = (await listReviewFeed()).find(i => i.id === row!.id)!
      const p = item.proposed as { source: { title: string, content: string }, queued: { target?: { id: string, path: string, title: string } }[] }
      expect(p.source).toMatchObject({ title: `Capture ${t}`, content: `a related fact (${t})` })
      expect(p.queued[0]!.target).toEqual({ id: target.id, path: target.path, title: `Target ${t}` })
      // Nothing was appended yet — only proposed.
      expect((await getDoc(target.id))!.content).toBe('# Target\n\nExisting.')
    } finally {
      await useDb().delete(reviewQueue).where(eq(reviewQueue.targetId, capture.id))
      await Promise.all([deleteDoc(target.id), deleteDoc(capture.id), useDb().delete(chunks).where(eq(chunks.sourceId, target.id))])
    }
  })
})
