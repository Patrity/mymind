import { z } from 'zod'
import { setSkillsEnabled } from '@mymind/core/lib/agent/skills-config'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

const Body = z.object({ enabled: z.boolean() })

export default defineEventHandler(async (event) => {
  let enabled: boolean
  try {
    ({ enabled } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  await setSkillsEnabled(enabled)
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('skills')
  return { enabled }
})
