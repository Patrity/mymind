import { getSkill, deleteSkill } from '@mymind/core/services/skills'

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const prior = await getSkill(name)
  if (!prior) throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
  // deleteSkill publishes the `agentSkill` live event itself (as every skills-service write does).
  await deleteSkill(name, { actor: 'human' })
  return { deleted: name }
})
