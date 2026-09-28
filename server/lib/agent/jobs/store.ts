// server/lib/agent/jobs/store.ts
// The ONLY writer of `agent_jobs`. A job is markdown-with-frontmatter (parse.ts) whose derived
// schedule columns (enabled/trigger_kind/trigger_expr/timezone/next_run_at/parse_error) are
// recomputed on every write and never edited directly — mirrors server/services/skills.ts's
// CAS/revision pattern (cycle 74, Task 3), adapted for jobs' extra guards (5-min-apart trigger,
// max 50 enabled) and the fact a job's `enabled` switch rewrites one frontmatter line instead of
// a dedicated column.
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentJobs, type AgentJobRow } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { recordRevision, getRevision, type RevisionActor } from '../config/revisions'
import { setFrontmatterKey } from '../../../../shared/utils/frontmatter'
import { parseJob, JOB_BODY_MAX, type JobSpec, type TriggerKind } from './parse'
import { nextRunAt as computeNextRunAt, describeTrigger } from './schedule'
import { loadConfig } from '../../ai/registry/store'
import { getOrCreateMain } from '../runtime/sessions'
import { appendEvent } from '../../../services/conversations'
import { ConflictError } from '../../../services/skills'
import { getDefaultTimezone } from './timezone'
import { SEED_JOB_SLUGS, SEED_JOBS } from './seeds'

export { ConflictError }
export { getDefaultTimezone }

export const MAX_ENABLED_JOBS = 50
export const JOB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// A single FIXED advisory-lock key serializes the enabled-count check against every other
// concurrent enabling write, globally — MAX_ENABLED_JOBS is a whole-TABLE invariant, not a
// per-slug one, so a per-row lock (e.g. on the slug) would not help: two concurrent creates of
// DIFFERENT slugs could each read count=49 and both commit, landing at 51 enabled. Held for the
// transaction's lifetime (`_xact_`), released automatically on commit/rollback. Arbitrary
// constant (review fix round 1, item 3), scoped to this one guard only. Exported ONLY so a test
// can take the SAME key with a raw client and prove writeJob actually blocks on it (a real
// concurrent-timing race is otherwise too fast/unreliable to force deterministically in a test).
export const MAX_ENABLED_LOCK_KEY = 740_450_001

/** True for a Postgres unique-violation (23505), from either node-postgres shape. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string, cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

/** Thrown when a job's markdown fails to parse, or a write violates a guard (rate/count).
 *  Invalid content is REJECTED at write time — it is never stored (planning ruling in
 *  global-constraints.md); only the boot revalidation pass (revalidateAll) stores parse_error. */
export class JobValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobValidationError'
  }
}

export interface JobDTO {
  id: string
  slug: string
  content: string
  contentHash: string
  source: 'human' | 'agent'
  enabled: boolean
  triggerKind: string | null
  triggerExpr: string | null
  timezone: string | null
  description: string | null
  nextRunAt: string | null
  parseError: string | null
  lastRunAt: string | null
  lastRunId: string | null
  lastOutcome: string | null
  consecutiveFailures: number
  updatedAt: string
}

const hashOf = (content: string) => createHash('sha256').update(content).digest('hex')

async function rowBySlug(slug: string): Promise<AgentJobRow | null> {
  const [row] = await useDb().select().from(agentJobs).where(eq(agentJobs.slug, slug)).limit(1)
  return row ?? null
}

// Anything with the drizzle query surface (the pool, or an open transaction) — so the
// enabled-count check can run against the SAME `tx` as the write it's guarding.
type Executor = Pick<ReturnType<typeof useDb>, 'select'>

async function countEnabledExcluding(slug: string, db: Executor): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(agentJobs)
    .where(and(eq(agentJobs.enabled, true), ne(agentJobs.slug, slug)))
  return row?.count ?? 0
}

/**
 * Builds an `isKnownModel` predicate off the AI registry's configured model ids (Task 4 brief:
 * "find how registry model ids are listed... and pass isKnownModel"). `'default'` (the job
 * frontmatter default, meaning "use the resolver's own chain") is always considered known,
 * regardless of registry state.
 *
 * `failOpen` controls what happens when the registry genuinely can't be read (DB down / config
 * row corrupt): write paths (`writeJob`, the default, `failOpen: false`) fail CLOSED — only
 * `'default'` is known, so a human/agent saving a job that pins a SPECIFIC model while the
 * registry is unreachable is rejected rather than silently accepted unverified. `revalidateAll`
 * (boot) passes `failOpen: true` — every id is treated as known — because a registry outage must
 * never mass-invalidate every job that happens to name a real model; nothing about those jobs
 * changed, only the registry's availability did (review fix round 1, item 7).
 */
