import { isNotNull, ilike, sql, inArray } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages } from '../db/schema'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import { getSearchConfig } from '../lib/search/config'
import type { SessionResult, MessageResult } from '../../shared/types/search'

export async function searchSessions(q: string, limit = 5): Promise<SessionResult[]> {
  if (!q.trim()) return []
  const db = useDb()

  // Lane 1: trigram — ILIKE filter + similarity ordering
  const trgRows = await db.select({ id: sessions.id }).from(sessions)
    .where(sql`(${sessions.title} ilike ${'%' + q + '%'} or ${sessions.summary} ilike ${'%' + q + '%'})`)
    .orderBy(sql`greatest(coalesce(similarity(${sessions.title}, ${q}), 0), coalesce(similarity(${sessions.summary}, ${q}), 0)) desc`)
    .limit(50)

  // Lane 2: vector — cosine distance via HNSW index, with fallback
  let vecIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vRows = await db.select({
      id: sessions.id,
      distance: sql<number>`${sessions.summaryEmbedding} <=> ${lit}::halfvec`
    }).from(sessions)
      .where(isNotNull(sessions.summaryEmbedding))
      .orderBy(sql`${sessions.summaryEmbedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vRows.filter(r => r.distance <= cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchSessions] vector lane failed, falling back to trigram-only:', err)
  }

  // Fuse with RRF
  const fusedIds = rrfFuse([trgRows.map(r => r.id), vecIds]).slice(0, limit)
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

export async function searchMessages(q: string, limit = 5): Promise<MessageResult[]> {
  if (!q.trim()) return []
  const db = useDb()

  // Lane 1: trigram — ILIKE filter + similarity ordering
  const trgRows = await db.select({ id: messages.id }).from(messages)
    .where(ilike(messages.content, `%${q}%`))
    .orderBy(sql`similarity(${messages.content}, ${q}) desc`)
    .limit(50)

  // Lane 2: vector — cosine distance via HNSW index, with fallback
  let vecIds: string[] = []
  try {
    const { cosineFloor } = await getSearchConfig()
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vRows = await db.select({
      id: messages.id,
      distance: sql<number>`${messages.embedding} <=> ${lit}::halfvec`
    }).from(messages)
      .where(isNotNull(messages.embedding))
      .orderBy(sql`${messages.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vRows.filter(r => r.distance <= cosineFloor).map(r => r.id)
  } catch (err) {
    console.warn('[searchMessages] vector lane failed, falling back to trigram-only:', err)
  }

  // Fuse with RRF
  const fusedIds = rrfFuse([trgRows.map(r => r.id), vecIds]).slice(0, limit)
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
