// DB-backed — harness pattern from test/agent-runs.db.test.ts
//
// Cycle 74, Task 5: the jobs scheduler (tick.ts), event triggers (events.ts) and run outcomes
// (outcome.ts). The dev DB is SHARED with live dev servers in other checkouts, so:
//   - every job slug is prefixed `jstick-` and every jobsTick/fireEvent/dueTaskEvents call is
//     scoped with `onlySlugs` (and `onlyTaskIds`) — no real job or task is ever claimed/fired;
//   - onRunFinished posts its note to a SCRATCH thread via the `mainConversationId` seam;
//   - the fake wakeFn creates REAL agent_runs rows (so job_id linkage and overlap are real) in a
//     scratch thread that holds a permanent `running` INTERACTIVE sentinel run: claimNextRun
//     never claims a queued run of a conversation that has one running, so no other process's
//     pump can pick these fake runs up and execute a real model turn. (Interactive, so it never
//     occupies the global headless slot; claimed_at/alive_at null, so no age-based recovery.)
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { Client } from 'pg'
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentJobs, agentJobFires, agentConfigRevisions, agentRuns, conversations, conversationMessages, tasks, taskColumns
} from '../server/db/schema'
import type { AgentRun } from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { createRun } from '../server/lib/agent/runtime/runs'
import { wake, type WakeRequest } from '../server/lib/agent/runtime/wake'
import { createJob, saveJob, getJob, setJobEnabled } from '../server/lib/agent/jobs/store'
import { pumpOnce } from '../server/lib/agent/runtime/queue'
import { registerAbort, releaseAbort, abortRun } from '../server/lib/agent/runtime/aborts'
import type { RunOutcome } from '../server/lib/agent/runtime/types'
import { jobsTick, runJobNow } from '../server/lib/agent/jobs/tick'
import { fireEvent, dueTaskEvents } from '../server/lib/agent/jobs/events'
import { onRunFinished, MAX_CONSECUTIVE_FAILURES } from '../server/lib/agent/jobs/outcome'
import { recoverOnBoot, recoverStale } from '../server/lib/agent/runtime/recover'

const PREFIX = 'jstick-'
const db = () => useDb()

function md(fm: string, body: string): string {
  return `---\n${fm}\n---\n${body}\n`
}

let scratch = ''       // runs land here (sentinel-guarded)
let scratchB = ''      // a 'running' job run is moved here (one running per conversation)
let scratchMain = ''   // stands in for main in onRunFinished
const convIds: string[] = []
const taskIds: string[] = []

async function cleanupJobs() {
  const rows = await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`))
  if (rows.length) {
    const ids = rows.map(r => r.id)
    await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
    await db().delete(agentJobFires).where(inArray(agentJobFires.jobId, ids))
    await db().delete(agentJobs).where(inArray(agentJobs.id, ids))
  }
}

beforeAll(async () => {
  await cleanupJobs()
  for (let i = 0; i < 3; i++) convIds.push((await createConversation({ title: `${PREFIX}scratch-${i}` })).id)
  ;[scratch, scratchB, scratchMain] = convIds as [string, string, string]
  await db().insert(agentRuns).values({
    conversationId: scratch, sessionKey: `thread:${scratch}`, trigger: 'user', profile: 'interactive',
    status: 'running', input: { text: 'sentinel', modality: 'text' }
  })
})

afterAll(async () => {
  await db().delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await cleanupJobs()
  if (taskIds.length) await db().delete(tasks).where(inArray(tasks.id, taskIds))
  await db().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db().delete(conversations).where(inArray(conversations.id, convIds))
})

// The fake wake: records the request, creates a real (queued, never claimable) run with job_id.
const calls: WakeRequest[] = []
const fakeWake = (async (req: WakeRequest) => {
  calls.push(req)
  const run = await createRun({
    conversationId: scratch, sessionKey: `thread:${scratch}`, trigger: 'wake', profile: 'headless',
    input: { text: req.prompt, modality: 'text', ...(req.context ? { context: req.context } : {}) },
    wakeReason: req.reason, jobId: req.jobId ?? null
  })
  return { runId: run.id, conversationId: scratch }
}) as typeof wake

function callsFor(slug: string) { return calls.filter(c => c.reason === `job:${slug}`) }

async function finishJobRuns(jobId: string) {
  await db().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` })
    .where(and(eq(agentRuns.jobId, jobId), inArray(agentRuns.status, ['queued', 'running'])))
}

