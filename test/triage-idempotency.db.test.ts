// test/triage-idempotency.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi, beforeEach } from 'vitest'

// triageThresholds is read from useRuntimeConfig() inside triageCapture/route — without it here
// `thresholds[action.kind]` in server/lib/triage/route.ts would throw on `undefined`. Mirror
// prod's parked 1.1 (nuxt.config.ts: "ALL ship at 1.1 = never auto-apply") as the file-wide
// default rather than picking a lower in-test value: with the default 'task' stub below (0.95
// confidence), a lower bar would let the primary auto-apply, which soft-deletes the courier
// document as a side effect. That incidentally masks the concurrency test below — a broken
// claim() would still show only ONE classify() call, because the loser's getDoc() sometimes
// lands after the winner has already deleted the doc and bails via the "doc not found" branch
// instead of the claim. Confirmed by deliberately breaking claim() (Step 5's vacuity check):
// with a 0.7 bar the race was hidden; at the real 1.1 bar (nothing ever auto-applies, doc stays
// live) both concurrent calls reach classify() and the break is correctly exposed as 2 calls.
// mutable so ONE test below (which needs a genuine applied action) can override it locally.
let triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  get triageThresholds() { return triageThresholds }
}))

// Stub the model — this test is about orchestration, not classification quality.
vi.mock('../server/lib/ai/triage', async (orig) => ({
  ...(await orig<typeof import('../server/lib/ai/triage')>()),
  classify: vi.fn(async () => ({
    primary: { kind: 'task' as const, confidence: 0.95, title: 'Stubbed task' },
    secondary: [], reasoning: 'stub'
  }))
}))

const { triageCapture } = await import('../server/services/triage')
const { classify } = await import('../server/lib/ai/triage')

import { createDoc, deleteDoc } from '../server/services/documents'
import { deleteTask } from '../server/services/tasks'
import { useDb } from '../server/db'
import { reviewQueue, triageActions, documents } from '../server/db/schema'
import { eq, and } from 'drizzle-orm'

const jot = () => createDoc({ path: `/input/i-${Math.random().toString(36).slice(2, 10)}.md`, content: 'do a thing' })

// Cleanup for whatever a test run may have produced: an applied action creates a real task
// (soft-deleted via deleteTask, same convention as test/triage-actuators.db.test.ts), a queued
// action creates a review_queue row, and a document that was never auto-applied stays live.
// triageCapture only hands back the TriageAction, not the created entity id, so the task lookup
// goes through triage_actions (its durable record) the same way Task 12's durable-reversal path
// is expected to. Without this every run leaks another "Stubbed task" or live /input/i-*.md doc
// into Tony's real dev DB.
async function cleanupTriaged(docId: string) {
  const rows = await useDb().select().from(triageActions).where(eq(triageActions.docId, docId))
  for (const row of rows) {
    if (row.entityType === 'task' && row.entityId) await deleteTask(row.entityId)
  }
  await useDb().delete(reviewQueue).where(eq(reviewQueue.docId, docId))
  await deleteDoc(docId)
}

beforeEach(() => vi.clearAllMocks())

describe('triageCapture idempotency', () => {
  it('claims the document by stamping triaged_at', async () => {
    const doc = await jot()
    try {
      await triageCapture(doc.id)
      const [row] = await useDb().select().from(documents).where(eq(documents.id, doc.id))
      expect(row!.triagedAt).not.toBeNull()
    } finally {
      await cleanupTriaged(doc.id)
    }
  })

  // The immediate path and the sweeper CAN both fire for the same doc.
  it('runs the model exactly once across two concurrent invocations', async () => {
    const doc = await jot()
    try {
      const [a, b] = await Promise.all([triageCapture(doc.id), triageCapture(doc.id)])
      expect(vi.mocked(classify)).toHaveBeenCalledTimes(1)
      const skipped = [a, b].filter(r => r.skipped === 'already-triaged')
      expect(skipped).toHaveLength(1)
    } finally {
      await cleanupTriaged(doc.id)
    }
  })

  it('produces exactly one set of actions for a double invocation', async () => {
    // Override the bar so the primary genuinely auto-applies — otherwise triage_actions would
    // legitimately stay empty on both calls, which wouldn't distinguish "not duplicated" from
    // "never happened". Restored in `finally` so later tests keep the prod-like 1.1 default.
    triageThresholds = { task: 0.7, note: 0.7, memory: 0.7, append: 0.7 }
    const doc = await jot()
    try {
      await triageCapture(doc.id)
      await triageCapture(doc.id)
      const rows = await useDb().select().from(triageActions).where(eq(triageActions.docId, doc.id))
      expect(rows).toHaveLength(1)
    } finally {
      triageThresholds = { task: 1.1, note: 1.1, memory: 1.1, append: 1.1 }
      await cleanupTriaged(doc.id)
    }
  })

  it('returns already-triaged for a second sequential call', async () => {
    const doc = await jot()
    try {
      await triageCapture(doc.id)
      expect((await triageCapture(doc.id)).skipped).toBe('already-triaged')
    } finally {
      await cleanupTriaged(doc.id)
    }
  })
})

