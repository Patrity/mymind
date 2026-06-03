import { deleteProject } from '../../services/projects'

export default defineEventHandler(async (event) => {
  const ok = await deleteProject(getRouterParam(event, 'slug')!)
  if (!ok) throw createError({ statusCode: 404 })
  return { ok: true }
})