/** Moves a job's last fire outside the task.due rate gap (MIN_INTERVAL_MS). */
async function backdateLastRun(jobId: string) {
  await db().update(agentJobs).set({ lastRunAt: sql`now() - interval '10 minutes'` }).where(eq(agentJobs.id, jobId))
}

async function makeDue(slug: string, agoMs = 60_000) {
  await db().update(agentJobs).set({ nextRunAt: sql`now() - make_interval(secs => ${agoMs / 1000})` })
    .where(eq(agentJobs.slug, slug))
}

async function row(slug: string) {
  const [r] = await db().select().from(agentJobs).where(eq(agentJobs.slug, slug))
  return r!
}

async function dbNow(): Promise<number> {
  const r = await db().execute(sql`select now() as now`)
  return new Date((r.rows[0] as { now: string | Date }).now).getTime()
}

const HALF_HOUR = 30 * 60_000

describe('jobsTick — scheduling', () => {
  it('1. a due every-30m job fires once and next_run_at advances ~30 min', async () => {
    const slug = `${PREFIX}due`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true\ncontext: light', 'Check in.'), actor: 'human' })
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(res.fired).toEqual([slug])
    expect(callsFor(slug)).toHaveLength(1)
    expect(callsFor(slug)[0]).toMatchObject({ prompt: 'Check in.', sessionKey: 'main', model: null, jobId: job.id, context: 'light' })
    const r = await row(slug)
    const now = await dbNow()
    expect(Math.abs(r.nextRunAt!.getTime() - (now + HALF_HOUR))).toBeLessThan(60_000)
    expect(r.lastRunAt).not.toBeNull()
    // job_id linkage is a real row
    const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, r.lastRunId!))
    expect(run!.jobId).toBe(job.id)
    // not due any more: a second tick fires nothing
    const again = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(again.fired).toEqual([])
    await finishJobRuns(job.id)
  })

  it('2. concurrent jobsTick calls fire a due job exactly once', async () => {
    const slug = `${PREFIX}race`
    await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Race.'), actor: 'human' })
    await makeDue(slug)
    const results = await Promise.all(Array.from({ length: 4 }, () => jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })))
    expect(results.flatMap(r => r.fired)).toEqual([slug])
    expect(callsFor(slug)).toHaveLength(1)
    await finishJobRuns((await row(slug)).id)
  })

  it('2b. a tick running while another tick holds the claim fires nothing (deterministic interleave)', async () => {
    const slug = `${PREFIX}held`
    await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Held.'), actor: 'human' })
    await makeDue(slug)
    // Play the OTHER ticker by hand: lock the row and advance it, and hold the transaction open
    // while this process's tick runs. Scoped by slug — the only row this client touches.
    const other = new Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      await other.query('begin')
      await other.query(`select id from agent_jobs where slug = $1 for update`, [slug])
      await other.query(`update agent_jobs set next_run_at = now() + interval '30 minutes' where slug = $1`, [slug])
      const tick = jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
      // SKIP LOCKED: the tick passes the held row instead of queueing behind it. (Without it,
      // Postgres re-checks the WHERE after the wait and still fires once — but a slow claim
      // would stall every other ticker, so not blocking is pinned here too.)
      const finishedWhileHeld = await Promise.race([
        tick.then(() => true),
        new Promise<boolean>(r => setTimeout(() => r(false), 1500))
      ])
      await other.query('commit')
      expect(finishedWhileHeld).toBe(true)
      const res = await tick
      expect(res.fired).toEqual([])
      expect(callsFor(slug)).toHaveLength(0)
    } finally {
      await other.query('rollback').catch(() => {})
      await other.end()
    }
  })

  it('3. missed runs: 3 hours overdue fires exactly once, then next_run_at ≈ now + 30m', async () => {
    const slug = `${PREFIX}missed`
    await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Missed.'), actor: 'human' })
    await makeDue(slug, 3 * 3600_000)
    for (let i = 0; i < 3; i++) {
      await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
      await finishJobRuns((await row(slug)).id) // no overlap can mask a burst
    }
    expect(callsFor(slug)).toHaveLength(1)
    const now = await dbNow()
    expect(Math.abs((await row(slug)).nextRunAt!.getTime() - (now + HALF_HOUR))).toBeLessThan(60_000)
  })

  it('4. overlap: previous run still running → skipped, schedule advances, no wake', async () => {
    const slug = `${PREFIX}overlap`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Overlap.'), actor: 'human' })
    await makeDue(slug)
    await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(callsFor(slug)).toHaveLength(1)
    // Move the run to its own conversation and mark it running (interactive: no headless slot).
    await db().update(agentRuns).set({ status: 'running', conversationId: scratchB, profile: 'interactive' })
      .where(eq(agentRuns.jobId, job.id))
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(res.skipped).toEqual([slug])
    expect(res.fired).toEqual([])
    expect(callsFor(slug)).toHaveLength(1)
    const r = await row(slug)
    expect(r.lastOutcome).toBe('skipped')
    expect(r.nextRunAt!.getTime()).toBeGreaterThan(await dbNow())
    await finishJobRuns(job.id)
  })

  it('5. outside active_hours → skipped, no wake', async () => {
    const slug = `${PREFIX}hours`
    const now = new Date(await dbNow())
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const start = hhmm(new Date(now.getTime() + 2 * 3600_000))
    const end = hhmm(new Date(now.getTime() + 3 * 3600_000))
    await createJob({ slug, content: md(`trigger: every 30m\nenabled: true\ntimezone: UTC\nactive_hours: ${start}-${end}`, 'Hours.'), actor: 'human' })
    // next_run_at is the first in-hours instant — the window start (minute-floored), not now + 30m.
    const windowStart = Math.floor((now.getTime() + 2 * 3600_000) / 60_000) * 60_000
    expect(Math.abs((await row(slug)).nextRunAt!.getTime() - windowStart)).toBeLessThan(60_000)
    // The tick's own active-hours check still guards a slot that comes due outside the hours.
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(res.skipped).toEqual([slug])
    expect(callsFor(slug)).toHaveLength(0)
    const after = await row(slug)
    expect(after.lastOutcome).toBe('skipped')
    // …and re-arms at the window start, not at the next out-of-hours slot.
    expect(Math.abs(after.nextRunAt!.getTime() - windowStart)).toBeLessThan(60_000)
  })

  it('6. an `at` job fires, then enabled: false is written with a system revision and fired_at set', async () => {
    const slug = `${PREFIX}at`
    const when = new Date(Date.now() + 3600_000).toISOString()
    const job = await createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'Remind me.'), actor: 'agent' })
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(res.fired).toEqual([slug])
    expect(callsFor(slug)).toHaveLength(1)
    const r = await row(slug)
    expect(r.enabled).toBe(false)
    expect(r.content).toMatch(/^enabled: false$/m)
    expect(r.firedAt).not.toBeNull()
    expect(r.nextRunAt).toBeNull()
    const [rev] = await db().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
      .orderBy(desc(agentConfigRevisions.createdAt)).limit(1)
    expect(rev!.actor).toBe('system')
    expect(rev!.content).toBe(r.content)
    await finishJobRuns(job.id)
  })

  it('10. edit during a run: no refire while it runs; the next fire uses the new body', async () => {
    const slug = `${PREFIX}edit`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Old body.'), actor: 'human' })
    await makeDue(slug)
    await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(callsFor(slug)).toHaveLength(1)
    await db().update(agentRuns).set({ status: 'running', conversationId: scratchB, profile: 'interactive' })
      .where(eq(agentRuns.jobId, job.id))
    const cur = await getJob(slug)
    await saveJob(slug, md('trigger: every 30m\nenabled: true', 'New body.'), cur!.contentHash, 'human')
    await makeDue(slug)
    await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(callsFor(slug)).toHaveLength(1) // overlap: not fired again
    await finishJobRuns(job.id)
    await makeDue(slug)
    await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(callsFor(slug)).toHaveLength(2)
    expect(callsFor(slug)[1]!.prompt).toContain('New body.')
    expect(callsFor(slug)[1]!.prompt).not.toContain('Old body.')
    await finishJobRuns(job.id)
  })

  it('11. fired `at` jobs are pruned 30 days after firing (31 days pruned, 29 kept)', async () => {
    const old = `${PREFIX}prune-old`
    const recent = `${PREFIX}prune-recent`
    const when = new Date(Date.now() + 3600_000).toISOString()
    const a = await createJob({ slug: old, content: md(`trigger: at ${when}\nenabled: false`, 'Old.'), actor: 'agent' })
    await createJob({ slug: recent, content: md(`trigger: at ${when}\nenabled: false`, 'Recent.'), actor: 'agent' })
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '31 days'` }).where(eq(agentJobs.slug, old))
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '29 days'` }).where(eq(agentJobs.slug, recent))
    await jobsTick({ onlySlugs: [old, recent], wakeFn: fakeWake })
    expect(await getJob(old)).toBeNull()
    expect(await getJob(recent)).not.toBeNull()
    const revs = await db().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, a.id)))
    expect(revs).toHaveLength(0)
  })

  it('11b. a re-armed `at` job is never pruned; re-arming clears fired_at', async () => {
    const slug = `${PREFIX}rearm`
    const when = new Date(Date.now() + 3600_000).toISOString()
    await createJob({ slug, content: md(`trigger: at ${when}\nenabled: false`, 'Again.'), actor: 'agent' })
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '31 days'` }).where(eq(agentJobs.slug, slug))
    await setJobEnabled(slug, true, 'human')
    expect((await row(slug)).firedAt).toBeNull()
    // Even with a stale fired_at, an enabled job is kept.
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '31 days'` }).where(eq(agentJobs.slug, slug))
    await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake })
    expect(await getJob(slug)).not.toBeNull()
  })

  it('6b. an `at` job that could not fire is disabled with one note in main (deduped per job)', async () => {
    const slug = `${PREFIX}at-missed`
    const now = new Date(await dbNow())
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const hours = `${hhmm(new Date(now.getTime() + 2 * 3600_000))}-${hhmm(new Date(now.getTime() + 3 * 3600_000))}`
    const fm = (en: boolean) => `trigger: at ${new Date(now.getTime() + 3600_000).toISOString()}\nenabled: ${en}\ntimezone: UTC\nactive_hours: ${hours}`
    await createJob({ slug, content: md(fm(true), 'Missed reminder.'), actor: 'agent' })
    const notes = async () => db().select().from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, scratchMain), eq(conversationMessages.origin, 'runtime:job-not-fired')))
    for (let i = 0; i < 2; i++) {
      await makeDue(slug)
      const res = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake, mainConversationId: scratchMain })
      expect(res.skipped).toEqual([slug])
      expect((await row(slug)).enabled).toBe(false)
      await setJobEnabled(slug, true, 'human') // re-arm; the second miss must not note again
    }
    expect(callsFor(slug)).toHaveLength(0)
    const n = await notes()
    expect(n).toHaveLength(1)
    expect(n[0]!.content).toMatch(new RegExp(`^Reminder ${slug} did not fire: it came due outside its active hours`))
  })

  it('wake() carries jobId and context onto the real agent_runs row', async () => {
    const slug = `${PREFIX}wake`
    const job = await createJob({ slug, content: md('trigger: every 30m', 'W.'), actor: 'human' })
    const r = await wake({ reason: `job:${slug}`, prompt: 'W.', sessionKey: `thread:${scratch}`, jobId: job.id, context: 'light' }, { kick: false })
    const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(run!.jobId).toBe(job.id)
    expect((run!.input as { context?: string }).context).toBe('light')
    await finishJobRuns(job.id)
  })
})

