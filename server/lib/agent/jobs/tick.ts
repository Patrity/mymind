// server/lib/agent/jobs/tick.ts
// The jobs scheduler, called from the cycle-73 worker tick (runtime/queue.ts workerTick).
//
// Exactly-once: due rows are claimed `for update skip locked` and their next_run_at advanced in
// the SAME transaction, so a concurrent tick (another process, or a 5s timer overlapping a slow
// one) either skips the locked row or, once committed, no longer sees it as due.
// Single catch-up: next_run_at is computed from NOW, never from the missed next_run_at, so a job
// that was due hours ago (server down) fires once and reschedules — no burst.
//
// No overlap: agent_runs_one_active_per_job (a partial unique index) allows one queued-or-running
// run per job, so a fire that races another fire of the same job fails its insert and is treated
// as an overlap skip. The hasActiveRun checks are only the cheap fast path.
// No lost fire: a wake that throws undoes what the fire committed before it (an `at` claim, an
// event's fire rows), and sweepCrashedFires repairs what a crash between the two left behind.
//
// Content is untouched here: only runtime columns (last_run_at, next_run_at, fired_at,
// last_outcome, last_run_id) are written directly. The one content change a fire causes — an
// `at` job's `enabled: false` — goes through store.setJobEnabled (system revision).
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentJobs, agentJobFires, agentConfigRevisions, agentRuns, type AgentJobRow } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { wake } from '../runtime/wake'
import { getOrCreateMain } from '../runtime/sessions'
import { appendEvent } from '../../../services/conversations'
import { parseJob, type JobSpec } from './parse'
import { nextRunAt, inActiveHours, resolveAtInstant } from './schedule'
import { setJobEnabled, ConflictError, AT_NOT_FIRED_KEY } from './store'
import { getDefaultTimezone } from './timezone'

export const JOBS_CLAIM_LIMIT = 10
export const AT_JOB_PRUNE_DAYS = 30
/** A fire whose wake has not landed this long after it committed is treated as crashed. */
export const CRASHED_FIRE_AFTER_MS = 2 * 60_000
/** Unrecorded fire rows older than this are left alone: a crash is repaired on the next boot's
 *  first tick, and an old NULL run_id is more likely a row from before migration 0059, or one
 *  whose run was deleted with its thread (on delete set null) — neither is a crash to repair. */
export const CRASHED_FIRE_LOOKBACK_HOURS = 24
/** An `at` job whose wake fails (throws, or its process crashes) this many times in a row gives up:
 *  disabled, with the "did not fire" note. Counted in agent_jobs.fire_failures. */
export const MAX_FIRE_FAILURES = 5
export const ONE_ACTIVE_RUN_PER_JOB_INDEX = 'agent_runs_one_active_per_job'

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
    context: spec.context,
    // Cycle 78: a job's declared toolsets load at run start; omitted (not []) when none —
    // wake()/RunInput treat an absent key and an empty array differently.
    ...(spec.toolsets.length ? { toolsets: spec.toolsets } : {})
  }
}

/** The insert of a job's run hit agent_runs_one_active_per_job: another run of it is active. */
export function isJobOverlapError(err: unknown): boolean {
  // drizzle wraps the pg error (DrizzleQueryError.cause); walk a few levels of `cause`.
  let e = err as { code?: string; constraint?: string; cause?: unknown } | undefined
  for (let depth = 0; e && depth < 4; depth++) {
    if (e.code === '23505' && e.constraint === ONE_ACTIVE_RUN_PER_JOB_INDEX) return true
    e = e.cause as typeof e
  }
  return false
}

export type FireResult = { runId: string } | { overlap: true }

/**
 * Wakes the job and records the run it started. `{ overlap: true }` when the database refused
 * the run because another run of this job is active. Throws whatever else wake throws — and ONLY
 * when no run was created, so a caller may safely undo its claim on a throw.
 */
