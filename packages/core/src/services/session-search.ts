import { and, eq, isNotNull, ilike, sql, inArray } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages } from '../db/schema'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import { getSearchConfig } from '../lib/search/config'
import { withHnswSession } from '../lib/search/hnsw'
import { runLexicalLane, ftsMatch, ftsRank } from '../lib/search/lexical'
import { snippetAround } from './session-read'
import type { SessionResult, MessageResult } from '../shared/types/search'

export async function searchSessions(q: string, opts: { limit?: number; project?: string; includeSidechain?: boolean } = {}): Promise<SessionResult[]> {
  if (!q.trim()) return []
  // `includeSidechain` is accepted for signature symmetry with searchMessages; sessions has no isSidechain column, so it's a no-op here.
  const { limit = 5, project, includeSidechain: _includeSidechain = true } = opts
  const db = useDb()

  const cfg = await getSearchConfig()
  const projectFilter = project ? eq(sessions.project, project) : undefined

  // Lane 1: lexical — sessions.tsv FTS (title + summary), ILIKE + trigram as the fallback
  const tsv = sql`${sessions.tsv}`
  const { ids: lexicalIds } = await runLexicalLane({
    q, enabled: cfg.lexicalFts,
    fts: async () => (await db.select({ id: sessions.id }).from(sessions)
      .where(and(ftsMatch(tsv, q), projectFilter))
      .orderBy(ftsRank(tsv, q))
      .limit(50)).map(r => r.id),
    fallback: async () => (await db.select({ id: sessions.id }).from(sessions)
      .where(and(
        sql`(${sessions.title} ilike ${'%' + q + '%'} or ${sessions.summary} ilike ${'%' + q + '%'})`,
        projectFilter
      ))
      .orderBy(sql`greatest(coalesce(similarity(${sessions.title}, ${q}), 0), coalesce(similarity(${sessions.summary}, ${q}), 0)) desc`)
      .limit(50)).map(r => r.id)
  })

  // Lane 2: vector — cosine distance via HNSW index, with fallback
  let vecIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vRows = await withHnswSession(db, { limit: 50, filtered: !!projectFilter, efSearchMin: cfg.hnswEfSearchMin, iterativeScan: cfg.hnswIterativeScan }, tx =>
      tx.select({
        id: sessions.id,
        distance: sql<number>`${sessions.summaryEmbedding} <=> ${lit}::halfvec`
      }).from(sessions)
        .where(and(isNotNull(sessions.summaryEmbedding), projectFilter))
        .orderBy(sql`${sessions.summaryEmbedding} <=> ${lit}::halfvec`)
        .limit(50))
    vecIds = vRows.filter(r => r.distance <= cfg.cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchSessions] vector lane failed, falling back to lexical-only:', err)
  }

  // Fuse with RRF
  const fusedIds = rrfFuse([lexicalIds, vecIds]).slice(0, limit)
  if (!fusedIds.length) return []

  // Hydrate and re-order (mirrors searchMemories: inArray hydration)
  const rows = await db.select().from(sessions).where(inArray(sessions.id, fusedIds))
  const byId = new Map(rows.map(r => [r.id, r]))
  return fusedIds.flatMap(id => {
    const r = byId.get(id)
    return r
      ? [{ type: 'session' as const, id: r.id, title: r.title || '(untitled session)', snippet: (r.summary || '').slice(0, 160), project: r.project, to: `/sessions/${r.id}` }]
      : []
  })
}

