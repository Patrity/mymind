import { z } from 'zod'
import { updateProject } from '../../services/projects'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
  color: z.string().nullable().optional(),
  repositoryUrl: z.string().nullable().optional(),
  productionUrl: z.string().nullable().optional(),
  stagingUrl: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
  slug: z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug').optional()
})

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const body = Body.parse(await readBody(event))

  let project
  try {
    project = await updateProject(slug, body)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('already exists')) {
      throw createError({ statusCode: 409, statusMessage: 'Project slug already exists' })
    }
    throw err
  }

  if (!project) throw createError({ statusCode: 404 })

  publishChange({ resource: 'project', action: 'updated', id: project.slug })

  // When the slug changed, additionally emit for downstream resources so their
  // list queries refetch cross-tab (sessions/tasks/memories are indexed by slug).
  if (body.slug && body.slug !== slug) {
    publishChange({ resource: 'session', action: 'updated', id: project.slug })
    publishChange({ resource: 'task', action: 'updated', id: project.slug })
    publishChange({ resource: 'memory', action: 'updated', id: project.slug })
  }

  return project
})
