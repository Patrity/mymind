// server/lib/agent/runtime/inbox.ts
// Messages Tony sends while a run is busy. A 'steer' is drained into the running turn at its
// next step boundary (runAgent's prepareStep); whatever the run never read survives an abort.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentInbox, type AgentRun } from '../../../db/schema'
import { createRun } from './runs'
import type { RunInput } from './types'

/**
 * Insert a steer, but ONLY if the run it's aimed at is still 'running' — closes the enqueue
 * race (Task 8 review, fix round 1): `enqueue` reads `activeRunFor` and then calls this in a
 * separate await; if the run finishes in between, an unconditional insert would attach the
 * steer to a run that will never drain it (Tony's words silently dropped). The `where exists`
 * makes the check and the insert one atomic statement — no window for the run to finish
 * between "is it running" and "attach to it". Returns whether it actually inserted; `enqueue`
 * falls back to creating a fresh run when it didn't.
 *
 * `for share` (final review I3) closes the last millisecond: without a row lock, finishRun's
 * UPDATE could commit between this statement's snapshot and its insert, and execute()'s
 * requeueUnconsumed could run before the insert was visible — a steer attached to a finished
 * run that nothing ever drains. The share lock makes finishRun wait for this insert to commit,
 * so the requeue that follows it always sees the steer.
 */
export async function pushSteer(runId: string, conversationId: string, text: string, source: 'user' | 'wake'): Promise<boolean> {
  const result = await useDb().execute(sql`
    insert into agent_inbox (run_id, conversation_id, mode, content, source)
    select ${runId}::uuid, ${conversationId}::uuid, 'steer', ${text}, ${source}
    where exists (select 1 from agent_runs where id = ${runId}::uuid and status = 'running' for share)
    returning id
  `)
  return result.rows.length > 0
}

/** Unconsumed steers for this run, oldest first, marked consumed in the same statement. */
export async function drainSteerFor(runId: string): Promise<string[]> {
  const rows = await useDb().update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt)))
    .returning({ content: agentInbox.content, createdAt: agentInbox.createdAt })
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(r => r.content)
}

/** On every terminal outcome (done/failed/aborted) and on recovery: whatever Tony typed that
 *  the run never read becomes the next run. His words are never silently dropped — this holds
 *  regardless of WHY the run ended, not only on abort (Task 8 review, fix round 1: a steer can
 *  arrive during the last step's generation, or in the gap between runTurn returning and
 *  finishRun, and was previously only requeued on 'aborted'). Always interactive/user: an
 *  unread steer is always something Tony typed, even when the run it missed was a headless
 *  wake — the follow-up must run as a normal interactive turn, not inherit 'headless'. */
export async function requeueUnconsumed(run: AgentRun): Promise<string | null> {
  const left = await drainSteerFor(run.id)
  if (!left.length) return null
  const input: RunInput = { text: left.join('\n\n'), modality: 'text' }
  const next = await createRun({ conversationId: run.conversationId, sessionKey: run.sessionKey, trigger: 'user', profile: 'interactive', input, originSinkId: run.originSinkId })
  return next.id
}
