import { z } from 'zod'
import { createProject } from '../../services/projects'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  slug: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  try {
    const project = await createProject(body)
    publishChange({ resource: 'project', action: 'created', id: project.slug })
    return project
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('already exists')) {
      throw createError({ statusCode: 409, statusMessage: 'Project slug already exists' })
    }
    throw err
  }
})
