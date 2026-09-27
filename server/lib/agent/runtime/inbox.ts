// server/lib/agent/runtime/inbox.ts
// Messages Tony sends while a run is busy. A 'steer' is drained into the running turn at its
// next step boundary (runAgent's prepareStep); whatever the run never read survives an abort.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentInbox, type AgentRun } from '../../../db/schema'
import { createRun } from './runs'
import type { RunInput } from './types'

export async function pushSteer(runId: string, conversationId: string, text: string, source: 'user' | 'wake'): Promise<void> {
  await useDb().insert(agentInbox).values({ runId, conversationId, mode: 'steer', content: text, source })
}

/** Unconsumed steers for this run, oldest first, marked consumed in the same statement. */
export async function drainSteerFor(runId: string): Promise<string[]> {
  const rows = await useDb().update(agentInbox).set({ consumedAt: sql`now()` })
    .where(and(eq(agentInbox.runId, runId), isNull(agentInbox.consumedAt)))
    .returning({ content: agentInbox.content, createdAt: agentInbox.createdAt })
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(r => r.content)
}

/** After an abort: whatever Tony typed that the run never read becomes the next run. His words
 *  are never silently dropped. */
export async function requeueUnconsumed(run: AgentRun): Promise<string | null> {
  const left = await drainSteerFor(run.id)
  if (!left.length) return null
  const input: RunInput = { text: left.join('\n\n'), modality: 'text' }
  const next = await createRun({ conversationId: run.conversationId, sessionKey: run.sessionKey, trigger: 'user', profile: run.profile as 'interactive' | 'headless', input, originSinkId: run.originSinkId })
  return next.id
}
