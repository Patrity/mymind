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
  return serverTimezone()
}

/** The server process's own IANA zone — what jobs use when no `agent_timezone` is set. */
export function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The stored `agent_timezone` setting, or null when unset. */
export async function getAgentTimezoneSetting(): Promise<string | null> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_TIMEZONE_SETTING_KEY)).limit(1)
  return row && typeof row.value === 'string' && row.value.trim() ? row.value : null
}

/**
 * Sets (an IANA zone) or clears (null → back to the server's zone) the `agent_timezone` setting.
 * The caller re-derives stored jobs afterwards (store.ts rederiveDefaultTimezone): each job row
 * keeps the zone it resolved when it was saved. Validation is the caller's (the PUT route).
 */
export async function setAgentTimezoneSetting(tz: string | null): Promise<void> {
  if (tz === null) {
    await useDb().delete(settings).where(eq(settings.key, AGENT_TIMEZONE_SETTING_KEY))
    return
  }
  await useDb().insert(settings).values({ key: AGENT_TIMEZONE_SETTING_KEY, value: tz, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: tz, updatedAt: new Date() } })
}