export async function fireJob(slug: string, jobId: string, spec: JobSpec, prompt: string, wakeFn: WakeFn): Promise<FireResult> {
  let runId: string
  try {
    ({ runId } = await wakeFn(wakeRequestFor(slug, jobId, spec, prompt)))
  } catch (err) {
    if (isJobOverlapError(err)) return { overlap: true }
    throw err
  }
  // The run exists from here on: bookkeeping failures are logged, never thrown (a throw would
  // make the caller undo a claim whose run is already queued, and fire the job twice).
  await useDb().update(agentJobs).set({ lastRunId: runId, lastRunAt: sql`now()`, fireFailures: 0 }).where(eq(agentJobs.id, jobId))
    .catch(err => console.error(`[jobs] recording run ${runId} on "${slug}" failed:`, err))
  publishChange({ resource: 'agentJob', action: 'updated', id: jobId })
  return { runId }
}

/**
 * After an `at` job's wake failed (it threw, or a crash stranded the claim): counts the failure
 * and, below MAX_FIRE_FAILURES, undoes the claim so the next tick fires it again — fired_at
 * cleared, next_run_at back to its instant (already past, so due at once). At the cap the claim
 * stays and `gaveUp` is set: the caller disables the job with the "did not fire" note. `enabled`
 * is untouched here. Unparseable content falls back to `fallback`. One statement, so `onlyIf`
 * (the sweep's re-check) and the count are atomic; null = `onlyIf` no longer matched.
 */
async function retryAtJob(jobId: string, spec: JobSpec | null, fallback: Date, onlyIf?: SQL): Promise<{ failures: number; gaveUp: boolean } | null> {
  const instant = (spec && resolveAtInstant(spec.trigger.expr, spec.timezone)) ?? fallback
  const atCap = sql`${agentJobs.fireFailures} + 1 >= ${MAX_FIRE_FAILURES}`
  const [r] = await useDb().update(agentJobs).set({
    fireFailures: sql`${agentJobs.fireFailures} + 1`,
    firedAt: sql`case when ${atCap} then ${agentJobs.firedAt} else null end`,
    nextRunAt: sql`case when ${atCap} then ${agentJobs.nextRunAt} else ${instant.toISOString()}::timestamptz end`
  }).where(and(eq(agentJobs.id, jobId), onlyIf)).returning({ failures: agentJobs.fireFailures })
  if (!r) return null
  publishChange({ resource: 'agentJob', action: 'updated', id: jobId })
  return { failures: r.failures, gaveUp: r.failures >= MAX_FIRE_FAILURES }
}

const gaveUpReason = (failures: number, why: string) => `waking it failed ${failures} times in a row (${why})`

