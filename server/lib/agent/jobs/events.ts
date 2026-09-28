// server/lib/agent/jobs/events.ts
// Event triggers (cycle 74): `cc.session_end` (fired by the Claude Code SessionEnd hook) and
// `task.due` (a tick query). Dedupe is the database's job: (job_id, event_key) is agent_job_fires'
// primary key, and a fire only wakes the job when ITS insert actually landed — a repeated hook
// delivery or the next tick seeing the same due task inserts nothing and wakes nothing.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentJobs, agentJobFires } from '../../../db/schema'
import { wake } from '../runtime/wake'
import { fireJob, specFor } from './tick'

export type JobEventName = 'cc.session_end' | 'task.due'
type WakeFn = typeof wake

/** Tasks overdue longer than this are not announced (a backlog of ancient tasks is not news). */
export const TASK_DUE_LOOKBACK_DAYS = 7

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v))

/**
 * The plain-sentence description of an event appended to a job's prompt. No brackets or tags:
 * the model imitates whatever markers its history carries (the cycle-73 imitation lesson).
 */
export function eventBlock(name: string, payload: Record<string, unknown>): string {
  if (name === 'cc.session_end') {
    const title = str(payload.title) ?? 'untitled'
    const project = str(payload.project) ?? 'no known project'
    const minutes = typeof payload.durationMinutes === 'number' ? `${payload.durationMinutes} minutes` : 'unknown duration'
    const summary = str(payload.summary) ?? 'not summarised yet'
    const id = str(payload.sessionId)
    return `A Claude Code session just ended: '${title}' in project ${project}, ${minutes}. Summary: ${summary}.`
      + (id ? ` Its session id is ${id}.` : '')
  }
  if (name === 'task.due') {
    const title = str(payload.title) ?? 'untitled'
    const due = str(payload.dueDate)
    const id = str(payload.taskId)
    return `A task is due: '${title}'${due ? `, due ${due}` : ''}. It is not completed yet.`
      + (id ? ` Its task id is ${id}.` : '')
  }
  const details = Object.entries(payload).map(([k, v]) => `${k} is ${String(v)}`).join(', ')
  return `The event ${name} just happened${details ? `: ${details}` : ''}.`
}

// `undefined` = every job (production); `[]` = none (a test scoped to nothing fires nothing).
function slugFilter(onlySlugs: string[] | undefined) {
  if (onlySlugs === undefined) return undefined
  return onlySlugs.length ? inArray(agentJobs.slug, onlySlugs) : sql`false`
}

async function eventJobs(name: JobEventName, onlySlugs: string[] | undefined) {
  return useDb().select().from(agentJobs).where(and(
    eq(agentJobs.enabled, true),
    sql`${agentJobs.parseError} is null`,
    eq(agentJobs.triggerKind, 'event'),
    eq(agentJobs.triggerExpr, name),
    slugFilter(onlySlugs)
  ))
}

/**
 * Fires every enabled job listening for `name` whose filter matches `payload`, at most once per
 * (job, key). Returns the slugs that fired. A wake failure after the fire row landed is logged,
 * not retried: at-most-once is the safer failure for an event (no repeated nags).
 */
export async function fireEvent(
  name: JobEventName,
  key: string,
  payload: Record<string, unknown>,
  deps: { onlySlugs?: string[]; wakeFn?: WakeFn } = {}
): Promise<string[]> {
  const wakeFn = deps.wakeFn ?? wake
  const fired: string[] = []
  for (const job of await eventJobs(name, deps.onlySlugs)) {
    const spec = await specFor(job)
    if (!spec) continue
    if (spec.filter && !Object.entries(spec.filter).every(([k, v]) => String(payload[k]) === v)) continue
    const inserted = await useDb().insert(agentJobFires).values({ jobId: job.id, eventKey: key })
      .onConflictDoNothing().returning({ jobId: agentJobFires.jobId })
    if (!inserted.length) continue // already fired for this key
    try {
      await fireJob(job.slug, job.id, spec, `${spec.body}\n\n${eventBlock(name, payload)}`, wakeFn)
      fired.push(job.slug)
    } catch (err) {
      console.error(`[jobs] event ${name} could not wake "${job.slug}":`, err)
      await useDb().update(agentJobs).set({ lastOutcome: 'failed' }).where(eq(agentJobs.id, job.id)).catch(() => {})
    }
  }
  return fired
}

/**
 * The `task.due` source, run on every worker tick: tasks whose due date has passed (within the
 * last 7 days) and that are not completed. Key = task id + due date, so moving a due date makes
 * it a new event. Returns how many job fires happened. `onlySlugs`/`onlyTaskIds` are test seams.
 */
export async function dueTaskEvents(opts: { onlySlugs?: string[]; onlyTaskIds?: string[]; wakeFn?: WakeFn } = {}): Promise<number> {
  const jobs = await eventJobs('task.due', opts.onlySlugs)
  if (!jobs.length) return 0 // nobody listening: skip the tasks query entirely
  if (opts.onlyTaskIds && !opts.onlyTaskIds.length) return 0
  const taskScope = opts.onlyTaskIds
    ? sql`and id in (${sql.join(opts.onlyTaskIds.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const res = await useDb().execute(sql`
    select id, title, due_date from tasks
    where due_date <= now() and completed_at is null and deleted_at is null
      and due_date > now() - make_interval(days => ${TASK_DUE_LOOKBACK_DAYS})
      ${taskScope}
    order by due_date`)
  const rows = res.rows as { id: string; title: string; due_date: string | Date }[]
  if (!rows.length) return 0

  // Skip keys every listening job has already fired for, so a steady state of overdue tasks costs
  // one read per tick instead of an insert attempt per (task, job).
  const keys = rows.map(r => `task:${r.id}:${new Date(r.due_date).toISOString()}`)
  const done = await useDb().select({ jobId: agentJobFires.jobId, eventKey: agentJobFires.eventKey }).from(agentJobFires)
    .where(and(inArray(agentJobFires.jobId, jobs.map(j => j.id)), inArray(agentJobFires.eventKey, keys)))
  const firedPairs = new Set(done.map(d => `${d.jobId}|${d.eventKey}`))

  let count = 0
  for (const [i, r] of rows.entries()) {
    const key = keys[i]!
    if (jobs.every(j => firedPairs.has(`${j.id}|${key}`))) continue
    const dueDate = new Date(r.due_date).toISOString()
    const slugs = await fireEvent('task.due', key, { taskId: r.id, title: r.title, dueDate }, {
      onlySlugs: opts.onlySlugs ?? jobs.map(j => j.slug), wakeFn: opts.wakeFn
    })
    count += slugs.length
  }
  return count
}
