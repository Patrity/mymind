// server/lib/agent/jobs/tick.ts
// The jobs scheduler, called from the cycle-73 worker tick (runtime/queue.ts workerTick).
//
// Exactly-once: due rows are claimed `for update skip locked` and their next_run_at advanced in
// the SAME transaction, so a concurrent tick (another process, or a 5s timer overlapping a slow
// one) either skips the locked row or, once committed, no longer sees it as due.
// Single catch-up: next_run_at is computed from NOW, never from the missed next_run_at, so a job
// that was due hours ago (server down) fires once and reschedules — no burst.
//
// Content is untouched here: only runtime columns (last_run_at, next_run_at, fired_at,
// last_outcome, last_run_id) are written directly. The one content change a fire causes — an
// `at` job's `enabled: false` — goes through store.setJobEnabled (system revision).
import { and, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentJobs, agentJobFires, agentConfigRevisions, agentRuns, type AgentJobRow } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { wake } from '../runtime/wake'
import { getOrCreateMain } from '../runtime/sessions'
import { appendEvent } from '../../../services/conversations'
import { parseJob, type JobSpec } from './parse'
import { nextRunAt, inActiveHours } from './schedule'
import { setJobEnabled } from './store'
import { getDefaultTimezone } from './timezone'

export const JOBS_CLAIM_LIMIT = 10
export const AT_JOB_PRUNE_DAYS = 30

type WakeFn = typeof wake

/** Parses a stored job at fire time (the content may have changed since it was scheduled).
 *  The model is not re-checked here — the boot revalidation pass owns that (parse_error). */
export async function specFor(row: Pick<AgentJobRow, 'content' | 'timezone'>): Promise<JobSpec | null> {
  const res = parseJob(row.content, { defaultTimezone: row.timezone ?? await getDefaultTimezone() })
  return res.ok ? res.spec : null
}

/** A job's previous run still queued or running → a new fire would overlap it. */
export async function hasActiveRun(jobId: string): Promise<boolean> {
  const [r] = await useDb().select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.jobId, jobId), inArray(agentRuns.status, ['queued', 'running']))).limit(1)
  return !!r
}

/** The one shape every job fire takes (spec §4 "Firing a job"). */
export function wakeRequestFor(slug: string, jobId: string, spec: JobSpec, prompt: string) {
  return {
    reason: `job:${slug}`,
    prompt,
    sessionKey: spec.thread === 'main' ? 'main' as const : `isolated:${slug}` as const,
    model: spec.model === 'default' ? null : spec.model,
    jobId,
    context: spec.context
  }
}

/** Wakes the job and records the run it started. Throws whatever wake throws. */
export async function fireJob(slug: string, jobId: string, spec: JobSpec, prompt: string, wakeFn: WakeFn): Promise<string> {
  const { runId } = await wakeFn(wakeRequestFor(slug, jobId, spec, prompt))
  await useDb().update(agentJobs).set({ lastRunId: runId, lastRunAt: sql`now()` }).where(eq(agentJobs.id, jobId))
  publishChange({ resource: 'agentJob', action: 'updated', id: jobId })
  return runId
}

async function setOutcome(jobId: string, outcome: 'skipped' | 'failed'): Promise<void> {
  await useDb().update(agentJobs).set({ lastOutcome: outcome }).where(eq(agentJobs.id, jobId))
  publishChange({ resource: 'agentJob', action: 'updated', id: jobId })
}

// `undefined` = unscoped (production); `[]` = scoped to nothing (claims nothing).
function slugScope(onlySlugs: string[] | undefined) {
  if (onlySlugs === undefined) return sql``
  return onlySlugs.length
    ? sql`and slug in (${sql.join(onlySlugs.map(s => sql`${s}`), sql`, `)})`
    : sql`and false`
}

interface Claimed { id: string; slug: string; spec: JobSpec | null; kind: string | null }

/** Deletes `at` jobs fired more than 30 days ago, with their revisions (no FK cascade there). */
// `not enabled`: an `at` job re-armed with a new time is live again, whatever fired_at says
// (writeJob also clears fired_at on re-arm — belt and braces).
async function pruneFiredAtJobs(onlySlugs: string[] | undefined): Promise<number> {
  const ids = await useDb().transaction(async (tx) => {
    const res = await tx.execute(sql`
      select id from agent_jobs
      where trigger_kind = 'at' and not enabled and fired_at is not null
        and fired_at < now() - make_interval(days => ${AT_JOB_PRUNE_DAYS})
        ${slugScope(onlySlugs)}`)
    const ids = (res.rows as { id: string }[]).map(r => r.id)
    if (!ids.length) return ids
    await tx.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
    await tx.delete(agentJobs).where(inArray(agentJobs.id, ids))
    return ids
  })
  // Only after commit: a live client must never refetch a row a rolled-back delete kept.
  for (const id of ids) publishChange({ resource: 'agentJob', action: 'deleted', id })
  return ids.length
}

/**
 * An `at` job fires once, so when its one moment is skipped or fails it is disabled without ever
 * having run — tell Tony, once per job (deduped through agent_job_fires, key `at:not-fired`).
 */
