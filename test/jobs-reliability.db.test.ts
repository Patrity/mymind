// DB-backed — harness pattern from test/jobs-tick.db.test.ts
//
// Reliability pass, Task 1: one active run per job is enforced by the DATABASE
// (agent_runs_one_active_per_job), a failed wake never loses a fire, and the crash sweep repairs
// fires a crash left half-done. The dev DB is SHARED with live dev servers in other checkouts, so:
//   - every job slug is prefixed `jrel-`, and every jobsTick/fireEvent/dueTaskEvents/sweep call is
//     scoped with `onlySlugs` (and `onlyTaskIds`) — no real job, task or fire row is ever touched;
//   - "reminder did not fire" notes go to a SCRATCH thread via the `mainConversationId` seam;
//   - fake wakes create REAL agent_runs rows (so the unique index is really hit) in a scratch
//     thread that holds a permanent `running` INTERACTIVE sentinel run, so no other process's pump
//     ever claims and executes them;
//   - the real wake() is mocked (run_job calls runJobNow with no wakeFn): anything reaching it
//     without a test having installed a fake fails loudly instead of enqueueing on main.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const wakeHolder = vi.hoisted(() => ({
  impl: null as null | ((req: import('../server/lib/agent/runtime/wake').WakeRequest) => Promise<{ runId: string; conversationId: string }>)
}))
vi.mock('../server/lib/agent/runtime/wake', () => ({
  wake: (req: import('../server/lib/agent/runtime/wake').WakeRequest) => {
    if (!wakeHolder.impl) throw new Error('test reached the real wake() without a fake installed')
    return wakeHolder.impl(req)
  }
}))

import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentJobs, agentJobFires, agentConfigRevisions, agentRuns, conversations, conversationMessages, tasks, taskColumns
} from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { createRun } from '../server/lib/agent/runtime/runs'
import type { wake, WakeRequest } from '../server/lib/agent/runtime/wake'
import { createJob } from '../server/lib/agent/jobs/store'
import { resolveAtInstant } from '../server/lib/agent/jobs/schedule'
import { jobsTick, runJobNow, sweepCrashedFires } from '../server/lib/agent/jobs/tick'
import { fireEvent, dueTaskEvents } from '../server/lib/agent/jobs/events'
import { jobTools } from '../server/lib/agent/tools/jobs'
import type { ToolContext } from '../server/lib/agent/types'

const PREFIX = 'jrel-'
const db = () => useDb()
const md = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`

let scratch = ''       // runs land here (sentinel-guarded)
let scratchMain = ''   // stands in for main
const convIds: string[] = []
const taskIds: string[] = []

async function cleanupJobs() {
  const rows = await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`))
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  await db().delete(agentRuns).where(inArray(agentRuns.jobId, ids))
  await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
  await db().delete(agentJobFires).where(inArray(agentJobFires.jobId, ids))
  await db().delete(agentJobs).where(inArray(agentJobs.id, ids))
}

beforeAll(async () => {
  await cleanupJobs()
  for (let i = 0; i < 2; i++) convIds.push((await createConversation({ title: `${PREFIX}scratch-${i}` })).id)
  ;[scratch, scratchMain] = convIds as [string, string]
  await db().insert(agentRuns).values({
    conversationId: scratch, sessionKey: `thread:${scratch}`, trigger: 'user', profile: 'interactive',
    status: 'running', input: { text: 'sentinel', modality: 'text' }
  })
})

afterAll(async () => {
  wakeHolder.impl = null
  await db().delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await cleanupJobs()
  if (taskIds.length) await db().delete(tasks).where(inArray(tasks.id, taskIds))
  await db().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db().delete(conversations).where(inArray(conversations.id, convIds))
})

const calls: WakeRequest[] = []
function callsFor(slug: string) { return calls.filter(c => c.reason === `job:${slug}`) }

/** A queued, never-claimable job run in the sentinel-guarded scratch thread. */
async function jobRunRow(jobId: string | null, prompt = 'x') {
  return createRun({
    conversationId: scratch, sessionKey: `thread:${scratch}`, trigger: 'wake', profile: 'headless',
    input: { text: prompt, modality: 'text' }, wakeReason: 'job:test', jobId
  })
}

const fakeWake = (async (req: WakeRequest) => {
  calls.push(req)
  const run = await jobRunRow(req.jobId ?? null, req.prompt)
  return { runId: run.id, conversationId: scratch }
}) as typeof wake

