// DB-backed — harness pattern from test/agent-runs.db.test.ts
//
// Cycle 74, Task 8: Bridget's job tools (server/lib/agent/tools/jobs.ts), wrapping jobs/store.ts
// + jobs/tick.ts. Every slug this file creates is prefixed `jstools-` and cleaned up by that
// prefix, EXCEPT schedule_wake's `reminder-<hex>` slugs, which are collected explicitly as
// they're created and cleaned up by exact id.
//
// run_job's SUCCESS path (ok:true, a real runId) is deliberately NOT exercised here: the tool
// calls runJobNow(slug) with no wakeFn override, so a real success run would call the real
// wake() -> enqueue() and insert a queued run against whatever session the job's `thread`
// resolves to (main, for a default job) — on the SHARED dev DB, a live dev server elsewhere
// could then actually pick that up and execute it. Only the skip paths (not_found/disabled/
// invalid/overlap) are covered — none of them reach wake().
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi, onTestFinished } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentJobs, agentConfigRevisions, agentRuns, conversations } from '../server/db/schema'
import { listRevisions } from '../server/lib/agent/config/revisions'
import {
  createJob as storeCreateJob, getJob as storeGetJob, deleteJob as storeDeleteJob,
  countAgentAtCreatesLastHour, MAX_AGENT_AT_CREATES_PER_HOUR
} from '../server/lib/agent/jobs/store'
import * as jobsStore from '../server/lib/agent/jobs/store'
import { createRun } from '../server/lib/agent/runtime/runs'
import { jobTools } from '../server/lib/agent/tools/jobs'
import type { ToolContext } from '../server/lib/agent/types'

const PREFIX = 'jstools-'
const ctx: ToolContext = { signal: new AbortController().signal }
const T = Object.fromEntries(jobTools.map(t => [t.name, t])) as Record<string, (typeof jobTools)[number]>

function md(fm: string, body: string): string {
  return `---\n${fm}\n---\n${body}\n`
}

const reminderSlugs: string[] = []
const convIds: string[] = []

async function cleanup() {
  const db = useDb()
  const slugs = await db.select({ id: agentJobs.id, slug: agentJobs.slug }).from(agentJobs)
    .where(like(agentJobs.slug, `${PREFIX}%`))
  const reminderRows = reminderSlugs.length
    ? await db.select({ id: agentJobs.id }).from(agentJobs).where(inArray(agentJobs.slug, reminderSlugs))
    : []
  const ids = [...slugs.map(r => r.id), ...reminderRows.map(r => r.id)]
  if (ids.length) {
    await db.delete(agentRuns).where(inArray(agentRuns.jobId, ids))
    await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
    await db.delete(agentJobs).where(inArray(agentJobs.id, ids))
  }
  if (convIds.length) await db.delete(conversations).where(inArray(conversations.id, convIds))
}
afterAll(cleanup)

describe('job tools — list_jobs / get_job', () => {
  it('list_jobs includes a created job\'s slug/enabled/description; get_job returns content + status + fire times', async () => {
    const slug = `${PREFIX}list-get`
    await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'hello'), actor: 'human' })

    const listed = await T.list_jobs!.handler({}, ctx)
    const jobs = (listed.result as { jobs: { slug: string, enabled: boolean, description: string | null }[] }).jobs
    const found = jobs.find(j => j.slug === slug)
    expect(found).toBeDefined()
    expect(found!.enabled).toBe(true)
    expect(found!.description).toMatch(/every 10 minutes/)

    const got = await T.get_job!.handler({ slug }, ctx)
    const res = got.result as { ok: boolean, content: string, status: { enabled: boolean }, nextFireTimes: string[] }
    expect(res.ok).toBe(true)
    expect(res.content).toContain('hello')
    expect(res.status.enabled).toBe(true)
    expect(res.nextFireTimes.length).toBe(5)
  })

  it('get_job on an unknown slug returns ok:false not_found', async () => {
    const got = await T.get_job!.handler({ slug: `${PREFIX}does-not-exist` }, ctx)
    expect((got.result as { ok: boolean, error: string }).ok).toBe(false)
    expect((got.result as { ok: boolean, error: string }).error).toBe('not_found')
  })
})