async function noteAtNotFired(jobId: string, slug: string, reason: string, mainConversationId?: string): Promise<void> {
  const inserted = await useDb().insert(agentJobFires).values({ jobId, eventKey: 'at:not-fired' })
    .onConflictDoNothing().returning({ jobId: agentJobFires.jobId })
  if (!inserted.length) return
  const mainId = mainConversationId ?? await getOrCreateMain()
  await appendEvent(mainId, `Reminder ${slug} did not fire: ${reason}. It is now turned off; re-arm it on /jobs/${slug} if it still matters.`, 'runtime:job-not-fired')
}

/**
 * Claim and act on every due job. `onlySlugs` is the test seam (the dev DB is shared: a test must
 * never claim a real job); `now` overrides the clock for the claim + active-hours check (default:
 * Postgres `now()`); `wakeFn` replaces wake(); `mainConversationId` stands in for main (the
 * "reminder did not fire" note) so tests never write to the real main thread.
 */
export async function jobsTick(opts: { onlySlugs?: string[]; now?: Date; wakeFn?: WakeFn; mainConversationId?: string } = {}): Promise<{ fired: string[]; skipped: string[] }> {
  const wakeFn = opts.wakeFn ?? wake
  const fired: string[] = []
  const skipped: string[] = []

  const claimed = await useDb().transaction(async (tx): Promise<{ now: Date; jobs: Claimed[] }> => {
    const now = opts.now ?? new Date((((await tx.execute(sql`select now() as now`)).rows[0]) as { now: string | Date }).now)
    const picked = await tx.execute(sql`
      select id, slug, content, timezone, trigger_kind from agent_jobs
      where enabled and parse_error is null and next_run_at <= ${now.toISOString()}::timestamptz
        ${slugScope(opts.onlySlugs)}
      order by next_run_at
      for update skip locked
      limit ${JOBS_CLAIM_LIMIT}`)
    const jobs: Claimed[] = []
    for (const r of picked.rows as { id: string; slug: string; content: string; timezone: string | null; trigger_kind: string | null }[]) {
      const spec = await specFor({ content: r.content, timezone: r.timezone })
      const isAt = r.trigger_kind === 'at'
      // From NOW (single catch-up). An unparseable row gets no next run; revalidation owns it.
      const next = isAt || !spec ? null : nextRunAt(spec, now)
      await tx.update(agentJobs).set({
        lastRunAt: now,
        nextRunAt: next,
        ...(isAt ? { firedAt: now } : {})
      }).where(eq(agentJobs.id, r.id))
      jobs.push({ id: r.id, slug: r.slug, spec, kind: r.trigger_kind })
    }
    return { now, jobs }
  })

  for (const job of claimed.jobs) {
    let notFired: string | null = null
    try {
      if (!job.spec) {
        console.warn(`[jobs] job "${job.slug}" no longer parses at fire time — skipped`)
        notFired = 'its file no longer parses'
      } else if (!inActiveHours(job.spec, claimed.now)) {
        notFired = 'it came due outside its active hours'
      } else if (await hasActiveRun(job.id)) {
        notFired = 'its previous run was still going'
      } else {
        await fireJob(job.slug, job.id, job.spec, job.spec.body, wakeFn)
        fired.push(job.slug)
      }
      if (notFired) { await setOutcome(job.id, 'skipped'); skipped.push(job.slug) }
    } catch (err) {
      console.error(`[jobs] firing "${job.slug}" failed:`, err)
      notFired = `waking it failed (${(err as Error).message})`
      await setOutcome(job.id, 'failed').catch(() => {})
      skipped.push(job.slug)
    }
    if (job.kind === 'at') {
      await setJobEnabled(job.slug, false, 'system')
        .catch(err => console.error(`[jobs] disabling fired at-job "${job.slug}" failed:`, err))
      if (notFired) {
        await noteAtNotFired(job.id, job.slug, notFired, opts.mainConversationId)
          .catch(err => console.error(`[jobs] posting the not-fired note for "${job.slug}" failed:`, err))
      }
    }
  }

  await pruneFiredAtJobs(opts.onlySlugs).catch(err => console.error('[jobs] pruning fired at-jobs failed:', err))
  return { fired, skipped }
}

/** "Run now" (UI + run_job tool): fires immediately, respecting overlap; the schedule is untouched. */
export async function runJobNow(slug: string, deps: { wakeFn?: WakeFn } = {}): Promise<{ runId: string } | { skipped: 'overlap' | 'disabled' | 'invalid' }> {
  const [row] = await useDb().select().from(agentJobs).where(eq(agentJobs.slug, slug)).limit(1)
  if (!row) throw new Error(`no job named "${slug}"`)
  if (!row.enabled) return { skipped: 'disabled' }
  const spec = row.parseError ? null : await specFor(row)
  if (!spec) return { skipped: 'invalid' }
  if (await hasActiveRun(row.id)) return { skipped: 'overlap' }
  const runId = await fireJob(slug, row.id, spec, spec.body, deps.wakeFn ?? wake)
  return { runId }
}
