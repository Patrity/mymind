// test/triage-sweeper.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// sweepUntriaged, unlike triageCapture (test/triage-idempotency.db.test.ts), is NOT scoped to
// a single docId it was handed — its whole job is to scan the documents table for every live,
// untriaged /input/* row. That means a naive call here would also sweep up whatever real
// captures Tony already has sitting in the dev DB, stamping a spurious triaged_at and a fake
// "Stub" review_queue proposal onto genuine data. `withStaleRealDocsParked` below neutralizes
// anything untriaged and older than an hour for the duration of each test and restores it
// exactly afterward, so this suite only ever "sees" its own fixtures. Sub-hour-old rows (e.g.
// another db-test file's fixtures created moments ago by a concurrently running vitest worker)
// are NOT parked — narrowing the guard to genuinely stale rows keeps the risk of stepping on a
// concurrent file's in-flight fixture low, though not literally zero; that residual risk is the
// same class as the ambient-state caveat already called out for test/home-endpoint.db.test.ts.
process.loadEnvFile('.env')
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  get triageThresholds() { return triageThresholds }
}))

// Stub the model — this suite is about the sweeper's candidate query and per-candidate error
// isolation, not classification quality. A doc whose content carries POISON simulates the
// "other step inside triageCapture throws" case the isolation test exists for (the finding
// this file fixes: activeProjects select / reviewQueue insert aren't try/catched either, so
// treating classify() as the stand-in throw site is representative, not a narrower test than
// the bug). Everything else gets a harmless low-confidence stub; the threshold stays at the
// prod-parked 1.1 (nuxt.config.ts) so nothing auto-applies — no real task/memory/document
// mutation to clean up beyond the review_queue row triageCapture inserts on the queued path.
const POISON = 'POISON_MARKER'
vi.mock('../server/lib/ai/triage', async (orig) => ({
  ...(await orig<typeof import('../server/lib/ai/triage')>()),
  classify: vi.fn(async (doc: { path: string, content: string }) => {
    if (doc.content.includes(POISON)) throw new Error('simulated classify failure')
    return { primary: { kind: 'task' as const, confidence: 0.5, title: 'Stub' }, secondary: [], reasoning: 'stub' }
  })
}))

const { sweepUntriaged } = await import('../server/services/triage')

import { createDoc, deleteDoc } from '../server/services/documents'
import { useDb } from '../server/db'
import { documents, reviewQueue } from '../server/db/schema'
import { eq, and, isNull, inArray, sql } from 'drizzle-orm'

const jot = (content = 'sweep fixture') =>
  createDoc({ path: `/input/sweep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.md`, content })

async function docRow(id: string) {
  const [row] = await useDb().select({ triagedAt: documents.triagedAt }).from(documents).where(eq(documents.id, id))
  return row
}

async function reviewRowOf(id: string) {
  const [row] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.docId, id))
  return row
}

// review_queue is the only side table sweepUntriaged's stubbed path can populate (threshold
// 1.1 means nothing auto-applies, so no task/memory/triage_actions row is ever created here).
async function cleanupFixture(id: string) {
  await useDb().delete(reviewQueue).where(eq(reviewQueue.docId, id))
  await deleteDoc(id)
}

let parkedIds: string[] = []

beforeEach(async () => {
  vi.clearAllMocks()
  const stale = await useDb().select({ id: documents.id })
    .from(documents)
    .where(and(
      isNull(documents.deletedAt),
      isNull(documents.triagedAt),
      sql`${documents.path} LIKE '/input/%'`,
      sql`${documents.createdAt} < now() - interval '1 hour'`
    ))
  parkedIds = stale.map(d => d.id)
  if (parkedIds.length > 0) {
    await useDb().update(documents).set({ triagedAt: new Date() }).where(inArray(documents.id, parkedIds))
  }
})

afterEach(async () => {
  if (parkedIds.length > 0) {
    await useDb().update(documents).set({ triagedAt: null }).where(inArray(documents.id, parkedIds))
  }
  parkedIds = []
})