describe('job tools — create_job', () => {
  it('creates a valid job as actor agent, with one agent revision', async () => {
    const slug = `${PREFIX}create-ok`
    const out = await T.create_job!.handler({ slug, content: md('trigger: every 10m\nenabled: true', 'do the thing') }, ctx)
    const res = out.result as { ok: boolean, slug: string }
    expect(res.ok).toBe(true)
    expect(res.slug).toBe(slug)

    const job = await storeGetJob(slug)
    expect(job).not.toBeNull()
    expect(job!.source).toBe('agent')
    const revs = await listRevisions('job', job!.id)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.actor).toBe('agent')
  })

  it('rejects invalid content with ok:false and writes nothing (mutation-checked below)', async () => {
    const slug = `${PREFIX}create-invalid`
    const out = await T.create_job!.handler({ slug, content: md('trigger: nonsense', 'body') }, ctx)
    const res = out.result as { ok: boolean, error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(await storeGetJob(slug)).toBeNull()
  })

  it('a duplicate slug returns ok:false with the current content, not a thrown conflict', async () => {
    const slug = `${PREFIX}create-dup`
    await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: false', 'v1'), actor: 'human' })
    const out = await T.create_job!.handler({ slug, content: md('trigger: every 10m\nenabled: false', 'v2') }, ctx)
    const res = out.result as { ok: boolean, error?: string, current?: { content: string } }
    expect(res.ok).toBe(false)
    expect(res.current?.content).toContain('v1')
  })
})

describe('job tools — edit_job', () => {
  it('find/replace changes one line and writes an agent revision', async () => {
    const slug = `${PREFIX}edit-replace`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'Body line one.\nBody line two.'), actor: 'human' })

    const out = await T.edit_job!.handler({ slug, old_string: 'line one', new_string: 'line ONE' }, ctx)
    const res = out.result as { ok: boolean, slug: string }
    expect(res.ok).toBe(true)

    const updated = await storeGetJob(slug)
    expect(updated!.content).toContain('line ONE')
    expect(updated!.content).toContain('line two')

    const revs = await listRevisions('job', job.id)
    expect(revs).toHaveLength(2) // create (human), edit (agent)
    expect(revs[0]!.actor).toBe('agent')
  })

  it('an ambiguous old_string returns ok:false and writes nothing', async () => {
    const slug = `${PREFIX}edit-ambiguous`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'dup dup dup'), actor: 'human' })

    const out = await T.edit_job!.handler({ slug, old_string: 'dup', new_string: 'DUP' }, ctx)
    const res = out.result as { ok: boolean, error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe('ambiguous_match')

    // Nothing written: content and revision count both unchanged.
    const after = await storeGetJob(slug)
    expect(after!.content).toBe(job.content)
    expect(after!.contentHash).toBe(job.contentHash)
    const revs = await listRevisions('job', job.id)
    expect(revs).toHaveLength(1)
  })

  it('replace_all replaces every occurrence', async () => {
    const slug = `${PREFIX}edit-replace-all`
    await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'dup dup dup'), actor: 'human' })
    const out = await T.edit_job!.handler({ slug, old_string: 'dup', new_string: 'X', replace_all: true }, ctx)
    expect((out.result as { ok: boolean }).ok).toBe(true)
    const after = await storeGetJob(slug)
    expect(after!.content).toContain('X X X')
  })

  it('full `content` replaces the whole file', async () => {
    const slug = `${PREFIX}edit-full`
    await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'v1'), actor: 'human' })
    const out = await T.edit_job!.handler({ slug, content: md('trigger: every 15m\nenabled: true', 'v2') }, ctx)
    expect((out.result as { ok: boolean }).ok).toBe(true)
    const after = await storeGetJob(slug)
    expect(after!.content).toContain('v2')
    expect(after!.triggerExpr).toBe('15m')
  })

  it('invalid replacement content is rejected and writes nothing', async () => {
    const slug = `${PREFIX}edit-invalid`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'v1'), actor: 'human' })
    const out = await T.edit_job!.handler({ slug, content: md('trigger: nonsense', 'v2') }, ctx)
    expect((out.result as { ok: boolean }).ok).toBe(false)
    const after = await storeGetJob(slug)
    expect(after!.contentHash).toBe(job.contentHash)
  })

  it('edit_job on an unknown slug returns ok:false not_found', async () => {
    const out = await T.edit_job!.handler({ slug: `${PREFIX}edit-missing`, content: 'x' }, ctx)
    expect((out.result as { ok: boolean, error: string }).error).toBe('not_found')
  })

  it('neither content nor old_string/new_string returns a missing_args error', async () => {
    const slug = `${PREFIX}edit-missing-args`
    await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'v1'), actor: 'human' })
    const out = await T.edit_job!.handler({ slug }, ctx)
    expect((out.result as { ok: boolean, error: string }).error).toBe('missing_args')
  })

  it('review fix round 1: a job deleted between the read and the write returns ok:false not_found, not a raw exception', async () => {
    const slug = `${PREFIX}edit-vanish`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'v1'), actor: 'human' })
    // getJob returns the STALE (pre-delete) job so edit_job's own not-found check passes and it
    // proceeds to saveJob — reproducing the real race (deleted between the read and the write
    // landing), not just "never existed". Restored even if an assertion below throws.
    const spy = vi.spyOn(jobsStore, 'getJob').mockResolvedValueOnce(job)
    try {
      await storeDeleteJob(slug) // the row is genuinely gone by the time saveJob's CAS runs
      const out = await T.edit_job!.handler({ slug, content: md('trigger: every 10m\nenabled: true', 'v2') }, ctx)
      const res = out.result as { ok: boolean, error: string }
      expect(res.ok).toBe(false)
      expect(res.error).toBe('not_found')
    } finally {
      spy.mockRestore()
      // Same leak the delete_job test guards against: the job is already gone, so afterAll's
      // slug-prefix sweep can never find its revision again — clean it explicitly.
      await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
    }
  })
})