describe('triageCapture queueing', () => {
  it('queues ONE review row holding every below-bar action', async () => {
    vi.mocked(classify).mockResolvedValueOnce({
      primary: { kind: 'task', confidence: 0.1, title: 'Unsure' },
      secondary: [{ kind: 'memory', confidence: 0.1, content: 'also unsure' }],
      reasoning: 'stub'
    })
    const doc = await jot()
    try {
      const out = await triageCapture(doc.id)
      expect(out.queued).toBe(true)
      const rows = await useDb().select().from(reviewQueue).where(eq(reviewQueue.docId, doc.id))
      expect(rows).toHaveLength(1)                 // one pending row per doc — enforced by a unique index
      expect(rows[0]!.kind).toBe('triage')
    } finally {
      await cleanupTriaged(doc.id)
    }
  })

  it('still stamps triaged_at when the model fails, so it is not retried forever', async () => {
    vi.mocked(classify).mockResolvedValueOnce(null)
    const doc = await jot()
    try {
      expect((await triageCapture(doc.id)).skipped).toBe('parse-failed')
      const [row] = await useDb().select().from(documents).where(eq(documents.id, doc.id))
      expect(row!.triagedAt).not.toBeNull()
    } finally {
      await cleanupTriaged(doc.id)
    }
  })
})

// Final-review Finding A: review_queue_one_pending_per_doc (migration 0005) is a partial
// unique index on doc_id WHERE status='pending' ACROSS ALL KINDS, not just 'triage'. Before
// this fix, a document that already carried a pending row of another kind (e.g. a leftover
// `enrichment` row from the retired enrich-input cron) would still get claim()'d — stamping
// triaged_at — classified, and routed to review, only for the INSERT to silently no-op via
// onConflictDoNothing. Result: triaged_at set, no triage row, proposal discarded, and because
// triaged_at is never cleared anywhere in this codebase, the document became terminal —
// never re-swept. Measured in prod: both live /input docs (including the motivating
// vpxm_harpS.md capture) carried exactly this leftover state.
describe('triageCapture pending-review guard', () => {
  it('does not claim or classify a doc that already has a pending review row of another kind', async () => {
    const doc = await jot()
    await useDb().insert(reviewQueue).values({ docId: doc.id, kind: 'enrichment', proposed: { stub: true } })
    try {
      const out = await triageCapture(doc.id)

      expect(out.skipped).toBe('review-pending')
      expect(out.queued).toBe(false)
      expect(out.applied).toEqual([])
      // Never even reached the model — proves the guard runs before claim(), not just
      // before the insert.
      expect(vi.mocked(classify)).not.toHaveBeenCalled()

      const [row] = await useDb().select().from(documents).where(eq(documents.id, doc.id))
      expect(row!.triagedAt).toBeNull()                 // NOT claimed — stays eligible for a later sweep

      const triageRows = await useDb().select().from(reviewQueue)
        .where(and(eq(reviewQueue.docId, doc.id), eq(reviewQueue.kind, 'triage')))
      expect(triageRows).toHaveLength(0)                // no triage row was created (and none silently dropped)
    } finally {
      await cleanupTriaged(doc.id)
    }
  })
})