/**
 * Loses a race it cannot see: another fire's run for the same job lands between this fire's
 * hasActiveRun pre-check and its own insert. Only the unique index can stop the second run.
 */
const racingWake = (async (req: WakeRequest) => {
  calls.push(req)
  await jobRunRow(req.jobId ?? null, 'the other fire won')
  const run = await jobRunRow(req.jobId ?? null, req.prompt)
  return { runId: run.id, conversationId: scratch }
}) as typeof wake

const throwingWake = (async (req: WakeRequest) => {
  calls.push(req)
  throw new Error('queue unavailable')
}) as typeof wake

async function finishJobRuns(jobId: string) {
  await db().update(agentRuns).set({ status: 'done', finishedAt: sql`now()` })
    .where(and(eq(agentRuns.jobId, jobId), inArray(agentRuns.status, ['queued', 'running'])))
}
const activeRuns = async (jobId: string) => (await db().select({ id: agentRuns.id }).from(agentRuns)
  .where(and(eq(agentRuns.jobId, jobId), inArray(agentRuns.status, ['queued', 'running'])))).length
const allRuns = async (jobId: string) => (await db().select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.jobId, jobId))).length
const firesFor = (jobId: string) => db().select().from(agentJobFires).where(eq(agentJobFires.jobId, jobId))

async function row(slug: string) {
  const [r] = await db().select().from(agentJobs).where(eq(agentJobs.slug, slug))
  return r!
}
async function makeDue(slug: string) {
  await db().update(agentJobs).set({ nextRunAt: sql`now() - interval '1 minute'` }).where(eq(agentJobs.slug, slug))
}
async function dueTask(title: string): Promise<string> {
  const [col] = await db().select({ id: taskColumns.id }).from(taskColumns).limit(1)
  const [t] = await db().insert(tasks).values({ title, columnId: col!.id, dueDate: sql`now() - interval '1 hour'` }).returning()
  taskIds.push(t!.id)
  return t!.id
}
const notFiredNotes = () => db().select().from(conversationMessages)
  .where(and(eq(conversationMessages.conversationId, scratchMain), eq(conversationMessages.origin, 'runtime:job-not-fired')))

describe('migration 0059', () => {
  it('creates the partial unique index and agent_job_fires.run_id', async () => {
    const idx = await db().execute(sql`select indexdef from pg_indexes where indexname = 'agent_runs_one_active_per_job'`)
    expect(idx.rows).toHaveLength(1)
    const def = (idx.rows[0] as { indexdef: string }).indexdef
    expect(def).toMatch(/CREATE UNIQUE INDEX agent_runs_one_active_per_job ON public\.agent_runs USING btree \(job_id\)/)
    expect(def).toMatch(/job_id IS NOT NULL/)
    expect(def).toMatch(/'queued'.*'running'/)
    const col = await db().execute(sql`select is_nullable from information_schema.columns where table_name = 'agent_job_fires' and column_name = 'run_id'`)
    expect(col.rows).toEqual([{ is_nullable: 'YES' }])
  })

  it('the database refuses a second active run for one job, and allows one once the first is done', async () => {
    const job = await createJob({ slug: `${PREFIX}index`, content: md('trigger: every 30m', 'I.'), actor: 'human' })
    await jobRunRow(job.id)
    await expect(jobRunRow(job.id)).rejects.toMatchObject({ cause: { code: '23505', constraint: 'agent_runs_one_active_per_job' } })
    await finishJobRuns(job.id)
    await jobRunRow(job.id)
    expect(await allRuns(job.id)).toBe(2)
    await finishJobRuns(job.id)
  })
})

