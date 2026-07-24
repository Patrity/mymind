import { getSkill, deleteSkill } from '../../services/skills'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const prior = await getSkill(name)
  if (!prior) throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
  await deleteSkill(name)
  publishChange({ resource: 'document', action: 'deleted', id: prior.id })
  return { deleted: name }
})
