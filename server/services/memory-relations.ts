import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { memoryRelations } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { registerUndo } from '../lib/agent/undo'

/** Relation types a user can manually draw between two memories. */
export type MemoryRelationType = 'supersedes' | 'contradicts'

const VALID_TYPES: readonly MemoryRelationType[] = ['supersedes', 'contradicts']

export interface RelationInput {
  fromId: string
  toId: string
  type: MemoryRelationType
}

// ---------------------------------------------------------------------------
// Pure validation (exported for tests)
// ---------------------------------------------------------------------------

/** Rejects self-links and unknown relation types. Pure — no I/O. */
export function validateRelationInput(input: { fromId: string, toId: string, type: string }): RelationInput {
  if (input.fromId === input.toId) {
    throw new Error('a memory cannot be related to itself')
  }
  if (!VALID_TYPES.includes(input.type as MemoryRelationType)) {
    throw new Error(`unknown relation type: ${input.type}`)
  }
  return { fromId: input.fromId, toId: input.toId, type: input.type as MemoryRelationType }
}

// ---------------------------------------------------------------------------
// Create / delete (manual edges — reason 'manual', confidence left null)
// ---------------------------------------------------------------------------

/**
 * Draw a manual supersede/contradict edge between two memories.
 * Idempotent (onConflictDoNothing on the (fromId,toId,type) unique index): if the edge
 * already existed, nothing was inserted — return `{ created: false }` without publishing
 * a live event or registering an undo (there is nothing to refetch or undo).
 */
export async function createMemoryRelation(fromId: string, toId: string, type: MemoryRelationType): Promise<{ created: true, undoToken: string } | { created: false }> {
  const input = validateRelationInput({ fromId, toId, type })
  const db = useDb()

  const [inserted] = await db.insert(memoryRelations)
    .values({ fromId: input.fromId, toId: input.toId, type: input.type, status: 'active', reason: 'manual' })
    .onConflictDoNothing()
    .returning()

  if (!inserted) return { created: false }

  publishChange({ resource: 'graph', action: 'updated', id: input.fromId })

  const relationId = inserted.id
  const undoToken = registerUndo(async () => {
    await db.delete(memoryRelations).where(eq(memoryRelations.id, relationId))
    publishChange({ resource: 'graph', action: 'updated', id: input.fromId })
  })

  return { created: true, undoToken }
}

/**
 * Remove a memory relation edge by id.
 * Undo re-inserts the same edge (onConflictDoNothing guards a double-undo race).
 */
export async function deleteMemoryRelation(id: string): Promise<{ undoToken: string }> {
  const db = useDb()

  const [existing] = await db.select().from(memoryRelations)
    .where(eq(memoryRelations.id, id)).limit(1)
  if (!existing) throw new Error('memory relation not found')

  await db.delete(memoryRelations).where(eq(memoryRelations.id, id))
  publishChange({ resource: 'graph', action: 'updated', id: existing.fromId })

  const undoToken = registerUndo(async () => {
    await db.insert(memoryRelations).values({
      fromId: existing.fromId,
      toId: existing.toId,
      type: existing.type,
      confidence: existing.confidence,
      status: existing.status,
      reason: existing.reason
    }).onConflictDoNothing()
    publishChange({ resource: 'graph', action: 'updated', id: existing.fromId })
  })

  return { undoToken }
}
