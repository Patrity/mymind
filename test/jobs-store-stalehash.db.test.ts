// DB-backed — harness pattern from test/agent-runs.db.test.ts.
//
// Review fix round 1, item 5: revalidateAll's per-row UPDATE must also require the row's
// content_hash unchanged since its initial SELECT — otherwise a REAL write (human/agent save)
// landing on a not-yet-processed row, DURING revalidateAll's loop over an earlier row, gets
// clobbered by revalidateAll's own update, which was derived from the now-stale content it read
// at the top of the pass.
//
// Review fix round 2, item 2: that guard matching ZERO rows (a concurrent writer won) must also
// skip changed++/publishChange/the invalid-job notify for that row — otherwise revalidateAll can
// report a job as "changed" and post "Job X is invalid" for a row a concurrent write just
// REPAIRED, based purely on the stale pre-race snapshot.
//
// This needs a WRITE to land inside revalidateAll's loop, between its initial bulk SELECT and the
// specific row's UPDATE — genuine wall-clock timing can't force that reliably (see the
// pg_advisory_xact_lock test in jobs-store.db.test.ts for the same problem/solution shape).
// Instead: mock appendEvent (called once per job that transitions to invalid) to perform the
// racing write as a side effect the FIRST time it's called — which is guaranteed to run mid-loop,
// after the initial SELECT has already cached every row's snapshot, and before the loop reaches
// whichever job's notify didn't fire first.
process.loadEnvFile('.env')

import { describe, it, expect, vi, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const notifyCalls: string[] = []
let injectRaceOnce: ((noteText: string) => Promise<void>) | null = null
vi.mock('@mymind/core/services/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mymind/core/services/conversations')>()
  return {
    ...actual,
    appendEvent: async (_conversationId: string, content: string) => {
      notifyCalls.push(content)
      if (injectRaceOnce) {
        const fn = injectRaceOnce
        injectRaceOnce = null
        await fn(content)
      }
      // Deliberately does NOT insert a real message — this test only cares about agent_jobs state.
    }
  }
})

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentJobs, agentConfigRevisions } from '@mymind/core/db/schema'
import { createJob, saveJob, revalidateAll } from '@mymind/core/lib/agent/jobs/store'

const PREFIX = 'jstest-stalehash-'

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

describe('revalidateAll content_hash guard', () => {
  it('does not clobber a row a real write updated mid-pass, and excludes it from changed/publish/notify', async () => {
    await cleanup()
    notifyCalls.length = 0
    const db = useDb()
    const slugA = `${PREFIX}a`
    const slugB = `${PREFIX}b`
    const jobA = await createJob({ slug: slugA, content: md('trigger: every 10m\nenabled: true', 'a'), actor: 'human' })
    const jobB = await createJob({ slug: slugB, content: md('trigger: every 10m\nenabled: true', 'b'), actor: 'human' })

    // Break BOTH externally so both transition null -> non-null (both are eligible to notify) —
    // store.ts itself would reject this at write time.
    await db.update(agentJobs).set({ content: md('trigger: nonsense', 'a') }).where(eq(agentJobs.id, jobA.id))
    await db.update(agentJobs).set({ content: md('trigger: nonsense', 'b') }).where(eq(agentJobs.id, jobB.id))

    const freshContent = md('trigger: every 20m\nenabled: true', 'fresh')
    injectRaceOnce = async (noteText: string) => {
      // Whichever job's notify fired first, race-write the OTHER one — by construction it is
      // guaranteed not to have been reached by the loop yet.
      const noticedSlug = /Job (\S+) is invalid/.exec(noteText)?.[1]
      const raceSlug = noticedSlug === slugA ? slugB : slugA
      const raceJobId = noticedSlug === slugA ? jobB.id : jobA.id
      const [current] = await db.select().from(agentJobs).where(eq(agentJobs.id, raceJobId))
      await saveJob(raceSlug, freshContent, current!.contentHash, 'human')
    }

    const changed = await revalidateAll({ onlyIds: [jobA.id, jobB.id], mainConversationId: '00000000-0000-0000-0000-000000000000' })

    const [rowA] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobA.id))
    const [rowB] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobB.id))
    const raced = rowA!.content === freshContent ? rowA! : rowB!
    const nonRaced = raced.id === rowA!.id ? rowB! : rowA!

    // The raced row must reflect the CONCURRENT write in full — content AND its correctly-derived
    // columns — never a mix of the fresh content with revalidateAll's stale (broken-content-
    // derived) parse_error/next_run_at.
    expect(raced.content).toBe(freshContent)
    expect(raced.parseError).toBeNull()
    expect(raced.triggerExpr).toBe('20m')
    expect(raced.nextRunAt).not.toBeNull()

    // The NON-raced row is the one whose guarded update genuinely matched — it correctly got
    // flagged invalid.
    expect(nonRaced.parseError).toMatch(/unknown trigger/)
    expect(nonRaced.nextRunAt).toBeNull()

    // Review fix round 2, item 2: `changed` counts only the row whose update actually matched —
    // the raced row's stale-guarded update matched zero rows and must be excluded entirely.
    expect(changed).toBe(1)
    // Exactly one notify was posted in the whole pass, and it names the NON-raced slug — the
    // raced (already-repaired-by-someone-else) row must never be reported as newly invalid.
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]).toContain(nonRaced.slug)
    expect(notifyCalls.some(c => c.includes(raced.slug))).toBe(false)
  })
})
