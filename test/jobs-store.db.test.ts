// DB-backed — harness pattern from test/agent-runs.db.test.ts
//
// Cycle 74, Task 4: agent_jobs is written ONLY through store.ts. Every slug this file creates is
// prefixed `jstest-` and cleaned up by that prefix (installSeedJobs is the one exception — it
// writes REAL seed slugs like `morning-brief`, so that test records which ones already existed
// and only deletes the ones it created itself).
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi, onTestFinished } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

// Cycle 75: the store's "deliver channel must be set up" check reads the channel config. Stubbed
// (never written): the dev DB is shared, and enabling iMessage there — even for a moment — would
// switch it on for every live dev server using it.
const chan = vi.hoisted(() => ({ imessage: false, email: false, loads: 0 }))
vi.mock('../server/lib/channels/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/lib/channels/config')>()),
  loadChannelsConfig: async () => {
    chan.loads++
    return {
      imessage: { enabled: chan.imessage, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: [], defaultHandle: null, defaultChatGuid: null },
      email: { enabled: chan.email, to: null },
      presenceAwayMinutes: 10
    }
  }
}))

import { Client } from 'pg'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentJobs, agentConfigRevisions, conversations, conversationMessages } from '../server/db/schema'
import { listRevisions } from '../server/lib/agent/config/revisions'
import { SEED_JOB_SLUGS } from '../server/lib/agent/jobs/seeds'
import {
  createJob, saveJob, getJob, setJobEnabled, revertJob, revalidateAll, installSeedJobs,
  deleteJob, restoreJob, rederiveDefaultTimezone,
  JobValidationError, ConflictError, MAX_ENABLED_JOBS, MAX_ENABLED_LOCK_KEY
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

describe('job store — enabled-jobs guard race (review fix round 1, item 3)', () => {
  // A genuine concurrent-timing race (two transactions each reading the enabled count before
  // either writes) is too fast on local Postgres (sub-millisecond round trips) to force
  // reliably with a bare Promise.all — verified empirically: 5 concurrent createJob calls at the
  // cap boundary consistently let exactly one through even with the advisory lock DELETED from
  // the source, making that shape of test pass regardless of the fix (vacuous). Instead: hold the
  // SAME fixed lock key manually with a raw client and prove createJob's write actually blocks
  // behind it until released — deterministic, not timing-dependent.
  it('actually takes pg_advisory_xact_lock(MAX_ENABLED_LOCK_KEY) around the enabled-count check + write', async () => {
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock($1)', [MAX_ENABLED_LOCK_KEY])

    const slug = `${PREFIX}lock-holds`
    let settled = false
    const pending = createJob({ slug, content: md('trigger: every 10m\nenabled: true', 'x'), actor: 'human' })
      .then(
        (r) => {
          settled = true
          return r
        },
        (e: unknown) => {
          settled = true
          throw e
        }
      )
    pending.catch(() => {}) // avoid an unhandled-rejection warning if an assertion below throws first

    try {
      await new Promise(r => setTimeout(r, 300))
      expect(settled).toBe(false) // still blocked behind the held lock, 300ms later

      await holder.query('COMMIT') // releases the advisory lock
      const result = await pending
      expect(settled).toBe(true)
      expect(result.slug).toBe(slug)
    } finally {
      await holder.query('COMMIT').catch(() => {}) // no-op if already committed above
      await holder.end().catch(() => {})
      await pending.catch(() => {}) // let the (now unblocked) write finish before cleaning up rows
      const db = useDb()
      const ids = (await db.select({ id: agentJobs.id }).from(agentJobs).where(eq(agentJobs.slug, slug))).map(r => r.id)
      if (ids.length) await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
      await db.delete(agentJobs).where(eq(agentJobs.slug, slug))
    }
  })

  it('lets exactly one concurrent create through the last enabled slot (integration sanity check — not the primary proof above)', async () => {
    const db = useDb()
    const [before] = await db.select({ count: sql<number>`count(*)::int` }).from(agentJobs).where(eq(agentJobs.enabled, true))
    const alreadyEnabled = before?.count ?? 0
    const room = Math.max(0, MAX_ENABLED_JOBS - alreadyEnabled)
    const fillerSlugs: string[] = []
    const raceSlugs = Array.from({ length: 5 }, (_, i) => `${PREFIX}race-${i}`)
    try {
      for (let i = 0; i < room - 1; i++) {
        const slug = `${PREFIX}race-filler-${i}`
        fillerSlugs.push(slug)
        await createJob({ slug, content: md('trigger: every 5h\nenabled: true', `filler ${i}`), actor: 'human' })
      }

      const results = await Promise.allSettled(raceSlugs.map(slug => createJob({
        slug, content: md('trigger: every 5h\nenabled: true', 'race'), actor: 'human'
      })))
      const succeeded = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(raceSlugs.length - 1)
      for (const f of failed) expect(f.reason).toBeInstanceOf(JobValidationError)

      const [after] = await db.select({ count: sql<number>`count(*)::int` }).from(agentJobs).where(eq(agentJobs.enabled, true))
      expect(after?.count ?? 0).toBe(MAX_ENABLED_JOBS)
    } finally {
      const allSlugs = [...fillerSlugs, ...raceSlugs]
      const ids = (await db.select({ id: agentJobs.id }).from(agentJobs).where(inArray(agentJobs.slug, allSlugs))).map(r => r.id)
      if (ids.length) await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
      await db.delete(agentJobs).where(inArray(agentJobs.slug, allSlugs))
    }
  })
})

describe('job store — create/create race on one slug (review fix round 1, item 4)', () => {
  it('maps the loser of a concurrent create on the SAME slug to ConflictError, not a raw Postgres error', async () => {
    const slug = `${PREFIX}race-slug`
    try {
      const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createJob({
        slug, content: md('trigger: every 10m\nenabled: false', `attempt ${i}`), actor: 'human'
      })))
      const succeeded = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(4)
      for (const f of failed) expect(f.reason).toBeInstanceOf(ConflictError)

      // Exactly one row landed — the loser's write never happened.
      const rows = await useDb().select().from(agentJobs).where(eq(agentJobs.slug, slug))
      expect(rows).toHaveLength(1)
    } finally {
      const db = useDb()
      const ids = (await db.select({ id: agentJobs.id }).from(agentJobs).where(eq(agentJobs.slug, slug))).map(r => r.id)
      if (ids.length) await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
      await db.delete(agentJobs).where(eq(agentJobs.slug, slug))
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

    // Review fix round 1, item 2: `onlyIds` scopes revalidateAll to rows THIS test created —
    // the shared dev DB may hold other real jobs, and without this seam `changed` could not be
    // asserted exactly (some other row's validity might independently flip mid-run).
    const onlyIds = [job.id]

    try {
      // Simulate an external break (e.g. a registry model removed) by writing invalid content
      // straight to the row — store.ts itself would reject this at write time; revalidateAll is
      // the one path that must tolerate content that is already invalid.
      await db.update(agentJobs).set({ content: md('trigger: nonsense', 'body') }).where(eq(agentJobs.id, job.id))

      const changed1 = await revalidateAll({ mainConversationId: fakeMainId, onlyIds })
      expect(changed1).toBe(1)
      const broken = await getJob(slug)
      expect(broken?.parseError).toMatch(/unknown trigger/)
      expect(broken?.nextRunAt).toBeNull()
      expect(await countNotes()).toBe(1)

      // Re-running against the SAME still-broken content must not re-notify, and — scoped to
      // exactly this one row — must report 0 jobs changed (nothing transitioned).
      const changed2 = await revalidateAll({ mainConversationId: fakeMainId, onlyIds })
      expect(changed2).toBe(0)
      expect(await countNotes()).toBe(1)

      // Repair it (again, simulating an external fix) — parse_error clears and nextRunAt comes
      // back, but there is still no SECOND note (only the invalid transition notifies).
      await db.update(agentJobs).set({ content: md('trigger: every 10m\nenabled: true', 'body text') }).where(eq(agentJobs.id, job.id))
      const changed3 = await revalidateAll({ mainConversationId: fakeMainId, onlyIds })
      expect(changed3).toBe(1)
      const fixed = await getJob(slug)
      expect(fixed?.parseError).toBeNull()
      expect(fixed?.nextRunAt).not.toBeNull()
      expect(await countNotes()).toBe(1)
    } finally {
      await db.delete(conversations).where(eq(conversations.id, fakeMainId))
    }
  })

  it('review fix round 1, item 6: one job\'s notify failure does not abort the rest of the pass', async () => {
    const db = useDb()
    const slugA = `${PREFIX}revalidate-notify-a`
    const slugB = `${PREFIX}revalidate-notify-b`
    const jobA = await createJob({ slug: slugA, content: md('trigger: every 10m\nenabled: true', 'a'), actor: 'human' })
    const jobB = await createJob({ slug: slugB, content: md('trigger: every 10m\nenabled: true', 'b'), actor: 'human' })
    try {
      await db.update(agentJobs).set({ content: md('trigger: nonsense', 'a') }).where(eq(agentJobs.id, jobA.id))
      await db.update(agentJobs).set({ content: md('trigger: nonsense', 'b') }).where(eq(agentJobs.id, jobB.id))

      // A well-formed but NON-EXISTENT conversation id: appendEvent's insert violates the
      // conversation_messages -> conversations foreign key and throws for EVERY job's notify in
      // this pass (both A and B transition null -> non-null). Without the try/catch, the first
      // throw would abort the loop and job B would never get its parse_error set.
      const bogusMainId = '00000000-0000-0000-0000-000000000000'
      const changed = await revalidateAll({ mainConversationId: bogusMainId, onlyIds: [jobA.id, jobB.id] })

      expect(changed).toBe(2)
      expect((await getJob(slugA))?.parseError).toMatch(/unknown trigger/)
      expect((await getJob(slugB))?.parseError).toMatch(/unknown trigger/)
    } finally {
      const ids = [jobA.id, jobB.id]
      await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
      await db.delete(agentJobs).where(inArray(agentJobs.id, ids))
    }
  })
})