describe('job tools — delete_job', () => {
  it('deletes an existing job', async () => {
    const slug = `${PREFIX}delete-ok`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'x'), actor: 'human' })
    try {
      const out = await T.delete_job!.handler({ slug }, ctx)
      expect((out.result as { ok: boolean }).ok).toBe(true)
      expect(await storeGetJob(slug)).toBeNull()
    } finally {
      // The job row is already gone (that's the point of this test) — the main afterAll sweep
      // finds rows by CURRENT slug, so it can never see this one again. Its revision (written
      // before the delete) would otherwise leak permanently; clean it explicitly here.
      await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
    }
  })

  it('delete_job on an unknown slug returns ok:false not_found', async () => {
    const out = await T.delete_job!.handler({ slug: `${PREFIX}delete-missing` }, ctx)
    const res = out.result as { ok: boolean, error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_found')
  })
})

describe('job tools — run_job (skip paths only — see file header)', () => {
  it('not_found', async () => {
    const out = await T.run_job!.handler({ slug: `${PREFIX}run-missing` }, ctx)
    const res = out.result as { ok: boolean, error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no job named/)
  })

  it('disabled', async () => {
    const slug = `${PREFIX}run-disabled`
    await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: false', 'x'), actor: 'human' })
    const out = await T.run_job!.handler({ slug }, ctx)
    const res = out.result as { ok: boolean, error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe('disabled')
  })

  it('invalid (content no longer parses at fire time)', async () => {
    const slug = `${PREFIX}run-invalid`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'x'), actor: 'human' })
    // Simulate externally-broken content (same technique as store.ts's revalidateAll tests) —
    // bypasses store.ts's own write-time validation, which is the point: prove run_job handles a
    // row that is enabled but whose content no longer parses.
    await useDb().update(agentJobs).set({ content: md('trigger: nonsense', 'x') }).where(eq(agentJobs.id, job.id))
    const out = await T.run_job!.handler({ slug }, ctx)
    const res = out.result as { ok: boolean, error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe('invalid')
  })

  it('overlap (a previous run is still queued/running)', async () => {
    const slug = `${PREFIX}run-overlap`
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: true', 'x'), actor: 'human' })
    const [c] = await useDb().insert(conversations).values({ title: 'JSTOOLS-TEST overlap' }).returning()
    convIds.push(c!.id)
    await createRun({
      conversationId: c!.id, sessionKey: `isolated:${slug}`, trigger: 'wake', profile: 'headless',
      input: { text: 'x', modality: 'text' }, jobId: job.id
    })
    const out = await T.run_job!.handler({ slug }, ctx)
    const res = out.result as { ok: boolean, error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe('overlap')
  })
})