/** An `at` job that gave up: disabled (system revision) with the one "did not fire" note. */
async function giveUpAtJob(jobId: string, slug: string, reason: string, mainConversationId?: string): Promise<void> {
  await setJobEnabled(slug, false, 'system')
    .catch(err => console.error(`[jobs] disabling fired at-job "${slug}" failed:`, err))
  await noteAtNotFired(jobId, slug, reason, mainConversationId)
    .catch(err => console.error(`[jobs] posting the not-fired note for "${slug}" failed:`, err))
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
  const inserted = await useDb().insert(agentJobFires).values({ jobId, eventKey: AT_NOT_FIRED_KEY })
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
    let wakeError: string | null = null
    try {
      if (!job.spec) {
        console.warn(`[jobs] job "${job.slug}" no longer parses at fire time — skipped`)
        notFired = 'its file no longer parses'
      } else if (!inActiveHours(job.spec, claimed.now)) {
        notFired = 'it came due outside its active hours'
      } else if (await hasActiveRun(job.id)) {
        notFired = 'its previous run was still going'
      } else if ('overlap' in await fireJob(job.slug, job.id, job.spec, job.spec.body, wakeFn)) {
        notFired = 'its previous run was still going'
      } else {
        fired.push(job.slug)
      }
      if (notFired) { await setOutcome(job.id, 'skipped'); skipped.push(job.slug) }
    } catch (err) {
      console.error(`[jobs] firing "${job.slug}" failed:`, err)
      wakeError = (err as Error).message
      await setOutcome(job.id, 'failed').catch(() => {})
      skipped.push(job.slug)
    }
    if (job.kind !== 'at') continue
    if (wakeError !== null) {
      // Nothing ran: undo the claim so the next tick tries again (no note — it has not missed
      // yet), until MAX_FIRE_FAILURES in a row. A failed re-arm is left to the crash sweep.
      const retry = await retryAtJob(job.id, job.spec, claimed.now)
        .catch((err) => { console.error(`[jobs] re-arming "${job.slug}" after a failed wake failed:`, err); return null })
      if (retry?.gaveUp) await giveUpAtJob(job.id, job.slug, gaveUpReason(retry.failures, wakeError), opts.mainConversationId)
    } else if (notFired) {
      await giveUpAtJob(job.id, job.slug, notFired, opts.mainConversationId)
    } else {
      await setJobEnabled(job.slug, false, 'system')
        .catch(err => console.error(`[jobs] disabling fired at-job "${job.slug}" failed:`, err))
    }
  }

  await pruneFiredAtJobs(opts.onlySlugs).catch(err => console.error('[jobs] pruning fired at-jobs failed:', err))
  return { fired, skipped }
}

/** "Run now" (UI + run_job tool): fires immediately, respecting overlap; the schedule is untouched.
 *  `allowDisabled` (final review M10, revised ruling): a HUMAN Run now (the API/UI) works on a
 *  disabled job, so Tony can try a seed before enabling it; the agent's run_job leaves it unset
 *  and still gets `skipped: 'disabled'`. */
export async function runJobNow(slug: string, deps: { wakeFn?: WakeFn; allowDisabled?: boolean } = {}): Promise<{ runId: string } | { skipped: 'overlap' | 'disabled' | 'invalid' }> {
  const [row] = await useDb().select().from(agentJobs).where(eq(agentJobs.slug, slug)).limit(1)
  if (!row) throw new Error(`no job named "${slug}"`)
  if (!row.enabled && !deps.allowDisabled) return { skipped: 'disabled' }
  const spec = row.parseError ? null : await specFor(row)
  if (!spec) return { skipped: 'invalid' }
  if (await hasActiveRun(row.id)) return { skipped: 'overlap' }
  const res = await fireJob(slug, row.id, spec, spec.body, deps.wakeFn ?? wake)
  return 'overlap' in res ? { skipped: 'overlap' } : res
}

/**
 * Repairs fires a crash left half-done, from the production (unscoped) worker tick. A fire commits
 * its claim / fire rows BEFORE its wake, so a crash in between would otherwise lose it:
 * - an `at` job claimed more than 2 min ago, still enabled (the tick disables it only after the
 *   fire), with no run of it created since the claim → re-armed, and the next tick fires it;
 * - an `at` job claimed more than 2 min ago, still enabled, whose run WAS created since the claim
 *   (the crash, or a failed write, hit between the fire and the tick's self-disable) → disabled,
 *   with no note: it did fire. Otherwise it shows enabled forever, is never pruned, and holds
 *   one of the MAX_ENABLED_JOBS slots;
 * - an event fire row more than 2 min old with no run_id and no run of its job since → deleted,
 *   so the key can fire again. task.due re-fires on the next dueTaskEvents tick; a lost
 *   cc.session_end cannot (its payload is gone) — the delete only frees the key for a redelivery.
 * Idempotent: a repaired row no longer matches. `onlySlugs`/`now` are the test seams.
 */
