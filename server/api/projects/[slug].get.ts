import { getProject } from '../../services/projects'

export default defineEventHandler(async (event) => {
  const project = await getProject(getRouterParam(event, 'slug')!)
  if (!project) throw createError({ statusCode: 404 })
  return project
})
