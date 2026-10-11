// Cycle 81 (spec §2, D6): the agent's scheduled tasks — summarize-threads, reflect-threads,
// reflect-jobs — moved out of Nitro `scheduledTasks` (server/tasks/*.ts) so the process that
// executes agent runs owns them: apps/worker.
// Bodies are unchanged from the old task files; only the trigger moved (croner instead of Nitro cron,
// same UTC expressions).
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { summarizeIdleThreads } from './runtime/summarize'
import { runThreadPass } from './reflect/thread-pass'
import { runJobsPass } from './reflect/jobs-pass'
import { getSelfImprovementMode } from './self-improvement-mode'
import { getDefaultTimezone } from './jobs/timezone'
import { contextDate } from './context'
import { withSpan, recordJobSummary } from '../observability/record'

export type AgentTaskResult = { result: Record<string, unknown> }
export interface AgentTask {
  name: 'summarize-threads' | 'reflect-threads' | 'reflect-jobs'
  description: string
  /** UTC cron expression (the old nuxt.config scheduledTasks slot). */
  cron: string
  run(): Promise<AgentTaskResult>
}

export const REFLECT_JOBS_LAST_DATE_KEY = 'reflect_jobs_last_date'
export const REFLECT_JOBS_MIN_HOUR = 3

/** The hour (0–23) of `now` on the wall clock in `tz`. */
function hourIn(now: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(now))
}

/**
 * Pure (preflight Ruling 2, cycle 76): true once the agent-timezone hour has reached 3 AND the pass
 * hasn't already run today (agent-timezone date, `contextDate`). Never true before 03:00 local; true
 * at every tick from then on (03:40, 04:40, …) until `lastDate` catches up to today, then false
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

export const summarizeThreadsTask: AgentTask = {
  name: 'summarize-threads',
  description: 'Fold idle side threads into their running summary (cycle 73)',
  cron: '*/10 * * * *',
  async run() {
    const result = await withSpan({ kind: 'job', name: 'summarize-threads' }, async () => {
      const r = await summarizeIdleThreads()
      recordJobSummary('summarize-threads', r)
      return r
    })
    return { result }
  }
}

// The mode check happens BEFORE withSpan opens — runThreadPass() also short-circuits on 'off', but
// checking first means an 'off' tick never opens a span or touches the DB at all.
export const reflectThreadsTask: AgentTask = {
  name: 'reflect-threads',
  description: 'Per-thread self-improvement reflection pass (cycle 76)',
  cron: '*/15 * * * *',
  async run() {
    if (await getSelfImprovementMode() === 'off') return { result: { threads: 0, proposals: 0 } }
    const result = await withSpan({ kind: 'job', name: 'reflect-threads' }, async () => {
      const r = await runThreadPass()
      recordJobSummary('reflect-threads', r)
      return r
    })
    return { result }
  }
}

// Nightly jobs pass (spec §4.2, cycle 76). Cron is UTC-only and the agent timezone is a runtime
// setting, so this runs hourly at :40 and does the work only when shouldRunJobsPass says so — a
// missed tick (restart, clock skew) still runs later the same day.
export const reflectJobsTask: AgentTask = {
  name: 'reflect-jobs',
  description: 'Nightly job-tuning self-improvement pass (cycle 76)',
  cron: '40 * * * *',
  async run() {
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
}

export const AGENT_TASKS: readonly AgentTask[] = [summarizeThreadsTask, reflectThreadsTask, reflectJobsTask]

/**
 * Start the agent scheduled tasks (UTC cron, like Nitro's). `protect`: a tick never overlaps a
 * still-running previous one of the same task. A throwing task is logged, never fatal. Returns stop.
 */
export function startAgentSchedule(tasks: readonly AgentTask[] = AGENT_TASKS): () => void {
  const jobs = tasks.map(t => new Cron(t.cron, { timezone: 'UTC', protect: true }, async () => {
    try { await t.run() } catch (err) { console.error(`[agent-schedule] ${t.name} failed:`, err) }
  }))
  return () => { for (const j of jobs) j.stop() }
}
