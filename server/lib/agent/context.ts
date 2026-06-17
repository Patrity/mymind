// server/lib/agent/context.ts
import { desc, eq, inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { projects, tasks } from '../../db/schema'

/** Cheap live-state block injected into Bridget's prompt; assembled once per connection. */
export async function buildLiveContext(now: Date): Promise<string> {
  const db = useDb()
  const [activeProjects, openTasks] = await Promise.all([
    db.select({ name: projects.name }).from(projects).where(eq(projects.active, true)).orderBy(desc(projects.lastActivityAt)).limit(12),
    db.select({ title: tasks.title, project: tasks.project, status: tasks.status }).from(tasks).where(inArray(tasks.status, ['todo', 'in_progress'])).orderBy(desc(tasks.updatedAt)).limit(10)
  ])
  const lines: string[] = []
  if (activeProjects.length) lines.push(`Active projects: ${activeProjects.map(p => p.name).join(', ')}.`)
  if (openTasks.length) lines.push('Open tasks:', ...openTasks.map(t => `- ${t.title}${t.project ? ` (${t.project})` : ''} [${t.status}]`))
  if (!lines.length) return ''
  return [`Current context (as of ${now.toISOString().slice(0, 10)}):`, ...lines].join('\n')
}
