import { and, eq, isNull, isNotNull, ne, ilike, or, sql, inArray, arrayContains, count } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { useDb } from '../db'
import { memories, memoryRelations } from '../db/schema'
import type { MemoryDTO, MemoryEvidenceEntry, MemoryRelationDTO, MemoryScope } from '../../shared/types/memory'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import { rerank } from '../lib/ai/rerank'
import { resolveChain } from '../lib/ai/registry/resolve'
import { dedupDecision, type DedupCandidate } from './memory-dedup'
import { publishChange } from '../utils/live-bus'

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

function toDTO(r: typeof memories.$inferSelect, relations?: MemoryRelationDTO[]): MemoryDTO {
  const evidenceRaw = Array.isArray(r.evidence) ? (r.evidence as unknown[]) : []
  const evidence: MemoryEvidenceEntry[] = evidenceRaw.map((e) => {
    const entry = e as Record<string, unknown>
    return {
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      msgIds: Array.isArray(entry.msgIds) ? entry.msgIds as string[] : undefined,
      quote: typeof entry.quote === 'string' ? entry.quote : null,
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : null,
      mergedAt: typeof entry.mergedAt === 'string' ? entry.mergedAt : null
    }
  })
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
    sourceDate: r.sourceDate?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    evidence: evidence.length > 0 ? evidence : undefined,
    relations
  }
}

/** Fetch all memory_relations for a set of memory ids and attach them as RelationDTOs. */
async function fetchRelationsForIds(ids: string[]): Promise<Map<string, MemoryRelationDTO[]>> {
  if (!ids.length) return new Map()
  const db = useDb()

  // Fetch outgoing (fromId in ids)
  const outgoing = await db
    .select({
      fromId: memoryRelations.fromId,
      toId: memoryRelations.toId,
      type: memoryRelations.type,
      status: memoryRelations.status,
      otherContent: memories.content
    })
    .from(memoryRelations)
    .leftJoin(memories, eq(memories.id, memoryRelations.toId))
    .where(inArray(memoryRelations.fromId, ids))

  // Fetch incoming (toId in ids)
  const incoming = await db
    .select({
      fromId: memoryRelations.fromId,
      toId: memoryRelations.toId,
      type: memoryRelations.type,
      status: memoryRelations.status,
      otherContent: memories.content
    })
    .from(memoryRelations)
    .leftJoin(memories, eq(memories.id, memoryRelations.fromId))
    .where(inArray(memoryRelations.toId, ids))

  const result = new Map<string, MemoryRelationDTO[]>()

  for (const r of outgoing) {
    if (!result.has(r.fromId)) result.set(r.fromId, [])
    result.get(r.fromId)!.push({
      type: r.type,
      direction: 'outgoing',
      otherId: r.toId,
      otherContent: r.otherContent ?? null,
      status: r.status
    })
  }

  for (const r of incoming) {
    if (!result.has(r.toId)) result.set(r.toId, [])
    result.get(r.toId)!.push({
      type: r.type,
      direction: 'incoming',
      otherId: r.fromId,
      otherContent: r.otherContent ?? null,
      status: r.status
    })
  }

  return result
}

// ---------------------------------------------------------------------------
// Dedup candidate pool builder (shared by createMemory + dedupMemoriesAfterMerge)
// ---------------------------------------------------------------------------

/**
 * Build the two-stage dedup candidate pool for a given memory fingerprint.
 *
 * Stage 1: exact content-hash match (global — the unique index is on hash alone).
 * Stage 2: top-20 nearest vectors in the same (scope, project) partition.
 *
 * An optional `excludeId` is used to exclude the memory being checked from its
 * own candidate pool (needed when checking an existing memory against others).
 */
