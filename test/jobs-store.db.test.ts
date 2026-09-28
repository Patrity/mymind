// DB-backed — harness pattern from test/agent-runs.db.test.ts
//
// Cycle 74, Task 4: agent_jobs is written ONLY through store.ts. Every slug this file creates is
// prefixed `jstest-` and cleaned up by that prefix (installSeedJobs is the one exception — it
// writes REAL seed slugs like `morning-brief`, so that test records which ones already existed
// and only deletes the ones it created itself).
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentJobs, agentConfigRevisions, conversations, conversationMessages } from '../server/db/schema'
import { listRevisions } from '../server/lib/agent/config/revisions'
import { SEED_JOB_SLUGS } from '../server/lib/agent/jobs/seeds'
import {
  createJob, saveJob, getJob, setJobEnabled, revertJob, revalidateAll, installSeedJobs,
  JobValidationError, ConflictError, MAX_ENABLED_JOBS
} from '../server/lib/agent/jobs/store'

const PREFIX = 'jstest-'

function md(fm: string, body: string): string {
  return `---\n${fm}\n---\n${body}\n`
}

async function cleanup() {
  const db = useDb()
  const rows = await db.select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${PREFIX}%`))
  if (rows.length) {
    const ids = rows.map(r => r.id)
    await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
    await db.delete(agentJobs).where(inArray(agentJobs.id, ids))
  }
}
afterAll(cleanup)

describe('job store — create / validate', () => {
  it('creates a valid job: enabled, triggerKind and nextRunAt are derived, and 1 revision exists', async () => {
    await cleanup()
    const slug = `${PREFIX}create`
    const job = await createJob({
      slug,
      content: md('trigger: every 10m\nenabled: true', 'Say hello.'),
      actor: 'human'
    })
    expect(job.enabled).toBe(true)
    expect(job.triggerKind).toBe('every')
    expect(job.triggerExpr).toBe('10m')
    expect(job.nextRunAt).not.toBeNull()
    expect(job.parseError).toBeNull()
    expect(job.source).toBe('human')

    const revs = await listRevisions('job', job.id)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.actor).toBe('human')
    expect(revs[0]!.content).toBe(job.content)
  })

  it('rejects invalid content with JobValidationError and writes nothing', async () => {
    const slug = `${PREFIX}invalid`
    await expect(createJob({
      slug,
      content: md('trigger: nonsense', 'body'),
      actor: 'human'
    })).rejects.toThrow(JobValidationError)
    expect(await getJob(slug)).toBeNull()
  })
})

describe('job store — CAS', () => {
  it('saveJob with a stale hash throws ConflictError carrying the current content', async () => {
    const slug = `${PREFIX}cas`
    const job = await createJob({ slug, content: md('trigger: every 10m\nenabled: true', 'v1'), actor: 'human' })
    const updated = await saveJob(slug, md('trigger: every 10m\nenabled: true', 'v2'), job.contentHash, 'human')
    expect(updated.content).toContain('v2')

    // A second writer still holding the ORIGINAL (now stale) hash loses.
    const err = await saveJob(slug, md('trigger: every 10m\nenabled: true', 'v3'), job.contentHash, 'agent')
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as InstanceType<typeof ConflictError>).current).toEqual({ content: updated.content, contentHash: updated.contentHash })
    expect((await getJob(slug))?.content).toBe(updated.content)
  })
})

describe('job store — enabled switch', () => {
  it('setJobEnabled(false) flips only the enabled: line and clears nextRunAt', async () => {
    const slug = `${PREFIX}toggle`
    const content = md('trigger: every 10m\nenabled: true', 'Body line one.\nBody line two.')
    const job = await createJob({ slug, content, actor: 'human' })
    expect(job.nextRunAt).not.toBeNull()

    const off = await setJobEnabled(slug, false, 'human')
    expect(off.enabled).toBe(false)
    expect(off.nextRunAt).toBeNull()

    // Every other line is byte-stable.
    const otherLines = (s: string) => s.split('\n').filter(l => !l.startsWith('enabled:'))
    expect(otherLines(off.content)).toEqual(otherLines(content))
    expect(off.content).toContain('enabled: false')

    const on = await setJobEnabled(slug, true, 'human')
    expect(on.enabled).toBe(true)
    expect(on.nextRunAt).not.toBeNull()
  })
})

describe('job store — reschedule on save', () => {
  it('saving new content recomputes nextRunAt from now', async () => {
    const slug = `${PREFIX}reschedule`
    const job = await createJob({ slug, content: md('trigger: every 10m\nenabled: true', 'v1'), actor: 'human' })
    const firstNextRun = new Date(job.nextRunAt!).getTime()

    await new Promise(r => setTimeout(r, 5))
    const saved = await saveJob(slug, md('trigger: every 10m\nenabled: true', 'v2 different body'), job.contentHash, 'human')
    const secondNextRun = new Date(saved.nextRunAt!).getTime()

    // Recomputed from a LATER "now", not carried over from the first save.
    expect(secondNextRun).toBeGreaterThan(firstNextRun)
    // Within a generous tolerance of "now + 10m" (not some stale earlier schedule).
    expect(Math.abs(secondNextRun - (Date.now() + 10 * 60_000))).toBeLessThan(5_000)
  })
})

describe('job store — enabled-jobs guard', () => {
  it('rejects the 51st enabled job with a message containing 50', async () => {
    const db = useDb()
    const [before] = await db.select({ count: sql<number>`count(*)::int` }).from(agentJobs).where(eq(agentJobs.enabled, true))
    const alreadyEnabled = before?.count ?? 0
    const needed = Math.max(0, MAX_ENABLED_JOBS - alreadyEnabled)

    const slugs: string[] = []
    try {
      for (let i = 0; i < needed; i++) {
        const slug = `${PREFIX}cap-${i}`
        slugs.push(slug)
        await createJob({ slug, content: md('trigger: every 5h\nenabled: true', `cap job ${i}`), actor: 'human' })
      }

      await expect(createJob({
        slug: `${PREFIX}cap-overflow`,
        content: md('trigger: every 5h\nenabled: true', 'one too many'),
        actor: 'human'
      })).rejects.toThrow(/50/)
    } finally {
      // Clean these up now rather than waiting for afterAll — up to 50 enabled test rows would
      // otherwise sit in the shared dev DB (and skew the guard's count) for the rest of this
      // file's run. try/finally so this still runs if an assertion above fails.
      const ids = (await db.select({ id: agentJobs.id }).from(agentJobs).where(inArray(agentJobs.slug, slugs))).map(r => r.id)
      if (ids.length) await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
      await db.delete(agentJobs).where(inArray(agentJobs.slug, slugs))
    }
  })
})

describe('job store — revert', () => {
  it('revertJob restores an older revision\'s content and writes a new revision', async () => {
    const slug = `${PREFIX}revert`
    const v1 = md('trigger: every 10m\nenabled: true', 'first version')
    const job = await createJob({ slug, content: v1, actor: 'human' })
    await saveJob(slug, md('trigger: every 10m\nenabled: true', 'second version'), job.contentHash, 'human')

    const revs = await listRevisions('job', job.id)
    expect(revs).toHaveLength(2) // [second (newest), first]
    const firstRevisionId = revs[1]!.id
    expect(revs[1]!.content).toBe(v1)

    const reverted = await revertJob(slug, firstRevisionId, 'human')
    expect(reverted.content).toBe(v1)
    expect((await getJob(slug))?.content).toBe(v1)

    const revsAfter = await listRevisions('job', job.id)
    expect(revsAfter).toHaveLength(3) // create, update, revert
  })

  it('refuses to revert to a revision that does not belong to the job', async () => {
    const slugA = `${PREFIX}revert-a`
    const slugB = `${PREFIX}revert-b`
    const jobA = await createJob({ slug: slugA, content: md('trigger: every 10m\nenabled: true', 'a'), actor: 'human' })
    await createJob({ slug: slugB, content: md('trigger: every 10m\nenabled: true', 'b'), actor: 'human' })
    const revsA = await listRevisions('job', jobA.id)
    await expect(revertJob(slugB, revsA[0]!.id, 'human')).rejects.toThrow(/does not belong/)
  })
})

describe('job store — installSeedJobs', () => {
  it('is idempotent and installs its jobs disabled, without touching any seed that already existed', async () => {
    const existedBefore: Record<string, boolean> = {}
    for (const slug of SEED_JOB_SLUGS) existedBefore[slug] = (await getJob(slug)) !== null

    // try/finally: only delete the slugs THIS test installed (real pre-existing seeds are left
    // alone) — but that cleanup must run even if an assertion below fails, or a broken
    // idempotency guard would leak real-named seed rows into the shared dev DB.
    try {
      const firstRun = await installSeedJobs()
      const secondRun = await installSeedJobs()
      expect(secondRun).toBe(0) // nothing left to install after the first pass

      for (const slug of SEED_JOB_SLUGS) {
        const job = await getJob(slug)
        expect(job).not.toBeNull()
        expect(job!.enabled).toBe(false)
        expect(job!.parseError).toBeNull()
        expect(job!.source).toBe('human') // actor 'system' maps to source 'human' (not agent-authored)
      }
      expect(firstRun).toBe(Object.values(existedBefore).filter(v => !v).length)
    } finally {
      const createdSlugs = SEED_JOB_SLUGS.filter(slug => !existedBefore[slug])
      if (createdSlugs.length) {
        const db = useDb()
        const ids = (await db.select({ id: agentJobs.id }).from(agentJobs).where(inArray(agentJobs.slug, createdSlugs))).map(r => r.id)
        await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
        await db.delete(agentJobs).where(inArray(agentJobs.slug, createdSlugs))
      }
    }
  })
})

describe('job store — revalidateAll (boot)', () => {
  it('sets parse_error on externally-broken content, notifies main only on the null->non-null transition, and clears on repair', async () => {
    const db = useDb()
    const slug = `${PREFIX}revalidate`
    const job = await createJob({ slug, content: md('trigger: every 10m\nenabled: true', 'body text'), actor: 'human' })

    // A fake "main" thread — revalidateAll's test seam means it never touches the REAL main
    // conversation.
    const [fakeMain] = await db.insert(conversations).values({ title: 'JSTEST fake main' }).returning({ id: conversations.id })
    const fakeMainId = fakeMain!.id
    const countNotes = async () => {
      const rows = await db.select({ id: conversationMessages.id }).from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, fakeMainId), eq(conversationMessages.role, 'event')))
      return rows.length
    }

    try {
      // Simulate an external break (e.g. a registry model removed) by writing invalid content
      // straight to the row — store.ts itself would reject this at write time; revalidateAll is
      // the one path that must tolerate content that is already invalid.
      await db.update(agentJobs).set({ content: md('trigger: nonsense', 'body') }).where(eq(agentJobs.id, job.id))

      const changed1 = await revalidateAll({ mainConversationId: fakeMainId })
      expect(changed1).toBeGreaterThanOrEqual(1)
      const broken = await getJob(slug)
      expect(broken?.parseError).toMatch(/unknown trigger/)
      expect(broken?.nextRunAt).toBeNull()
      expect(await countNotes()).toBe(1)

      // Re-running against the SAME still-broken content must not re-notify.
      await revalidateAll({ mainConversationId: fakeMainId })
      expect(await countNotes()).toBe(1)

      // Repair it (again, simulating an external fix) — parse_error clears and nextRunAt comes
      // back, but there is still no SECOND note (only the invalid transition notifies).
      await db.update(agentJobs).set({ content: md('trigger: every 10m\nenabled: true', 'body text') }).where(eq(agentJobs.id, job.id))
      await revalidateAll({ mainConversationId: fakeMainId })
      const fixed = await getJob(slug)
      expect(fixed?.parseError).toBeNull()
      expect(fixed?.nextRunAt).not.toBeNull()
      expect(await countNotes()).toBe(1)
    } finally {
      await db.delete(conversations).where(eq(conversations.id, fakeMainId))
    }
  })
})