export async function searchMessages(q: string, opts: { limit?: number; project?: string; session?: string; includeSidechain?: boolean } = {}): Promise<MessageResult[]> {
  if (!q.trim()) return []
  const { limit = 5, project, session, includeSidechain = true } = opts
  const db = useDb()

  // resolve project -> session ids once (only if project given)
  let projectSessionIds: string[] | null = null
  if (project) {
    const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.project, project))
    projectSessionIds = rows.map(r => r.id)
    if (!projectSessionIds.length) return []
  }
  const scope = and(
    includeSidechain ? undefined : eq(messages.isSidechain, false),
    session ? eq(messages.sessionId, session) : undefined,
    projectSessionIds ? inArray(messages.sessionId, projectSessionIds) : undefined
  )

  const filtered = !includeSidechain || !!session || !!projectSessionIds
  const cfg = await getSearchConfig()

  // Lane 1: lexical — messages.tsv FTS, ILIKE + trigram as the fallback
  const tsv = sql`${messages.tsv}`
  const { ids: lexicalIds } = await runLexicalLane({
    q, enabled: cfg.lexicalFts,
    fts: async () => (await db.select({ id: messages.id }).from(messages)
      .where(and(ftsMatch(tsv, q), scope))
      .orderBy(ftsRank(tsv, q))
      .limit(50)).map(r => r.id),
    fallback: async () => (await db.select({ id: messages.id }).from(messages)
      .where(and(ilike(messages.content, `%${q}%`), scope))
      .orderBy(sql`similarity(${messages.content}, ${q}) desc`)
      .limit(50)).map(r => r.id)
  })

  // Lane 2: vector — cosine distance via HNSW index, with fallback
  let vecIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vRows = await withHnswSession(db, { limit: 50, filtered, efSearchMin: cfg.hnswEfSearchMin, iterativeScan: cfg.hnswIterativeScan }, tx =>
      tx.select({
        id: messages.id,
        distance: sql<number>`${messages.embedding} <=> ${lit}::halfvec`
      }).from(messages)
        .where(and(isNotNull(messages.embedding), scope))
        .orderBy(sql`${messages.embedding} <=> ${lit}::halfvec`)
        .limit(50))
    vecIds = vRows.filter(r => r.distance <= cfg.cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchMessages] vector lane failed, falling back to lexical-only:', err)
  }

  // Fuse with RRF
  const fusedIds = rrfFuse([lexicalIds, vecIds]).slice(0, limit)
  if (!fusedIds.length) return []

  // Hydrate and re-order (mirrors searchMemories: inArray hydration)
  const rows = await db.select({ id: messages.id, sessionId: messages.sessionId, role: messages.role, content: messages.content })
    .from(messages).where(inArray(messages.id, fusedIds))
  const byId = new Map(rows.map(r => [r.id, r]))
  return fusedIds.flatMap(id => {
    const r = byId.get(id)
    return r
      ? [{ type: 'message' as const, id: r.id, sessionId: r.sessionId, role: r.role, snippet: r.content.slice(0, 160), to: `/sessions/${r.sessionId}` }]
      : []
  })
}

// Agent-shaped hydration wrappers — reuse the ranking above, then hydrate richer
// display fields (sessionTitle, match-centered snippet) with a keyed select. Kept
// separate from searchSessions/searchMessages so the web DTOs in shared/types/search.ts
// stay untouched. Sidechain messages are always excluded here (no legacy caller to preserve).

export async function searchMessagesForAgent(q: string, opts: { limit?: number; project?: string; session?: string } = {}) {
  const hits = await searchMessages(q, { ...opts, includeSidechain: false })
  if (!hits.length) return []
  const db = useDb()
  const ids = hits.map(h => h.id)
  const full = await db.select({ id: messages.id, sessionId: messages.sessionId, content: messages.content, createdAt: messages.createdAt }).from(messages).where(inArray(messages.id, ids))
  const byId = new Map(full.map(r => [r.id, r]))
  const sessIds = [...new Set(full.map(r => r.sessionId))]
  const sessRows = await db.select({ id: sessions.id, title: sessions.title, project: sessions.project }).from(sessions).where(inArray(sessions.id, sessIds))
  const sessById = new Map(sessRows.map(r => [r.id, r]))
  return hits.flatMap(h => {
    const m = byId.get(h.id); if (!m) return []
    const s = sessById.get(m.sessionId)
    return [{ messageId: h.id, sessionId: m.sessionId, role: h.role, snippet: snippetAround(m.content, q), createdAt: m.createdAt.toISOString(), sessionTitle: s?.title ?? null, project: s?.project ?? null }]
  })
}

export async function searchSessionsForAgent(q: string, opts: { limit?: number; project?: string } = {}) {
  const hits = await searchSessions(q, opts)
  if (!hits.length) return []
  const db = useDb()
  const rows = await db.select({ id: sessions.id, title: sessions.title, summary: sessions.summary, project: sessions.project, startedAt: sessions.startedAt, messageCount: sessions.messageCount }).from(sessions).where(inArray(sessions.id, hits.map(h => h.id)))
  const byId = new Map(rows.map(r => [r.id, r]))
  return hits.flatMap(h => {
    const s = byId.get(h.id); if (!s) return []
    return [{ sessionId: s.id, title: s.title || '(untitled session)', snippet: (s.summary || '').slice(0, 200), project: s.project, startedAt: s.startedAt.toISOString(), messageCount: s.messageCount }]
  })
}