export async function buildDedupCandidates(opts: {
  contentHash: string
  embedding: number[]
  scope: MemoryScope
  project: string | null
  excludeId?: string
}): Promise<DedupCandidate[]> {
  const db = useDb()
  const { contentHash, embedding, scope, project, excludeId } = opts
  const lit = `[${embedding.join(',')}]`

  const [exactRows, vectorRows] = await Promise.all([
    // Exact-hash lookup is GLOBAL (no scope/project filter) — the unique index
    // is on content_hash alone (where archived_at is null), so we must match it.
    db.select({ id: memories.id, contentHash: memories.contentHash, embedding: memories.embedding })
      .from(memories)
      .where(and(live(), eq(memories.contentHash, contentHash), excludeId ? ne(memories.id, excludeId) : undefined))
      .limit(1),
    // Semantic near-dup search stays scoped to (scope, project) for relevance.
    db.select({ id: memories.id, contentHash: memories.contentHash, embedding: memories.embedding })
      .from(memories)
      .where(and(
        live(),
        eq(memories.scope, scope),
        project ? eq(memories.project, project) : isNull(memories.project),
        isNotNull(memories.embedding),
        excludeId ? ne(memories.id, excludeId) : undefined
      ))
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

  return candidates
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

  const candidates = await buildDedupCandidates({
    contentHash,
    embedding: vec,
    scope,
    project: input.project ?? null
  })

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
// Post-merge dedup: collapse near/exact duplicates in a merged project bucket
// ---------------------------------------------------------------------------

/**
 * For each memory id (the "loser" memories now reassigned to the winner project),
 * run the same candidate-pool + decision logic that createMemory uses, but for an
 * existing memory, excluding itself from its own candidate pool.
 *
 * - exact hash match  → 'skip':  archive this memory, set supersededBy, merge evidence into survivor
 * - near-dup (≥0.85) → 'merge': same as skip
 * - no dup           → 'insert': leave it alone
 *
 * Processed sequentially (for...of) to avoid thundering-herd on the DB and to
 * keep decisions deterministic (later iterations see the updated survivor state).
 */
export async function dedupMemoriesAfterMerge(memoryIds: string[]): Promise<{ collapsed: number }> {
  if (memoryIds.length === 0) return { collapsed: 0 }

  const db = useDb()
  let collapsed = 0

  for (const id of memoryIds) {
    // 1. Load the memory — skip if missing, archived, or has no embedding
    const [row] = await db
      .select({
        id: memories.id,
        contentHash: memories.contentHash,
        embedding: memories.embedding,
        scope: memories.scope,
        project: memories.project,
        evidence: memories.evidence
      })
      .from(memories)
      .where(and(eq(memories.id, id), live()))
      .limit(1)

    if (!row || !row.embedding) continue

    const { contentHash, embedding, project, evidence } = row
    const scope = row.scope as MemoryScope

    // 2. Build candidate pool excluding this memory
    const candidates = await buildDedupCandidates({
      contentHash,
      embedding,
      scope,
      project: project ?? null,
      excludeId: id
    })

    // 3. Run the same dedup decision
    const decision = dedupDecision({ contentHash, embedding }, candidates)

    if (decision.action === 'skip' || decision.action === 'merge') {
      const survivorId = decision.mergeId!
      const thisEvidence = Array.isArray(evidence) ? evidence : []

      // 4a. Archive this memory (the duplicate), pointing supersededBy at the survivor
      await db.update(memories)
        .set({ archivedAt: new Date(), supersededBy: survivorId, updatedAt: new Date() })
        .where(eq(memories.id, id))

      // 4b. Merge this memory's evidence into the survivor
      await db.update(memories)
        .set({
          evidence: sql`${memories.evidence} || ${JSON.stringify(thisEvidence)}::jsonb`,
          updatedAt: new Date()
        })
        .where(eq(memories.id, survivorId))

      // 4c. Emit live-bus events for both the archived memory and the updated survivor
      publishChange({ resource: 'memory', action: 'updated', id })
      publishChange({ resource: 'memory', action: 'updated', id: survivorId })

      collapsed++
    }
    // action === 'insert': leave this memory in place
  }

  return { collapsed }
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

  // Optional: reranker (OFF by default — a 'rerank' model must be assigned in config)
  let rerankCfg: { baseURL: string; apiKey: string; model: string } | null = null
  try {
    const [m] = await resolveChain('rerank')
    if (m?.baseURL) rerankCfg = { baseURL: m.baseURL.replace(/\/$/, ''), apiKey: m.apiKey ?? '', model: m.modelId }
  } catch { rerankCfg = null }  // AiNotConfiguredError → rerank stays off
  if (rerankCfg) {
    try {
      const docs = withRelevance.map(dto => ({ id: dto.id, text: dto.content }))
      const reranked = await rerank(q, docs, rerankCfg.baseURL, rerankCfg.apiKey, rerankCfg.model)
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
  project?: string | null
  limit?: number
}

export async function listMemories(opts: ListMemoriesOptions = {}): Promise<MemoryDTO[]> {
  const db = useDb()
  const conditions = [live()]
  if (opts.scope) conditions.push(eq(memories.scope, opts.scope))
  if (opts.reviewed === true) conditions.push(isNotNull(memories.reviewedAt))
  if (opts.reviewed === false) conditions.push(isNull(memories.reviewedAt))
  if (opts.project !== undefined) {
    if (opts.project === null) conditions.push(isNull(memories.project))
    else conditions.push(eq(memories.project, opts.project))
  }

  const rows = await db.select().from(memories)
    .where(and(...conditions))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(opts.limit ?? 100)

  const ids = rows.map(r => r.id)
  const relationsMap = await fetchRelationsForIds(ids)
  return rows.map(r => toDTO(r, relationsMap.get(r.id)))
}

export async function getMemory(id: string): Promise<MemoryDTO | null> {
  const [r] = await useDb().select().from(memories)
    .where(and(eq(memories.id, id), live())).limit(1)
  if (!r) return null
  const relationsMap = await fetchRelationsForIds([id])
  return toDTO(r, relationsMap.get(id))
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