describe('event triggers', () => {
  it('7. cc.session_end fires a matching job once per key; a non-matching filter does not fire', async () => {
    const match = `${PREFIX}ev-match`
    const other = `${PREFIX}ev-other`
    await createJob({ slug: match, content: md('trigger: event cc.session_end\nenabled: true\nfilter: { project: mymind }', 'Digest it.'), actor: 'human' })
    await createJob({ slug: other, content: md('trigger: event cc.session_end\nenabled: true\nfilter: { project: other }', 'Other.'), actor: 'human' })
    const scope = { onlySlugs: [match, other], wakeFn: fakeWake }
    const first = await fireEvent('cc.session_end', 'sess-1', { project: 'mymind' }, scope)
    expect(first).toEqual([match])
    const again = await fireEvent('cc.session_end', 'sess-1', { project: 'mymind' }, scope)
    expect(again).toEqual([])
    expect(callsFor(match)).toHaveLength(1)
    expect(callsFor(other)).toHaveLength(0)
    expect(callsFor(match)[0]!.prompt).toMatch(/^Digest it\.\n\nA Claude Code session just ended/)
    expect(callsFor(match)[0]!.prompt).not.toMatch(/[[\]]/)
    await finishJobRuns((await row(match)).id)
  })

  it('8. dueTaskEvents fires a task.due job once per (task, due date)', async () => {
    const slug = `${PREFIX}due-task`
    await createJob({ slug, content: md('trigger: event task.due\nenabled: true', 'A task is due.'), actor: 'human' })
    const [col] = await db().select({ id: taskColumns.id }).from(taskColumns).limit(1)
    const [t] = await db().insert(tasks).values({
      title: `${PREFIX}fixture task`, columnId: col!.id, dueDate: sql`now() - interval '1 hour'`
    }).returning()
    taskIds.push(t!.id)
    const scope = { onlySlugs: [slug], onlyTaskIds: [t!.id], wakeFn: fakeWake }
    expect(await dueTaskEvents(scope)).toBe(1)
    await finishJobRuns((await row(slug)).id)
    expect(await dueTaskEvents(scope)).toBe(0)
    expect(callsFor(slug)).toHaveLength(1)
    expect(callsFor(slug)[0]!.prompt).toContain(`${PREFIX}fixture task`)
    // a new due date is a new key → fires again
    await db().update(tasks).set({ dueDate: sql`now() - interval '2 hours'` }).where(eq(tasks.id, t!.id))
    await backdateLastRun((await row(slug)).id)
    expect(await dueTaskEvents(scope)).toBe(1)
    // completed tasks never fire
    await db().update(tasks).set({ dueDate: sql`now() - interval '3 hours'`, completedAt: sql`now()` }).where(eq(tasks.id, t!.id))
    expect(await dueTaskEvents(scope)).toBe(0)
    expect(callsFor(slug)).toHaveLength(2)
    await finishJobRuns((await row(slug)).id)
  })
})

