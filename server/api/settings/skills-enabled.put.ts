import { z } from 'zod'
import { setSkillsEnabled } from '../../lib/agent/skills-config'

const Body = z.object({ enabled: z.boolean() })

export default defineEventHandler(async (event) => {
  const { enabled } = Body.parse(await readBody(event))
  await setSkillsEnabled(enabled)
  return { enabled }
})
