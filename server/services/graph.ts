import { and, eq, isNull, isNotNull, ne, inArray, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { graphLayout, memories, documents, images, sessions, projects, chunks, memoryRelations } from '../db/schema'
import { meanPool } from '../lib/galaxy/layout'
import type { GraphData, GraphEdge, GraphNode, GraphNodeType, GraphNeighbor } from '../../shared/types/graph'

// ---------------------------------------------------------------------------
// Pure edge assembly (exported for tests)
// ---------------------------------------------------------------------------

export interface EdgeSourceRows {
  memberships: { type: GraphNodeType; id: string; projectId: string | null }[]
  provenance: { memoryId: string; sessionId: string | null }[]
  ocr: { documentId: string; imageId: string }[]
  relations: { fromId: string; toId: string; type: 'supersedes' | 'contradicts' }[]
}

/**
 * Turn the four edge-source row sets into a flat GraphEdge[]. Pure — no DB.
 * Rows with a null projectId (membership) or null sessionId (provenance)
 * produce no edge.
 */
export function assembleEdges(r: EdgeSourceRows): GraphEdge[] {
  const edges: GraphEdge[] = []
  for (const m of r.memberships) if (m.projectId) edges.push({ from: { type: m.type, id: m.id }, to: { type: 'project', id: m.projectId }, kind: 'membership' })
  for (const p of r.provenance) if (p.sessionId) edges.push({ from: { type: 'memory', id: p.memoryId }, to: { type: 'session', id: p.sessionId }, kind: 'provenance' })
  for (const o of r.ocr) edges.push({ from: { type: 'document', id: o.documentId }, to: { type: 'image', id: o.imageId }, kind: 'ocr' })
  for (const rel of r.relations) edges.push({ from: { type: 'memory', id: rel.fromId }, to: { type: 'memory', id: rel.toId }, kind: rel.type })
  return edges
}

// ---------------------------------------------------------------------------
// Pure display helpers
// ---------------------------------------------------------------------------

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// ---------------------------------------------------------------------------
// getGraph — nodes from graph_layout (joined to live source rows) + edges
// ---------------------------------------------------------------------------

/**
 * Build the full galaxy graph: nodes come from `graph_layout` joined to their
 * source table (soft-deleted / archived rows are skipped), edges are assembled
 * from the source-table FKs + active memory_relations.
 *
 * `graph_layout` is empty until Task 2.4's layout job runs, so this returns
 * `{ nodes: [], edges: [] }` until then. Edges are filtered to the rendered
 * node set so the client never receives a dangling edge.
 */
export async function getGraph(): Promise<GraphData> {
  const db = useDb()

  const layoutCols = { x: graphLayout.x, y: graphLayout.y, z: graphLayout.z, degree: graphLayout.degree }

  const [memRows, docRows, imgRows, sessRows, projRows] = await Promise.all([
    db.select({ id: graphLayout.sourceId, ...layoutCols, content: memories.content, project: memories.project, projectId: memories.projectId })
      .from(graphLayout)
      .innerJoin(memories, eq(memories.id, graphLayout.sourceId))
      .where(and(eq(graphLayout.sourceType, 'memory'), isNull(memories.archivedAt))),
    db.select({ id: graphLayout.sourceId, ...layoutCols, title: documents.title, path: documents.path, preview: sql<string>`left(${documents.content}, 280)`, project: documents.project, projectId: documents.projectId })
      .from(graphLayout)
      .innerJoin(documents, eq(documents.id, graphLayout.sourceId))
      .where(and(eq(graphLayout.sourceType, 'document'), isNull(documents.deletedAt))),
    db.select({ id: graphLayout.sourceId, ...layoutCols, originalName: images.originalName, summary: images.summary })
      .from(graphLayout)
      .innerJoin(images, eq(images.id, graphLayout.sourceId))
      .where(and(eq(graphLayout.sourceType, 'image'), isNull(images.deletedAt))),
    db.select({ id: graphLayout.sourceId, ...layoutCols, title: sessions.title, summary: sessions.summary, project: sessions.project, projectId: sessions.projectId })
      .from(graphLayout)
      .innerJoin(sessions, eq(sessions.id, graphLayout.sourceId))
      .where(eq(graphLayout.sourceType, 'session')),
    db.select({ id: graphLayout.sourceId, ...layoutCols, slug: projects.slug, name: projects.name })
      .from(graphLayout)
      .innerJoin(projects, eq(projects.id, graphLayout.sourceId))
      .where(eq(graphLayout.sourceType, 'project'))
  ])

  const nodes: GraphNode[] = [
    ...memRows.map((r): GraphNode => ({ type: 'memory', id: r.id, label: truncate(r.content, 80), preview: truncate(r.content, 280), project: r.project, projectId: r.projectId, x: r.x, y: r.y, z: r.z, degree: r.degree })),
    ...docRows.map((r): GraphNode => ({ type: 'document', id: r.id, label: r.title ?? basename(r.path), preview: truncate(r.preview, 280) || undefined, project: r.project, projectId: r.projectId, x: r.x, y: r.y, z: r.z, degree: r.degree })),
    ...imgRows.map((r): GraphNode => ({ type: 'image', id: r.id, label: r.originalName ?? 'image', preview: r.summary ? truncate(r.summary, 280) : undefined, project: null, projectId: null, x: r.x, y: r.y, z: r.z, degree: r.degree })),
    ...sessRows.map((r): GraphNode => ({ type: 'session', id: r.id, label: r.title ?? 'session', preview: r.summary ? truncate(r.summary, 280) : undefined, project: r.project, projectId: r.projectId, x: r.x, y: r.y, z: r.z, degree: r.degree })),
    ...projRows.map((r): GraphNode => ({ type: 'project', id: r.id, label: r.slug, preview: r.name || undefined, project: r.slug, projectId: r.id, x: r.x, y: r.y, z: r.z, degree: r.degree }))
  ]

  // Edge source rows — pulled from live rows only so we don't build edges into
  // soft-deleted nodes. Images carry no project column, so they never join a hub.
  const [memMem, docMem, sessMem, prov, ocrRows, relRows] = await Promise.all([
    db.select({ id: memories.id, projectId: memories.projectId }).from(memories).where(and(isNull(memories.archivedAt), isNotNull(memories.projectId))),
    db.select({ id: documents.id, projectId: documents.projectId }).from(documents).where(and(isNull(documents.deletedAt), isNotNull(documents.projectId))),
    db.select({ id: sessions.id, projectId: sessions.projectId }).from(sessions).where(isNotNull(sessions.projectId)),
    db.select({ memoryId: memories.id, sessionId: memories.sessionId }).from(memories).where(and(isNull(memories.archivedAt), isNotNull(memories.sessionId))),
    db.select({ documentId: documents.id, imageId: documents.ocrId }).from(documents).where(and(isNull(documents.deletedAt), isNotNull(documents.ocrId))),
    db.select({ fromId: memoryRelations.fromId, toId: memoryRelations.toId, type: memoryRelations.type }).from(memoryRelations).where(and(eq(memoryRelations.status, 'active'), inArray(memoryRelations.type, ['supersedes', 'contradicts'])))
  ])

  const allEdges = assembleEdges({
    memberships: [
      ...memMem.map((r) => ({ type: 'memory' as const, id: r.id, projectId: r.projectId })),
      ...docMem.map((r) => ({ type: 'document' as const, id: r.id, projectId: r.projectId })),
      ...sessMem.map((r) => ({ type: 'session' as const, id: r.id, projectId: r.projectId }))
    ],
    provenance: prov.map((r) => ({ memoryId: r.memoryId, sessionId: r.sessionId })),
    ocr: ocrRows.map((r) => ({ documentId: r.documentId, imageId: r.imageId! })),
    relations: relRows.map((r) => ({ fromId: r.fromId, toId: r.toId, type: r.type as 'supersedes' | 'contradicts' }))
  })

  // Keep only edges whose endpoints are both in the rendered node set.
  const nodeKeys = new Set(nodes.map((n) => `${n.type}:${n.id}`))
  const edges = allEdges.filter((e) => nodeKeys.has(`${e.from.type}:${e.from.id}`) && nodeKeys.has(`${e.to.type}:${e.to.id}`))

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// getNeighbors — nearest nodes to a given node by its own stored vector
// ---------------------------------------------------------------------------

/** Load the source vector for a node. Documents mean-pool their chunk vectors. */
async function loadNodeVector(type: GraphNodeType, id: string): Promise<number[] | null> {
  const db = useDb()
  switch (type) {
    case 'memory': {
      const [r] = await db.select({ embedding: memories.embedding }).from(memories).where(and(eq(memories.id, id), isNull(memories.archivedAt))).limit(1)
      return r?.embedding ?? null
    }
    case 'image': {
      const [r] = await db.select({ embedding: images.embedding }).from(images).where(and(eq(images.id, id), isNull(images.deletedAt))).limit(1)
      return r?.embedding ?? null
    }
    case 'session': {
      const [r] = await db.select({ embedding: sessions.summaryEmbedding }).from(sessions).where(eq(sessions.id, id)).limit(1)
      return r?.embedding ?? null
    }
    case 'document': {
      const rows = await db.select({ embedding: chunks.embedding }).from(chunks).where(and(eq(chunks.sourceType, 'document'), eq(chunks.sourceId, id)))
      const vecs = rows.map((r) => r.embedding).filter((v): v is number[] => Array.isArray(v) && v.length > 0)
      return vecs.length ? meanPool(vecs) : null
    }
    case 'project':
      // Projects are hub nodes with no vector — no semantic neighbors.
      return null
  }
}

/**
 * Return the top-k semantically nearest nodes to a given node, searching across
 * every vector-bearing node type (memory / image / session / document). The
 * source node uses its OWN stored vector (mean-pooled chunk vectors for a
 * document); the node itself is excluded from the results. Raw vectors never
 * leave this module — only `{ type, id, label, score }` is returned.
 */
export async function getNeighbors(type: GraphNodeType, id: string, k: number): Promise<GraphNeighbor[]> {
  if (k <= 0) return []
  const db = useDb()

  const vec = await loadNodeVector(type, id)
  if (!vec || vec.length === 0) return []
  const lit = `[${vec.join(',')}]`

  type Cand = { type: GraphNodeType; id: string; label: string; distance: number }

  const [memHits, imgHits, sessHits, docChunkHits] = await Promise.all([
    db.select({ id: memories.id, content: memories.content, distance: sql<number>`${memories.embedding} <=> ${lit}::halfvec` })
      .from(memories)
      .where(and(isNull(memories.archivedAt), isNotNull(memories.embedding), type === 'memory' ? ne(memories.id, id) : undefined))
      .orderBy(sql`${memories.embedding} <=> ${lit}::halfvec`)
      .limit(k),
    db.select({ id: images.id, originalName: images.originalName, distance: sql<number>`${images.embedding} <=> ${lit}::halfvec` })
      .from(images)
      .where(and(isNull(images.deletedAt), isNotNull(images.embedding), type === 'image' ? ne(images.id, id) : undefined))
      .orderBy(sql`${images.embedding} <=> ${lit}::halfvec`)
      .limit(k),
    db.select({ id: sessions.id, title: sessions.title, distance: sql<number>`${sessions.summaryEmbedding} <=> ${lit}::halfvec` })
      .from(sessions)
      .where(and(isNotNull(sessions.summaryEmbedding), type === 'session' ? ne(sessions.id, id) : undefined))
      .orderBy(sql`${sessions.summaryEmbedding} <=> ${lit}::halfvec`)
      .limit(k),
    db.select({ sourceId: chunks.sourceId, title: documents.title, path: documents.path, distance: sql<number>`${chunks.embedding} <=> ${lit}::halfvec` })
      .from(chunks)
      .innerJoin(documents, eq(chunks.sourceId, documents.id))
      .where(and(eq(chunks.sourceType, 'document'), isNotNull(chunks.embedding), isNull(documents.deletedAt), type === 'document' ? ne(documents.id, id) : undefined))
      .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
      .limit(k * 4)
  ])

  // Collapse chunk hits to the best (nearest) chunk per document.
  const docBest = new Map<string, Cand>()
  for (const r of docChunkHits) {
    if (!docBest.has(r.sourceId)) docBest.set(r.sourceId, { type: 'document', id: r.sourceId, label: r.title ?? basename(r.path), distance: r.distance })
  }

  const candidates: Cand[] = [
    ...memHits.map((r): Cand => ({ type: 'memory', id: r.id, label: truncate(r.content, 80), distance: r.distance })),
    ...imgHits.map((r): Cand => ({ type: 'image', id: r.id, label: r.originalName ?? 'image', distance: r.distance })),
    ...sessHits.map((r): Cand => ({ type: 'session', id: r.id, label: r.title ?? 'session', distance: r.distance })),
    ...docBest.values()
  ]

  return candidates
    .filter((c) => !(c.type === type && c.id === id)) // defensive self-exclusion
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k)
    .map((c) => ({ type: c.type, id: c.id, label: c.label, score: Math.round((1 - c.distance) * 1000) / 1000 }))
}
