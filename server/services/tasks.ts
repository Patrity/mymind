import { and, asc, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { tasks, taskColumns } from '../db/schema'
import { kindForStatus, statusForKind } from '../lib/tasks/status-kind'
import { defaultColumnFor } from './task-columns'
import type { TaskDTO, TaskStatus, TaskPriority } from '../../shared/types/tasks'
import type { TaskColumnKind } from '../../shared/types/task-columns'
import type { TaskSummaryDTO } from '../../shared/types/summaries'

// ---------------------------------------------------------------------------
// Pure helper — exported for TDD
// ---------------------------------------------------------------------------

/** Returns `now` when transitioning into ANY done-kind column, null otherwise. */
export function completedAtFor(kind: TaskColumnKind, now: Date): Date | null {
  return kind === 'done' ? now : null
}

// ---------------------------------------------------------------------------
// Column resolution — the compat seam between the legacy `status` field and columns
// ---------------------------------------------------------------------------

/**
 * Resolves the target column (id + kind) for a create/update: an explicit `columnId` always
 * wins; otherwise the default column for the kind implied by `status`; otherwise the default
 * open column. The kind is returned alongside the id because every caller needs it right away
 * — to dual-write `tasks.status` (`statusForKind`) and to compute `completedAt`
 * (`completedAtFor`).
 */
async function resolveColumn(
  input: { columnId?: string; status?: TaskStatus }
): Promise<{ id: string; kind: TaskColumnKind }> {
  if (input.columnId) {
    const [row] = await useDb()
      .select({ id: taskColumns.id, kind: taskColumns.kind })
      .from(taskColumns)
      .where(eq(taskColumns.id, input.columnId))
      .limit(1)
    if (!row) throw new Error(`no such task_columns row: ${input.columnId}`)
    return { id: row.id, kind: row.kind as TaskColumnKind }
  }
  const kind = input.status ? kindForStatus(input.status) : 'open'
  const column = await defaultColumnFor(kind)
  return { id: column.id, kind: column.kind }
}

async function kindForColumnId(columnId: string): Promise<TaskColumnKind> {
  const [row] = await useDb()
    .select({ kind: taskColumns.kind })
    .from(taskColumns)
    .where(eq(taskColumns.id, columnId))
    .limit(1)
  if (!row) throw new Error(`no such task_columns row: ${columnId}`)
  return row.kind as TaskColumnKind
}

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

// `status` is DERIVED from the joined column's kind, not read off `tasks.status` — that shadow
// column exists only as a rollback target (dual-written below) and reads must not trust it.
function toDTO(r: typeof tasks.$inferSelect & { columnKind: string }): TaskDTO {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: statusForKind(r.columnKind as TaskColumnKind),
    columnId: r.columnId,
    priority: r.priority as TaskPriority,
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    project: r.project ?? null,
    order: r.order,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null
  }
}

const live = () => isNull(tasks.deletedAt)

// Every task row read for a DTO must carry its column's kind — see toDTO above.
const TASK_SELECT_WITH_KIND = () => ({ ...getTableColumns(tasks), columnKind: taskColumns.kind })

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function listTasks(filter: { status?: string; project?: string } = {}): Promise<TaskDTO[]> {
  const db = useDb()
  const conditions = [live()]
  if (filter.status) conditions.push(eq(tasks.status, filter.status))
  if (filter.project) conditions.push(eq(tasks.project, filter.project))

  const rows = await db
    .select(TASK_SELECT_WITH_KIND())
    .from(tasks)
    .innerJoin(taskColumns, eq(tasks.columnId, taskColumns.id))
    .where(and(...conditions))
    .orderBy(asc(tasks.order), asc(tasks.createdAt))

  return rows.map(toDTO)
}

const TASK_SUMMARY_COLUMNS = {
  id: tasks.id, title: tasks.title, status: tasks.status, priority: tasks.priority,
  project: tasks.project, dueDate: tasks.dueDate, updatedAt: tasks.updatedAt
}

/**
 * Body-free projection for the agent read tools. Exported for unit testing.
 * Deliberately NOT `toDTO` minus a field — selecting fewer columns means Postgres never
 * ships the descriptions either. `dueDate` is a `timestamp` column (see schema/tasks.ts),
 * hence `.toISOString()`. Reads `tasks.status` directly (not the column join): every write
 * dual-writes it, so it's accurate, and this projection is intentionally join-free/cheap.
 */