describe('overlap is enforced by the database on every fire path', () => {
  it('two concurrent runJobNow calls on one job produce exactly one run', async () => {
    const slug = `${PREFIX}runnow-race`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Race.'), actor: 'human' })
    // Barrier: neither wake inserts until BOTH calls have passed the hasActiveRun pre-check.
    let entered = 0
    let release!: () => void
    const bothIn = new Promise<void>(r => { release = r })
    const barrierWake = (async (req: WakeRequest) => {
      if (++entered === 2) release()
      await Promise.race([bothIn, new Promise(r => setTimeout(r, 3000))])
      return fakeWake(req)
    }) as typeof wake
    const results = await Promise.all([runJobNow(slug, { wakeFn: barrierWake }), runJobNow(slug, { wakeFn: barrierWake })])
    expect(entered).toBe(2)
    expect(results.filter(r => 'runId' in r)).toHaveLength(1)
    expect(results.filter(r => 'skipped' in r)).toEqual([{ skipped: 'overlap' }])
    expect(await allRuns(job.id)).toBe(1)
    expect((await row(slug)).lastRunId).toBe((results.find(r => 'runId' in r) as { runId: string }).runId)
    await finishJobRuns(job.id)
  })

  it('the run_job tool reports overlap when it loses the race', async () => {
    const slug = `${PREFIX}tool-race`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Tool.'), actor: 'human' })
    wakeHolder.impl = racingWake
    try {
      const ctx: ToolContext = { signal: new AbortController().signal }
      const tool = jobTools.find(t => t.name === 'run_job')!
      const out = await tool.handler({ slug }, ctx)
      expect(out.result).toEqual({ ok: false, error: 'overlap' })
    } finally { wakeHolder.impl = null }
    expect(await activeRuns(job.id)).toBe(1) // only the winner's
    await finishJobRuns(job.id)
  })

  it('jobsTick: an every job that loses the race is skipped, not failed', async () => {
    const slug = `${PREFIX}tick-race`
    const job = await createJob({ slug, content: md('trigger: every 30m\nenabled: true', 'Tick.'), actor: 'human' })
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: racingWake, mainConversationId: scratchMain })
    expect(res).toEqual({ fired: [], skipped: [slug] })
    const r = await row(slug)
    expect(r.lastOutcome).toBe('skipped')
    expect(r.nextRunAt!.getTime()).toBeGreaterThan(Date.now())
    expect(await activeRuns(job.id)).toBe(1)
    await finishJobRuns(job.id)
  })

  it('jobsTick: an `at` job that loses the race is disabled with the overlap note (a genuine skip)', async () => {
    const slug = `${PREFIX}at-race`
    const when = new Date(Date.now() + 3600_000).toISOString()
    const job = await createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'At race.'), actor: 'agent' })
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: racingWake, mainConversationId: scratchMain })
    expect(res.skipped).toEqual([slug])
    const r = await row(slug)
    expect(r.enabled).toBe(false)
    expect(r.firedAt).not.toBeNull()
    const notes = (await notFiredNotes()).filter(n => n.content.includes(slug))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toContain('its previous run was still going')
    await finishJobRuns(job.id)
  })

  it('fireEvent: a job that loses the race records no key and no failure', async () => {
    const slug = `${PREFIX}ev-race`
    const job = await createJob({ slug, content: md('trigger: event cc.session_end\nenabled: true', 'Digest.'), actor: 'human' })
    const fired = await fireEvent('cc.session_end', 'race-1', {}, { onlySlugs: [slug], wakeFn: racingWake })
    expect(fired).toEqual([])
    expect(await firesFor(job.id)).toHaveLength(0)
    expect((await row(slug)).lastOutcome).toBeNull()
    await finishJobRuns(job.id)
    // The key is free: it fires once the other run is done.
    expect(await fireEvent('cc.session_end', 'race-1', {}, { onlySlugs: [slug], wakeFn: fakeWake })).toEqual([slug])
    await finishJobRuns(job.id)
  })

  it('dueTaskEvents: a job that loses the race records no keys, so the tasks retry', async () => {
    const slug = `${PREFIX}due-race`
    const job = await createJob({ slug, content: md('trigger: event task.due\nenabled: true', 'Due.'), actor: 'human' })
    const t = await dueTask(`${PREFIX}race task`)
    const scope = { onlySlugs: [slug], onlyTaskIds: [t] }
    expect(await dueTaskEvents({ ...scope, wakeFn: racingWake })).toBe(0)
    expect(await firesFor(job.id)).toHaveLength(0)
    expect((await row(slug)).lastOutcome).toBeNull()
    await finishJobRuns(job.id)
    expect(await dueTaskEvents({ ...scope, wakeFn: fakeWake })).toBe(1)
    await finishJobRuns(job.id)
  })
})

