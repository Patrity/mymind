import { and, eq, isNull, isNotNull, ilike, or, sql, inArray, arrayContains, count } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { useDb } from '../db'
import { memories } from '../db/schema'
import type { MemoryDTO, MemoryScope } from '../../shared/types/memory'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import { rerank } from '../lib/ai/rerank'
import { dedupDecision, type DedupCandidate } from './memory-dedup'

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True if confidence is a number and >= threshold. */
export function shouldAutoReview(confidence: number | null | undefined, threshold: number): boolean {
  return confidence != null && confidence >= threshold
}

/** Remove 'unreviewed' from tags, deduplicate remaining, preserve order. */
export function stripUnreviewed(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of tags) {
    if (tag === 'unreviewed') continue
    if (seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const live = () => isNull(memories.archivedAt)

function toDTO(r: typeof memories.$inferSelect): MemoryDTO {
  return {
    id: r.id,
    scope: r.scope as MemoryScope,
    content: r.content,
    tags: r.tags,
    source: r.source,
    confidence: r.confidence,
    project: r.project,
    sessionId: r.sessionId,
    enrichedAt: r.enrichedAt?.toISOString() ?? null,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  }
}

// ---------------------------------------------------------------------------
// Create (with two-stage dedup)
// ---------------------------------------------------------------------------

export interface CreateMemoryInput {
  content: string
  scope?: MemoryScope
  tags?: string[]
  source?: string
  project?: string | null
  sessionId?: string | null
  confidence?: number | null
  evidence?: unknown[]
  reviewed?: boolean
}

export async function createMemory(input: CreateMemoryInput): Promise<MemoryDTO> {
  const db = useDb()
  const config = useRuntimeConfig()
  const threshold = config.memoryAutoReviewThreshold as number ?? 0.75
  const scope = input.scope ?? 'user'
  const contentHash = createHash('sha256').update(input.content).digest('hex')
  const vec = await embedOne(input.content)
  const lit = `[${vec.join(',')}]`

  // Build dedup candidate pool:
  // 1. Exact contentHash match (SQL WHERE)
  // 2. Top-20 nearest vectors in same scope+project partition
  const scopeFilter = eq(memories.scope, scope)
  const projectFilter = input.project ? eq(memories.project, input.project) : isNull(memories.project)

  const [exactRows, vectorRows] = await Promise.all([
    // Exact-hash lookup is GLOBAL (no scope/project filter) — the unique index
    // is on content_hash alone (where archived_at is null), so we must match it.
    db.select({ id: memories.id, contentHash: memories.contentHash, embedding: memories.embedding })
      .from(memories)
      .where(and(live(), eq(memories.contentHash, contentHash)))
      .limit(1),
    // Semantic near-dup search stays scoped to (scope, project) for relevance.
    db.select({ id: memories.id, contentHash: memories.contentHash, embedding: memories.embedding })
      .from(memories)
      .where(and(live(), scopeFilter, projectFilter, isNotNull(memories.embedding)))
      .orderBy(sql`${memories.embedding} <=> ${lit}::halfvec`)
      .limit(20)
  ])

  // Merge both candidate pools (exact first, deduplicated by id)
  const seen = new Set<string>()
  const candidates: DedupCandidate[] = []
  for (const r of [...exactRows, ...vectorRows]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    candidates.push({ id: r.id, contentHash: r.contentHash, embedding: r.embedding })
  }

  const decision = dedupDecision({ contentHash, embedding: vec }, candidates)

  if (decision.action === 'skip') {
    // Already stored identically — return the existing memory
    const [existing] = await db.select().from(memories)
      .where(eq(memories.id, decision.mergeId!)).limit(1)
    return toDTO(existing!)
  }

  if (decision.action === 'merge') {
    // Append evidence entry to the nearest duplicate and return it
    const evidenceEntry = {
      sessionId: input.sessionId ?? null,
      mergedAt: new Date().toISOString(),
      ...(input.evidence ? { evidence: input.evidence } : {})
    }
    const [updated] = await db.update(memories)
      .set({
        evidence: sql`${memories.evidence} || ${JSON.stringify([evidenceEntry])}::jsonb`,
        updatedAt: new Date()
      })
      .where(eq(memories.id, decision.mergeId!))
      .returning()
    return toDTO(updated!)
  }

  // action === 'insert'
  // Wrap in try/catch for the race where a concurrent insert wins the
  // content_hash unique index (Postgres error 23505).
  try {
    const autoReview = shouldAutoReview(input.confidence, threshold)
    const finalTags = (autoReview || input.reviewed) ? stripUnreviewed(input.tags ?? []) : (input.tags ?? [])
    const finalReviewedAt = (input.reviewed || autoReview) ? new Date() : null

    const [inserted] = await db.insert(memories).values({
      scope,
      content: input.content,
      tags: finalTags,
      source: input.source ?? null,
      embedding: vec,
      contentHash,
      confidence: input.confidence ?? null,
      evidence: (input.evidence ?? []) as unknown as string,
      project: input.project ?? null,
      sessionId: input.sessionId ?? null,
      enrichedAt: null,
      reviewedAt: finalReviewedAt
    }).returning()

    return toDTO(inserted!)
  } catch (err: unknown) {
    // Unique-violation on content_hash: a concurrent insert beat us.
    // Fetch the winning row and merge evidence into it.
    if ((err as NodeJS.ErrnoException & { code?: string }).code === '23505') {
      const evidenceEntry = {
        sessionId: input.sessionId ?? null,
        mergedAt: new Date().toISOString(),
        ...(input.evidence ? { evidence: input.evidence } : {})
      }
      const [raceRow] = await db.update(memories)
        .set({
          evidence: sql`${memories.evidence} || ${JSON.stringify([evidenceEntry])}::jsonb`,
          updatedAt: new Date()
        })
        .where(and(live(), eq(memories.contentHash, contentHash)))
        .returning()
      if (raceRow) return toDTO(raceRow)
      // Fallback: fetch without update (archived between our check and update)
      const [existing] = await db.select().from(memories)
        .where(eq(memories.contentHash, contentHash)).limit(1)
      return toDTO(existing!)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Search (hybrid trigram + vector RRF, mirrors searchDocs)
// ---------------------------------------------------------------------------

export interface SearchMemoriesOptions {
  scope?: MemoryScope
  project?: string | null
  tags?: string[]
  limit?: number
}

export async function searchMemories(q: string, opts: SearchMemoriesOptions = {}): Promise<MemoryDTO[]> {
  if (!q.trim()) return []

  const db = useDb()
  const limit = opts.limit ?? 20

  // Build shared filter conditions
  const baseConditions = [live()]
  if (opts.scope) baseConditions.push(eq(memories.scope, opts.scope))
  if (opts.project !== undefined) {
    if (opts.project === null) baseConditions.push(isNull(memories.project))
    else baseConditions.push(eq(memories.project, opts.project))
  }
  if (opts.tags?.length) baseConditions.push(arrayContains(memories.tags, opts.tags))

  const baseWhere = and(...baseConditions)

  // Lane 1: trigram — ILIKE filter + similarity ordering
  const trigramRows = await db.select({ id: memories.id }).from(memories)
    .where(and(baseWhere, or(ilike(memories.content, `%${q}%`))))
    .orderBy(sql`similarity(${memories.content}, ${q}) desc`)
    .limit(50)
  const trigramIds = trigramRows.map(r => r.id)

  // Lane 2: vector — cosine distance via HNSW index, with fallback
  let vectorIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vecRows = await db.select({ id: memories.id })
      .from(memories)
      .where(and(baseWhere, isNotNull(memories.embedding)))
      .orderBy(sql`${memories.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vectorIds = vecRows.map(r => r.id)
  } catch (err) {
    console.warn('[searchMemories] vector lane failed, falling back to trigram-only:', err)
  }

  // Fuse with RRF
  const fusedIds = rrfFuse([trigramIds, vectorIds]).slice(0, limit)
  if (fusedIds.length === 0) return []

  // Hydrate and re-order
  const fetched = await db.select().from(memories)
    .where(and(live(), inArray(memories.id, fusedIds)))
  const byId = new Map(fetched.map(r => [r.id, r]))

  // Build DTOs in fused order (baseline: rank-based relevance)
  const dtos = fusedIds.flatMap(id => {
    const r = byId.get(id)
    return r ? [toDTO(r)] : []
  })

  // Attach rank-based relevance scores: relevance = 1/(1+rank), rounded to 3dp
  const withRelevance = dtos.map((dto, rank) => ({
    ...dto,
    relevance: Math.round((1 / (1 + rank)) * 1000) / 1000
  }))

  // Optional: reranker (OFF by default — aiRerankBaseUrl must be set in config)
  const config = useRuntimeConfig()
  const rerankBaseUrl = (config.ai as { rerankBaseUrl?: string }).rerankBaseUrl ?? ''
  if (rerankBaseUrl) {
    try {
      const rerankApiKey = (config.ai as { rerankApiKey?: string }).rerankApiKey ?? ''
      const docs = withRelevance.map(dto => ({ id: dto.id, text: dto.content }))
      const reranked = await rerank(q, docs, rerankBaseUrl, rerankApiKey)
      if (reranked.length === withRelevance.length) {
        const rerankedById = new Map(reranked.map(r => [r.id, r.score]))
        return withRelevance
          .map(dto => ({ ...dto, relevance: rerankedById.get(dto.id) ?? dto.relevance }))
          .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      }
    } catch (err) {
      console.warn('[searchMemories] reranker failed, using RRF order:', err)
    }
  }

  return withRelevance
}

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

export interface ListMemoriesOptions {
  scope?: MemoryScope
  reviewed?: boolean
  limit?: number
}

export async function listMemories(opts: ListMemoriesOptions = {}): Promise<MemoryDTO[]> {
  const db = useDb()
  const conditions = [live()]
  if (opts.scope) conditions.push(eq(memories.scope, opts.scope))
  if (opts.reviewed === true) conditions.push(isNotNull(memories.reviewedAt))
  if (opts.reviewed === false) conditions.push(isNull(memories.reviewedAt))

  const rows = await db.select().from(memories)
    .where(and(...conditions))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(opts.limit ?? 100)
  return rows.map(toDTO)
}

export async function getMemory(id: string): Promise<MemoryDTO | null> {
  const [r] = await useDb().select().from(memories)
    .where(and(eq(memories.id, id), live())).limit(1)
  return r ? toDTO(r) : null
}

// ---------------------------------------------------------------------------
// Update / Review / Archive
// ---------------------------------------------------------------------------

export interface UpdateMemoryInput {
  content?: string
  scope?: MemoryScope
  tags?: string[]
  source?: string | null
  project?: string | null
  sessionId?: string | null
  confidence?: number | null
  evidence?: unknown[]
}

export async function updateMemory(id: string, patch: UpdateMemoryInput): Promise<MemoryDTO | null> {
  const db = useDb()
  const update: Record<string, unknown> = { updatedAt: new Date() }

  if (patch.content !== undefined) {
    update.content = patch.content
    update.contentHash = createHash('sha256').update(patch.content).digest('hex')
    // Re-embed on content change — best-effort, skip on failure
    try {
      update.embedding = await embedOne(patch.content)
    } catch (err) {
      console.warn('[updateMemory] re-embed failed, keeping old embedding:', err)
    }
  }
  if (patch.scope !== undefined) update.scope = patch.scope
  if (patch.tags !== undefined) update.tags = patch.tags
  if ('source' in patch) update.source = patch.source
  if ('project' in patch) update.project = patch.project
  if ('sessionId' in patch) update.sessionId = patch.sessionId
  if ('confidence' in patch) update.confidence = patch.confidence
  if (patch.evidence !== undefined) update.evidence = patch.evidence as unknown as string

  const [r] = await db.update(memories)
    .set(update as Partial<typeof memories.$inferInsert>)
    .where(and(eq(memories.id, id), live()))
    .returning()
  return r ? toDTO(r) : null
}

export async function reviewMemory(id: string): Promise<MemoryDTO | null> {
  const db = useDb()
  // Fetch current tags so we can strip 'unreviewed'
  const [current] = await db.select({ tags: memories.tags }).from(memories)
    .where(and(eq(memories.id, id), live())).limit(1)
  if (!current) return null

  const [r] = await db.update(memories)
    .set({ reviewedAt: new Date(), updatedAt: new Date(), tags: stripUnreviewed(current.tags) })
    .where(and(eq(memories.id, id), live()))
    .returning()
  return r ? toDTO(r) : null
}

export async function archiveMemory(id: string): Promise<MemoryDTO | null> {
  const [r] = await useDb().update(memories)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(memories.id, id), live()))
    .returning()
  return r ? toDTO(r) : null
}

export async function countUnreviewedMemories(): Promise<number> {
  const [result] = await useDb()
    .select({ n: count() })
    .from(memories)
    .where(and(live(), isNull(memories.reviewedAt)))
  return result?.n ?? 0
}
