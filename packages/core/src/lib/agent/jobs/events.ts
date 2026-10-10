// server/lib/agent/jobs/events.ts
// Event triggers (cycle 74): `cc.session_end` (fired by the Claude Code SessionEnd hook) and
// `task.due` (a tick query). Dedupe is the database's job: (job_id, event_key) is agent_job_fires'
// primary key, and a fire only wakes the job when ITS insert actually landed — a repeated hook
// delivery or the next tick seeing the same due task inserts nothing and wakes nothing.
// A fire row with run_id NULL is a fire whose wake has not landed: a wake that throws or overlaps
// deletes its rows again (the key stays free), and tick.ts sweepCrashedFires clears one a crash
// stranded.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentJobs, agentJobFires } from '../../../db/schema'
import { wake } from '../runtime/wake'
import { fireJob, hasActiveRun, specFor, type FireResult } from './tick'
import { MIN_INTERVAL_MS } from './parse'

export type JobEventName = 'cc.session_end' | 'task.due'
type WakeFn = typeof wake

/** Tasks overdue longer than this are not announced (a backlog of ancient tasks is not news). */
export const TASK_DUE_LOOKBACK_DAYS = 7

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v))

/** `text` as the end of a sentence: one full stop, never "done.." (final review M2). */
const sentence = (text: string): string => /[.!?…]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`

/** One due task as a clause: 'title', due X (task id Y). */
function taskClause(t: Record<string, unknown>): string {
  const title = str(t.title) ?? 'untitled'
  const due = str(t.dueDate)
  const id = str(t.taskId)
  return `'${title}'${due ? `, due ${due}` : ''}${id ? ` (task id ${id})` : ''}`
}

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
    return `A Claude Code session just ended: '${title}' in project ${project}, ${minutes}. Summary: ${sentence(summary)}`
      + (id ? ` Its session id is ${id}.` : '')
  }
  // task.due batches (final review I4): one fire per tick lists every newly-due task.
  if (name === 'task.due' && Array.isArray(payload.tasks)) {
    const tasks = payload.tasks as Record<string, unknown>[]
    if (tasks.length === 1) return eventBlock('task.due', tasks[0]!)
    return `${tasks.length} tasks are due and not completed yet: ${tasks.map(taskClause).join('; ')}.`
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
 * Wakes a job for fire rows `keys` that just landed, and settles them: run_id recorded on success;
 * rows deleted when nothing ran (overlap, or the wake threw) so the keys can fire again. A throw
 * also marks the job failed and stamps last_run_at (the task.due retry spacing). Returns whether a run was started.
 */
async function fireAndSettle(
  job: { id: string; slug: string }, keys: string[], wakeIt: () => Promise<FireResult>, what: string
): Promise<boolean> {
  const rows = and(eq(agentJobFires.jobId, job.id), inArray(agentJobFires.eventKey, keys))
  let res: FireResult | null = null
  try {
    res = await wakeIt()
  } catch (err) {
    console.error(`[jobs] ${what} could not wake "${job.slug}":`, err)
    // last_run_at too: dueTaskEvents' MIN_INTERVAL_MS gap then spaces the retries of a wake that
    // keeps throwing (5 min, not every tick).
    await useDb().update(agentJobs).set({ lastOutcome: 'failed', lastRunAt: sql`now()` }).where(eq(agentJobs.id, job.id)).catch(() => {})
  }
  if (res && 'runId' in res) {
    await useDb().update(agentJobFires).set({ runId: res.runId }).where(rows)
      .catch(err => console.error(`[jobs] recording run ${res.runId} on ${what} fire of "${job.slug}" failed:`, err))
    return true
  }
  // Left behind on a failed delete, the rows are cleared by the crash sweep 2 minutes later.
  await useDb().delete(agentJobFires).where(rows)
    .catch(err => console.error(`[jobs] releasing ${what} keys of "${job.slug}" failed:`, err))
  return false
}

/**
 * Fires every enabled job listening for `name` whose filter matches `payload`, at most once per
 * (job, key). Returns the slugs that fired. A wake that fails or overlaps releases the key again
 * (its fire row is deleted), so a redelivery of the same event can still fire.
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
    // No self-overlap (spec §4; final review I4): a job whose previous run is still queued or
    // running is skipped WITHOUT recording the key, so nothing piles up behind it on main.
    // For a cc.session_end that event is simply not digested; task.due retries next tick.
    if (await hasActiveRun(job.id)) continue
    const inserted = await useDb().insert(agentJobFires).values({ jobId: job.id, eventKey: key })
      .onConflictDoNothing().returning({ jobId: agentJobFires.jobId })
    if (!inserted.length) continue // already fired for this key
    const prompt = `${spec.body}\n\n${eventBlock(name, payload)}`
    if (await fireAndSettle(job, [key], () => fireJob(job.slug, job.id, spec, prompt, wakeFn), `event ${name}`)) fired.push(job.slug)
  }
  return fired
}

/**
 * The `task.due` source, run on every worker tick: tasks whose due date has passed (within the
 * last 7 days) and that are not completed. Key = task id + due date, so moving a due date makes
 * it a new event.
 *
 * Batched (final review I4): each listening job fires AT MOST ONCE per tick, with one event block
 * listing every task newly due for it — never one queued wake per task. Dedupe stays per task
 * (one agent_job_fires row per (job, task key)), so a task never re-fires; a job whose previous
 * run is still going is skipped with no keys recorded, so those tasks retry on a later tick.
 * Returns how many job fires happened. `onlySlugs`/`onlyTaskIds` are test seams.
 */
export async function dueTaskEvents(opts: { onlySlugs?: string[]; onlyTaskIds?: string[]; wakeFn?: WakeFn } = {}): Promise<number> {
  const wakeFn = opts.wakeFn ?? wake
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

  const due = rows.map(r => {
    const dueDate = new Date(r.due_date).toISOString()
    return { key: `task:${r.id}:${dueDate}`, payload: { taskId: r.id, title: r.title, dueDate } }
  })
  // Skip keys each listening job has already fired for, so a steady state of overdue tasks costs
  // one read per tick instead of an insert attempt per (task, job).
  const done = await useDb().select({ jobId: agentJobFires.jobId, eventKey: agentJobFires.eventKey }).from(agentJobFires)
    .where(and(inArray(agentJobFires.jobId, jobs.map(j => j.id)), inArray(agentJobFires.eventKey, due.map(d => d.key))))
  const firedPairs = new Set(done.map(d => `${d.jobId}|${d.eventKey}`))

  let count = 0
  for (const job of jobs) {
    const spec = await specFor(job)
    if (!spec) continue
    const fresh = due.filter(d => !firedPairs.has(`${job.id}|${d.key}`)
      && (!spec.filter || Object.entries(spec.filter).every(([k, v]) => String((d.payload as Record<string, unknown>)[k]) === v)))
    if (!fresh.length) continue
    // Rate guard (final re-review N1): a job-fired run can create an already-overdue task, which
    // would re-fire this job on the next tick. task.due fires are spaced MIN_INTERVAL_MS apart per
    // job, like every/cron triggers; tasks due in the gap are batched into the next fire.
    if (job.lastRunAt && Date.now() - job.lastRunAt.getTime() < MIN_INTERVAL_MS) continue
    if (await hasActiveRun(job.id)) continue // retried next tick: no key recorded
    const inserted = await useDb().insert(agentJobFires)
      .values(fresh.map(d => ({ jobId: job.id, eventKey: d.key })))
      .onConflictDoNothing().returning({ eventKey: agentJobFires.eventKey })
    const landed = new Set(inserted.map(i => i.eventKey))
    const tasks = fresh.filter(d => landed.has(d.key)).map(d => d.payload)
    if (!tasks.length) continue // a concurrent tick recorded them first
    const prompt = `${spec.body}\n\n${eventBlock('task.due', { tasks })}`
    if (await fireAndSettle(job, [...landed], () => fireJob(job.slug, job.id, spec, prompt, wakeFn), 'task.due')) count++
  }
  return count
}
