import { getSkillSource } from '@mymind/core/services/skills'
import { requireSkillName } from '../../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const name = requireSkillName(event)
  const source = await getSkillSource(name)
  if (!source) throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
  return source
})
