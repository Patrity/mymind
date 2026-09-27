// server/lib/agent/runtime/runs.ts
// The run store. Serialisation is the DATABASE's job, not a promise chain: a claim takes the
// oldest queued run whose conversation has nothing running, and agent_runs_one_running makes a
// second concurrent claim on the same conversation fail at the index, not merely unlikely.
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns, type AgentRun } from '../../../db/schema'
import type { RunInput, RunOutcome, RunProfile, RunTrigger } from './types'

export const HEADLESS_SLOTS = 1
export const ORPHAN_STALE_MS = 60_000

export async function createRun(i: {
  conversationId: string; sessionKey: string; trigger: RunTrigger; profile: RunProfile; input: RunInput
  wakeReason?: string | null; modelDefId?: string | null; originSinkId?: string | null
}): Promise<AgentRun> {
  const [row] = await useDb().insert(agentRuns).values({
    conversationId: i.conversationId, sessionKey: i.sessionKey, trigger: i.trigger, profile: i.profile,
    input: i.input, wakeReason: i.wakeReason ?? null, modelDefId: i.modelDefId ?? null, originSinkId: i.originSinkId ?? null
  }).returning()
  return row!
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

/**
 * Claim the oldest runnable run, or null.
 *
 * Two claimers can each lock a DIFFERENT queued row of the same conversation (SKIP LOCKED lets
 * them pass each other) and both pass the NOT EXISTS check before either commits. The loser's
 * UPDATE then violates agent_runs_one_running — that is the design, and it returns null here.
 * `onlyConversations` is a test seam: the dev database is shared, so a test must not claim
 * another file's (or a live session's) queued run.
 */
export async function claimNextRun(opts: { headlessSlots?: number; onlyConversations?: string[] } = {}): Promise<AgentRun | null> {
  const slots = opts.headlessSlots ?? HEADLESS_SLOTS
  const scope = opts.onlyConversations?.length
    ? sql`and r.conversation_id in (${sql.join(opts.onlyConversations.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  try {
    return await useDb().transaction(async (tx) => {
      const picked = await tx.execute(sql`
        select r.id from agent_runs r
        where r.status = 'queued'
          and not exists (select 1 from agent_runs x where x.conversation_id = r.conversation_id and x.status = 'running')
          and (r.profile <> 'headless'
               or (select count(*) from agent_runs h where h.status = 'running' and h.profile = 'headless') < ${slots})
          ${scope}
        order by r.created_at, r.id
        limit 1
        for update skip locked`)
      const id = (picked.rows[0] as { id?: string } | undefined)?.id
      if (!id) return null
      const [row] = await tx.update(agentRuns)
        .set({ status: 'running', claimedAt: sql`now()`, aliveAt: sql`now()` })
        .where(eq(agentRuns.id, id)).returning()
      return row ?? null
    })
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
}

export async function touchRun(id: string): Promise<void> {
  await useDb().update(agentRuns).set({ aliveAt: sql`now()` }).where(eq(agentRuns.id, id))
}

export async function finishRun(id: string, o: RunOutcome): Promise<void> {
  await useDb().update(agentRuns).set({
    status: o.status, suppressed: o.suppressed ?? false, error: o.error ?? null, usage: o.usage ?? null,
    userMessageId: o.userMessageId ?? null, assistantMessageId: o.assistantMessageId ?? null,
    finishedAt: sql`now()`
  }).where(eq(agentRuns.id, id))
}

export async function activeRunFor(conversationId: string): Promise<AgentRun | null> {
  const [row] = await useDb().select().from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.status, 'running'))).limit(1)
  return row ?? null
}

export async function recoverOrphans(opts: { staleMs?: number; onlyConversations?: string[] } = {}): Promise<AgentRun[]> {
  const staleSec = Math.round((opts.staleMs ?? ORPHAN_STALE_MS) / 1000)
  const scope = opts.onlyConversations?.length ? inArray(agentRuns.conversationId, opts.onlyConversations) : undefined
  return useDb().update(agentRuns)
    .set({ status: 'interrupted', finishedAt: sql`now()`, error: 'interrupted by a restart' })
    .where(and(
      eq(agentRuns.status, 'running'),
      sql`coalesce(${agentRuns.aliveAt}, ${agentRuns.claimedAt}) < now() - make_interval(secs => ${staleSec})`,
      scope
    ))
    .returning()
}

export async function listRuns(o: { conversationId?: string; limit?: number }): Promise<AgentRun[]> {
  return useDb().select().from(agentRuns)
    .where(o.conversationId ? eq(agentRuns.conversationId, o.conversationId) : undefined)
    .orderBy(desc(agentRuns.createdAt)).limit(Math.min(o.limit ?? 50, 200))
}
