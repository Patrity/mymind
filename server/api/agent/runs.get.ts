import { listRuns } from '../../lib/agent/runtime/runs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A malformed/absent limit degrades to the default (50) instead of reaching Postgres as
 *  NaN — this is a low-stakes drawer, not a request worth 400ing over a typo'd number.
 *  Clamped, not just defaulted, so an absurd value can't turn into an unbounded scan. */
function parseLimit(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 50
  return Math.min(Math.max(Math.floor(n), 1), 200)
}

/** Runs drawer — the raw agent_runs rows for one thread (or the most recent globally),
 *  newest first. `durationMs` is claim→finish, not enqueue→finish: a queued run waiting
 *  behind another one on the same thread hasn't started doing anything yet. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)

  const conversationId = typeof q.conversationId === 'string' ? q.conversationId : undefined
  // Spliced into a plain `eq()` (server/lib/agent/runtime/runs.ts) against a uuid column —
  // Postgres throws a driver-level type error (500) on a non-uuid string, so a malformed one
  // is rejected HERE with a 400 instead, same shape as sessions' `sinceId` guard.
  if (conversationId !== undefined && !UUID_RE.test(conversationId)) {
    throw createError({ statusCode: 400, statusMessage: 'Malformed `conversationId`' })
  }

  const rows = await listRuns({ conversationId, limit: parseLimit(q.limit) })
  return rows.map(r => ({
    id: r.id, trigger: r.trigger, wakeReason: r.wakeReason, profile: r.profile, status: r.status, suppressed: r.suppressed,
    createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
    durationMs: r.claimedAt && r.finishedAt ? r.finishedAt.getTime() - r.claimedAt.getTime() : null,
    assistantMessageId: r.assistantMessageId
  }))
})
