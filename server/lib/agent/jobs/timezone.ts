// server/lib/agent/jobs/timezone.ts
// Resolves the default timezone a job uses when its frontmatter omits `timezone` (spec §3):
// the `agent_timezone` setting row if Tony has set one, else the server process's own
// Intl-resolved IANA zone. Never `process.env.TZ` (see schedule.ts's `at`-resolution comments
// for why: it isn't guaranteed to reflect what Intl actually uses).
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { settings } from '../../../db/schema'

export const AGENT_TIMEZONE_SETTING_KEY = 'agent_timezone'

export async function getDefaultTimezone(): Promise<string> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_TIMEZONE_SETTING_KEY)).limit(1)
  if (row && typeof row.value === 'string' && row.value.trim()) return row.value
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