describe('a failed wake loses no fire', () => {
  it('`at`: the claim is undone (enabled, fired_at null, next_run_at = the at instant), no note; the next tick fires it', async () => {
    const slug = `${PREFIX}at-throw`
    const when = new Date(Date.now() + 3600_000).toISOString()
    const job = await createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'Remind.'), actor: 'agent' })
    await makeDue(slug)
    const res = await jobsTick({ onlySlugs: [slug], wakeFn: throwingWake, mainConversationId: scratchMain })
    expect(res.fired).toEqual([])
    const r = await row(slug)
    expect(r.enabled).toBe(true)
    expect(r.content).toMatch(/^enabled: true$/m)
    expect(r.firedAt).toBeNull()
    expect(r.nextRunAt!.getTime()).toBe(new Date(when).getTime())
    expect(r.lastOutcome).toBe('failed')
    expect((await notFiredNotes()).filter(n => n.content.includes(slug))).toHaveLength(0)

    await makeDue(slug) // the at instant is an hour out; bring it due for the retry
    const retry = await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake, mainConversationId: scratchMain })
    expect(retry.fired).toEqual([slug])
    expect((await row(slug)).enabled).toBe(false)
    expect(await allRuns(job.id)).toBe(1)
    await finishJobRuns(job.id)
  })

  it('cc.session_end: the fire row is deleted so the same key can fire again', async () => {
    const slug = `${PREFIX}ev-throw`
    const job = await createJob({ slug, content: md('trigger: event cc.session_end\nenabled: true', 'Digest.'), actor: 'human' })
    const scope = { onlySlugs: [slug] }
    expect(await fireEvent('cc.session_end', 'throw-1', {}, { ...scope, wakeFn: throwingWake })).toEqual([])
    expect(await firesFor(job.id)).toHaveLength(0)
    expect((await row(slug)).lastOutcome).toBe('failed')
    expect(await fireEvent('cc.session_end', 'throw-1', {}, { ...scope, wakeFn: fakeWake })).toEqual([slug])
    const fires = await firesFor(job.id)
    expect(fires).toHaveLength(1)
    expect(fires[0]!.runId).toBe((await row(slug)).lastRunId)
    await finishJobRuns(job.id)
  })

  it('task.due: the fire rows are deleted so the tasks fire on the next tick; run_id is recorded', async () => {
    const slug = `${PREFIX}due-throw`
    const job = await createJob({ slug, content: md('trigger: event task.due\nenabled: true', 'Due.'), actor: 'human' })
    const a = await dueTask(`${PREFIX}throw A`)
    const b = await dueTask(`${PREFIX}throw B`)
    const scope = { onlySlugs: [slug], onlyTaskIds: [a, b] }
    expect(await dueTaskEvents({ ...scope, wakeFn: throwingWake })).toBe(0)
    expect(await firesFor(job.id)).toHaveLength(0)
    expect(await dueTaskEvents({ ...scope, wakeFn: fakeWake })).toBe(1)
    const fires = await firesFor(job.id)
    expect(fires).toHaveLength(2)
    const runId = (await row(slug)).lastRunId
    expect(runId).not.toBeNull()
    expect(fires.map(f => f.runId)).toEqual([runId, runId])
    await finishJobRuns(job.id)
  })
})

