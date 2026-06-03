import { and, asc, eq, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { tasks } from '../db/schema'
import type { TaskDTO, TaskStatus, TaskPriority } from '../../shared/types/tasks'

// ---------------------------------------------------------------------------
// Pure helper — exported for TDD
// ---------------------------------------------------------------------------

/** Returns `now` when transitioning to 'completed', null for all other statuses. */
export function completedAtFor(status: TaskStatus, now: Date): Date | null {
  return status === 'completed' ? now : null
}

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

function toDTO(r: typeof tasks.$inferSelect): TaskDTO {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as TaskStatus,
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

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function listTasks(filter: { status?: string; project?: string } = {}): Promise<TaskDTO[]> {
  const db = useDb()
  const conditions = [live()]
  if (filter.status) conditions.push(eq(tasks.status, filter.status))
  if (filter.project) conditions.push(eq(tasks.project, filter.project))

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.order), asc(tasks.createdAt))

  return rows.map(toDTO)
}

export async function getTask(id: string): Promise<TaskDTO | null> {
  const [r] = await useDb()
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), live()))
    .limit(1)
  return r ? toDTO(r) : null
}

export interface CreateTaskInput {
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  dueDate?: Date | null
  project?: string | null
  order?: number
}

export async function createTask(input: CreateTaskInput): Promise<TaskDTO> {
  const status: TaskStatus = input.status ?? 'todo'
  const now = new Date()
  const rows = await useDb()
    .insert(tasks)
    .values({
      title: input.title,
      description: input.description ?? '',
      status,
      priority: input.priority ?? 'low',
      dueDate: input.dueDate ?? null,
      project: input.project ?? null,
      order: input.order ?? 0,
      completedAt: completedAtFor(status, now)
    })
    .returning()
  return toDTO(rows[0]!)
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
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

  if (patch.status !== undefined) {
    update.status = patch.status
    update.completedAt = completedAtFor(patch.status, now)
  }

  const [r] = await useDb()
    .update(tasks)
    .set(update as Partial<typeof tasks.$inferInsert>)
    .where(and(eq(tasks.id, id), live()))
    .returning()
  return r ? toDTO(r) : null
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