describe('job tools — schedule_wake', () => {
  it('"in 10m" creates an enabled `at` job about 10 minutes out, context light', async () => {
    const before = Date.now()
    const out = await T.schedule_wake!.handler({ when: 'in 10m', prompt: 'stretch' }, ctx)
    const res = out.result as { ok: boolean, slug: string, at: string }
    expect(res.ok).toBe(true)
    expect(res.slug).toMatch(/^reminder-[0-9a-f]{6}$/)
    reminderSlugs.push(res.slug)

    const job = await storeGetJob(res.slug)
    expect(job).not.toBeNull()
    expect(job!.enabled).toBe(true)
    expect(job!.triggerKind).toBe('at')
    expect(job!.content).toContain('context: light')
    expect(job!.content).toContain('stretch')
    const at = new Date(res.at).getTime()
    expect(at - before).toBeGreaterThan(9 * 60_000)
    expect(at - before).toBeLessThan(11 * 60_000)
  })

  it('an unparseable `when` returns ok:false and creates nothing', async () => {
    const before = await useDb().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, 'reminder-%'))
    const out = await T.schedule_wake!.handler({ when: 'whenever', prompt: 'x' }, ctx)
    expect((out.result as { ok: boolean, error: string }).ok).toBe(false)
    const after = await useDb().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, 'reminder-%'))
    expect(after.length).toBe(before.length)
  })

  it('a past `when` is rejected', async () => {
    const out = await T.schedule_wake!.handler({ when: '2020-01-01T00:00:00Z', prompt: 'x' }, ctx)
    expect((out.result as { ok: boolean }).ok).toBe(false)
  })

  it('thread:isolated is written into the frontmatter', async () => {
    const out = await T.schedule_wake!.handler({ when: 'in 15m', prompt: 'x', thread: 'isolated' }, ctx)
    const res = out.result as { ok: boolean, slug: string }
    expect(res.ok).toBe(true)
    reminderSlugs.push(res.slug)
    const job = await storeGetJob(res.slug)
    expect(job!.content).toContain('thread: isolated')
  })
})

// ---- cycle 74 final review fix wave --------------------------------------------------------

