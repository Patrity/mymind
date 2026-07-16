import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { graphLayout, memories, documents, images, sessions, chunks } from '../db/schema'
import { meanPool, computeLayout, type LayoutItem, type LayoutRow } from '../lib/galaxy/layout'
import { assembleEdges, buildEdgeSourceRows } from '../services/graph'
import { withSpan, recordJobSummary } from '../lib/observability/record'
import { publishChange } from '../utils/live-bus'

// Fixed seed so the UMAP layout is reproducible run-to-run (the same vectors
// land in the same place, so the galaxy doesn't reshuffle every night).
const SEED = 42

// Postgres caps a statement at 65535 bound params; each row binds 6, so keep
// upsert batches well under that (and avoids a single giant statement).
const UPSERT_CHUNK = 1000

export interface GraphLayoutSummary {
  memories: number
  documents: number
  images: number
  sessions: number
  projects: number
  edges: number
  upserted: number
  /** true when the hourly run short-circuited because the node set was unchanged. */
  skipped?: boolean
}

/**
 * Recompute the whole knowledge-galaxy layout:
 *  1. Load one vector per LIVE node (memories/images embeddings, session summary
 *     embeddings, documents mean-pooled from their chunk embeddings).
 *  2. UMAP → 3D coords for every vector-bearing node.
 *  3. Project hubs = centroid of their member coords (memories/documents/sessions
 *     with a project_id; images have no project column so they don't contribute).
 *  4. Degree per node from the same edge model getGraph renders (buildEdgeSourceRows
 *     → assembleEdges), counting every incident edge.
 *  5. Upsert every row into graph_layout (idempotent on the (source_type, source_id) PK).
 *
 * Exported so the /api/graph/recompute endpoint can trigger it on demand; also the
 * body of the nightly `compute-graph-layout` task below. Wrapped in a job span so
 * both paths land in the activity log. Publishes a single `graph` live event once
 * the upsert commits so every open galaxy tab refetches the rebuilt layout.
 */
