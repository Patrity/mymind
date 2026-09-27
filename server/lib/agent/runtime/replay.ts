// server/lib/agent/runtime/replay.ts
// Approving a headless proposal runs the STORED call — deterministic, no model turn, nothing
// suspended. Args are re-validated against the tool's CURRENT schema: a proposal that no longer
// fits fails visibly instead of running a stale call.
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue, type ReviewItem } from '../../../db/schema'
import { agentTools } from '../tools'
import { appendEvent } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'
import type { AgentTool } from '../types'

interface Proposed { tool: string; args: Record<string, unknown>; conversationId: string }

export async function replayAgentAction(
  p: { tool: string; args: Record<string, unknown> },
  deps: { tools?: AgentTool[] } = {}
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const t = (deps.tools ?? agentTools).find(x => x.name === p.tool)
  if (!t) return { ok: false, error: `unknown tool ${p.tool}` }
  if (t.dangerous) return { ok: false, error: `${t.name} is not replayable` }
  const parsed = z.object(t.schema).safeParse(p.args)
  if (!parsed.success) return { ok: false, error: `arguments no longer match the tool: ${parsed.error.issues.map(i => i.path.join('.') || i.message).join(', ')}` }
  try {
    const exec = await t.handler(parsed.data as Record<string, unknown>, { signal: AbortSignal.timeout(60_000) })
    return { ok: true, summary: exec.summary }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function settle(item: ReviewItem, status: 'approved' | 'rejected' | 'failed') {
  await useDb().update(reviewQueue).set({ status, resolvedAt: sql`now()` }).where(eq(reviewQueue.id, item.id))
  publishChange({ resource: 'review', action: 'updated', id: item.id })
}

export async function approveAgentAction(item: ReviewItem, deps: { tools?: AgentTool[] } = {}): Promise<void> {
  const p = item.proposed as Proposed
  const r = await replayAgentAction(p, deps)
  await settle(item, r.ok ? 'approved' : 'failed')
  await appendEvent(p.conversationId, r.ok ? `Approved: ${p.tool} — ${r.summary}` : `Could not apply ${p.tool}: ${r.error}`, r.ok ? 'review:approved' : 'review:failed')
}

export async function rejectAgentAction(item: ReviewItem): Promise<void> {
  await settle(item, 'rejected')
}
