// server/tasks/reflect-jobs.ts
//
// Cron wrapper for the nightly jobs self-improvement pass (spec §4.2). The plan called for a
// cron firing once at 03:30 local, but Nitro cron is UTC-only and the agent timezone is a runtime
// setting, so no fixed UTC expression can land on 03:30 local for every zone (and DST moves it
// twice a year anyway). Preflight Ruling 2 (progress.md) overrides the plan: this task runs on
// an hourly tick (`'40 * * * *'`, so it normally lands at 03:40 local) and does the work only
// when the agent-timezone hour has reached 3 AND it hasn't already run today (agent-timezone
// date, tracked in the `reflect_jobs_last_date` setting) — so a missed tick (server restart,
// clock skew) still runs later the same day instead of waiting for tomorrow.
import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { settings } from '../db/schema'
import { runJobsPass } from '../lib/agent/reflect/jobs-pass'
import { getSelfImprovementMode } from '../lib/agent/self-improvement-mode'
import { getDefaultTimezone } from '../lib/agent/jobs/timezone'
import { contextDate } from '../lib/agent/context'
import { withSpan, recordJobSummary } from '../lib/observability/record'

export const REFLECT_JOBS_LAST_DATE_KEY = 'reflect_jobs_last_date'
export const REFLECT_JOBS_MIN_HOUR = 3

/** The hour (0–23) of `now` on the wall clock in `tz`. */
function hourIn(now: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(now))
}

/**
 * Pure (preflight Ruling 2): true once the agent-timezone hour has reached 3 AND the pass hasn't
 * already run today (agent-timezone date, `contextDate`). Never true before 03:00 local; true at
 * every tick from then on (03:40, 04:40, …) until `lastDate` catches up to today, then false
 * again until midnight flips the date. A DST transition only ever moves which UTC instant is
 * "hour 3 local" — the comparison itself is unaffected by it.
 */
export function shouldRunJobsPass(now: Date, tz: string, lastDate: string | null): boolean {
  if (hourIn(now, tz) < REFLECT_JOBS_MIN_HOUR) return false
  return lastDate !== contextDate(now, tz)
}

async function getLastDate(): Promise<string | null> {
  const [row] = await useDb().select({ value: settings.value }).from(settings).where(eq(settings.key, REFLECT_JOBS_LAST_DATE_KEY)).limit(1)
  return typeof row?.value === 'string' ? row.value : null
}

async function setLastDate(date: string): Promise<void> {
  await useDb().insert(settings).values({ key: REFLECT_JOBS_LAST_DATE_KEY, value: date, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: date, updatedAt: new Date() } })
}

export default defineTask({
  meta: { name: 'reflect-jobs', description: 'Nightly job-tuning self-improvement pass (cycle 76)' },
  async run(): Promise<{ result: Record<string, unknown> }> {
    if (await getSelfImprovementMode() === 'off') return { result: { jobs: 0, proposals: 0 } }
    const now = new Date()
    const tz = await getDefaultTimezone()
    if (!shouldRunJobsPass(now, tz, await getLastDate())) return { result: { jobs: 0, proposals: 0 } }
    const result = await withSpan({ kind: 'job', name: 'reflect-jobs' }, async () => {
      const r = await runJobsPass({ now })
      // Marked done only on a completed run, so a crash mid-pass is retried later the same day.
      await setLastDate(contextDate(now, tz))
      recordJobSummary('reflect-jobs', r)
      return r
    })
    return { result }
  }
})
