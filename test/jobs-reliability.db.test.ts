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

import { Client } from 'pg'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentJobs, agentJobFires, agentConfigRevisions, agentRuns, conversations, conversationMessages, tasks, taskColumns
} from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { createRun } from '../server/lib/agent/runtime/runs'
import type { wake, WakeRequest } from '../server/lib/agent/runtime/wake'
import { createJob, setJobEnabled, ConflictError } from '../server/lib/agent/jobs/store'
import { resolveAtInstant } from '../server/lib/agent/jobs/schedule'
import { jobsTick, runJobNow, sweepCrashedFires, MAX_FIRE_FAILURES } from '../server/lib/agent/jobs/tick'
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

describe('migration 0062', () => {
  it('indexes agent_runs on (job_id, created_at) for the sweep\'s "any run since" checks', async () => {
    const idx = await db().execute(sql`select indexdef from pg_indexes where indexname = 'agent_runs_job_created_idx'`)
    expect(idx.rows).toEqual([{ indexdef: 'CREATE INDEX agent_runs_job_created_idx ON public.agent_runs USING btree (job_id, created_at)' }])
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
    const job = await createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'At race.'), actor: 'human' })
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
    const job = await createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'Remind.'), actor: 'human' })
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

  it('task.due: the fire rows are deleted and the retry waits out the 5-minute gap; run_id is recorded', async () => {
    const slug = `${PREFIX}due-throw`
    const job = await createJob({ slug, content: md('trigger: event task.due\nenabled: true', 'Due.'), actor: 'human' })
    const a = await dueTask(`${PREFIX}throw A`)
    const b = await dueTask(`${PREFIX}throw B`)
    const scope = { onlySlugs: [slug], onlyTaskIds: [a, b] }
    expect(await dueTaskEvents({ ...scope, wakeFn: throwingWake })).toBe(0)
    expect(await firesFor(job.id)).toHaveLength(0)
    // The failed wake stamped last_run_at, so the next tick is throttled like any fire …
    expect((await row(slug)).lastRunAt).not.toBeNull()
    expect(await dueTaskEvents({ ...scope, wakeFn: fakeWake })).toBe(0)
    expect(await firesFor(job.id)).toHaveLength(0)
    // … and once the gap has passed, the tasks fire.
    await db().update(agentJobs).set({ lastRunAt: sql`now() - interval '10 minutes'` }).where(eq(agentJobs.id, job.id))
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
    const crashed = await createJob({ slug: `${PREFIX}sw-crashed`, content: atFm, actor: 'human' })
    // Healthy: claimed 5 min ago and its run exists.
    const ran = await createJob({ slug: `${PREFIX}sw-ran`, content: atFm, actor: 'human' })
    // Healthy: claimed 30 s ago — its wake may still be in flight.
    const fresh = await createJob({ slug: `${PREFIX}sw-fresh`, content: atFm, actor: 'human' })
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
    const skippedAt = await createJob({ slug: `${PREFIX}sw-notfired`, content: md(`trigger: at ${when}\nenabled: false`, 'N.'), actor: 'human' })
    await db().update(agentJobs).set({ firedAt: MIN5 }).where(eq(agentJobs.id, skippedAt.id))
    await db().insert(agentJobFires).values({ jobId: skippedAt.id, eventKey: 'at:not-fired', firedAt: sql`now() - interval '10 minutes'` })

    const slugs = [crashed, ran, fresh, ev, skippedAt].map(j => j.slug)
    const out = await sweepCrashedFires({ onlySlugs: slugs })
    expect(out).toEqual({ rearmed: [`${PREFIX}sw-crashed`], gaveUp: [], disabled: [`${PREFIX}sw-ran`], clearedFires: 1 })

    const c = await row(`${PREFIX}sw-crashed`)
    expect(c.enabled).toBe(true)
    expect(c.firedAt).toBeNull()
    expect(c.fireFailures).toBe(1) // a crash counts as a failed wake
    expect(c.nextRunAt!.getTime()).toBe(resolveAtInstant(when, 'UTC')!.getTime())
    const ranRow = await row(`${PREFIX}sw-ran`)
    expect(ranRow.firedAt).not.toBeNull()
    expect(ranRow.enabled).toBe(false) // it fired: the missed self-disable is done now
    expect((await row(`${PREFIX}sw-fresh`)).firedAt).not.toBeNull()
    expect((await firesFor(ev.id)).map(f => f.eventKey).sort()).toEqual(['in-flight', 'settled'])
    expect(await firesFor(skippedAt.id)).toHaveLength(1)
    expect((await row(`${PREFIX}sw-notfired`)).firedAt).not.toBeNull()

    // Idempotent: a second sweep finds nothing.
    expect(await sweepCrashedFires({ onlySlugs: slugs })).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })
    await finishJobRuns(ran.id)
  })

  it('disables a fired `at` job whose self-disable never happened, with no note, and leaves a re-armed one alone', async () => {
    const when = new Date(Date.now() + 3600_000).toISOString()
    const atFm = md(`trigger: at ${when}\nenabled: true`, 'Fired.')
    // The run landed, then the process died before the tick's setJobEnabled(false).
    const stuck = await createJob({ slug: `${PREFIX}sw-stuck`, content: atFm, actor: 'human' })
    // Same shape, but Tony re-armed it (new content) after the sweep read the row: the disable is
    // pinned to the content hash it read, so the re-arm wins.
    const rearmedByTony = await createJob({ slug: `${PREFIX}sw-stuck-rearmed`, content: atFm, actor: 'human' })
    for (const j of [stuck, rearmedByTony]) {
      await db().update(agentJobs).set({ firedAt: sql`now() - interval '5 minutes'`, nextRunAt: null }).where(eq(agentJobs.id, j.id))
      await jobRunRow(j.id)
      await finishJobRuns(j.id)
    }
    const before = (await notFiredNotes()).length
    const out = await sweepCrashedFires({ onlySlugs: [stuck.slug], mainConversationId: scratchMain })
    expect(out).toEqual({ rearmed: [], gaveUp: [], disabled: [stuck.slug], clearedFires: 0 })
    const r = await row(stuck.slug)
    expect(r.enabled).toBe(false)
    expect(r.content).toMatch(/^enabled: false$/m)
    expect(r.firedAt).not.toBeNull()
    expect((await notFiredNotes()).length).toBe(before)
    expect(await sweepCrashedFires({ onlySlugs: [stuck.slug], mainConversationId: scratchMain }))
      .toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })

    // The stale-hash disable: exactly what the sweep would call after a concurrent re-arm.
    const staleHash = (await row(rearmedByTony.slug)).contentHash
    await db().update(agentJobs).set({ content: atFm.replace('Fired.', 'Re-armed.'), contentHash: 'rearmed-by-tony' })
      .where(eq(agentJobs.id, rearmedByTony.id))
    await expect(setJobEnabled(rearmedByTony.slug, false, 'system', null, staleHash)).rejects.toBeInstanceOf(ConflictError)
    expect((await row(rearmedByTony.slug)).enabled).toBe(true)
  })

  it('keeps an unrecorded fire row whose run did land (crash between wake and run_id write)', async () => {
    const ev = await createJob({ slug: `${PREFIX}sw-landed`, content: md('trigger: event cc.session_end\nenabled: true', 'L.'), actor: 'human' })
    await db().insert(agentJobFires).values({ jobId: ev.id, eventKey: 'landed', firedAt: sql`now() - interval '10 minutes'` })
    await jobRunRow(ev.id) // created after fired_at, run_id never written
    expect(await sweepCrashedFires({ onlySlugs: [ev.slug] })).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })
    expect(await firesFor(ev.id)).toHaveLength(1)
    await finishJobRuns(ev.id)
  })

  it('the `now` seam moves the 2-minute threshold', async () => {
    const ev = await createJob({ slug: `${PREFIX}sw-now`, content: md('trigger: event cc.session_end\nenabled: true', 'N.'), actor: 'human' })
    await db().insert(agentJobFires).values({ jobId: ev.id, eventKey: 'young' })
    expect(await sweepCrashedFires({ onlySlugs: [ev.slug] })).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })
    const later = new Date(Date.now() + 3 * 60_000)
    expect(await sweepCrashedFires({ onlySlugs: [ev.slug], now: later })).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 1 })
  })

  it('scoped to nothing, it touches nothing', async () => {
    expect(await sweepCrashedFires({ onlySlugs: [] })).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })
  })
})