async function buildIsKnownModel(opts: { failOpen?: boolean } = {}): Promise<(id: string) => boolean> {
  try {
    const cfg = await loadConfig()
    const knownIds = new Set(cfg.models.map(m => m.id))
    return (id: string) => id === 'default' || knownIds.has(id)
  } catch {
    return opts.failOpen ? () => true : (id: string) => id === 'default'
  }
}

/** Reconstructs just enough of a JobSpec from the DERIVED columns (no re-parse needed) to
 *  describe the schedule in plain English. Returns null when the job has no valid trigger. */
function describeRow(row: AgentJobRow): string | null {
  if (row.parseError || !row.triggerKind || !row.triggerExpr) return null
  const spec: JobSpec = {
    trigger: { kind: row.triggerKind as TriggerKind, expr: row.triggerExpr },
    timezone: row.timezone ?? 'UTC',
    activeHours: null,
    model: 'default',
    thread: 'main',
    context: 'full',
    deliver: [],
    enabled: row.enabled,
    filter: null,
    body: ''
  }
  return describeTrigger(spec)
}

function rowToJobDTO(row: AgentJobRow): JobDTO {
  return {
    id: row.id,
    slug: row.slug,
    content: row.content,
    contentHash: row.contentHash,
    source: row.source === 'agent' ? 'agent' : 'human',
    enabled: row.enabled,
    triggerKind: row.triggerKind,
    triggerExpr: row.triggerExpr,
    timezone: row.timezone,
    description: describeRow(row),
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    parseError: row.parseError,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastRunId: row.lastRunId,
    lastOutcome: row.lastOutcome,
    consecutiveFailures: row.consecutiveFailures,
    updatedAt: row.updatedAt.toISOString()
  }
}

// ---- reads --------------------------------------------------------------------------------

export async function listJobs(): Promise<JobDTO[]> {
  const rows = await useDb().select().from(agentJobs).orderBy(asc(agentJobs.slug))
  return rows.map(rowToJobDTO)
}

export async function getJob(slug: string): Promise<JobDTO | null> {
  const row = await rowBySlug(slug)
  return row ? rowToJobDTO(row) : null
}

// ---- writes ---------------------------------------------------------------------------------
// Every write, in order (Task 4 brief): parse -> JobValidationError on failure -> derive columns
// (nextRunAt only when enabled) -> enforce MAX_ENABLED_JOBS -> CAS on content_hash inside the
// UPDATE's WHERE (zero rows => ConflictError) -> recordRevision -> publishChange. The count-check
// + insert/update + revision run in ONE transaction (review fix round 1, items 3-4): an advisory
// lock serializes the enabled-count race, and a lost create/create race on the slug's unique
// index is mapped to ConflictError rather than surfacing a raw Postgres error.

type WriteOutcome
  = | { kind: 'ok', row: AgentJobRow, wasCreate: boolean }
    | { kind: 'conflict', current: { content: string, contentHash: string } }
    | { kind: 'not-found' }

/**
 * Runtime columns a write resets (Task 5 review):
 * - off → on clears the failure streak. Otherwise a job auto-disabled after 3 failures, then
 *   fixed and re-enabled, would be disabled again by its first failure.
 * - an `at` job re-armed with a future time clears fired_at, so the 30-day prune can't delete it.
 */
function rearm(existing: AgentJobRow, spec: JobSpec, nextRunAt: Date | null): Partial<AgentJobRow> {
  const out: Partial<AgentJobRow> = {}
  if (spec.enabled && !existing.enabled) out.consecutiveFailures = 0
  if (spec.trigger.kind === 'at' && spec.enabled && nextRunAt) out.firedAt = null
  return out
}