describe('onRunFinished', () => {
  async function jobRun(slug: string): Promise<AgentRun> {
    const r = await row(slug)
    const res = await fakeWake({ reason: `job:${slug}`, prompt: 'x', jobId: r.id })
    const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, res.runId))
    await finishJobRuns(r.id)
    return run!
  }

  it('9a. done + suppressed → silent; done → spoke', async () => {
    const slug = `${PREFIX}outcome`
    await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'O.'), actor: 'human' })
    const opts = { mainConversationId: scratchMain }
    await onRunFinished(await jobRun(slug), { status: 'done', suppressed: true }, opts)
    expect((await row(slug)).lastOutcome).toBe('silent')
    await onRunFinished(await jobRun(slug), { status: 'done' }, opts)
    expect((await row(slug)).lastOutcome).toBe('spoke')
  })

  it('9b. failed ×3 → auto-disabled with a system revision and a runtime:job-disabled note in main', async () => {
    const slug = `${PREFIX}failing`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'F.'), actor: 'human' })
    const opts = { mainConversationId: scratchMain }
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await onRunFinished(await jobRun(slug), { status: 'failed', error: 'boom' }, opts)
      expect((await row(slug)).enabled).toBe(true)
    }
    // a success in between resets the streak
    await onRunFinished(await jobRun(slug), { status: 'done' }, opts)
    expect((await row(slug)).consecutiveFailures).toBe(0)
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await onRunFinished(await jobRun(slug), { status: 'failed', error: 'boom' }, opts)
    }
    const r = await row(slug)
    expect(r.lastOutcome).toBe('failed')
    expect(r.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES)
    expect(r.enabled).toBe(false)
    expect(r.content).toMatch(/^enabled: false$/m)
    const [rev] = await db().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
      .orderBy(desc(agentConfigRevisions.createdAt)).limit(1)
    expect(rev!.actor).toBe('system')
    const notes = await db().select().from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, scratchMain), eq(conversationMessages.origin, 'runtime:job-disabled')))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toContain(slug)

    // I1: re-enabling resets the streak — one failure after a fix must not re-disable it.
    await setJobEnabled(slug, true, 'human')
    expect((await row(slug)).consecutiveFailures).toBe(0)
    await onRunFinished(await jobRun(slug), { status: 'failed', error: 'once' }, opts)
    const after = await row(slug)
    expect(after.enabled).toBe(true)
    expect(after.consecutiveFailures).toBe(1)
  })

  it('9c. a user abort records failed without counting; a wall-clock abort counts (through execute)', async () => {
    const slug = `${PREFIX}aborts`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'A.'), actor: 'human' })
    // Hangs until aborted, like a real turn.
    const hang = async (run: AgentRun): Promise<RunOutcome> => {
      const ac = registerAbort(run.id)
      await new Promise<void>(r => ac.signal.aborted ? r() : ac.signal.addEventListener('abort', () => r()))
      releaseAbort(run.id)
      return { status: 'aborted' }
    }
    async function runThroughExecute(opts: { wallClockMs?: number; userAbort?: boolean }) {
      const conv = (await createConversation({ title: `${PREFIX}exec` })).id
      convIds.push(conv)
      const r = await createRun({
        conversationId: conv, sessionKey: `thread:${conv}`, trigger: 'wake', profile: 'headless',
        input: { text: 'A.', modality: 'text' }, wakeReason: `job:${slug}`, jobId: job.id
      })
      expect(await pumpOnce({ onlyConversations: [conv], run: hang, rekick: false, wallClockMs: opts.wallClockMs })).toBe(1)
      if (opts.userAbort) abortRun(r.id)
      for (let i = 0; i < 100; i++) {
        const [cur] = await db().select({ s: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, r.id))
        if (cur!.s === 'aborted') break
        await new Promise(res => setTimeout(res, 50))
      }
      await new Promise(res => setTimeout(res, 200)) // onRunFinished runs right after finishRun
    }
    await runThroughExecute({ userAbort: true })
    expect(await row(slug)).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 0 })
    await runThroughExecute({ wallClockMs: 50 })
    expect(await row(slug)).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 1 })
  })

  it('a run with no job_id is ignored: no job row changes, no note is posted', async () => {
    const slug = `${PREFIX}nojob`
    await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'N.'), actor: 'human' })
    const run = await jobRun(slug)
    const snapshot = async () => ({
      jobs: await db().select({ slug: agentJobs.slug, o: agentJobs.lastOutcome, f: agentJobs.consecutiveFailures, e: agentJobs.enabled, h: agentJobs.contentHash })
        .from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`)).orderBy(agentJobs.slug),
      notes: (await db().select({ id: conversationMessages.id }).from(conversationMessages)
        .where(eq(conversationMessages.conversationId, scratchMain))).length
    })
    const before = await snapshot()
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await onRunFinished({ ...run, jobId: null }, { status: 'failed', error: 'x' }, { mainConversationId: scratchMain })
    }
    expect(await snapshot()).toEqual(before)
  })
})

// ---- cycle 74 final review fix wave --------------------------------------------------------

describe('final review fixes — events', () => {
  async function dueTask(title: string, hoursAgo: number): Promise<string> {
    const [col] = await db().select({ id: taskColumns.id }).from(taskColumns).limit(1)
    const [t] = await db().insert(tasks).values({
      title, columnId: col!.id, dueDate: sql`now() - make_interval(hours => ${hoursAgo})`
    }).returning()
    taskIds.push(t!.id)
    return t!.id
  }
  const firesFor = async (jobId: string) =>
    (await db().select().from(agentJobFires).where(eq(agentJobFires.jobId, jobId))).length

  it('I4: fireEvent skips a job whose previous run is still going, without recording the key', async () => {
    const slug = `${PREFIX}ev-overlap`
    const job = await createJob({ slug, content: md('trigger: event cc.session_end\nenabled: true', 'Digest.'), actor: 'human' })
    const scope = { onlySlugs: [slug], wakeFn: fakeWake }
    expect(await fireEvent('cc.session_end', 'ov-1', {}, scope)).toEqual([slug])
    // Run for ov-1 still queued → ov-2 is skipped and leaves no fire row.
    expect(await fireEvent('cc.session_end', 'ov-2', {}, scope)).toEqual([])
    expect(await firesFor(job.id)).toBe(1)
    await finishJobRuns(job.id)
    expect(await fireEvent('cc.session_end', 'ov-2', {}, scope)).toEqual([slug])
    expect(callsFor(slug)).toHaveLength(2)
    await finishJobRuns(job.id)
  })

  it('I4: task.due batches every newly-due task into ONE fire per tick; tasks never re-fire; overlap defers', async () => {
    const slug = `${PREFIX}due-batch`
    const job = await createJob({ slug, content: md('trigger: event task.due\nenabled: true', 'Tasks are due.'), actor: 'human' })
    const a = await dueTask(`${PREFIX}batch A`, 1)
    const b = await dueTask(`${PREFIX}batch B`, 2)
    const c = await dueTask(`${PREFIX}batch C`, 3)
    const scope = (ids: string[]) => ({ onlySlugs: [slug], onlyTaskIds: ids, wakeFn: fakeWake })

    expect(await dueTaskEvents(scope([a, b]))).toBe(1)
    expect(callsFor(slug)).toHaveLength(1)
    const prompt = callsFor(slug)[0]!.prompt
    expect(prompt).toMatch(/^Tasks are due\.\n\n2 tasks are due and not completed yet: /)
    expect(prompt).toContain(`${PREFIX}batch A`)
    expect(prompt).toContain(`${PREFIX}batch B`)
    expect(await firesFor(job.id)).toBe(2) // dedupe stays per task

    // C becomes visible while the batch's run is still going: deferred, no key recorded.
    expect(await dueTaskEvents(scope([a, b, c]))).toBe(0)
    expect(await firesFor(job.id)).toBe(2)
    await finishJobRuns(job.id)
    // N1: inside the 5-min gap since the last fire, C is still deferred (no key recorded) — a
    // job-fired run creating an overdue task cannot re-fire its own job on the next tick.
    expect(await dueTaskEvents(scope([a, b, c]))).toBe(0)
    expect(await firesFor(job.id)).toBe(2)
    await backdateLastRun(job.id)
    // Next tick past the gap: only C fires; A and B never again.
    expect(await dueTaskEvents(scope([a, b, c]))).toBe(1)
    const last = callsFor(slug)[1]!.prompt
    expect(last).toContain(`${PREFIX}batch C`)
    expect(last).not.toContain(`${PREFIX}batch A`)
    await finishJobRuns(job.id)
    expect(await dueTaskEvents(scope([a, b, c]))).toBe(0)
    expect(callsFor(slug)).toHaveLength(2)
  })
})

describe('final review fixes — Run now and fenced finish', () => {
  it('M10: a human Run now (allowDisabled) runs a disabled job; without it the run is skipped', async () => {
    const slug = `${PREFIX}runnow-disabled`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: false', 'Try me.'), actor: 'human' })
    expect(await runJobNow(slug, { wakeFn: fakeWake })).toEqual({ skipped: 'disabled' })
    const res = await runJobNow(slug, { wakeFn: fakeWake, allowDisabled: true })
    expect(res).toHaveProperty('runId')
    expect(callsFor(slug)).toHaveLength(1)
    const r = await row(slug)
    expect(r.enabled).toBe(false)
    expect(r.nextRunAt).toBeNull() // schedule untouched
    await finishJobRuns(job.id)
  })

  // Since reliability Task 2 the RECOVERING process records the job outcome (failed, counted —
  // see "recovery — an interrupted job run updates its job"); here the row is flipped by hand, not
  // by recovery, so this pins only the fenced owner's side: it must not write one too.
  it('M11: a run whose finish was fenced (recovered as interrupted meanwhile) gets no outcome from its owner', async () => {
    const slug = `${PREFIX}fenced`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'F.'), actor: 'human' })
    const conv = (await createConversation({ title: `${PREFIX}fenced` })).id
    convIds.push(conv)
    const r = await createRun({
      conversationId: conv, sessionKey: `thread:${conv}`, trigger: 'wake', profile: 'headless',
      input: { text: 'F.', modality: 'text' }, wakeReason: `job:${slug}`, jobId: job.id
    })
    // The turn "completes", but another process recovered the row as interrupted first.
    const fencedTurn = async (run: AgentRun): Promise<RunOutcome> => {
      await db().update(agentRuns).set({ status: 'interrupted' }).where(eq(agentRuns.id, run.id))
      return { status: 'done', suppressed: false }
    }
    expect(await pumpOnce({ onlyConversations: [conv], run: fencedTurn, rekick: false })).toBe(1)
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 50))
      const [cur] = await db().select({ s: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, r.id))
      if (cur!.s === 'interrupted') break
    }
    await new Promise(res => setTimeout(res, 300))
    const after = await row(slug)
    expect(after.lastOutcome).toBeNull()
    const [final] = await db().select({ s: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, r.id))
    expect(final!.s).toBe('interrupted')
  })
})

// ---- reliability pass, Task 2 ------------------------------------------------------------------

describe('recovery — an interrupted job run updates its job', () => {
  /** A job run in its OWN scratch thread, left `running` by a dead process (`status` overridable).
   *  alive_at is 5 minutes old, past ORPHAN_STALE_MS, and recovery is scoped to this thread. */
  async function deadJobRun(jobId: string, status: 'running' | 'aborted' = 'running'): Promise<string> {
    const conv = (await createConversation({ title: `${PREFIX}crash` })).id
    convIds.push(conv)
    await db().insert(agentRuns).values({
      conversationId: conv, sessionKey: `thread:${conv}`, trigger: 'wake', profile: 'headless',
      status, input: { text: 'J.', modality: 'text' }, wakeReason: 'job:test', jobId,
      claimedAt: sql`now() - interval '5 minutes'`, aliveAt: sql`now() - interval '5 minutes'`
    })
    return conv
  }

  it('periodic and boot recovery record failed and count it; the third one auto-disables with a note', async () => {
    const slug = `${PREFIX}crashy`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'C.'), actor: 'human' })
    const opts = { mainConversationId: scratchMain }

    expect(await recoverStale({ onlyConversations: [await deadJobRun(job.id)], ...opts })).toBe(1)
    expect(await row(slug)).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 1, enabled: true })

    expect(await recoverOnBoot({ onlyConversations: [await deadJobRun(job.id)], exclusive: false, ...opts })).toBe(1)
    expect(await row(slug)).toMatchObject({ consecutiveFailures: 2, enabled: true })

    expect(await recoverStale({ onlyConversations: [await deadJobRun(job.id)], ...opts })).toBe(1)
    expect(await row(slug)).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: MAX_CONSECUTIVE_FAILURES, enabled: false })
    const notes = await db().select().from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, scratchMain), eq(conversationMessages.origin, 'runtime:job-disabled')))
    expect(notes.filter(n => n.content.includes(slug))).toHaveLength(1)
    expect(notes.find(n => n.content.includes(slug))!.content).toContain('interrupted by a restart')
  })

  it('a run Tony stopped (finished aborted) is not recovered and does not count', async () => {
    const slug = `${PREFIX}stopped`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'S.'), actor: 'human' })
    expect(await recoverStale({ onlyConversations: [await deadJobRun(job.id, 'aborted')], mainConversationId: scratchMain })).toBe(0)
    expect(await row(slug)).toMatchObject({ lastOutcome: null, consecutiveFailures: 0, enabled: true })
  })
})
