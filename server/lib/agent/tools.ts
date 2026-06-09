// server/lib/agent/tools.ts
import { z } from 'zod'
import type { AgentTool } from './types'
import { searchMemories, createMemory, listMemories, archiveMemory } from '../../services/memory'
import { searchDocs, createDoc } from '../../services/documents'
import { listProjects, createProject, updateProject, getProject, deleteProject } from '../../services/projects'
import { createTask, listTasks, updateTask, getTask, deleteTask } from '../../services/tasks'
import { nanoid } from 'nanoid'

export const agentTools: AgentTool[] = [
  // ---- memory ----
  {
    name: 'search_memories',
    description: 'Semantic + keyword search over stored memories.',
    kind: 'read',
    schema: {
      query: z.string().describe('Search query'),
      scope: z.enum(['user', 'agent', 'world']).optional(),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    handler: async (a) => {
      const res = await searchMemories(a.query as string, {
        scope: a.scope as undefined, project: a.project as undefined, limit: a.limit as undefined
      })
      return { result: res, summary: `searched memories (${res.length})` }
    }
  },
  {
    name: 'get_recent_memories',
    description: 'List recent memories, optionally filtered by scope.',
    kind: 'read',
    schema: { scope: z.enum(['user', 'agent', 'world']).optional(), limit: z.number().int().min(1).max(100).optional() },
    handler: async (a) => {
      const res = await listMemories({ scope: a.scope as undefined, limit: (a.limit as number) ?? 20 })
      return { result: res, summary: `recent memories (${res.length})` }
    }
  },
  {
    name: 'save_memory',
    description: 'Store a new memory (with deduplication).',
    kind: 'create',
    schema: {
      content: z.string().max(20_000),
      scope: z.enum(['user', 'agent', 'world']),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional()
    },
    handler: async (a) => {
      const m = await createMemory({
        content: a.content as string, scope: a.scope as undefined,
        project: (a.project as string) ?? null, tags: a.tags as undefined, source: (a.source as string) ?? 'voice'
      })
      return {
        result: m,
        summary: `saved memory`,
        undo: async () => { await archiveMemory((m as { id: string }).id) }
      }
    }
  },
  // ---- documents ----
  {
    name: 'search_docs',
    description: 'Semantic + keyword search over stored documents.',
    kind: 'read',
    schema: { query: z.string().describe('Search query') },
    handler: async (a) => {
      const res = await searchDocs(a.query as string)
      return { result: res, summary: `searched docs (${Array.isArray(res) ? res.length : 0})` }
    }
  },
  // ---- projects ----
  {
    name: 'search_projects',
    description: 'List all projects, optionally active-only.',
    kind: 'read',
    schema: { activeOnly: z.boolean().optional() },
    handler: async (a) => {
      const res = await listProjects({ activeOnly: (a.activeOnly as boolean) ?? false })
      return { result: res, summary: `listed projects (${res.length})` }
    }
  },
  {
    name: 'create_project',
    description: 'Create a new project.',
    kind: 'create',
    schema: { name: z.string().min(1), description: z.string().optional() },
    handler: async (a) => {
      const p = await createProject({ name: a.name as string, description: a.description as undefined })
      return {
        result: p, summary: `created project "${(p as { name: string }).name}"`,
        undo: async () => { await deleteProject((p as { slug: string }).slug) }
      }
    }
  },
  {
    name: 'edit_project',
    description: 'Update an existing project. Confirm with the user before calling.',
    kind: 'destructive',
    schema: {
      slug: z.string(), name: z.string().optional(),
      description: z.string().optional(), active: z.boolean().optional()
    },
    handler: async (a) => {
      const slug = a.slug as string
      const prior = await getProject(slug)
      const { slug: _s, ...patch } = a
      const p = await updateProject(slug, patch as { name?: string; description?: string; active?: boolean })
      return {
        result: p ?? { error: 'not found', slug },
        summary: `updated project "${slug}"`,
        undo: prior ? async () => { await updateProject(slug, { name: prior.name, description: prior.description ?? undefined, active: prior.active }) } : undefined
      }
    }
  },
  // ---- tasks ----
  {
    name: 'search_tasks',
    description: 'List tasks, optionally filtered by status or project.',
    kind: 'read',
    schema: {
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
      project: z.string().optional()
    },
    handler: async (a) => {
      const res = await listTasks({ status: a.status as undefined, project: a.project as undefined })
      return { result: res, summary: `listed tasks (${res.length})` }
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task.',
    kind: 'create',
    schema: {
      title: z.string().min(1).max(500),
      description: z.string().max(20_000).optional(),
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      project: z.string().optional(),
      dueDate: z.string().optional()
    },
    handler: async (a) => {
      const t = await createTask({
        title: a.title as string, description: a.description as undefined,
        status: a.status as undefined, priority: a.priority as undefined,
        project: (a.project as string) ?? null,
        dueDate: a.dueDate ? new Date(a.dueDate as string) : undefined
      })
      return {
        result: t, summary: `added "${(t as { title: string }).title}" to ${(t as { status: string }).status}`,
        undo: async () => { await deleteTask((t as { id: string }).id) }
      }
    }
  },
  {
    name: 'edit_task',
    description: 'Update an existing task. Confirm with the user before calling.',
    kind: 'destructive',
    schema: {
      id: z.string(),
      title: z.string().max(500).optional(),
      description: z.string().max(20_000).optional(),
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      project: z.string().optional(),
      dueDate: z.string().optional()
    },
    handler: async (a) => {
      const id = a.id as string
      const prior = await getTask(id)
      const { id: _i, dueDate, ...rest } = a
      const t = await updateTask(id, { ...(rest as object), dueDate: dueDate ? new Date(dueDate as string) : undefined })
      return {
        result: t ?? { error: 'not found', id },
        summary: `updated task`,
        undo: prior ? async () => {
          await updateTask(id, {
            title: prior.title, description: prior.description ?? undefined,
            status: prior.status, priority: prior.priority,
            project: prior.project, dueDate: prior.dueDate ? new Date(prior.dueDate) : null
          })
        } : undefined
      }
    }
  },
  // ---- quick capture ----
  {
    name: 'quick_capture',
    description: 'Capture a quick note as a markdown document in /input.',
    kind: 'create',
    schema: { text: z.string().min(1), title: z.string().optional() },
    handler: async (a) => {
      const title = (a.title as string) ?? null
      const slug = title ? title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 64) || nanoid(8) : nanoid(10)
      const doc = await createDoc({ path: `/input/${slug}.md`, title, content: a.text as string }) as { id?: string; path?: string }
      return {
        result: doc, summary: `captured note${title ? ` "${title}"` : ''}`,
        // createDoc has no soft-delete service exposed here; undo is best-effort no-op marker.
        undo: undefined
      }
    }
  }
]

const byName = new Map(agentTools.map(t => [t.name, t]))
export function toolByName(name: string): AgentTool | undefined {
  return byName.get(name)
}