async function writeJob(
  slug: string,
  content: string,
  expectedHash: string | null,
  actor: RevisionActor,
  runId: string | null
): Promise<JobDTO> {
  if (!JOB_SLUG_RE.test(slug)) throw new JobValidationError(`invalid slug: ${slug}`)

  const defaultTimezone = await getDefaultTimezone()
  const isKnownModel = await buildIsKnownModel()
  const result = parseJob(content, { defaultTimezone, isKnownModel })
  if (!result.ok) throw new JobValidationError(result.error)
  const spec = result.spec

  const derived = {
    content,
    contentHash: hashOf(content),
    source: actor === 'agent' ? 'agent' : 'human',
    enabled: spec.enabled,
    triggerKind: spec.trigger.kind,
    triggerExpr: spec.trigger.expr,
    timezone: spec.timezone,
    nextRunAt: spec.enabled ? computeNextRunAt(spec, new Date()) : null,
    parseError: null as string | null
  }

  let outcome: WriteOutcome
  try {
    outcome = await useDb().transaction(async (tx): Promise<WriteOutcome> => {
      if (spec.enabled) {
        // Held for the transaction's lifetime: serializes this count-check + write against every
        // other concurrent enabling write, so two concurrent creates can't each read count=49
        // and both commit past "< 50".
        await tx.execute(sql`select pg_advisory_xact_lock(${MAX_ENABLED_LOCK_KEY})`)
        const enabledCount = await countEnabledExcluding(slug, tx)
        if (enabledCount >= MAX_ENABLED_JOBS) {
          throw new JobValidationError(`at most ${MAX_ENABLED_JOBS} jobs may be enabled at once`)
        }
      }

      const [existing] = await tx.select().from(agentJobs).where(eq(agentJobs.slug, slug)).limit(1)

      if (!existing) {
        if (expectedHash !== null) return { kind: 'not-found' }
        const [inserted] = await tx.insert(agentJobs).values({ slug, ...derived }).returning()
        await recordRevision({ targetKind: 'job', targetId: inserted!.id, content, actor, runId }, tx)
        return { kind: 'ok', row: inserted!, wasCreate: true }
      }

      if (expectedHash === null || existing.contentHash !== expectedHash) {
        return { kind: 'conflict', current: { content: existing.content, contentHash: existing.contentHash } }
      }
      // Re-checked IN the UPDATE so a write landing between the read above and this statement
      // still loses, rather than clobbering a concurrent writer (mirrors saveSkillSource).
      const [updated] = await tx.update(agentJobs)
        .set({ ...derived, ...rearm(existing, spec, derived.nextRunAt), updatedAt: sql`now()` })
        .where(and(eq(agentJobs.id, existing.id), eq(agentJobs.contentHash, expectedHash)))
        .returning()
      if (!updated) {
        // No SQL error occurred (an UPDATE matching zero rows isn't one) — safe to keep querying
        // this same tx.
        const [now] = await tx.select().from(agentJobs).where(eq(agentJobs.slug, slug)).limit(1)
        return { kind: 'conflict', current: { content: now?.content ?? '', contentHash: now?.contentHash ?? '' } }
      }
      await recordRevision({ targetKind: 'job', targetId: updated.id, content, actor, runId }, tx)
      return { kind: 'ok', row: updated, wasCreate: false }
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Lost a create/create race on the slug's unique index. The transaction above has already
    // rolled back entirely on the thrown error, so recovery runs as a FRESH query here — never
    // against that now-aborted transaction, which would refuse any further command on it.
    const now = await rowBySlug(slug)
    throw new ConflictError({ content: now?.content ?? '', contentHash: now?.contentHash ?? '' })
  }

  if (outcome.kind === 'not-found') throw new Error(`no job named "${slug}"`)
  if (outcome.kind === 'conflict') throw new ConflictError(outcome.current)

  publishChange({ resource: 'agentJob', action: outcome.wasCreate ? 'created' : 'updated', id: outcome.row.id })
  return rowToJobDTO(outcome.row)
}

export async function createJob(i: {
  slug: string
  content: string
  actor: 'human' | 'agent' | 'system'
  runId?: string | null
}): Promise<JobDTO> {
  return writeJob(i.slug, i.content, null, i.actor, i.runId ?? null)
}

export async function saveJob(
  slug: string,
  content: string,
  expectedHash: string | null,
  actor: 'human' | 'agent' | 'system',
  runId?: string | null
): Promise<JobDTO> {
  return writeJob(slug, content, expectedHash, actor, runId ?? null)
}

/** Flips only the `enabled:` frontmatter line (setFrontmatterKey keeps every other line
 *  byte-stable) and goes through the normal write path, so derived columns (notably
 *  next_run_at, cleared when disabling) stay consistent and the change gets a revision. */
export async function setJobEnabled(slug: string, enabled: boolean, actor: 'human' | 'agent' | 'system'): Promise<JobDTO> {
  const existing = await rowBySlug(slug)
  if (!existing) throw new Error(`no job named "${slug}"`)
  const content = setFrontmatterKey(existing.content, 'enabled', enabled)
  return writeJob(slug, content, existing.contentHash, actor, null)
}

export async function deleteJob(slug: string): Promise<boolean> {
  const [row] = await useDb().delete(agentJobs).where(eq(agentJobs.slug, slug)).returning()
  if (!row) return false
  publishChange({ resource: 'agentJob', action: 'deleted', id: row.id })
  return true
}

/** Restores a job to one of its revisions' content (recorded as a NEW revision by `actor`). */
export async function revertJob(slug: string, revisionId: string, actor: 'human' | 'agent'): Promise<JobDTO> {
  const row = await rowBySlug(slug)
  if (!row) throw new Error(`no job named "${slug}"`)
  const rev = await getRevision(revisionId)
  if (!rev || rev.targetKind !== 'job' || rev.targetId !== row.id) {
    throw new Error(`revision ${revisionId} does not belong to job "${slug}"`)
  }
  return writeJob(slug, rev.content, row.contentHash, actor, null)
}

// ---- boot revalidation ------------------------------------------------------------------
// Re-parses every stored job (e.g. after a model got removed from the registry, or the
// registry becomes reachable again). Unlike writeJob, invalid content here is NOT rejected —
// it can't be, the content is already stored — it sets parse_error instead, and clears it when
// a previously-invalid job now parses. next_run_at is only touched on a validity TRANSITION
// (never recomputed for a job that was already valid — that's the tick worker's job, and
// clobbering it here would silently defeat "a missed run fires once").
export async function revalidateAll(
  opts: { mainConversationId?: string, onlyIds?: string[] } = {}
): Promise<number> {
  const db = useDb()
  const rows = await db.select().from(agentJobs)
    .where(opts.onlyIds ? inArray(agentJobs.id, opts.onlyIds) : undefined)
  const defaultTimezone = await getDefaultTimezone()
  // Fail OPEN (review fix round 1, item 7): a registry outage must never mass-invalidate every
  // job that happens to name a real model — nothing about those jobs changed, only the
  // registry's availability did. Write paths (writeJob's own buildIsKnownModel() call) stay fail
  // CLOSED.
  const isKnownModel = await buildIsKnownModel({ failOpen: true })
  let changed = 0

  for (const row of rows) {
    const result = parseJob(row.content, { defaultTimezone, isKnownModel })
    const newParseError = result.ok ? null : result.error

    if (newParseError !== row.parseError) {
      // Review fix round 1, item 5: also requires content_hash unchanged since the SELECT above
      // — if a real write landed on this row between the select and here, that write already
      // derived this row's columns correctly from the content IT saw; this stale-content pass
      // must not clobber it with derivations computed from what is now a stale read.
      const guard = and(eq(agentJobs.id, row.id), eq(agentJobs.contentHash, row.contentHash))
      let touched: { id: string }[]
      if (result.ok) {
        const spec = result.spec
        touched = await db.update(agentJobs).set({
          parseError: null,
          enabled: spec.enabled,
          triggerKind: spec.trigger.kind,
          triggerExpr: spec.trigger.expr,
          timezone: spec.timezone,
          nextRunAt: spec.enabled ? computeNextRunAt(spec, new Date()) : null,
          updatedAt: sql`now()`
        }).where(guard).returning({ id: agentJobs.id })
      } else {
        touched = await db.update(agentJobs).set({
          parseError: newParseError,
          nextRunAt: null,
          updatedAt: sql`now()`
        }).where(guard).returning({ id: agentJobs.id })
      }

      // Review fix round 2, item 2: the guard matching ZERO rows means a concurrent writer won
      // (this row's real content_hash no longer equals the stale one this pass read) — that
      // writer's own write already derived everything correctly from what it saw. Counting this
      // as "changed", publishing it, or (worse) posting "Job X is invalid" here would be acting on
      // a snapshot that's already been overtaken — possibly reporting a job as newly-invalid that
      // the concurrent writer just REPAIRED.
      if (touched.length > 0) {
        changed++
        publishChange({ resource: 'agentJob', action: 'updated', id: row.id })

        // Only the null -> non-null transition posts to main (planning ruling): re-invalidating
        // an already-invalid job on every boot, or a job recovering, must not spam the thread.
        if (row.parseError === null && newParseError !== null) {
          try {
            const mainId = opts.mainConversationId ?? await getOrCreateMain()
            await appendEvent(
              mainId,
              `Job ${row.slug} is invalid: ${newParseError} — fix it on /jobs/${row.slug}.`,
              'runtime:job-invalid'
            )
          } catch (err) {
            // Review fix round 1, item 6: one job's note failing to post (e.g. main unreachable)
            // must not abort the rest of the boot revalidation pass.
            console.error(`[jobs] failed to post the invalid-job note for "${row.slug}":`, err)
          }
        }
      }
    }

    // Perf/controller ruling: yield to the event loop between jobs so a boot with many jobs
    // never blocks synchronously for seconds.
    await new Promise(resolve => setImmediate(resolve))
  }

  return changed
}

// ---- seeds --------------------------------------------------------------------------------

/** Installs the four seed jobs (spec §8), disabled, skipping any slug that already exists —
 *  safe to call on every boot. Returns how many were newly installed. */
export async function installSeedJobs(): Promise<number> {
  let installed = 0
  for (const slug of SEED_JOB_SLUGS) {
    if (await rowBySlug(slug)) continue
    await writeJob(slug, SEED_JOBS[slug], null, 'system', null)
    installed++
  }
  return installed
}

export { JOB_BODY_MAX }
