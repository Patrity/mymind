// server/lib/agent/runtime/replay.ts
// Approving a headless proposal runs the STORED call — deterministic, no model turn, nothing
// suspended. Args are re-validated against the tool's CURRENT schema: a proposal that no longer
// fits fails visibly instead of running a stale call.
import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue, type ReviewItem } from '../../../db/schema'
import { agentTools } from '../tools'
import { appendEvent } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'
import { publishActivity } from '../bus'
import { registerUndo } from '../undo'
import { withSpan } from '../../observability/record'
import type { AgentTool } from '../types'

interface Proposed { tool: string; args: Record<string, unknown>; conversationId: string }

export async function replayAgentAction(
  p: { tool: string; args: Record<string, unknown> },
  deps: { tools?: AgentTool[] } = {}
): Promise<{ ok: true; summary: string; undoToken?: string } | { ok: false; error: string }> {
  const t = (deps.tools ?? agentTools).find(x => x.name === p.tool)
  if (!t) return { ok: false, error: `unknown tool ${p.tool}` }
  if (t.dangerous) return { ok: false, error: `${t.name} is not replayable` }
  const parsed = z.object(t.schema).safeParse(p.args)
  if (!parsed.success) return { ok: false, error: `arguments no longer match the tool: ${parsed.error.issues.map(i => i.path.join('.') || i.message).join(', ')}` }
  try {
    // Same instrumentation buildAiTools gives every interactive tool call
    // (server/lib/agent/ai-tools.ts's execute) — a replayed call is a REAL tool call with real
    // side effects, so skipping this would make it invisible to the activity log and would
    // silently drop its undo (a replayed edit_image/create_skill call is exactly as undoable as
    // an interactive one, and the caller has no other way to get the token).
    const exec = await withSpan(
      { kind: 'tool', name: t.name, request: parsed.data as Record<string, unknown> },
      () => t.handler(parsed.data as Record<string, unknown>, { signal: AbortSignal.timeout(60_000) })
    )
    const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
    publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
    return { ok: true, summary: exec.summary, undoToken }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Move the row from `fromStatus` to `status`, guarded — a write that doesn't match `fromStatus`
 *  (lost the race, already resolved) touches zero rows rather than clobbering a concurrent
 *  caller's outcome. Returns whether THIS call's write won. */
async function settle(id: string, status: 'approved' | 'rejected' | 'failed', fromStatus: 'pending' | 'applying'): Promise<boolean> {
  const [row] = await useDb().update(reviewQueue)
    .set({ status, resolvedAt: sql`now()` })
    .where(and(eq(reviewQueue.id, id), eq(reviewQueue.status, fromStatus)))
    .returning({ id: reviewQueue.id })
  if (row) publishChange({ resource: 'review', action: 'updated', id })
  return !!row
}

/**
 * Claim the row for exclusive application BEFORE replaying: pending → 'applying', guarded by
 * `WHERE status = 'pending'` so only one concurrent `approveAgentAction` call ever wins it. A
 * second caller (a double-click, two open /review tabs, a retried request) updates zero rows and
 * returns without ever touching the tool. This matters ONLY for agent-action: unlike
 * triage/enrichment/memory-conflict approval, whose actuators tolerate re-application, several
 * proposable tools here (create_skill, edit_image) are NOT idempotent — replaying the SAME stored
 * call twice is a real double side effect, not a harmless retry.
 */
async function claim(id: string): Promise<boolean> {
  const [row] = await useDb().update(reviewQueue)
    .set({ status: 'applying' })
    .where(and(eq(reviewQueue.id, id), eq(reviewQueue.status, 'pending')))
    .returning({ id: reviewQueue.id })
  return !!row
}

export async function approveAgentAction(
  item: ReviewItem, deps: { tools?: AgentTool[] } = {}
): Promise<{ summary?: string; undoToken?: string }> {
  if (!(await claim(item.id))) return {} // lost the race (or already resolved) — never replay
  const p = item.proposed as Proposed
  const r = await replayAgentAction(p, deps)
  await settle(item.id, r.ok ? 'approved' : 'failed', 'applying')
  await appendEvent(p.conversationId, r.ok ? `Approved: ${p.tool} — ${r.summary}` : `Could not apply ${p.tool}: ${r.error}`, r.ok ? 'review:approved' : 'review:failed')
  return r.ok ? { summary: r.summary, undoToken: r.undoToken } : {}
}

export async function rejectAgentAction(item: ReviewItem): Promise<void> {
  await settle(item.id, 'rejected', 'pending')
}
