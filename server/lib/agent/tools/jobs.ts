// server/lib/agent/tools/jobs.ts
// Bridget's job tools (Task 8, cycle 74): list_jobs, get_job, create_job, edit_job, delete_job,
// run_job, schedule_wake. Thin wiring over jobs/store.ts + jobs/tick.ts — every write here goes
// through the SAME writeJob path the UI uses (CAS, validation-at-write, revisions), with
// actor:'agent' throughout. Per spec D2, Bridget may edit jobs freely — including delete — even
// in a headless/background run; that ruling lives in runtime/gate.ts's FREE_TOOLS, not here.
//
// Every handler below returns { ok:false, error } for a validation/conflict/guard failure —
// mirrors edit_document et al. in tools.ts — never lets a raw store.ts exception reach the model.
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { useDb } from '../../../db'
import { agentRuns } from '../../../db/schema'
import type { AgentTool } from '../types'
import { applyReplace } from '../../documents/edit-ops'
import {
  listJobs, getJob, createJob, saveJob, deleteJob, restoreJob, getDefaultTimezone,
  JobValidationError, JobNotFoundError, ConflictError, type JobDTO
} from '../jobs/store'
import type { runJobNow as RunJobNowFn } from '../jobs/tick'
import { parseJob, type JobSpec } from '../jobs/parse'
import { fireTimesAnchor, nextFireTimes } from '../jobs/schedule'
import { resolveWakeWhen } from '../jobs/wake-time'

/** Re-parses a stored job's content for scheduling purposes only (nextFireTimes doesn't need
 *  model/active_hours validity) — `isKnownModel` is deliberately omitted so a job whose pinned
 *  model has since left the registry still reports its fire times here. */
async function specFor(job: JobDTO): Promise<JobSpec | null> {
  const result = parseJob(job.content, { defaultTimezone: job.timezone ?? await getDefaultTimezone() })
  return result.ok ? result.spec : null
}

function jobSummary(job: JobDTO) {
  return {
    slug: job.slug,
    enabled: job.enabled,
    description: job.description,
    nextRunAt: job.nextRunAt,
    lastOutcome: job.lastOutcome
  }
}

function jobStatus(job: JobDTO) {
  return {
    enabled: job.enabled,
    description: job.description,
    parseError: job.parseError,
    source: job.source,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastRunId: job.lastRunId,
    lastOutcome: job.lastOutcome,
    consecutiveFailures: job.consecutiveFailures,
    updatedAt: job.updatedAt
  }
}

/** The job that fired the run making this call, if any (final review I1). A tool call outside
 *  the runtime (MCP, legacy callers) carries no run id and is never job-fired. */
