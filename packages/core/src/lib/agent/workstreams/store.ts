// Cycle 81 (spec §5.1): the workstreams table — reads, the guarded state writes, and the live
// `workstream` resource (published on every state/used change; the Task 6 UI subscribes).
// Transitions are decided in loop.ts; this file only persists them.
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../../db'
import { workstreams, type WorkstreamRow } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import {
  DEFAULT_WORKSTREAM_BUDGET, ZERO_USED,
  type WorkstreamAttention, type WorkstreamBudget, type WorkstreamDTO, type WorkstreamState, type WorkstreamUsed
} from '../../../shared/types/workstreams'

export type { WorkstreamRow }

export function usedOf(row: Pick<WorkstreamRow, 'used'>): WorkstreamUsed {
  return { ...ZERO_USED, ...(row.used as Partial<WorkstreamUsed> | null ?? {}) }
}
export function budgetOf(row: Pick<WorkstreamRow, 'budget'>): WorkstreamBudget {
  return { ...DEFAULT_WORKSTREAM_BUDGET, ...(row.budget as Partial<WorkstreamBudget> | null ?? {}) }
}

/** Which budget dimension is used up, or null. */
export function exhausted(row: Pick<WorkstreamRow, 'used' | 'budget'>): string | null {
  const u = usedOf(row)
  const b = budgetOf(row)
  if (u.steps >= b.maxSteps) return `step budget used up (${u.steps} of ${b.maxSteps} steps)`
  if (u.wallMs >= b.maxWallMs) return `time budget used up (${Math.round(u.wallMs / 60_000)} of ${Math.round(b.maxWallMs / 60_000)} min)`
  return null
}

export function toWorkstreamDTO(r: WorkstreamRow): WorkstreamDTO {
  return {
    id: r.id, conversationId: r.conversationId, originConversationId: r.originConversationId,
    goal: r.goal, state: r.state, toolsets: r.toolsets, budget: budgetOf(r), used: usedOf(r),
    attention: (r.attention as WorkstreamAttention | null) ?? null, summary: r.summary, failureReason: r.failureReason,
    currentRunId: r.currentRunId,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null
  }
}

export function publishWorkstream(id: string, action: 'created' | 'updated' | 'deleted' = 'updated'): void {
  publishChange({ resource: 'workstream', action, id })
}

export async function getWorkstream(id: string): Promise<WorkstreamRow | null> {
  const [r] = await useDb().select().from(workstreams).where(eq(workstreams.id, id)).limit(1)
  return r ?? null
}

/** The workstream whose own thread `conversationId` is, or null (an ordinary thread). */
export async function workstreamForConversation(conversationId: string): Promise<WorkstreamRow | null> {
  const [r] = await useDb().select().from(workstreams).where(eq(workstreams.conversationId, conversationId)).limit(1)
  return r ?? null
}

export async function listWorkstreams(o: { states?: WorkstreamState[]; limit?: number } = {}): Promise<WorkstreamRow[]> {
  return useDb().select().from(workstreams)
    .where(o.states?.length ? inArray(workstreams.state, o.states) : undefined)
    .orderBy(desc(workstreams.createdAt)).limit(Math.min(o.limit ?? 50, 200))
}

export async function insertWorkstream(v: {
  conversationId: string; originConversationId: string | null; goal: string; toolsets: string[]; budget: WorkstreamBudget
}): Promise<WorkstreamRow> {
  const [r] = await useDb().insert(workstreams).values({ ...v, used: ZERO_USED, state: 'queued' }).returning()
  publishWorkstream(r!.id, 'created')
  return r!
}

/** Patch a workstream, optionally only while it is in one of `whenStates` (a guarded transition: a
 *  late attention update must never overwrite `done`/`cancelled`). Returns the new row, or null when
 *  the guard did not match. Always bumps updated_at and publishes the live change. */
export async function patchWorkstream(
  id: string,
  patch: Partial<Pick<WorkstreamRow, 'state' | 'used' | 'attention' | 'summary' | 'failureReason' | 'failures' | 'lastOutcome' | 'cancelRequested' | 'currentRunId' | 'finishedAt' | 'budget'>>,
  whenStates?: WorkstreamState[]
): Promise<WorkstreamRow | null> {
  const where: SQL = and(eq(workstreams.id, id), whenStates?.length ? inArray(workstreams.state, whenStates) : undefined)!
  const [r] = await useDb().update(workstreams).set({ ...patch, updatedAt: sql`now()` }).where(where).returning()
  if (r) publishWorkstream(id)
  return r ?? null
}
