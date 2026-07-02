// server/lib/agent/context.ts
import { desc, eq, inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { projects, tasks } from '../../db/schema'
import { searchMemories } from '../../services/memory'

/** Cheap live-state block injected into Bridget's prompt; rebuilt per turn. */
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

/**
 * Proactive per-turn memory injection: top relevant memories for the user's
 * message, so the agent "knows Tony" without depending on it choosing to call
 * search_memories. Best-effort and bounded — on error or slow search (>1.5s)
 * it returns '' and the turn proceeds without it. Never throws.
 */
export async function buildMemoryContext(
  userText: string,
  deps: { search?: typeof searchMemories } = {}
): Promise<string> {
  const q = userText.trim()
  if (!q) return ''
  try {
    const search = deps.search ?? searchMemories
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 1500))
    const found = await Promise.race([search(q, { limit: 5 }), timeout])
    if (!found?.length) return ''
    const rows = found.filter(m => (m.relevance ?? 0) >= 0.2).slice(0, 5)
    if (!rows.length) return ''
    return [
      'Possibly relevant memories (background — may be stale or off-target; verify before relying on them):',
      ...rows.map(m => `- ${m.content}`)
    ].join('\n')
  } catch {
    return ''
  }
}
