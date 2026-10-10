import { getSkillSource, listSkillRevisions } from '@mymind/core/services/skills'
import { requireSkillName } from '../../../utils/agent-config-http'

export default defineEventHandler(async (event) => {
  const name = requireSkillName(event)
  if (!(await getSkillSource(name))) {
    throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
  }
  return listSkillRevisions(name)
})
