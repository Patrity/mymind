// test/triage-multi-destination.db.test.ts
//
// Task 11b: the spec's locked multi-intent decision — "one primary action plus up to two
// secondary actions in the same proposal" — is spec-level intent that only means something
// if BOTH actions in a task+memory proposal actually apply. Task 11's browser validation
// found that they didn't: the first courier-consuming actuator soft-deletes the document,
// and every actuator after it opens with a live-only read, so it throws "document ...
// not found". These two suites are the spec-level regression guards for that fix: one
// through the immediate auto-apply path (triageCapture), one through the human-approved
// queue path (approveTriage). See .superpowers/sdd/2026-08-16-capture-triage/task-11b-brief.md.
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

// Low enough that both the task primary and the memory secondary auto-apply.
const triageThresholds = { task: 0.5, note: 0.5, memory: 0.5, append: 0.5 }
vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  triageThresholds
}))

// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch — same canned
// mock as test/triage-actuators.db.test.ts's applyMemory suite (see that file's comment
// for why a real network call here is wrong for this test's subject).
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

// Stub the model — this file is about actuator orchestration across a shared docId, not
// classification quality. Mirrors test/triage-idempotency.db.test.ts's mocking pattern.
vi.mock('../server/lib/ai/triage', async (orig) => ({
  ...(await orig<typeof import('../server/lib/ai/triage')>()),
  classify: vi.fn(async () => ({
    primary: { kind: 'task' as const, confidence: 0.9, title: 'Stubbed multi-intent task' },
    secondary: [{ kind: 'memory' as const, confidence: 0.9, content: 'Stubbed multi-intent memory.' }],
    reasoning: 'stub: task primary + memory secondary on the same jot'
  }))
}))

const { triageCapture } = await import('../server/services/triage')

import { createDoc, deleteDoc } from '../server/services/documents'
import { deleteTask } from '../server/services/tasks'
import { useDb } from '../server/db'
import { reviewQueue, triageActions, memories, tasks } from '../server/db/schema'
import type { ReviewItem } from '../server/db/schema'
import { eq } from 'drizzle-orm'
import { approveHandlers } from '../server/api/review/kinds'
import type { TriageAction } from '../shared/types/triage'

const jot = () =>
  createDoc({ path: `/input/multi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.md`, content: 'finish the report; office wifi is hunter2' })

// Cleanup for whatever a test run may have produced: applied actions create a real task
// and a real memory (both looked up via triage_actions, its durable record — same
// convention as test/triage-idempotency.db.test.ts's cleanupTriaged), plus any leftover
// review_queue row and the courier document itself.
async function cleanup(docId: string) {
  const rows = await useDb().select().from(triageActions).where(eq(triageActions.docId, docId))
  for (const row of rows) {
    if (row.entityType === 'task' && row.entityId) await deleteTask(row.entityId)
    if (row.entityType === 'memory' && row.entityId) {
      await useDb().delete(memories).where(eq(memories.id, row.entityId))
    }
  }
  await useDb().delete(reviewQueue).where(eq(reviewQueue.docId, docId))
  await deleteDoc(docId)
}

describe('triageCapture: multi-destination auto-apply', () => {
  // Headline end-to-end regression: classify() routinely proposes a task PRIMARY plus a
  // memory SECONDARY on the same jot. Before the fix, the memory action fell into `queued`
  // (its actuator threw "document ... not found" after the task actuator's soft-delete),
  // so this asserted `applied` had length 1 and `queued` was true. After the fix both apply.
  it('applies BOTH a task primary and a memory secondary on the same doc', async () => {
    const doc = await jot()
    try {
      const out = await triageCapture(doc.id)

      expect(out.queued).toBe(false)
      expect(out.applied).toHaveLength(2)
      expect(out.applied.map(a => a.kind).sort()).toEqual(['memory', 'task'])

      const actionRows = await useDb().select().from(triageActions).where(eq(triageActions.docId, doc.id))
      expect(actionRows).toHaveLength(2)

      const taskRow = actionRows.find(r => r.kind === 'task')
      const memRow = actionRows.find(r => r.kind === 'memory')
      expect(taskRow?.entityId).toBeTruthy()
      expect(memRow?.entityId).toBeTruthy()

      const [t] = await useDb().select().from(tasks).where(eq(tasks.id, taskRow!.entityId!))
      const [m] = await useDb().select().from(memories).where(eq(memories.id, memRow!.entityId!))
      expect(t).toBeDefined()
      expect(m).toBeDefined()

      // No review row — nothing was left behind for a human to (wrongly) rubber-stamp.
      const reviewRows = await useDb().select().from(reviewQueue).where(eq(reviewQueue.docId, doc.id))
      expect(reviewRows).toHaveLength(0)
    } finally {
      await cleanup(doc.id)
    }
  })
})

describe('approveTriage: multi-destination approve path', () => {
  // A queued multi-action triage row (the shape triageCapture writes when actions fall
  // below their auto-apply threshold), approved, must apply EVERY queued action — not
  // just the first. Before the fix, approveTriage's loop silently dropped every action
  // after the first courier-consuming one (caught, logged, row still marked 'approved').
  it('applies every queued action, not just the first', async () => {
    const doc = await jot()
    const queuedActions: TriageAction[] = [
      { kind: 'task', confidence: 0.4, title: 'Queued task from review' },
      { kind: 'memory', confidence: 0.4, content: 'Queued memory from review.' }
    ]
    const [row] = await useDb().insert(reviewQueue).values({
      docId: doc.id,
      kind: 'triage',
      proposed: {
        primary: queuedActions[0], secondary: [queuedActions[1]],
        reasoning: 'stub', queued: queuedActions, applied: []
      }
    }).returning()

    try {
      const result = await approveHandlers.triage!(row as ReviewItem)
      expect((result as { applied?: TriageAction[] } | void)?.applied).toHaveLength(2)

      const actionRows = await useDb().select().from(triageActions).where(eq(triageActions.docId, doc.id))
      expect(actionRows).toHaveLength(2)
      expect(actionRows.map(r => r.kind).sort()).toEqual(['memory', 'task'])

      const [reviewRow] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row!.id))
      expect(reviewRow!.status).toBe('approved')
    } finally {
      await cleanup(doc.id)
    }
  })
})