describe('crash sweep', () => {
  const MIN5 = sql`now() - interval '5 minutes'`

  it('re-arms a crashed `at` job once, clears an orphan fire row, and leaves healthy rows alone', async () => {
    const when = new Date(Date.now() + 3600_000).toISOString()
    const atFm = md(`trigger: at ${when}\nenabled: true`, 'Crashed.')
    // Crashed: claimed 5 min ago (fired_at set, next_run_at null), never woke, still enabled.
    const crashed = await createJob({ slug: `${PREFIX}sw-crashed`, content: atFm, actor: 'agent' })
    // Healthy: claimed 5 min ago and its run exists.
    const ran = await createJob({ slug: `${PREFIX}sw-ran`, content: atFm, actor: 'agent' })
    // Healthy: claimed 30 s ago — its wake may still be in flight.
    const fresh = await createJob({ slug: `${PREFIX}sw-fresh`, content: atFm, actor: 'agent' })
    await db().update(agentJobs).set({ firedAt: MIN5, nextRunAt: null }).where(inArray(agentJobs.id, [crashed.id, ran.id]))
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '30 seconds'`, nextRunAt: null }).where(eq(agentJobs.id, fresh.id))
    await jobRunRow(ran.id)

    const ev = await createJob({ slug: `${PREFIX}sw-ev`, content: md('trigger: event cc.session_end\nenabled: true', 'E.'), actor: 'human' })
    // An earlier, settled fire (its run predates the orphan, so it does not mask the crash).
    const settledRun = await jobRunRow(ev.id)
    await finishJobRuns(ev.id)
    await db().update(agentRuns).set({ createdAt: sql`now() - interval '20 minutes'` }).where(eq(agentRuns.id, settledRun.id))
    await db().insert(agentJobFires).values([
      { jobId: ev.id, eventKey: 'orphan', firedAt: sql`now() - interval '10 minutes'` },  // crashed before wake
      { jobId: ev.id, eventKey: 'settled', firedAt: sql`now() - interval '21 minutes'`, runId: settledRun.id },
      { jobId: ev.id, eventKey: 'in-flight', firedAt: sql`now() - interval '30 seconds'` }
    ])
    // A genuinely skipped `at` job: fired 5 min ago, no run, but disabled by the tick — not a
    // crash. Its "did not fire" dedupe row has no run by design: never swept either.
    const skippedAt = await createJob({ slug: `${PREFIX}sw-notfired`, content: md(`trigger: at ${when}\nenabled: false`, 'N.'), actor: 'agent' })
    await db().update(agentJobs).set({ firedAt: MIN5 }).where(eq(agentJobs.id, skippedAt.id))
    await db().insert(agentJobFires).values({ jobId: skippedAt.id, eventKey: 'at:not-fired', firedAt: sql`now() - interval '10 minutes'` })

    const slugs = [crashed, ran, fresh, ev, skippedAt].map(j => j.slug)
    const out = await sweepCrashedFires({ onlySlugs: slugs })
    expect(out).toEqual({ rearmed: [`${PREFIX}sw-crashed`], clearedFires: 1 })

    const c = await row(`${PREFIX}sw-crashed`)
    expect(c.enabled).toBe(true)
    expect(c.firedAt).toBeNull()
    expect(c.nextRunAt!.getTime()).toBe(resolveAtInstant(when, 'UTC')!.getTime())
    expect((await row(`${PREFIX}sw-ran`)).firedAt).not.toBeNull()
    expect((await row(`${PREFIX}sw-fresh`)).firedAt).not.toBeNull()
    expect((await firesFor(ev.id)).map(f => f.eventKey).sort()).toEqual(['in-flight', 'settled'])
    expect(await firesFor(skippedAt.id)).toHaveLength(1)
    expect((await row(`${PREFIX}sw-notfired`)).firedAt).not.toBeNull()

    // Idempotent: a second sweep finds nothing.
    expect(await sweepCrashedFires({ onlySlugs: slugs })).toEqual({ rearmed: [], clearedFires: 0 })
    await finishJobRuns(ran.id)
  })

  it('keeps an unrecorded fire row whose run did land (crash between wake and run_id write)', async () => {
    const ev = await createJob({ slug: `${PREFIX}sw-landed`, content: md('trigger: event cc.session_end\nenabled: true', 'L.'), actor: 'human' })
    await db().insert(agentJobFires).values({ jobId: ev.id, eventKey: 'landed', firedAt: sql`now() - interval '10 minutes'` })
    await jobRunRow(ev.id) // created after fired_at, run_id never written
    expect(await sweepCrashedFires({ onlySlugs: [ev.slug] })).toEqual({ rearmed: [], clearedFires: 0 })
    expect(await firesFor(ev.id)).toHaveLength(1)
    await finishJobRuns(ev.id)
  })

  it('the `now` seam moves the 2-minute threshold', async () => {
    const ev = await createJob({ slug: `${PREFIX}sw-now`, content: md('trigger: event cc.session_end\nenabled: true', 'N.'), actor: 'human' })
    await db().insert(agentJobFires).values({ jobId: ev.id, eventKey: 'young' })
    expect(await sweepCrashedFires({ onlySlugs: [ev.slug] })).toEqual({ rearmed: [], clearedFires: 0 })
    const later = new Date(Date.now() + 3 * 60_000)
    expect(await sweepCrashedFires({ onlySlugs: [ev.slug], now: later })).toEqual({ rearmed: [], clearedFires: 1 })
  })

  it('scoped to nothing, it touches nothing', async () => {
    expect(await sweepCrashedFires({ onlySlugs: [] })).toEqual({ rearmed: [], clearedFires: 0 })
  })
})