describe('job tools — final review fixes', () => {
  async function jobFiredRun(jobId: string | null): Promise<string> {
    const [c] = await useDb().insert(conversations).values({ title: 'JSTOOLS-TEST fired' }).returning()
    convIds.push(c!.id)
    const run = await createRun({
      conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'wake', profile: 'headless',
      input: { text: 'x', modality: 'text' }, jobId
    })
    // Finished at once: a 'queued' row must never be left for a live pump to pick up.
    await useDb().update(agentRuns).set({ status: 'done' }).where(eq(agentRuns.id, run.id))
    return run.id
  }

  it('I1: run_job is refused (explained, not thrown) when the calling run was fired by a job', async () => {
    const firing = await storeCreateJob({ slug: `${PREFIX}i1-firing`, content: md('trigger: every 10m\nenabled: false', 'A.'), actor: 'human' })
    const target = `${PREFIX}i1-target`
    await storeCreateJob({ slug: target, content: md('trigger: every 10m\nenabled: false', 'B.'), actor: 'human' })
    const inJob = await T.run_job!.handler({ slug: target }, { ...ctx, runId: await jobFiredRun(firing.id) })
    expect(inJob.result).toMatchObject({ ok: false, error: 'refused_in_job_run' })
    expect((inJob.result as { message: string }).message).toMatch(/job started/)
    // A run no job fired is not refused (it reaches the normal checks: the target is disabled).
    const plain = await T.run_job!.handler({ slug: target }, { ...ctx, runId: await jobFiredRun(null) })
    expect(plain.result).toMatchObject({ ok: false, error: 'disabled' })
    // No run id (MCP) is not refused either.
    expect((await T.run_job!.handler({ slug: target }, ctx)).result).toMatchObject({ ok: false, error: 'disabled' })
  })

  it('I1: schedule_wake needs at least 5 minutes of lead; an agent-written `at` via create_job too', async () => {
    const soon = await T.schedule_wake!.handler({ when: 'in 1m', prompt: 'again' }, ctx)
    if ((soon.result as { ok: boolean, slug?: string }).ok) reminderSlugs.push((soon.result as { slug: string }).slug)
    expect(soon.result).toMatchObject({ ok: false })
    expect((soon.result as { error: string }).error).toMatch(/at least 5 minutes/)
    const at = new Date(Date.now() + 2 * 60_000).toISOString()
    const viaCreate = await T.create_job!.handler({ slug: `${PREFIX}i1-soon`, content: md(`trigger: at ${at}\nenabled: true`, 'x') }, ctx)
    expect((viaCreate.result as { error: string }).error).toMatch(/at least 5 minutes/)
    expect(await storeGetJob(`${PREFIX}i1-soon`)).toBeNull()
    // A human may still set a near time.
    const human = await storeCreateJob({ slug: `${PREFIX}i1-human-soon`, content: md(`trigger: at ${at}\nenabled: true`, 'x'), actor: 'human' })
    expect(human.enabled).toBe(true)
  })

  it('I1: at most 10 agent-created `at` jobs per rolling hour — deleting them does not reset the count', async () => {
    const baseline = await countAgentAtCreatesLastHour()
    const room = MAX_AGENT_AT_CREATES_PER_HOUR - baseline
    expect(room).toBeGreaterThan(0) // shared dev DB: someone else's burst would make this moot
    const at = (i: number) => new Date(Date.now() + (30 + i) * 60_000).toISOString()
    const made: string[] = []
    let deletedId: string | null = null
    try {
      for (let i = 0; i < room; i++) {
        const slug = `${PREFIX}i1-cap-${i}`
        const out = await T.create_job!.handler({ slug, content: md(`trigger: at ${at(i)}\nenabled: false`, 'x') }, ctx)
        expect(out.result).toMatchObject({ ok: true })
        made.push(slug)
      }
      // Deleting one frees nothing: the count is over creations (first revisions), not live rows.
      deletedId = (await storeGetJob(made[0]!))!.id
      await T.delete_job!.handler({ slug: made[0]! }, ctx)
      const over = await T.schedule_wake!.handler({ when: 'in 30m', prompt: 'one too many' }, ctx)
      if ((over.result as { ok: boolean, slug?: string }).ok) reminderSlugs.push((over.result as { slug: string }).slug)
      expect(over.result).toMatchObject({ ok: false })
      expect((over.result as { error: string }).error).toMatch(/at most 10/)
      // Non-`at` jobs are not capped.
      const cron = await T.create_job!.handler({ slug: `${PREFIX}i1-cap-cron`, content: md('trigger: every 10m\nenabled: false', 'x') }, ctx)
      expect(cron.result).toMatchObject({ ok: true })
    } finally {
      // The deleted job's revisions are unreachable by slug — remove them by its id.
      if (deletedId) await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, deletedId)))
    }
  })

  it('M3: agent revisions carry the calling run id', async () => {
    const runId = await jobFiredRun(null)
    const slug = `${PREFIX}m3-runid`
    await T.create_job!.handler({ slug, content: md('trigger: every 10m\nenabled: false', 'v1') }, { ...ctx, runId })
    await T.edit_job!.handler({ slug, old_string: 'v1', new_string: 'v2' }, { ...ctx, runId })
    const job = await storeGetJob(slug)
    const revs = await useDb().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job!.id)))
    expect(revs).toHaveLength(2)
    expect(revs.every(r => r.runId === runId && r.actor === 'agent')).toBe(true)
  })

  it('I2: delete_job records a final agent revision, and its undo restores the SAME id with its history', async () => {
    const slug = `${PREFIX}i2-undo`
    const runId = await jobFiredRun(null)
    const job = await storeCreateJob({ slug, content: md('trigger: every 10m\nenabled: false', 'keep me'), actor: 'human' })
    onTestFinished(async () => {
      if ((await storeGetJob(slug))?.id !== job.id) await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
    })
    const out = await T.delete_job!.handler({ slug }, { ...ctx, runId })
    expect(out.result).toMatchObject({ ok: true })
    const revs = await useDb().select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
    expect(revs).toHaveLength(2)
    expect(revs.some(r => r.actor === 'agent' && r.runId === runId && r.content === job.content)).toBe(true)
    await out.undo!()
    const back = await storeGetJob(slug)
    expect(back?.id).toBe(job.id)
    expect(await listRevisions('job', job.id)).toHaveLength(3)
  })
})