describe('sweepUntriaged candidate query', () => {
  it('picks up a plain /input doc with triaged_at IS NULL', async () => {
    const doc = await jot()
    try {
      await sweepUntriaged({ limit: 50 })
      expect((await docRow(doc.id))!.triagedAt).not.toBeNull()
    } finally {
      await cleanupFixture(doc.id)
    }
  })

  // The retired enrich-input excluded any doc with project IS NOT NULL or non-empty tags —
  // exactly why /input could never drain (anything touched by any prior pass, successful or
  // not, became permanently ineligible). The new query drops both conditions; this is the
  // headline regression check for this task. Set via a raw update (not createDoc's `project`
  // param, which would relocate the doc out of /input/ via computeFinalPath) so the doc stays
  // put and only its project/tags columns change — the exact "touched but still under /input"
  // shape the old filter mishandled.
  it('still picks up a doc that already has a project and non-empty tags set', async () => {
    const doc = await jot()
    await useDb().update(documents).set({ project: 'mymind', tags: ['already-tagged'] }).where(eq(documents.id, doc.id))
    try {
      await sweepUntriaged({ limit: 50 })
      expect((await docRow(doc.id))!.triagedAt).not.toBeNull()
    } finally {
      await cleanupFixture(doc.id)
    }
  })

  it('does not pick up a doc outside /input/', async () => {
    const doc = await createDoc({
      path: `/notes/sweep-boundary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
      content: 'not a capture'
    })
    try {
      await sweepUntriaged({ limit: 50 })
      expect((await docRow(doc.id))!.triagedAt).toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('does not pick up a soft-deleted /input doc', async () => {
    const doc = await jot()
    await deleteDoc(doc.id) // soft-delete BEFORE the sweep runs — nothing left to clean up after
    await sweepUntriaged({ limit: 50 })
    expect((await docRow(doc.id))!.triagedAt).toBeNull()
  })

  it('does not re-pick-up an already-triaged /input doc', async () => {
    const doc = await jot()
    const already = new Date('2026-01-01T00:00:00Z')
    await useDb().update(documents).set({ triagedAt: already }).where(eq(documents.id, doc.id))
    try {
      await sweepUntriaged({ limit: 50 })
      const row = await docRow(doc.id)
      expect(row!.triagedAt!.getTime()).toBe(already.getTime()) // untouched, not re-stamped
      expect(await reviewRowOf(doc.id)).toBeUndefined()          // never reached triageCapture's actuator
    } finally {
      await deleteDoc(doc.id)
    }
  })
})

// Finding K (same root cause as Finding A in triage-idempotency.db.test.ts): a candidate
// that already carries a pending review_queue row of another kind must be tallied as
// SKIPPED, not TRIAGED — before the fix, triageCapture returned `{ queued: true }` with no
// `skipped` field for this case (the insert silently no-opped via onConflictDoNothing), so
// this loop's `if (out.skipped) skipped++ else triaged++` counted it as a triaged success
// and recordJobSummary reported the sweep as clean.
describe('sweepUntriaged pending-review guard', () => {
  it('counts a doc with an existing pending review row as skipped, not triaged', async () => {
    const doc = await jot()
    await useDb().insert(reviewQueue).values({ docId: doc.id, kind: 'enrichment', proposed: { stub: true } })
    try {
      const result = await sweepUntriaged({ limit: 50 })
      expect(result.skipped).toBeGreaterThanOrEqual(1)
      expect((await docRow(doc.id))!.triagedAt).toBeNull()          // never claimed
      const triageRows = await useDb().select().from(reviewQueue)
        .where(and(eq(reviewQueue.docId, doc.id), eq(reviewQueue.kind, 'triage')))
      expect(triageRows).toHaveLength(0)
    } finally {
      await useDb().delete(reviewQueue).where(eq(reviewQueue.docId, doc.id))
      await deleteDoc(doc.id)
    }
  })
})

describe('sweepUntriaged error isolation', () => {
  // Reproduces the Task 9 review finding: before the fix, an uncaught throw from one
  // candidate propagated out of the `for` loop and aborted every candidate after it in that
  // batch. Run this test against the pre-fix loop (bare `await triageCapture(c.id)`, no
  // try/catch) to see it fail — the doc created AFTER the poison one in iteration order never
  // gets its triaged_at stamped and the `await sweepUntriaged(...)` call itself rejects instead
  // of resolving. See task-9-report.md's fix-report addendum for both captured runs.
  it('a candidate that throws does not stop the rest of the batch from being processed', async () => {
    const before = await jot('sweep fixture before poison')
    const poison = await jot(`sweep fixture ${POISON}`)
    const after = await jot('sweep fixture after poison')
    try {
      const result = await sweepUntriaged({ limit: 50 })
      expect(result.triaged + result.skipped).toBeGreaterThanOrEqual(3)

      // Both non-poison candidates were processed regardless of where the throw landed in
      // the batch (drizzle's unordered select gives no guarantee poison sits between them).
      expect((await docRow(before.id))!.triagedAt).not.toBeNull()
      expect((await docRow(after.id))!.triagedAt).not.toBeNull()
      expect(await reviewRowOf(before.id)).toBeDefined()
      expect(await reviewRowOf(after.id)).toBeDefined()

      // The poison doc: claim() inside triageCapture stamps triaged_at BEFORE classify() runs,
      // so it stays claimed even though classify threw — a pre-existing property of
      // triageCapture's claim-before-work design that this fix does not change (and is not
      // asked to). What the fix guarantees is that the throw doesn't propagate past this one
      // candidate — proven by before/after above and by sweepUntriaged resolving at all.
      expect((await docRow(poison.id))!.triagedAt).not.toBeNull()
      expect(await reviewRowOf(poison.id)).toBeUndefined() // never reached the actuator/queue step
    } finally {
      await Promise.all([cleanupFixture(before.id), cleanupFixture(poison.id), cleanupFixture(after.id)])
    }
  })
})
