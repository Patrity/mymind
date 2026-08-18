import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { taskColumns, tasks } from '../db/schema'
import { deleteTask } from './tasks'
import { publishChange } from '../utils/live-bus'
import type { TaskColumnDTO, TaskColumnKind, TaskColumnColor } from '../../shared/types/task-columns'

// Every publishChange call below deliberately uses `resource: 'task'`, NOT a dedicated
// `taskColumn` member of ResourceName. `task` already invalidates the board and the Home
// panel (app/utils/live-dispatch.ts) — the entire audience for a column change, since columns
// only ever render as part of the task board. Adding a `taskColumn` union member would require
// a matching live-dispatch.ts entry (ResourceName is exhaustively keyed there; omitting one is
// a type error) for no additional reach. Do not "fix" this by adding one — if a future surface
// needs column-only invalidation (independent of the task board), add the member then.

function toDTO(r: typeof taskColumns.$inferSelect): TaskColumnDTO {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as TaskColumnKind,
    color: r.color as TaskColumnColor,
    position: r.position,
    isDefault: r.isDefault
  }
}

export async function listColumns(): Promise<TaskColumnDTO[]> {
  const rows = await useDb().select().from(taskColumns).orderBy(asc(taskColumns.position))
  return rows.map(toDTO)
}

export async function defaultColumnFor(kind: TaskColumnKind): Promise<TaskColumnDTO> {
  const [row] = await useDb()
    .select()
    .from(taskColumns)
    .where(and(eq(taskColumns.kind, kind), eq(taskColumns.isDefault, true)))
    .limit(1)
  // Throw rather than defaulting: this is the compat seam's resolution point for
  // status -> column. A silent fallback would file a task into the wrong column, or into no
  // column at all, and the FK on tasks.column_id would reject that anyway.
  if (!row) throw new Error(`no default task_columns row for kind "${kind}"`)
  return toDTO(row)
}

export interface CreateColumnInput {
  name: string
  kind: TaskColumnKind
  color: TaskColumnColor
  position?: number
}

export async function createColumn(input: CreateColumnInput): Promise<TaskColumnDTO> {
  const db = useDb()
  let position = input.position
  if (position === undefined) {
    const [row] = await db
      .select({ max: sql<number>`coalesce(max(${taskColumns.position}), -1)` })
      .from(taskColumns)
    position = (row?.max ?? -1) + 1
  }
  const [created] = await db
    .insert(taskColumns)
    .values({ name: input.name, kind: input.kind, color: input.color, position })
    .returning()
  publishChange({ resource: 'task', action: 'updated', id: created!.id })
  return toDTO(created!)
}

export interface UpdateColumnInput {
  name?: string
  color?: TaskColumnColor
}

export async function updateColumn(id: string, patch: UpdateColumnInput): Promise<TaskColumnDTO> {
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) update.name = patch.name
  if (patch.color !== undefined) update.color = patch.color

  const [row] = await useDb()
    .update(taskColumns)
    .set(update as Partial<typeof taskColumns.$inferInsert>)
    .where(eq(taskColumns.id, id))
    .returning()
  if (!row) throw new Error(`no such column: ${id}`)
  publishChange({ resource: 'task', action: 'updated', id })
  return toDTO(row)
}

export async function reorderColumns(idsInOrder: string[]): Promise<void> {
  const db = useDb()
  for (let i = 0; i < idsInOrder.length; i++) {
    await db.update(taskColumns).set({ position: i }).where(eq(taskColumns.id, idsInOrder[i]!))
    publishChange({ resource: 'task', action: 'updated', id: idsInOrder[i]! })
  }
}

export interface DeleteColumnResult {
  ok: boolean
  reason?: string
  affected: number
}

export async function deleteColumn(
  id: string,
  opts: { mode: 'delete' | 'reassign', targetColumnId?: string }
): Promise<DeleteColumnResult> {
  const db = useDb()
  const [col] = await db.select().from(taskColumns).where(eq(taskColumns.id, id)).limit(1)
  if (!col) return { ok: false, reason: 'that column no longer exists', affected: 0 }

  // The last column of a kind can never be deleted, whatever happens to its cards: with no
  // `done` column, create_task(status='completed') has nothing to resolve to and
  // search_tasks(status='completed') silently returns nothing. Renaming is always available.
  const siblings = await db
    .select({ id: taskColumns.id })
    .from(taskColumns)
    .where(and(eq(taskColumns.kind, col.kind), ne(taskColumns.id, id)))
  if (siblings.length === 0) {
    return {
      ok: false,
      reason: `"${col.name}" is the only ${col.kind} column — rename it instead of deleting it`,
      affected: 0
    }
  }

  let affected = 0

  if (opts.mode === 'reassign') {
    const targetId = opts.targetColumnId
    if (!targetId || targetId === id) {
      return { ok: false, reason: 'choose a different column to move these cards to', affected: 0 }
    }
    const [target] = await db.select({ id: taskColumns.id }).from(taskColumns)
      .where(eq(taskColumns.id, targetId)).limit(1)
    if (!target) return { ok: false, reason: 'that target column no longer exists', affected: 0 }

    const moved = await db.update(tasks)
      .set({ columnId: targetId, updatedAt: new Date() })
      .where(and(eq(tasks.columnId, id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id })
    affected = moved.length

    // A card that was already soft-deleted before this call still carries column_id = id, and
    // tasks_column_id_task_columns_id_fk is ON DELETE NO ACTION — the DELETE below would fail
    // with a live FK violation if any row, live or dead, still points here. Repoint the
    // stragglers too; they don't count toward `affected` since nothing user-visible moved.
    await db.update(tasks).set({ columnId: targetId }).where(eq(tasks.columnId, id))
  } else {
    const liveCards = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.columnId, id), isNull(tasks.deletedAt)))
    for (const card of liveCards) await deleteTask(card.id)
    affected = liveCards.length

    // Same FK constraint as above: deleteTask sets deleted_at but leaves column_id pointing at
    // the column we're about to drop. Repoint every remaining reference (the ones just
    // soft-deleted, plus any historical strays) to a sibling of the same kind before deleting.
    await db.update(tasks).set({ columnId: siblings[0]!.id }).where(eq(tasks.columnId, id))
  }

  await db.delete(taskColumns).where(eq(taskColumns.id, id))
  publishChange({ resource: 'task', action: 'updated', id })
  return { ok: true, affected }
}