export function toTaskSummaryDTO(r: {
  id: string, title: string, status: string, priority: string,
  project: string | null, dueDate: Date | null, updatedAt: Date
}): TaskSummaryDTO {
  return {
    id: r.id, title: r.title, status: r.status, priority: r.priority,
    project: r.project,
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    updatedAt: r.updatedAt.toISOString()
  }
}

export async function listTasksSummary(
  opts: { status?: string, project?: string, limit: number, offset: number }
): Promise<TaskSummaryDTO[]> {
  const conditions = [live()]
  if (opts.status) conditions.push(eq(tasks.status, opts.status))
  if (opts.project) conditions.push(eq(tasks.project, opts.project))
  const rows = await useDb().select(TASK_SUMMARY_COLUMNS).from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.order), asc(tasks.createdAt))
    .limit(opts.limit).offset(opts.offset)
  return rows.map(toTaskSummaryDTO)
}

export async function countTasks(opts: { status?: string, project?: string } = {}): Promise<number> {
  const conditions = [live()]
  if (opts.status) conditions.push(eq(tasks.status, opts.status))
  if (opts.project) conditions.push(eq(tasks.project, opts.project))
  const [row] = await useDb().select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(...conditions))
  return row?.n ?? 0
}

export async function getTask(id: string): Promise<TaskDTO | null> {
  const [r] = await useDb()
    .select(TASK_SELECT_WITH_KIND())
    .from(tasks)
    .innerJoin(taskColumns, eq(tasks.columnId, taskColumns.id))
    .where(and(eq(tasks.id, id), live()))
    .limit(1)
  return r ? toDTO(r) : null
}

export interface CreateTaskInput {
  title: string
  description?: string
  status?: TaskStatus
  columnId?: string
  priority?: TaskPriority
  dueDate?: Date | null
  project?: string | null
  order?: number
}

export async function createTask(input: CreateTaskInput): Promise<TaskDTO> {
  const now = new Date()
  const column = await resolveColumn({ columnId: input.columnId, status: input.status })
  const rows = await useDb()
    .insert(tasks)
    .values({
      title: input.title,
      description: input.description ?? '',
      status: statusForKind(column.kind), // dual-write: rollback target until Task 10
      columnId: column.id,
      priority: input.priority ?? 'low',
      dueDate: input.dueDate ?? null,
      project: input.project ?? null,
      order: input.order ?? 0,
      completedAt: completedAtFor(column.kind, now)
    })
    .returning()
  return toDTO({ ...rows[0]!, columnKind: column.kind })
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
  columnId?: string
  priority?: TaskPriority
  dueDate?: Date | null
  project?: string | null
  order?: number
}

export async function updateTask(id: string, patch: UpdateTaskInput): Promise<TaskDTO | null> {
  const now = new Date()
  const update: Record<string, unknown> = { updatedAt: now }

  if (patch.title !== undefined) update.title = patch.title
  if (patch.description !== undefined) update.description = patch.description
  if (patch.priority !== undefined) update.priority = patch.priority
  if (patch.dueDate !== undefined) update.dueDate = patch.dueDate
  if (patch.project !== undefined) update.project = patch.project
  if (patch.order !== undefined) update.order = patch.order

  let resolvedKind: TaskColumnKind | undefined
  if (patch.columnId !== undefined || patch.status !== undefined) {
    const column = await resolveColumn({ columnId: patch.columnId, status: patch.status })
    update.columnId = column.id
    update.status = statusForKind(column.kind) // dual-write: rollback target until Task 10
    update.completedAt = completedAtFor(column.kind, now)
    resolvedKind = column.kind
  }

  const [r] = await useDb()
    .update(tasks)
    .set(update as Partial<typeof tasks.$inferInsert>)
    .where(and(eq(tasks.id, id), live()))
    .returning()
  if (!r) return null

  const kind = resolvedKind ?? await kindForColumnId(r.columnId)
  return toDTO({ ...r, columnKind: kind })
}

export async function moveTask(id: string, move: { status?: TaskStatus; order?: number }): Promise<TaskDTO | null> {
  return updateTask(id, move)
}

export async function deleteTask(id: string): Promise<boolean> {
  const [r] = await useDb()
    .update(tasks)
    .set({ deletedAt: new Date() })
    .where(and(eq(tasks.id, id), live()))
    .returning({ id: tasks.id })
  return !!r
}

export async function restoreTask(id: string): Promise<boolean> {
  const [r] = await useDb()
    .update(tasks)
    .set({ deletedAt: null })
    .where(eq(tasks.id, id))
    .returning({ id: tasks.id })
  return !!r
}
