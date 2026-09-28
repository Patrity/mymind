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

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentJobs, agentConfigRevisions, agentRuns, conversations } from '../server/db/schema'
import { listRevisions } from '../server/lib/agent/config/revisions'
import { createJob as storeCreateJob, getJob as storeGetJob } from '../server/lib/agent/jobs/store'
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