describe('retry cap: an `at` job gives up after MAX_FIRE_FAILURES failed wakes', () => {
  const atJob = async (slug: string) => {
    const when = new Date(Date.now() + 3600_000).toISOString()
    return createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'Capped.'), actor: 'human' })
  }
  const notesFor = async (slug: string) => (await notFiredNotes()).filter(n => n.content.includes(slug))

  it('throwing wakes: 4 failures leave it armed; the 5th disables it with one note', async () => {
    const slug = `${PREFIX}cap-throw`
    await atJob(slug)
    const tick = () => jobsTick({ onlySlugs: [slug], wakeFn: throwingWake, mainConversationId: scratchMain })
    for (let i = 1; i < MAX_FIRE_FAILURES; i++) {
      await makeDue(slug)
      await tick()
      const r = await row(slug)
      expect(r).toMatchObject({ enabled: true, firedAt: null, fireFailures: i })
    }
    expect(await notesFor(slug)).toHaveLength(0)
    await makeDue(slug)
    await tick()
    const r = await row(slug)
    expect(r.enabled).toBe(false)
    expect(r.fireFailures).toBe(MAX_FIRE_FAILURES)
    expect(r.firedAt).not.toBeNull()
    const notes = await notesFor(slug)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toContain(`did not fire: waking it failed ${MAX_FIRE_FAILURES} times in a row (queue unavailable)`)
    // Given up: no further tick claims it.
    await makeDue(slug)
    expect(await tick()).toEqual({ fired: [], skipped: [] })
  })

  it('sweep re-arms count toward the cap: the 5th gives up with the note', async () => {
    const slug = `${PREFIX}cap-sweep`
    const job = await atJob(slug)
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '5 minutes'`, nextRunAt: null, fireFailures: MAX_FIRE_FAILURES - 1 })
      .where(eq(agentJobs.id, job.id))
    const out = await sweepCrashedFires({ onlySlugs: [slug], mainConversationId: scratchMain })
    expect(out).toEqual({ rearmed: [], gaveUp: [slug], disabled: [], clearedFires: 0 })
    const r = await row(slug)
    expect(r.enabled).toBe(false)
    expect(r.fireFailures).toBe(MAX_FIRE_FAILURES)
    const notes = await notesFor(slug)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toContain(`waking it failed ${MAX_FIRE_FAILURES} times in a row`)
    // Idempotent: a disabled job is not swept again.
    expect(await sweepCrashedFires({ onlySlugs: [slug], mainConversationId: scratchMain })).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })
  })

  it('a run that is actually created resets the count', async () => {
    const slug = `${PREFIX}cap-reset`
    const job = await atJob(slug)
    await db().update(agentJobs).set({ fireFailures: MAX_FIRE_FAILURES - 1 }).where(eq(agentJobs.id, job.id))
    await makeDue(slug)
    expect((await jobsTick({ onlySlugs: [slug], wakeFn: fakeWake, mainConversationId: scratchMain })).fired).toEqual([slug])
    expect((await row(slug)).fireFailures).toBe(0)
    await finishJobRuns(job.id)
  })

  it('re-arming a given-up reminder starts the count afresh', async () => {
    const slug = `${PREFIX}cap-rearm`
    const job = await atJob(slug)
    await db().update(agentJobs).set({ fireFailures: MAX_FIRE_FAILURES }).where(eq(agentJobs.id, job.id))
    await setJobEnabled(slug, false, 'human')
    await setJobEnabled(slug, true, 'human')
    expect((await row(slug)).fireFailures).toBe(0)
  })

  it('a re-armed reminder that gives up again posts its note again', async () => {
    const slug = `${PREFIX}cap-renote`
    const job = await atJob(slug)
    const giveUp = async () => {
      await db().update(agentJobs).set({ fireFailures: MAX_FIRE_FAILURES - 1 }).where(eq(agentJobs.id, job.id))
      await makeDue(slug)
      await jobsTick({ onlySlugs: [slug], wakeFn: throwingWake, mainConversationId: scratchMain })
      expect((await row(slug)).enabled).toBe(false)
    }
    await giveUp()
    expect(await notesFor(slug)).toHaveLength(1)
    await setJobEnabled(slug, true, 'human')
    expect((await firesFor(job.id)).map(f => f.eventKey)).not.toContain('at:not-fired')
    await giveUp()
    expect(await notesFor(slug)).toHaveLength(2)
  })
})

describe('the sweep re-checks staleness in its UPDATE', () => {
  it('a job re-claimed (fresh fired_at) between the sweep\'s select and its update is left alone', async () => {
    const when = new Date(Date.now() + 3600_000).toISOString()
    const slug = `${PREFIX}sw-reclaimed`
    const job = await createJob({ slug, content: md(`trigger: at ${when}\nenabled: true`, 'R.'), actor: 'human' })
    await db().update(agentJobs).set({ firedAt: sql`now() - interval '5 minutes'`, nextRunAt: null }).where(eq(agentJobs.id, job.id))
    // Play the other process by hand: it holds the row lock and re-claims the job (fresh
    // fired_at, wake still in flight). The sweep's select sees the stale committed row; its
    // UPDATE waits for the lock, then must re-check against the fresh fired_at and skip.
    const other = new Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      await other.query('begin')
      await other.query(`select id from agent_jobs where id = $1 for update`, [job.id])
      await other.query(`update agent_jobs set fired_at = now() where id = $1`, [job.id])
      const sweep = sweepCrashedFires({ onlySlugs: [slug], mainConversationId: scratchMain })
      await new Promise(r => setTimeout(r, 500))
      await other.query('commit')
      expect(await sweep).toEqual({ rearmed: [], gaveUp: [], disabled: [], clearedFires: 0 })
    } finally {
      await other.query('rollback').catch(() => {})
      await other.end()
    }
    const r = await row(slug)
    expect(r.firedAt).not.toBeNull()
    expect(r.fireFailures).toBe(0)
  })
})
