// server/lib/agent/tools/improvements.ts
// Bridget's list_improvements read tool (cycle 76, Task 10) — the self-improvement log her
// digest seed reads from. Reads agent_improvements directly; there is no write path here (a
// proposal is decided through reflect/apply.ts, either automatically or via decide_review).
//
// `since` scopes the returned log to a window (default: the start of today in the agent
// timezone, spec-mandated for the daily digest). `pendingReview` is DELIBERATELY not scoped by
// `since` — it's the live count of everything still awaiting Tony's decision on /review
// (`pending_review` AND `conflict`: a conflict's review item is still pending, per
// global-constraints.md), independent of when it was originally raised, since that's what "how
// many are waiting" means to whoever's asking.
import { z } from 'zod'
import { desc, inArray, gte, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentImprovements, type AgentImprovementRow } from '../../../db/schema'
import { getDefaultTimezone } from '../jobs/timezone'
import type { AgentTool } from '../types'

/** `conflict` is not terminal — its review item is still pending (global-constraints.md). */
const PENDING_STATUSES = ['pending_review', 'conflict'] as const

export interface ImprovementItem {
  id: string
  kind: string
  target: string
  status: string
  reason: string
  revisionId: string | null
  createdAt: string
  link: string | null
}

/** The model's stated reason, pulled from the stored proposal (reflect/schema.ts's `Proposal`).
 *  Never throws on a malformed/missing proposal — just reports an empty reason. */
function reasonOf(row: AgentImprovementRow): string {
  const p = row.proposal as { reason?: unknown } | null
  return typeof p?.reason === 'string' ? p.reason : ''
}

/** While something is still pending Tony's decision (including a conflict), the useful place to
 *  send him is /review, whatever kind it is. Once applied, the useful place is the target itself
 *  (so he can see/undo the change). A rejected or dropped proposal changed nothing and has no
 *  target-relevant page to send him to. */
function linkFor(kind: string, target: string, status: string): string | null {
  if (status === 'pending_review' || status === 'conflict') return '/review'
  if (status !== 'applied') return null
  if (kind.startsWith('skill.')) return `/skills/${target}`
  if (kind.startsWith('job.')) return `/jobs/${target}`
  if (kind === 'profile.edit') return '/settings/profile'
  return null
}

/** Start-of-today in the agent timezone, computed in Postgres (matches apply.ts's
 *  countAutoAppliedToday) — never hand-rolled in JS, which would need its own DST-aware math. */
function sinceClause(since: string | undefined, tz: string): SQL {
  if (since) {
    const d = new Date(since)
    if (!Number.isNaN(d.getTime())) return gte(agentImprovements.createdAt, d)
  }
  return sql`${agentImprovements.createdAt} >= (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`
}

export async function listImprovementsSince(
  opts: { since?: string, limit: number }
): Promise<{ items: ImprovementItem[], pendingReview: number }> {
  const db = useDb()
  const tz = await getDefaultTimezone()

  const rows = await db.select().from(agentImprovements)
    .where(sinceClause(opts.since, tz))
    .orderBy(desc(agentImprovements.createdAt))
    .limit(opts.limit)

  const [pendingRow] = await db.select({ n: sql<number>`count(*)::int` }).from(agentImprovements)
    .where(inArray(agentImprovements.status, PENDING_STATUSES))

  const items: ImprovementItem[] = rows.map(row => ({
    id: row.id,
    kind: row.kind,
    target: row.target,
    status: row.status,
    reason: reasonOf(row),
    revisionId: row.revisionId,
    createdAt: row.createdAt.toISOString(),
    link: linkFor(row.kind, row.target, row.status)
  }))

  return { items, pendingReview: pendingRow?.n ?? 0 }
}

export const listImprovementsTool: AgentTool = {
  name: 'list_improvements',
  description: "List self-improvements — changes the reflector made or proposed to your own skills, jobs, or Tony's profile. Each item has id, kind (e.g. 'skill.edit', 'job.disable', 'profile.edit'), target, status ('applied' | 'pending_review' | 'rejected' | 'dropped' | 'conflict'), your stated reason, revisionId (once applied), createdAt, and a link: the target's page once applied, `/review` while pending (a conflict's review item is still pending too), or null for a rejected/dropped proposal. `pendingReview` is the live count of everything still awaiting a decision on /review, regardless of `since`. Defaults to today (agent timezone) — pass `since` (ISO datetime) to widen the window.",
  kind: 'read',
  toolset: 'improvements',
  schema: {
    since: z.string().min(1).optional().describe('ISO datetime — only improvements created at or after this. Defaults to the start of today in the agent timezone.'),
    limit: z.number().int().min(1).max(100).default(30).describe('Max items to return (1-100, default 30)')
  },
  handler: async (a) => {
    try {
      const { items, pendingReview } = await listImprovementsSince({
        since: a.since as string | undefined,
        limit: (a.limit as number | undefined) ?? 30
      })
      return { result: { items, pendingReview }, summary: `listed ${items.length} improvement(s), ${pendingReview} pending review` }
    } catch (err) {
      return { result: { ok: false, error: (err as Error).message }, summary: 'list_improvements failed' }
    }
  }
}

export const improvementTools: AgentTool[] = [listImprovementsTool]
