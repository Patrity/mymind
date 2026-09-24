import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { memories, memoryRelations } from '../db/schema'
import { enqueueReview } from './review'

export interface SweepOptions {
  /** How many retrievals before a global memory is worth pinning into every prompt. */
  residentMinRetrievals?: number
  /** Optional `durable` scorer (spec §5.2). Omitted in tests and when no key is configured. */
  scoreDurable?: (contents: { id: string, content: string }[]) => Promise<Map<string, number>>
  /** Below this durability, a memory is a stale CANDIDATE — surfaced, never auto-archived. */
  staleBelow?: number
  /**
   * Restrict every query in this sweep to these memory ids (matched via `memoryRelations.fromId`
   * for contradictions, `memories.id` everywhere else). Test-only scoping seam — production
   * (server/tasks/enrich-memories.ts) never sets this, so the real sweep scans the whole store.
   *
   * `sweepMemoryConcerns` is, by nature, an unscoped sweep over the entire memory store — exactly
   * like `enrichConversations` before it. All `.db.test.ts` files share one dev Postgres holding
   * Tony's real memories, so an unscoped call from a test WOULD file review items against real
   * rows. Passing `only: [...]` (or `only: []` to match nothing) keeps every query below scoped
   * to just the ids a test seeded.
   */
  only?: string[]
}

/** `undefined` when `only` was never passed (production: no filter). A `sql\`false\`` guard when
 *  `only` was passed but empty (a test wants zero real rows touched) — `inArray(col, [])` is not
 *  used here because an empty IN-list is not guaranteed safe across drivers. */
function scopeFilter(column: Parameters<typeof inArray>[0], only: string[] | undefined) {
  if (only === undefined) return undefined
  if (only.length === 0) return sql`false`
  return inArray(column, only)
}

/**
 * File memory concerns into the review queue. NOTHING here archives or deletes — every item is
 * a proposal for a human. There is no undo in this system.
 *
 * Deliberately excludes anything driven by an LLM value rubric: measured on 45 hand labels,
 * Jev's 4-level `value` predicted keep-vs-stale at AUC 0.55, which is chance. These signals are
 * structural instead — a contradiction edge is a fact about the graph, and a retrieval count is
 * measured behaviour.
 */
export async function sweepMemoryConcerns(
  opts: SweepOptions = {}
): Promise<{ contradictions: number, residentPromotions: number, staleCandidates: number }> {
  const db = useDb()
  const minRetrievals = opts.residentMinRetrievals ?? 10

  // 1. Contradictions. Cycle 13 built this graph and the judge that populates it; nothing has
  //    ever read those edges at turn time. A contradiction is the most damaging thing in the
  //    store, because agents act on it confidently.
  const contradictionConditions = [
    eq(memoryRelations.type, 'contradicts'),
    eq(memoryRelations.status, 'active')
  ]
  const contradictionScope = scopeFilter(memoryRelations.fromId, opts.only)
  if (contradictionScope) contradictionConditions.push(contradictionScope)

  const contradictions = await db.select({ fromId: memoryRelations.fromId, toId: memoryRelations.toId })
    .from(memoryRelations)
    .where(and(...contradictionConditions))

  for (const c of contradictions) {
    await enqueueReview({
      targetKind: 'memory', targetId: c.fromId, kind: 'contradiction',
      proposed: { contradicts: c.toId }
    })
  }

  // 2. Resident promotions. Rather than asking a model whether a fact deserves to live in every
  //    prompt, watch what is actually retrieved: a global memory pulled repeatedly is
  //    demonstrating that it matters. Measured behaviour, not an opinion.
  const promotableConditions = [
    sql`${memories.archivedAt} is null`,
    eq(memories.applicability, 'global'),
    eq(memories.resident, false),
    sql`${memories.reviewedAt} is not null`,
    gte(memories.retrievalCount, minRetrievals)
  ]
  const promotableScope = scopeFilter(memories.id, opts.only)
  if (promotableScope) promotableConditions.push(promotableScope)

  const promotable = await db.select({ id: memories.id, retrievalCount: memories.retrievalCount })
    .from(memories)
    .where(and(...promotableConditions))

  for (const m of promotable) {
    await enqueueReview({
      targetKind: 'memory', targetId: m.id, kind: 'resident-promotion',
      proposed: { resident: true, retrievalCount: m.retrievalCount }
    })
  }

  // 3. Stale candidates (spec §5.2). `durable` is the ONE facet that survived its confidence
  //    interval on the hand labels (AUC 0.73-0.74 on both the unbiased 28 and the full 45).
  //    Surfaced, NEVER auto-archived — precision is roughly 30-50% and there is no undo.
  let staleCandidates = 0
  if (opts.scoreDurable) {
    const staleRowConditions = [
      sql`${memories.archivedAt} is null`,
      sql`${memories.reviewedAt} is not null`
    ]
    const staleRowScope = scopeFilter(memories.id, opts.only)
    if (staleRowScope) staleRowConditions.push(staleRowScope)

    const rows = await db.select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(and(...staleRowConditions))
      .orderBy(sql`${memories.retrievalCount} desc`)
      .limit(200)
    const scores = await opts.scoreDurable(rows)
    for (const [id, durable] of scores) {
      if (durable >= (opts.staleBelow ?? 0.4)) continue
      await enqueueReview({ targetKind: 'memory', targetId: id, kind: 'stale', proposed: { durable } })
      staleCandidates++
    }
  }

  return { contradictions: contradictions.length, residentPromotions: promotable.length, staleCandidates }
}
