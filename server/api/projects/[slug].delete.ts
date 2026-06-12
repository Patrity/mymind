import { deleteProject } from '../../services/projects'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const ok = await deleteProject(slug)
  if (!ok) throw createError({ statusCode: 404 })
  publishChange({ resource: 'project', action: 'deleted', id: slug })
  return { ok: true }
})
