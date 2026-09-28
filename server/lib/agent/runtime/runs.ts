// server/lib/agent/runtime/runs.ts
// The run store. Serialisation is the DATABASE's job, not a promise chain: a claim takes the
// oldest queued run whose conversation has nothing running, and agent_runs_one_running makes a
// second concurrent claim on the same conversation fail at the index, not merely unlikely.
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns, type AgentRun } from '../../../db/schema'
import type { RunInput, RunOutcome, RunProfile, RunTrigger } from './types'

export const HEADLESS_SLOTS = 1
export const ORPHAN_STALE_MS = 60_000

/**
 * This process's boot id, stamped on every run it claims (agent_runs.owner). After a deploy
 * restart, a run the OLD process was executing still looks alive for up to ORPHAN_STALE_MS
 * (its alive_at is only seconds old), so boot recovery skipped it and the thread sat wedged —
 * messages "steered" into a dead run — until the periodic tick caught it (final review I4).
 * With the owner known, an EXCLUSIVE deployment (AGENT_RUNTIME_EXCLUSIVE=1: this is the only
 * process running agent turns against the database) can take over every foreign-owned run at
 * boot regardless of age. Never on the shared dev DB: other checkouts' live dev servers own
 * runs there that are genuinely still running.
 */
export const BOOT_ID = randomUUID()
export function runtimeExclusive(): boolean { return process.env.AGENT_RUNTIME_EXCLUSIVE === '1' }

export async function createRun(i: {
  conversationId: string; sessionKey: string; trigger: RunTrigger; profile: RunProfile; input: RunInput
  wakeReason?: string | null; modelDefId?: string | null; originSinkId?: string | null; jobId?: string | null
}): Promise<AgentRun> {
  const [row] = await useDb().insert(agentRuns).values({
    conversationId: i.conversationId, sessionKey: i.sessionKey, trigger: i.trigger, profile: i.profile,
    input: i.input, wakeReason: i.wakeReason ?? null, modelDefId: i.modelDefId ?? null, originSinkId: i.originSinkId ?? null,
    jobId: i.jobId ?? null
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
  // `undefined` (the key omitted) means "no scoping requested" — production's default, claim
  // globally. An explicit `[]` means "scoped to nothing" and must claim NOTHING, not fall
  // through to unscoped — `and false` is Postgres's plain boolean-literal way to say that
  // without producing the syntax error `in ()` would.
  const scope = opts.onlyConversations === undefined
    ? sql``
    : opts.onlyConversations.length
      ? sql`and r.conversation_id in (${sql.join(opts.onlyConversations.map(id => sql`${id}::uuid`), sql`, `)})`
      : sql`and false`
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
        .set({ status: 'running', claimedAt: sql`now()`, aliveAt: sql`now()`, owner: BOOT_ID })
        .where(eq(agentRuns.id, id)).returning()
      return row ?? null
    })
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
}

/**
 * Bump liveness — but ONLY while the row still says 'running'. Fenced (fix round 1, Task 8
 * review): if another process (a periodic recoverStale tick on the shared dev DB, or our own
 * after an event-loop stall) already flipped this run to 'interrupted', the bump must not
 * silently resurrect it by touching a row nothing owns anymore. Returns whether it actually
 * matched — `false` is the caller's signal that ITS run was taken out from under it.
 */
export async function touchRun(id: string): Promise<boolean> {
  const rows = await useDb().update(agentRuns).set({ aliveAt: sql`now()` })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id })
  return rows.length > 0
}

/**
 * Same fencing as `touchRun`: only a row still 'running' can be finished. Without this, a run
 * recovered (marked 'interrupted') while its owning process was still alive — event loop
 * stall past the 60s orphan threshold, or another checkout's periodic tick racing the same
 * shared dev DB — would have its interrupted note silently overwritten the moment the original
 * process's turn actually completed (Task 8 review ruling: this reverses Task 2's "finishRun
 * stays unguarded" — a run can now legitimately be taken from under a live process).
 */
export async function finishRun(id: string, o: RunOutcome): Promise<void> {
  await useDb().update(agentRuns).set({
    status: o.status, suppressed: o.suppressed ?? false, error: o.error ?? null, usage: o.usage ?? null,
    userMessageId: o.userMessageId ?? null, assistantMessageId: o.assistantMessageId ?? null,
    finishedAt: sql`now()`
  }).where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'running')))
}

export async function activeRunFor(conversationId: string): Promise<AgentRun | null> {
  const [row] = await useDb().select().from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.status, 'running'))).limit(1)
  return row ?? null
}

export async function recoverOrphans(opts: {
  staleMs?: number; onlyConversations?: string[]; excludeRunIds?: string[]
  /** Also recover any 'running' row claimed by a DIFFERENT boot, however fresh its alive_at.
   *  Only safe when this process is the sole runtime on the database — see BOOT_ID. */
  takeoverForeign?: boolean
} = {}): Promise<AgentRun[]> {
  const staleSec = Math.round((opts.staleMs ?? ORPHAN_STALE_MS) / 1000)
  // Same "undefined = unscoped, [] = nothing" distinction as claimNextRun — an empty array
  // must never be read the same as "no scope given" (that inverted the intent of a caller
  // that scoped itself to zero conversations, e.g. `workerTick({ onlyConversations: [] })`).
  const convScope = opts.onlyConversations === undefined
    ? undefined
    : opts.onlyConversations.length ? inArray(agentRuns.conversationId, opts.onlyConversations) : sql`false`
  // Runs this very process is still actively executing (queue.ts's `executing` set) must never
  // be recovered by our OWN periodic tick just because an alive_at bump happened to lag — that
  // set is this process's ground truth about what it owns. It can't protect against a
  // DIFFERENT process's tick (that's what the touchRun/finishRun fencing is for), only against
  // self-inflicted false positives.
  const idScope = opts.excludeRunIds?.length ? notInArray(agentRuns.id, opts.excludeRunIds) : undefined
  return useDb().update(agentRuns)
    .set({ status: 'interrupted', finishedAt: sql`now()`, error: 'interrupted by a restart' })
    .where(and(
      eq(agentRuns.status, 'running'),
      or(
        sql`coalesce(${agentRuns.aliveAt}, ${agentRuns.claimedAt}) < now() - make_interval(secs => ${staleSec})`,
        // A null owner (claimed before 0055, or by a process predating it) stays age-only.
        opts.takeoverForeign ? sql`(${agentRuns.owner} is not null and ${agentRuns.owner} <> ${BOOT_ID})` : undefined
      ),
      convScope,
      idScope
    ))
    .returning()
}

export async function listRuns(o: { conversationId?: string; limit?: number }): Promise<AgentRun[]> {
  return useDb().select().from(agentRuns)
    .where(o.conversationId ? eq(agentRuns.conversationId, o.conversationId) : undefined)
    .orderBy(desc(agentRuns.createdAt)).limit(Math.min(o.limit ?? 50, 200))
}