// ---- cycle 74 final review fix wave --------------------------------------------------------

describe('job store — final review fixes', () => {
  const future = () => new Date(Date.now() + 3 * 3600_000).toISOString()
  const past = () => new Date(Date.now() - 3600_000).toISOString()

  it('M4: a system write keeps the author\'s source — an agent reminder stays `agent` after the tick disables it', async () => {
    const slug = `${PREFIX}m4-source`
    await createJob({ slug, content: md(`trigger: at ${future()}\nenabled: true`, 'Ping.'), actor: 'agent' })
    const off = await setJobEnabled(slug, false, 'system')
    expect(off.source).toBe('agent')
    // …and a human edit still relabels it (source = who authored the current content).
    const human = await saveJob(slug, md(`trigger: at ${future()}\nenabled: false`, 'Ping 2.'), off.contentHash, 'human')
    expect(human.source).toBe('human')
    const sys = await setJobEnabled(slug, false, 'system')
    expect(sys.source).toBe('human')
  })

  it('M5: disabling always succeeds, even when the content would no longer validate (unknown model)', async () => {
    const slug = `${PREFIX}m5-disable`
    const job = await createJob({ slug, content: md('trigger: every 10m\nenabled: true', 'Hi.'), actor: 'human' })
    // A model that has left the registry: the content is stored as-is (the hash is left alone,
    // so the CAS still matches), exactly the state revalidateAll would later flag.
    const pinned = md('trigger: every 10m\nenabled: true\nmodel: jstest-no-such-model', 'Hi.')
    await useDb().update(agentJobs).set({ content: pinned }).where(eq(agentJobs.id, job.id))
    const off = await setJobEnabled(slug, false, 'human')
    expect(off.enabled).toBe(false)
    expect(off.nextRunAt).toBeNull()
    expect(off.content).toMatch(/^enabled: false$/m)
    expect(off.content).toContain('model: jstest-no-such-model')
    const revs = await listRevisions('job', job.id)
    expect(revs[0]!.content).toBe(off.content)
    // Enabling it again still validates.
    await expect(setJobEnabled(slug, true, 'human')).rejects.toBeInstanceOf(JobValidationError)
  })

  it('M6: an enabled `at` job in the past is a validation error; disabled it saves', async () => {
    const slug = `${PREFIX}m6-past`
    await expect(createJob({ slug, content: md(`trigger: at ${past()}\nenabled: true`, 'Late.'), actor: 'human' }))
      .rejects.toThrow(/in the past/)
    expect(await getJob(slug)).toBeNull()
    const off = await createJob({ slug, content: md(`trigger: at ${past()}\nenabled: false`, 'Late.'), actor: 'human' })
    expect(off.enabled).toBe(false)
    await expect(setJobEnabled(slug, true, 'human')).rejects.toThrow(/in the past/)
    expect((await getJob(slug))!.enabled).toBe(false)
  })

  it('I2: deleteJob records a final revision; restoreJob brings it back under the SAME id with its history', async () => {
    const slug = `${PREFIX}i2-delete`
    const job = await createJob({ slug, content: md('trigger: every 10m\nenabled: false', 'v1'), actor: 'human' })
    // The job is deleted mid-test: if anything below fails, the prefix sweep can't find its
    // revisions again, so they go by id.
    onTestFinished(async () => {
      if ((await getJob(slug))?.id !== job.id) await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, job.id)))
    })
    const v2 = await saveJob(slug, md('trigger: every 10m\nenabled: false', 'v2'), job.contentHash, 'human')
    const runId = '00000000-0000-4000-8000-00000000abcd'
    expect(await deleteJob(slug, { actor: 'agent', runId })).toBe(true)
    expect(await getJob(slug)).toBeNull()
    const afterDelete = await listRevisions('job', job.id)
    expect(afterDelete).toHaveLength(3)
    const [finalRev] = await useDb().select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.id, afterDelete[0]!.id))
    expect(finalRev).toMatchObject({ actor: 'agent', runId, content: v2.content })

    const restored = await restoreJob(job.id, slug, v2.content, 'agent')
    expect(restored.id).toBe(job.id)
    expect(restored.content).toBe(v2.content)
    expect(await listRevisions('job', job.id)).toHaveLength(4)
    // A taken slug refuses the restore.
    await expect(restoreJob('00000000-0000-4000-8000-00000000abce', slug, v2.content, 'agent')).rejects.toBeInstanceOf(ConflictError)
  })

  it('I5: rederiveDefaultTimezone moves jobs WITHOUT a timezone: line to the new default and leaves explicit ones alone', async () => {
    const plain = await createJob({ slug: `${PREFIX}i5-plain`, content: md('trigger: cron 30 7 * * *\nenabled: true', 'Brief.'), actor: 'human' })
    const pinned = await createJob({ slug: `${PREFIX}i5-pinned`, content: md('trigger: cron 30 7 * * *\ntimezone: Europe/London\nenabled: true', 'Brief.'), actor: 'human' })
    const ids = [plain.id, pinned.id]
    expect(await rederiveDefaultTimezone({ onlyIds: ids, defaultTimezone: 'Asia/Tokyo' })).toBe(plain.timezone === 'Asia/Tokyo' ? 0 : 1)
    const p = (await getJob(plain.slug))!
    const q = (await getJob(pinned.slug))!
    expect(p.timezone).toBe('Asia/Tokyo')
    // 07:30 in Tokyo is 22:30 UTC.
    expect(new Date(p.nextRunAt!).getUTCHours()).toBe(22)
    expect(new Date(p.nextRunAt!).getUTCMinutes()).toBe(30)
    expect(p.contentHash).toBe(plain.contentHash) // content untouched
    expect(q.timezone).toBe('Europe/London')
    expect(q.nextRunAt).toBe(pinned.nextRunAt)
    // Idempotent.
    expect(await rederiveDefaultTimezone({ onlyIds: ids, defaultTimezone: 'Asia/Tokyo' })).toBe(0)
  })
})

