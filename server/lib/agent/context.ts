// server/lib/agent/context.ts
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { useDb } from '../../db'
import { projects, tasks, taskColumns } from '../../db/schema'
import { statusForKind } from '../tasks/status-kind'
import type { TaskColumnKind } from '../../../shared/types/task-columns'

/**
 * Cheap live-state block injected into Bridget's prompt; rebuilt per turn.
 *
 * The open-task query filters on the joined column's `kind` ('open' | 'started') — there is
 * no `tasks.status` column anymore (cycle-58 Task 10 dropped it). It also excludes
 * soft-deleted rows (isNull(tasks.deletedAt)) — every other task reader does the same, and
 * deleteColumn's 'delete' mode can leave dead rows repointed at a live sibling column (the FK
 * is enforced against soft-deleted rows too), so without this filter a deleted column's cards
 * would get injected into every agent turn.
 */
export async function buildLiveContext(now: Date): Promise<string> {
  const db = useDb()
  const [activeProjects, openTasks] = await Promise.all([
    db.select({ name: projects.name }).from(projects).where(eq(projects.active, true)).orderBy(desc(projects.lastActivityAt)).limit(12),
    db.select({ title: tasks.title, project: tasks.project, kind: taskColumns.kind })
      .from(tasks)
      .innerJoin(taskColumns, eq(tasks.columnId, taskColumns.id))
      .where(and(inArray(taskColumns.kind, ['open', 'started']), isNull(tasks.deletedAt)))
      .orderBy(desc(tasks.updatedAt)).limit(10)
  ])
  const lines: string[] = []
  if (activeProjects.length) lines.push(`Active projects: ${activeProjects.map(p => p.name).join(', ')}.`)
  if (openTasks.length) {
    lines.push('Open tasks:', ...openTasks.map(t =>
      `- ${t.title}${t.project ? ` (${t.project})` : ''} [${statusForKind(t.kind as TaskColumnKind)}]`))
  }
  if (!lines.length) return ''
  return [`Current context (as of ${now.toISOString().slice(0, 10)}):`, ...lines].join('\n')
}
