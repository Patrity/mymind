import { listRuns } from '../../lib/agent/runtime/runs'

/** Runs drawer — the raw agent_runs rows for one thread (or the most recent globally),
 *  newest first. `durationMs` is claim→finish, not enqueue→finish: a queued run waiting
 *  behind another one on the same thread hasn't started doing anything yet. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const rows = await listRuns({ conversationId: typeof q.conversationId === 'string' ? q.conversationId : undefined, limit: Number(q.limit ?? 50) })
  return rows.map(r => ({
    id: r.id, trigger: r.trigger, wakeReason: r.wakeReason, profile: r.profile, status: r.status, suppressed: r.suppressed,
    createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error,
    durationMs: r.claimedAt && r.finishedAt ? r.finishedAt.getTime() - r.claimedAt.getTime() : null,
    assistantMessageId: r.assistantMessageId
  }))
})