describe('job store — deliver channels must be set up (cycle 75 ruling 4)', () => {
  it('rejects saving an ENABLED job that names a disabled channel, naming the channel', async () => {
    chan.imessage = false
    chan.email = false
    await expect(createJob({ slug: `${PREFIX}dl-im`, content: md('trigger: every 30m\ndeliver: [auto, imessage]\nenabled: true', 'Hi.'), actor: 'human' }))
      .rejects.toThrow(new JobValidationError('deliver: iMessage is not set up — configure it in Settings → Channels'))
    await expect(createJob({ slug: `${PREFIX}dl-em`, content: md('trigger: every 30m\ndeliver: [email]\nenabled: true', 'Hi.'), actor: 'human' }))
      .rejects.toThrow(/deliver: email is not set up/)
    expect(await getJob(`${PREFIX}dl-im`)).toBeNull()
    expect(await getJob(`${PREFIX}dl-em`)).toBeNull()
  })

  it('lets a DISABLED job name a disabled channel, but enabling it is then refused until the channel is on', async () => {
    chan.imessage = false
    const slug = `${PREFIX}dl-off`
    const job = await createJob({ slug, content: md('trigger: every 30m\ndeliver: [imessage]\nenabled: false', 'Hi.'), actor: 'human' })
    expect(job.enabled).toBe(false)
    await expect(setJobEnabled(slug, true, 'human')).rejects.toThrow(/iMessage is not set up/)
    expect((await getJob(slug))!.enabled).toBe(false)

    chan.imessage = true
    expect((await setJobEnabled(slug, true, 'human')).enabled).toBe(true)
    chan.imessage = false
  })

  it('accepts an enabled job with [app] / [auto] (no explicit channel) without loading channel config', async () => {
    chan.imessage = false
    chan.email = false
    const before = chan.loads
    const a = await createJob({ slug: `${PREFIX}dl-auto`, content: md('trigger: every 30m\ndeliver: [auto]\nenabled: true', 'Hi.'), actor: 'human' })
    const b = await createJob({ slug: `${PREFIX}dl-default`, content: md('trigger: every 30m\nenabled: true', 'Hi.'), actor: 'human' })
    expect(a.enabled && b.enabled).toBe(true)
    expect(chan.loads).toBe(before)
  })

  it('revalidateAll never applies the channel check: an enabled job whose channel went off stays valid', async () => {
    chan.imessage = true
    const job = await createJob({ slug: `${PREFIX}dl-reval`, content: md('trigger: every 30m\ndeliver: [imessage]\nenabled: true', 'Hi.'), actor: 'human' })
    chan.imessage = false
    expect(await revalidateAll({ onlyIds: [job.id] })).toBe(0)
    const after = (await getJob(job.slug))!
    expect(after.parseError).toBeNull()
    expect(after.enabled).toBe(true)
  })
})

