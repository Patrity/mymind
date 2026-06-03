import { z } from 'zod'
import { updateProject } from '../../services/projects'

const Body = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  active: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const body = Body.parse(await readBody(event))

  const project = await updateProject(slug, body)

  if (!project) throw createError({ statusCode: 404 })
  return project
})
