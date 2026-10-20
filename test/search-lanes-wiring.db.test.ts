// Real-Postgres test that the search SERVICES use the new lanes: the FTS lexical lane finds a
// natural-language hit the old ILIKE lane could not, and every vector lane runs inside
// withHnswSession with the lane's own LIMIT and a correct `filtered` flag. Inserts/deletes only its
// own marker rows. Run with `pnpm test:db` (developed against a throwaway pgvector container).
import { existsSync } from 'node:fs'
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env')

process.env.DATABASE_URL ??= 'postgres://invalid'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

// A deterministic 2560-d query vector so the vector lanes actually execute against pgvector
// (no rig needed). Every inserted row gets the same vector → distance 0 → it is the top vector hit.
const VEC = Array.from({ length: 2560 }, (_, i) => (i % 7) / 10)
vi.mock('@mymind/core/lib/ai/embeddings', () => ({ embedOne: vi.fn(async () => VEC) }))
vi.mock('@mymind/core/lib/search/hnsw', async (orig) => {
  const a = await orig<typeof import('@mymind/core/lib/search/hnsw')>()
  return { ...a, withHnswSession: vi.fn(a.withHnswSession) }
})

const { useDb } = await import('@mymind/core/db')
const { memories, documents, chunks, sessions, messages } = await import('@mymind/core/db/schema')
const { withHnswSession } = await import('@mymind/core/lib/search/hnsw')
const { searchMemories } = await import('@mymind/core/services/memory')
const { searchPassages, searchDocs } = await import('@mymind/core/services/documents')
const { searchSessions, searchMessages } = await import('@mymind/core/services/session-search')

const MARK = `zz-lanes-${Date.now().toString(36)}`
const PROJECT = `${MARK}-proj`
// Not a substring of any row below; FTS stems it to transcod / deadlock / throttl.
const Q = 'transcoder deadlocking throttles'
// An identifier-like token (dots + underscore) planted in every row: isIdentifierLike() routes a
// query for it to the ILIKE lane, and it is a verbatim substring, so ILIKE finds it.
const IDENT = `${MARK}.throttle_buffer`
const BODY = `${MARK} The Plex transcoder deadlocked because the throttle buffer (cfg ${IDENT}) was sixty seconds.`
const db = useDb()
const spy = withHnswSession as unknown as ReturnType<typeof vi.fn>
const lastHnswOpts = () => spy.mock.calls.map(c => c[1]) as Array<{ limit: number, filtered: boolean }>

let memId = '', docId = '', sessId = '', msgId = ''

beforeAll(async () => {
  const [m] = await db.insert(memories).values({ content: BODY, contentHash: `${MARK}-h`, scope: 'user', project: PROJECT, embedding: VEC }).returning({ id: memories.id })
  memId = m!.id
  const [d] = await db.insert(documents).values({ path: `/${MARK}/note.md`, title: `${MARK} plex note`, content: BODY, project: PROJECT }).returning({ id: documents.id })
  docId = d!.id
  await db.insert(chunks).values({ sourceType: 'document', sourceId: docId, ord: 0, content: BODY, context: 'About the Plex throttle deadlock.', embedding: VEC })
  const [s] = await db.insert(sessions).values({ source: 'test', externalId: MARK, title: `${MARK} plex session`, summary: BODY, project: PROJECT, summaryEmbedding: VEC }).returning({ id: sessions.id })
  sessId = s!.id
  const [mm] = await db.insert(messages).values({ sessionId: sessId, role: 'user', content: BODY, embedding: VEC }).returning({ id: messages.id })
  msgId = mm!.id
})
afterAll(async () => {
  await db.delete(messages).where(eq(messages.id, msgId))
  await db.delete(sessions).where(eq(sessions.id, sessId))
  await db.delete(chunks).where(eq(chunks.sourceId, docId))
  await db.delete(documents).where(eq(documents.id, docId))
  await db.delete(memories).where(eq(memories.id, memId))
})

