import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { searchMemories, createMemory, listMemories } from '../../services/memory'
import { searchDocs } from '../../services/documents'
import { listProjects, createProject, updateProject } from '../../services/projects'
import { createTask, listTasks, updateTask } from '../../services/tasks'

export function buildMcpServer() {
  const server = new McpServer({ name: 'mymind', version: '1.0.0' })

  // -------------------------------------------------------------------------
  // Memory tools
  // -------------------------------------------------------------------------

  server.tool(
    'search_memories',
    'Semantic + keyword search over stored memories',
    {
      query: z.string().describe('Search query'),
      scope: z.enum(['user', 'agent', 'world']).optional().describe('Memory scope filter'),
      project: z.string().optional().describe('Project slug filter'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)')
    },
    async (args) => {
      const res = await searchMemories(args.query, {
        scope: args.scope,
        project: args.project,
        limit: args.limit
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  server.tool(
    'save_memory',
    'Store a new memory (with deduplication)',
    {
      content: z.string().max(20_000).describe('Memory content to store'),
      scope: z.enum(['user', 'agent', 'world']).describe('Memory scope'),
      project: z.string().optional().describe('Associated project slug'),
      tags: z.array(z.string()).optional().describe('Tags for the memory'),
      source: z.string().optional().describe('Source identifier (e.g. session ID, tool name)')
    },
    async (args) => {
      const res = await createMemory({
        content: args.content,
        scope: args.scope,
        project: args.project ?? null,
        tags: args.tags,
        source: args.source
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  server.tool(
    'get_recent_memories',
    'List recent memories, optionally filtered by scope',
    {
      scope: z.enum(['user', 'agent', 'world']).optional().describe('Memory scope filter'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)')
    },
    async (args) => {
      const res = await listMemories({ scope: args.scope, limit: args.limit ?? 20 })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  // -------------------------------------------------------------------------
  // Documents tools
  // -------------------------------------------------------------------------

  server.tool(
    'search_docs',
    'Semantic + keyword search over stored documents',
    {
      query: z.string().describe('Search query')
    },
    async (args) => {
      const res = await searchDocs(args.query)
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  // -------------------------------------------------------------------------
  // Project tools
  // -------------------------------------------------------------------------

  server.tool(
    'search_projects',
    'List all projects, optionally filtered to active only',
    {
      activeOnly: z.boolean().optional().describe('When true, return only active projects')
    },
    async (args) => {
      const res = await listProjects({ activeOnly: args.activeOnly ?? false })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  server.tool(
    'create_project',
    'Create a new project',
    {
      name: z.string().min(1).describe('Project name'),
      description: z.string().optional().describe('Project description')
    },
    async (args) => {
      const res = await createProject({ name: args.name, description: args.description })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  server.tool(
    'edit_project',
    'Update an existing project',
    {
      slug: z.string().describe('Project slug'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      active: z.boolean().optional().describe('Set active/inactive')
    },
    async (args) => {
      const { slug, ...patch } = args
      const res = await updateProject(slug, patch)
      if (!res) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project not found', slug }) }] }
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  // -------------------------------------------------------------------------
  // Task tools
  // -------------------------------------------------------------------------

  server.tool(
    'create_task',
    'Create a new task',
    {
      title: z.string().min(1).max(500).describe('Task title'),
      description: z.string().max(20_000).optional().describe('Task description'),
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional().describe('Initial status (default: todo)'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority (default: low)'),
      project: z.string().optional().describe('Project slug'),
      dueDate: z.string().optional().describe('Due date (ISO 8601)')
    },
    async (args) => {
      const dueDate = args.dueDate ? new Date(args.dueDate) : undefined
      const res = await createTask({
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        project: args.project ?? null,
        dueDate
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  server.tool(
    'search_tasks',
    'List tasks, optionally filtered by status or project',
    {
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional().describe('Status filter'),
      project: z.string().optional().describe('Project slug filter')
    },
    async (args) => {
      const res = await listTasks({ status: args.status, project: args.project })
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  server.tool(
    'edit_task',
    'Update an existing task',
    {
      id: z.string().describe('Task ID'),
      title: z.string().max(500).optional().describe('New title'),
      description: z.string().max(20_000).optional().describe('New description'),
      status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional().describe('New status'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('New priority'),
      project: z.string().optional().describe('New project slug'),
      dueDate: z.string().optional().describe('New due date (ISO 8601)')
    },
    async (args) => {
      const { id, dueDate: dueDateStr, ...rest } = args
      const dueDate = dueDateStr ? new Date(dueDateStr) : undefined
      const res = await updateTask(id, { ...rest, dueDate })
      if (!res) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Task not found', id }) }] }
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    }
  )

  return server
}
