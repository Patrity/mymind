// server/lib/agent/config/revisions.ts
// Shared revision history for agent config (skills and jobs, cycle 74). Every write of a skill's
// or job's markdown records the full content here, so any edit — human or agent — is revertible.
import { and, desc, eq, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentConfigRevisions } from '../../../db/schema'

export const REVISIONS_KEPT = 100

export type RevisionTargetKind = 'skill' | 'job'
export type RevisionActor = 'human' | 'agent' | 'system'

// Anything with the drizzle query surface — the pool or an open transaction — so a caller that
// writes the target inside a transaction can record the revision in that same transaction.
type Executor = Pick<ReturnType<typeof useDb>, 'insert' | 'execute'>

export async function recordRevision(
  i: { targetKind: RevisionTargetKind, targetId: string, content: string, actor: RevisionActor, runId?: string | null },
  db: Executor = useDb()
): Promise<void> {
  await db.insert(agentConfigRevisions).values({
    targetKind: i.targetKind,
    targetId: i.targetId,
    content: i.content,
    actor: i.actor,
    runId: i.runId ?? null,
    // clock_timestamp, not now(): several revisions written in one transaction (or in a tight
    // loop) must still order strictly, or "keep the newest 100" has ties to break arbitrarily.
    createdAt: sql`clock_timestamp()`
  })
  await db.execute(sql`
    delete from agent_config_revisions
    where target_kind = ${i.targetKind} and target_id = ${i.targetId}
      and id not in (
        select id from agent_config_revisions
        where target_kind = ${i.targetKind} and target_id = ${i.targetId}
        order by created_at desc
        limit ${REVISIONS_KEPT}
      )`)
}

export async function listRevisions(
  targetKind: RevisionTargetKind, targetId: string, limit = REVISIONS_KEPT
): Promise<{ id: string, content: string, actor: string, createdAt: string }[]> {
  const rows = await useDb().select().from(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.targetKind, targetKind), eq(agentConfigRevisions.targetId, targetId)))
    .orderBy(desc(agentConfigRevisions.createdAt))
    .limit(limit)
  return rows.map(r => ({ id: r.id, content: r.content, actor: r.actor, createdAt: r.createdAt.toISOString() }))
}

export async function getRevision(id: string): Promise<{ id: string, targetKind: string, targetId: string, content: string } | null> {
  const [r] = await useDb().select().from(agentConfigRevisions).where(eq(agentConfigRevisions.id, id)).limit(1)
  return r ? { id: r.id, targetKind: r.targetKind, targetId: r.targetId, content: r.content } : null
}