describe('searchMemories', () => {
  it('finds the FTS-only hit and runs its vector lane with ef_search sized for LIMIT 50, iterative when filtered', async () => {
    spy.mockClear()
    const unfiltered = await searchMemories(Q, { limit: 20 })
    expect(unfiltered.map(m => m.id)).toContain(memId)
    expect(lastHnswOpts()).toEqual([{ limit: 50, filtered: false, efSearchMin: 100, iterativeScan: true }])

    spy.mockClear()
    const filtered = await searchMemories(Q, { limit: 20, project: PROJECT })
    expect(filtered.map(m => m.id)).toContain(memId)
    expect(lastHnswOpts()).toEqual([{ limit: 50, filtered: true, efSearchMin: 100, iterativeScan: true }])
  })
})

describe('searchPassages', () => {
  it('gains a lexical lane (chunks.tsv) fused with the vector lane, keeping LIMIT = opts.limit', async () => {
    spy.mockClear()
    const hits = await searchPassages(Q, { limit: 10, project: PROJECT })
    expect(hits.map(h => h.sourceId)).toContain(docId)
    expect(hits[0]).toMatchObject({ sourceId: docId, ord: 0, docTitle: `${MARK} plex note` })
    expect(lastHnswOpts()).toEqual([{ limit: 10, filtered: true, efSearchMin: 100, iterativeScan: true }])
  })
  it('still returns the row when the vector lane is unavailable (lexical-only)', async () => {
    const { embedOne } = await import('@mymind/core/lib/ai/embeddings')
    ;(embedOne as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rig down'))
    const hits = await searchPassages(Q, { limit: 10, project: PROJECT })
    expect(hits.map(h => h.sourceId)).toContain(docId)
  })
})

describe('searchDocs', () => {
  it('finds the document through documents.tsv and sizes the chunk vector lane for LIMIT 100', async () => {
    spy.mockClear()
    const docs = await searchDocs(Q, { project: PROJECT })
    expect(docs.map(d => d.id)).toContain(docId)
    expect(lastHnswOpts()).toEqual([{ limit: 100, filtered: true, efSearchMin: 100, iterativeScan: true }])
  })
})

describe('searchSessions / searchMessages', () => {
  it('sessions: FTS over title+summary; filtered only when a project is given', async () => {
    spy.mockClear()
    expect((await searchSessions(Q, { limit: 5 })).map(s => s.id)).toContain(sessId)
    expect((await searchSessions(Q, { limit: 5, project: PROJECT })).map(s => s.id)).toContain(sessId)
    expect(lastHnswOpts().map(o => o.filtered)).toEqual([false, true])
    expect(lastHnswOpts().every(o => o.limit === 50)).toBe(true)
  })
  it('messages: FTS over content; a session filter marks the lane filtered', async () => {
    spy.mockClear()
    expect((await searchMessages(Q, { limit: 5, session: sessId })).map(m => m.id)).toContain(msgId)
    expect(lastHnswOpts()).toEqual([{ limit: 50, filtered: true, efSearchMin: 100, iterativeScan: true }])
  })
})

describe('identifier fallback still works end to end', () => {
  // The vector lane is forced down for each call, so the hit can only come from the lexical lane —
  // and isIdentifierLike(IDENT) is true, so that lane is the ILIKE fallback, not FTS.
  const rigDown = async () => {
    const { embedOne } = await import('@mymind/core/lib/ai/embeddings')
    ;(embedOne as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rig down'))
  }
  it('memories: a dotted/underscored identifier is found by the ILIKE lane alone', async () => {
    await rigDown()
    const hits = await searchMemories(IDENT, { limit: 20 })
    expect(hits.map(m => m.id)).toContain(memId)
  })
  it('documents / passages / sessions / messages: same identifier, same fallback', async () => {
    await rigDown()
    expect((await searchDocs(IDENT, { project: PROJECT })).map(d => d.id)).toContain(docId)
    await rigDown()
    expect((await searchPassages(IDENT, { limit: 10 })).map(h => h.sourceId)).toContain(docId)
    await rigDown()
    expect((await searchSessions(IDENT, { limit: 5 })).map(s => s.id)).toContain(sessId)
    await rigDown()
    expect((await searchMessages(IDENT, { limit: 5, session: sessId })).map(m => m.id)).toContain(msgId)
  })
})