export async function sweepCrashedFires(opts: { onlySlugs?: string[]; now?: Date; mainConversationId?: string } = {}): Promise<{ rearmed: string[]; gaveUp: string[]; disabled: string[]; clearedFires: number }> {
  const now = opts.now ? sql`${opts.now.toISOString()}::timestamptz` : sql`now()`
  const stale = sql`(${now} - make_interval(secs => ${CRASHED_FIRE_AFTER_MS / 1000}))`
  const crashedAt = await useDb().execute(sql`
    select j.id, j.slug, j.content, j.timezone, j.fired_at from agent_jobs j
    where j.trigger_kind = 'at' and j.enabled and j.fired_at is not null and j.fired_at < ${stale}
      and not exists (select 1 from agent_runs r where r.job_id = j.id and r.created_at >= j.fired_at)
      ${slugScope(opts.onlySlugs)}`)
  const rearmed: string[] = []
  const gaveUp: string[] = []
  for (const r of crashedAt.rows as { id: string; slug: string; content: string; timezone: string | null; fired_at: string | Date }[]) {
    const firedAt = new Date(r.fired_at)
    // Re-checked in the UPDATE: a write since the select (Tony re-arming or disabling it, another
    // sweep re-arming it and a tick re-claiming it — a fresh fired_at) wins, and this sweep leaves
    // the row alone. A crash counts as a failed wake toward MAX_FIRE_FAILURES.
    const stillCrashed = sql`${agentJobs.enabled} and ${agentJobs.firedAt} is not null and ${agentJobs.firedAt} < ${stale}
      and not exists (select 1 from agent_runs r where r.job_id = ${agentJobs.id} and r.created_at >= ${agentJobs.firedAt})`
    const retry = await retryAtJob(r.id, await specFor(r), firedAt, stillCrashed)
    if (!retry) continue
    if (retry.gaveUp) {
      console.warn(`[jobs] "${r.slug}" never woke after ${retry.failures} tries (crash?) — giving up`)
      await giveUpAtJob(r.id, r.slug, gaveUpReason(retry.failures, 'the server stopped while waking it'), opts.mainConversationId)
      gaveUp.push(r.slug)
      continue
    }
    console.warn(`[jobs] "${r.slug}" was claimed at ${firedAt.toISOString()} but never woke (crash?) — re-armed`)
    rearmed.push(r.slug)
  }
  const firedStillOn = await useDb().execute(sql`
    select j.slug, j.content_hash from agent_jobs j
    where j.trigger_kind = 'at' and j.enabled and j.fired_at is not null and j.fired_at < ${stale}
      and exists (select 1 from agent_runs r where r.job_id = j.id and r.created_at >= j.fired_at)
      ${slugScope(opts.onlySlugs)}`)
  const disabled: string[] = []
  for (const r of firedStillOn.rows as { slug: string; content_hash: string }[]) {
    // Pinned to the hash just read: a re-arm since the select changes the content and wins.
    try {
      await setJobEnabled(r.slug, false, 'system', null, r.content_hash)
    } catch (err) {
      if (!(err instanceof ConflictError)) console.error(`[jobs] disabling fired at-job "${r.slug}" failed:`, err)
      continue
    }
    console.warn(`[jobs] "${r.slug}" fired but was never turned off (crash?) — disabled`)
    disabled.push(r.slug)
  }
  const cleared = await useDb().execute(sql`
    delete from agent_job_fires f using agent_jobs j
    where f.job_id = j.id and j.trigger_kind = 'event' and f.run_id is null
      and f.fired_at < ${stale}
      and f.fired_at > ${now} - make_interval(hours => ${CRASHED_FIRE_LOOKBACK_HOURS})
      and not exists (select 1 from agent_runs r where r.job_id = f.job_id and r.created_at >= f.fired_at)
      ${slugScope(opts.onlySlugs)}
    returning j.slug, f.event_key`)
  for (const r of cleared.rows as { slug: string; event_key: string }[]) {
    console.warn(`[jobs] fire "${r.event_key}" of "${r.slug}" never woke (crash?) — cleared so it can fire again`)
  }
  return { rearmed, gaveUp, disabled, clearedFires: cleared.rows.length }
}
