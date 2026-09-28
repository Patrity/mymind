// GET /api/settings/agent-timezone — the zone jobs use when their file names none (cycle 74
// final review I5). `timezone` is the stored setting (null = unset), `effective` what jobs use
// right now, `server` the process's own zone (the fallback).
import { getAgentTimezoneSetting, getDefaultTimezone, serverTimezone } from '../../lib/agent/jobs/timezone'

export default defineEventHandler(async () => ({
  timezone: await getAgentTimezoneSetting(),
  effective: await getDefaultTimezone(),
  server: serverTimezone()
}))
