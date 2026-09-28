// PUT /api/settings/agent-timezone { timezone: string | null } — sets (IANA zone) or clears the
// `agent_timezone` setting, then re-derives every job that does not name its own `timezone:`
// (their stored zone and next run), so a change reaches already-saved jobs at once.
import { z } from 'zod'
import { isValidTimezone } from '../../lib/agent/jobs/parse'
import { rederiveDefaultTimezone } from '../../lib/agent/jobs/store'
import { getAgentTimezoneSetting, getDefaultTimezone, serverTimezone, setAgentTimezoneSetting } from '../../lib/agent/jobs/timezone'

const Body = z.object({ timezone: z.string().trim().min(1).nullable() })

export default defineEventHandler(async (event) => {
  let timezone: string | null
  try {
    ({ timezone } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  if (timezone !== null && !isValidTimezone(timezone)) {
    throw createError({ statusCode: 400, statusMessage: `not a valid IANA timezone: ${timezone}` })
  }
  await setAgentTimezoneSetting(timezone)
  const rederived = await rederiveDefaultTimezone()
  return {
    timezone: await getAgentTimezoneSetting(),
    effective: await getDefaultTimezone(),
    server: serverTimezone(),
    rederived
  }
})