describe('job store — a schedule that never fires inside active_hours is rejected', () => {
  const never = (en: boolean) => md(`trigger: cron 0 3 * * *\nenabled: ${en}\ntimezone: UTC\nactive_hours: 08:00-22:00`, 'Night owl.')
  const msg = 'active_hours: the schedule never fires inside 08:00-22:00'

  it('rejects create, enabled or disabled, and writes nothing', async () => {
    for (const en of [true, false]) {
      const slug = `${PREFIX}hours-never-${en}`
      await expect(createJob({ slug, content: never(en), actor: 'agent' })).rejects.toThrow(new JobValidationError(msg))
      expect(await getJob(slug)).toBeNull()
    }
  })

  it('rejects a save that makes the hours unsatisfiable and keeps the stored content', async () => {
    const slug = `${PREFIX}hours-save`
    const job = await createJob({ slug, content: md('trigger: cron 0 9 * * *\nenabled: false\ntimezone: UTC\nactive_hours: 08:00-22:00', 'Morning.'), actor: 'human' })
    await expect(saveJob(slug, never(false), job.contentHash, 'human')).rejects.toThrow(new JobValidationError(msg))
    expect((await getJob(slug))!.contentHash).toBe(job.contentHash)
  })

  it('accepts an `at` job whose instant falls outside the hours', async () => {
    const slug = `${PREFIX}hours-at`
    const at = new Date(Date.now() + 7 * 24 * 3600_000)
    at.setUTCHours(3, 0, 0, 0)
    const job = await createJob({ slug, content: md(`trigger: at ${at.toISOString()}\nenabled: false\ntimezone: UTC\nactive_hours: 08:00-22:00`, 'Late.'), actor: 'human' })
    expect(job.slug).toBe(slug)
  })
})