export async function runComputeGraphLayout(opts: { force?: boolean } = {}): Promise<GraphLayoutSummary> {
  return withSpan({ kind: 'job', name: 'compute-graph-layout' }, async () => {
    const db = useDb()

    // 1. Load vectors for every LIVE, vector-bearing node.
    const [memRows, imgRows, sessRows, docChunkRows] = await Promise.all([
      db.select({ id: memories.id, embedding: memories.embedding })
        .from(memories)
        .where(and(isNotNull(memories.embedding), isNull(memories.archivedAt))),
      db.select({ id: images.id, embedding: images.embedding })
        .from(images)
        .where(and(isNotNull(images.embedding), isNull(images.deletedAt))),
      db.select({ id: sessions.id, embedding: sessions.summaryEmbedding })
        .from(sessions)
        .where(isNotNull(sessions.summaryEmbedding)),
      // Mean-pool each live document's chunk embeddings; join filters out
      // soft-deleted docs, and docs with zero chunks simply never appear.
      db.select({ docId: chunks.sourceId, embedding: chunks.embedding })
        .from(chunks)
        .innerJoin(documents, eq(chunks.sourceId, documents.id))
        .where(and(eq(chunks.sourceType, 'document'), isNotNull(chunks.embedding), isNull(documents.deletedAt)))
    ])

    const items: LayoutItem[] = []
    for (const r of memRows) if (r.embedding) items.push({ type: 'memory', id: r.id, vector: r.embedding })
    for (const r of imgRows) if (r.embedding) items.push({ type: 'image', id: r.id, vector: r.embedding })
    for (const r of sessRows) if (r.embedding) items.push({ type: 'session', id: r.id, vector: r.embedding })

    const docVecs = new Map<string, number[][]>()
    for (const r of docChunkRows) {
      if (!r.embedding) continue
      const arr = docVecs.get(r.docId)
      if (arr) arr.push(r.embedding)
      else docVecs.set(r.docId, [r.embedding])
    }
    for (const [docId, vecs] of docVecs) {
      if (vecs.length === 0) continue
      items.push({ type: 'document', id: docId, vector: meanPool(vecs) })
    }

    // Hourly-cron guard: if the eligible node set is unchanged since the last run
    // (no adds/removes), the seeded UMAP would land identically — skip the heavy,
    // event-loop-blocking recompute. `force` (manual /api/graph/recompute) always
    // rebuilds. Count-only compare: a pure content edit keeps the count and is
    // picked up on the next add/remove; a slightly stale coord is harmless.
    if (!opts.force) {
      const [cur] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(graphLayout)
        .where(sql`${graphLayout.sourceType} <> 'project'`)
      const currentNodeCount = cur?.c ?? 0
      if (currentNodeCount > 0 && currentNodeCount === items.length) {
        const skipped: GraphLayoutSummary = { memories: 0, documents: 0, images: 0, sessions: 0, projects: 0, edges: 0, upserted: 0, skipped: true }
        recordJobSummary('compute-graph-layout', skipped as unknown as Record<string, unknown>)
        return skipped
      }
    }

    // 2. UMAP → 3D coords.
    const layoutRows = computeLayout(items, SEED)
    const coordByKey = new Map<string, { x: number; y: number; z: number }>()
    for (const r of layoutRows) coordByKey.set(`${r.type}:${r.id}`, { x: r.x, y: r.y, z: r.z })

    // 3 + 4. Shared edge sources drive BOTH project centroids and node degree.
    const edgeSrc = await buildEdgeSourceRows()

    // Project hubs = centroid of their positioned members.
    const projAccum = new Map<string, { x: number; y: number; z: number; n: number }>()
    for (const m of edgeSrc.memberships) {
      if (!m.projectId) continue
      const c = coordByKey.get(`${m.type}:${m.id}`)
      if (!c) continue // member has no vector / wasn't laid out
      const acc = projAccum.get(m.projectId) ?? { x: 0, y: 0, z: 0, n: 0 }
      acc.x += c.x; acc.y += c.y; acc.z += c.z; acc.n++
      projAccum.set(m.projectId, acc)
    }
    const projectRows: LayoutRow[] = []
    for (const [projectId, acc] of projAccum) {
      if (acc.n === 0) continue
      projectRows.push({ type: 'project', id: projectId, x: acc.x / acc.n, y: acc.y / acc.n, z: acc.z / acc.n })
    }

    // Degree = number of assembled edges incident to each node (same edge model
    // getGraph renders). Project hubs pick up their membership edges here too.
    const degreeByKey = new Map<string, number>()
    const bump = (t: string, id: string) => degreeByKey.set(`${t}:${id}`, (degreeByKey.get(`${t}:${id}`) ?? 0) + 1)
    const edges = assembleEdges(edgeSrc)
    for (const e of edges) { bump(e.from.type, e.from.id); bump(e.to.type, e.to.id) }

    // 5. Upsert every row into graph_layout (chunked; idempotent on the PK).
    const now = new Date()
    const allRows = [...layoutRows, ...projectRows].map((r) => ({
      sourceType: r.type,
      sourceId: r.id,
      x: r.x,
      y: r.y,
      z: r.z,
      degree: degreeByKey.get(`${r.type}:${r.id}`) ?? 0,
      updatedAt: now
    }))

    for (let i = 0; i < allRows.length; i += UPSERT_CHUNK) {
      const batch = allRows.slice(i, i + UPSERT_CHUNK)
      if (batch.length === 0) continue
      await db.insert(graphLayout).values(batch).onConflictDoUpdate({
        target: [graphLayout.sourceType, graphLayout.sourceId],
        set: {
          x: sql`excluded.x`,
          y: sql`excluded.y`,
          z: sql`excluded.z`,
          degree: sql`excluded.degree`,
          updatedAt: sql`excluded.updated_at`
        }
      })
    }

    const summary: GraphLayoutSummary = {
      memories: layoutRows.filter((r) => r.type === 'memory').length,
      documents: layoutRows.filter((r) => r.type === 'document').length,
      images: layoutRows.filter((r) => r.type === 'image').length,
      sessions: layoutRows.filter((r) => r.type === 'session').length,
      projects: projectRows.length,
      edges: edges.length,
      upserted: allRows.length
    }
    recordJobSummary('compute-graph-layout', summary as unknown as Record<string, unknown>)
    // One signal for the whole rebuild (not per-row) — the galaxy refetches the
    // entire layout in one call, so a single event is all any listener needs.
    publishChange({ resource: 'graph', action: 'updated', id: 'layout' })
    return summary
  })
}

export default defineTask({
  meta: { name: 'compute-graph-layout', description: 'Recompute the knowledge-galaxy UMAP layout (hourly; skips when the node set is unchanged)' },
  async run() {
    const result = await runComputeGraphLayout()
    return { result }
  }
})
