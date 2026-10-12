// server/lib/agent/runtime/inbox.ts
// Messages Tony sends while a run is busy. A 'steer' is drained into the running turn at its
// next step boundary (runAgent's prepareStep); whatever the run never read survives an abort.
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
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
/** Cycle 83 final fix wave (M2/C4): what a coordinator sends its child. 'coordinator' (steer_workstream)
 *  is spliced into the running turn like a report — as a coordinator event row; 'coordinator-answer'
 *  (answer_child) is NEVER drained mid-turn: the child's question turn ends first, and the answer
 *  becomes the next segment (onSegmentFinished), so it sits after the question in the thread. */
export type InboxSource = 'user' | 'wake' | 'report' | 'coordinator' | 'coordinator-answer'
const NOT_TYPED: InboxSource[] = ['report', 'coordinator', 'coordinator-answer']

export async function pushSteer(runId: string, conversationId: string, text: string, source: InboxSource): Promise<boolean> {
  const result = await useDb().execute(sql`
    insert into agent_inbox (run_id, conversation_id, mode, content, source)
    select ${runId}::uuid, ${conversationId}::uuid, 'steer', ${text}, ${source}
    where exists (select 1 from agent_runs where id = ${runId}::uuid and status = 'running' for share)
    returning id
  `)
  return result.rows.length > 0
}

/** Unconsumed steers for this run, oldest first, marked consumed in the same statement. Only
 *  words someone TYPED (source user/wake) — a coordinator's child report (source 'report', cycle 83)
 *  or its own message to a child (final fix wave M2) is never Tony's words: drainInboxFor /
 *  drainReportsFor / drainCoordinatorFor take those. */
export async function drainSteerFor(runId: string): Promise<string[]> {
  const rows = await useDb().update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt), notInArray(agentInbox.source, NOT_TYPED)))
    .returning({ content: agentInbox.content, createdAt: agentInbox.createdAt })
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(r => r.content)
}

/** Cycle 83 fix round 2: a child report steered into a running coordinator segment, or Tony's words;
 *  final fix wave (M2): or a coordinator's steer into its running child. */
export type InboxItem = { kind: 'typed' | 'report' | 'coordinator'; text: string }

/** The runner's drain: everything unconsumed, in arrival order, typed words, reports and coordinator
 *  steers kept apart (the latter two are spliced and persisted as EVENT rows, never as user messages).
 *  A coordinator's ANSWER is left for the segment's end (C4: it must follow the question turn). */
export async function drainInboxFor(runId: string): Promise<InboxItem[]> {
  const rows = await useDb().update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt), notInArray(agentInbox.source, ['coordinator-answer'])))
    .returning({ content: agentInbox.content, source: agentInbox.source, createdAt: agentInbox.createdAt })
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(r => ({ kind: r.source === 'report' ? 'report' : r.source === 'coordinator' ? 'coordinator' : 'typed', text: r.content }) as InboxItem)
}

/** Final fix wave (M2/C4): what the coordinator sent a segment that never read it (an answer always;
 *  a steer that arrived as the turn ended) — the loop makes it the child's next segment. */
export async function drainCoordinatorFor(runId: string): Promise<string[]> {
  const rows = await useDb().update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt), inArray(agentInbox.source, ['coordinator', 'coordinator-answer'])))
    .returning({ content: agentInbox.content, createdAt: agentInbox.createdAt })
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(r => r.content)
}

/** Reports a segment never read (it ended first) — the loop appends them to the thread as event rows. */
export async function drainReportsFor(runId: string, o: { tx?: Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0] } = {}): Promise<string[]> {
  const rows = await (o.tx ?? useDb()).update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt), eq(agentInbox.source, 'report')))
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
