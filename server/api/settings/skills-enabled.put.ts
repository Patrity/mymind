import { z } from 'zod'
import { setSkillsEnabled } from '../../lib/agent/skills-config'

const Body = z.object({ enabled: z.boolean() })

export default defineEventHandler(async (event) => {
  let enabled: boolean
  try {
    ({ enabled } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  await setSkillsEnabled(enabled)
  return { enabled }
})