async function firingJobOf(runId: string | undefined): Promise<string | null> {
  if (!runId) return null
  const [run] = await useDb().select({ jobId: agentRuns.jobId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  return run?.jobId ?? null
}

const jobNotFound = (slug: string) => ({ ok: false as const, error: 'not_found' as const, message: `no job named "${slug}"`, slug })

export const jobTools: AgentTool[] = [
  {
    name: 'list_jobs',
    description: 'List all scheduled jobs: slug, enabled, a plain-English description of the trigger, next run time, and last outcome. Use get_job for the full content of one.',
    kind: 'read',
    toolset: 'jobs',
    schema: {},
    handler: async () => {
      const jobs = await listJobs()
      return { result: { jobs: jobs.map(jobSummary) }, summary: `listed jobs (${jobs.length})` }
    }
  },
  {
    name: 'get_job',
    description: 'Get one job by slug: its full markdown content, status (enabled, parse error, last run/outcome), and its next 5 scheduled fire times. On failure returns ok:false with error "not_found".',
    kind: 'read',
    toolset: 'jobs',
    schema: { slug: z.string().describe('Job slug') },
    handler: async (a) => {
      const slug = a.slug as string
      const job = await getJob(slug)
      if (!job) return { result: jobNotFound(slug), summary: 'get_job: not found' }
      const spec = await specFor(job)
      // Same anchor as GET /api/jobs/:slug, so Bridget and the UI list the same times.
      const fireTimes = spec ? nextFireTimes(spec, 5, new Date(), { anchor: fireTimesAnchor(job) }).map(d => d.toISOString()) : []
      return {
        result: { ok: true, slug: job.slug, content: job.content, status: jobStatus(job), nextFireTimes: fireTimes },
        summary: `got job "${job.slug}"`
      }
    }
  },
  {
    name: 'create_job',
    description: 'Create a new scheduled job from markdown (frontmatter + body — see an existing job with get_job for the shape: trigger, timezone, active_hours, model, thread, context, deliver, toolsets (on-demand toolsets the job needs, e.g. [images]), enabled). Goes live immediately if enabled:true. On failure returns ok:false with a validation or conflict error; nothing is written.',
    kind: 'create',
    toolset: 'jobs',
    schema: {
      slug: z.string().min(1).describe('Job slug (lowercase letters/digits/hyphens)'),
      content: z.string().min(1).describe('Full job markdown: frontmatter + body')
    },
    handler: async (a, ctx) => {
      const slug = a.slug as string
      const content = a.content as string
      try {
        const job = await createJob({ slug, content, actor: 'agent', runId: ctx.runId ?? null })
        return {
          result: { ok: true, slug: job.slug, status: jobStatus(job) },
          summary: `created job "${job.slug}"`,
          undo: async () => { await deleteJob(job.slug, { actor: 'agent' }) }
        }
      } catch (err) {
        if (err instanceof JobValidationError) {
          return { result: { ok: false, error: err.message }, summary: `create_job rejected: ${err.message}` }
        }
        if (err instanceof ConflictError) {
          return { result: { ok: false, error: 'a job with that slug already exists', current: err.current }, summary: 'create_job: slug already exists' }
        }
        // Defense in depth: createJob always passes expectedHash:null, so writeJob's
        // 'not-found' branch (JobNotFoundError) can't actually trigger here — but never let ANY
        // raw error escape the tool contract (review fix round 1: matches create_skill/edit_skill).
        const message = err instanceof Error ? err.message : String(err)
        return { result: { ok: false, error: message }, summary: `create_job failed: ${message}` }
      }
    }
  },
  {
    name: 'edit_job',
    description: 'Edit an existing job. Either find/replace (`old_string`/`new_string`, unique match unless `replace_all` — like edit_document) or pass full `content` to replace the whole file. Re-validated and re-scheduled on save. On failure returns ok:false with error "not_found", "no_match", "ambiguous_match", "empty_old_string", "missing_args", or a validation/conflict message; nothing is written in any case.',
    kind: 'create',
    toolset: 'jobs',
    schema: {
      slug: z.string().min(1).describe('Job slug'),
      old_string: z.string().optional().describe('Exact text to replace (must be unique unless replace_all)'),
      new_string: z.string().optional().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence'),
      content: z.string().optional().describe('Full replacement content (alternative to old_string/new_string)')
    },
    handler: async (a, ctx) => {
      const slug = a.slug as string
      const job = await getJob(slug)
      if (!job) return { result: jobNotFound(slug), summary: 'edit_job: not found' }

      let newContent: string
      if (a.content !== undefined) {
        newContent = a.content as string
      } else {
        const oldStr = a.old_string as string | undefined
        const newStr = a.new_string as string | undefined
        if (oldStr === undefined || newStr === undefined) {
          return {
            result: { ok: false, error: 'missing_args', message: 'pass `content`, or both `old_string` and `new_string`' },
            summary: 'edit_job: missing args'
          }
        }
        const res = applyReplace(job.content, oldStr, newStr, a.replace_all as boolean | undefined)
        if ('error' in res) return { result: { ok: false, ...res }, summary: `edit_job: ${res.error}` }
        newContent = res.content
      }

      const priorContent = job.content
      try {
        const updated = await saveJob(slug, newContent, job.contentHash, 'agent', ctx.runId ?? null)
        return {
          result: { ok: true, slug: updated.slug, status: jobStatus(updated) },
          summary: `edited job "${slug}"`,
          undo: async () => {
            const current = await getJob(slug)
            if (!current) return { ok: false, reason: 'the job was deleted since the edit — nothing to undo' }
            await saveJob(slug, priorContent, current.contentHash, 'agent').catch(() => {})
          }
        }
      } catch (err) {
        // The job was deleted between the getJob read above and this saveJob call landing —
        // writeJob's CAS finds no row at all (not a hash mismatch), so it resolves 'not-found'
        // rather than ConflictError. Map it to the SAME not_found shape the initial getJob
        // check above already returns, rather than leaking the raw exception (review fix
        // round 1, Important).
        if (err instanceof JobNotFoundError) {
          return { result: jobNotFound(slug), summary: 'edit_job: not found' }
        }
        if (err instanceof JobValidationError) {
          return { result: { ok: false, error: err.message }, summary: `edit_job rejected: ${err.message}` }
        }
        if (err instanceof ConflictError) {
          return { result: { ok: false, error: 'the job changed since it was read', current: err.current }, summary: 'edit_job: conflict' }
        }
        const message = err instanceof Error ? err.message : String(err)
        return { result: { ok: false, error: message }, summary: `edit_job failed: ${message}` }
      }
    }
  },
  {
    name: 'delete_job',
    description: 'Delete a job. Free to call even in a background run (spec D2) — job management is Bridget\'s own upkeep, not a change to Tony\'s data. On failure returns ok:false with error "not_found".',
    kind: 'destructive',
    toolset: 'jobs',
    schema: { slug: z.string().describe('Job slug') },
    handler: async (a, ctx) => {
      const slug = a.slug as string
      const job = await getJob(slug)
      if (!job) return { result: jobNotFound(slug), summary: 'delete_job: not found' }
      // The delete records a final revision (actor agent, this run), so it shows in the job's
      // history and is revertible (final review I2).
      const deleted = await deleteJob(slug, { actor: 'agent', runId: ctx.runId ?? null })
      if (!deleted) return { result: jobNotFound(slug), summary: 'delete_job: not found' }
      return {
        result: { ok: true, slug },
        summary: `deleted job "${slug}"`,
        // restoreJob re-creates it under its ORIGINAL id, so its revision history comes back too.
        undo: async () => {
          try {
            await restoreJob(job.id, slug, job.content, 'agent')
          } catch (err) {
            return { ok: false, reason: `could not restore job "${slug}": ${err instanceof Error ? err.message : String(err)}` }
          }
        }
      }
    }
  },
  {
    name: 'run_job',
    description: 'Run a job right now, outside its schedule (schedule is untouched). Not available from inside a run that a job itself started. On failure or skip returns ok:false with error "not_found", "overlap" (previous run still going), "disabled", "invalid" (doesn\'t currently parse), or "refused_in_job_run".',
    kind: 'create',
    toolset: 'jobs',
    schema: { slug: z.string().describe('Job slug') },
    handler: async (a, ctx) => {
      const slug = a.slug as string
      try {
        // Final review I1: a job-fired run may not start another job run — job A running B
        // running A would ping-pong forever (overlap only checks the target's own runs).
        if (await firingJobOf(ctx.runId)) {
          return {
            result: {
              ok: false,
              error: 'refused_in_job_run',
              message: 'run_job is not available inside a run that a job started (it could chain jobs into a loop). Do the work here, or schedule_wake a follow-up at least 5 minutes out.'
            },
            summary: `run_job "${slug}" refused: called from a job-fired run`
          }
        }
        // Dynamic import breaks a real cycle: tools.ts -> tools/jobs.ts -> jobs/tick.ts ->
        // runtime/wake.ts -> runtime/queue.ts -> runtime/runner.ts -> profile.ts -> tools.ts
        // (same pattern as subagents.ts's run.ts import, for the same reason).
        const runJobNow: typeof RunJobNowFn = (await import('../jobs/tick')).runJobNow
        const res = await runJobNow(slug)
        if ('runId' in res) return { result: { ok: true, runId: res.runId }, summary: `ran job "${slug}" (run ${res.runId})` }
        return { result: { ok: false, error: res.skipped }, summary: `run_job "${slug}" skipped: ${res.skipped}` }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { result: { ok: false, error: message }, summary: `run_job "${slug}" failed: ${message}` }
      }
    }
  },
  {
    name: 'schedule_wake',
    description: 'Schedule a one-off reminder/wake for yourself: creates an `at` job that fires once and then disables itself. `when` accepts an ISO datetime (with or without an offset — offset-less is wall-clock time in the default timezone), a relative time (`in 10m`, `in 2h`, `in 1d`), or `today HH:MM` / `tomorrow HH:MM`. Must be at least 5 minutes from now; at most 10 wakes may be scheduled per hour. On failure returns ok:false with error explaining why `when` was rejected.',
    kind: 'create',
    toolset: 'jobs',
    schema: {
      when: z.string().min(1).describe('ISO datetime, "in <n>m|h|d", or "today|tomorrow HH:MM"'),
      prompt: z.string().min(1).describe('What to do/say when it fires'),
      thread: z.enum(['main', 'isolated']).optional().describe('Which thread to wake into (default main)')
    },
    handler: async (a, ctx) => {
      const when = a.when as string
      const prompt = a.prompt as string
      const thread = a.thread as 'main' | 'isolated' | undefined

      const timezone = await getDefaultTimezone()
      const resolved = resolveWakeWhen(when, { timezone })
      if (!resolved.ok) {
        return { result: { ok: false, error: resolved.error }, summary: `schedule_wake rejected: ${resolved.error}` }
      }

      const slug = `reminder-${randomBytes(3).toString('hex')}`
      const lines = [`trigger: at ${resolved.at.toISOString()}`, 'enabled: true', 'context: light']
      if (thread === 'isolated') lines.push('thread: isolated')
      const content = `---\n${lines.join('\n')}\n---\n${prompt}\n`

      try {
        const job = await createJob({ slug, content, actor: 'agent', runId: ctx.runId ?? null })
        return {
          result: { ok: true, slug: job.slug, at: resolved.at.toISOString() },
          summary: `scheduled wake "${job.slug}" for ${resolved.at.toISOString()}`,
          undo: async () => { await deleteJob(job.slug, { actor: 'agent' }) }
        }
      } catch (err) {
        if (err instanceof JobValidationError) {
          return { result: { ok: false, error: err.message }, summary: `schedule_wake rejected: ${err.message}` }
        }
        // A slug collision (astronomically unlikely — 16^6 space) surfaces as ConflictError;
        // report it rather than throw, same as every other write path here.
        if (err instanceof ConflictError) {
          return { result: { ok: false, error: 'reminder slug collision — try again' }, summary: 'schedule_wake: slug collision' }
        }
        // Defense in depth: createJob always passes expectedHash:null, so writeJob's
        // 'not-found' branch (JobNotFoundError) can't actually trigger here — but never let ANY
        // raw error escape the tool contract (review fix round 1: matches create_skill/edit_skill).
        const message = err instanceof Error ? err.message : String(err)
        return { result: { ok: false, error: message }, summary: `schedule_wake failed: ${message}` }
      }
    }
  }
]
