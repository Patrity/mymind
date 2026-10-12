// Cycle 81 (spec §5.1): the workstreams table — reads, the guarded state writes, and the live
// `workstream` resource (published on every state/used change; the Task 6 UI subscribes).
// Transitions are decided in loop.ts; this file only persists them.
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../../db'
import { workstreams, type WorkstreamRow } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import {
  DEFAULT_TREE_BUDGET, DEFAULT_WORKSTREAM_BUDGET, TERMINAL_WORKSTREAM_STATES, ZERO_USED,
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

/** A coordinator's tree budget, or null (not a coordinator). */
export function treeBudgetOf(row: Pick<WorkstreamRow, 'treeBudget'>): WorkstreamBudget | null {
  return row.treeBudget ? { ...DEFAULT_TREE_BUDGET, ...(row.treeBudget as Partial<WorkstreamBudget>) } : null
}

/** `childIds`: the coordinator's children (workstreamDTOs/workstreamDTO load them). */
export function toWorkstreamDTO(r: WorkstreamRow, childIds: string[] = []): WorkstreamDTO {
  return {
    id: r.id, conversationId: r.conversationId, originConversationId: r.originConversationId,
    goal: r.goal, state: r.state, toolsets: r.toolsets, budget: budgetOf(r), used: usedOf(r),
    attention: (r.attention as WorkstreamAttention | null) ?? null, summary: r.summary, failureReason: r.failureReason,
    currentRunId: r.currentRunId,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    parentId: r.parentId, modelLabel: r.modelLabel, workspaceMode: r.workspaceMode,
    treeBudget: treeBudgetOf(r), treeUsed: r.treeUsed ? usedOf({ used: r.treeUsed }) : null,
    childIds, tainted: r.tainted
  }
}

/** Child ids per coordinator, oldest first. */
export async function childIdsOf(parentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!parentIds.length) return out
  const rows = await useDb().select({ id: workstreams.id, parentId: workstreams.parentId }).from(workstreams)
    .where(inArray(workstreams.parentId, parentIds)).orderBy(asc(workstreams.createdAt), asc(workstreams.id))
  for (const r of rows) out.set(r.parentId!, [...(out.get(r.parentId!) ?? []), r.id])
  return out
}

/** DTOs with their children's ids filled in. */
export async function workstreamDTOs(rows: WorkstreamRow[]): Promise<WorkstreamDTO[]> {
  const kids = await childIdsOf(rows.filter(r => !r.parentId).map(r => r.id))
  return rows.map(r => toWorkstreamDTO(r, kids.get(r.id) ?? []))
}
export async function workstreamDTO(row: WorkstreamRow): Promise<WorkstreamDTO> {
  return (await workstreamDTOs([row]))[0]!
}

/** A coordinator's children (all states), oldest first. */
export async function childrenOf(parentId: string): Promise<WorkstreamRow[]> {
  return useDb().select().from(workstreams).where(eq(workstreams.parentId, parentId)).orderBy(asc(workstreams.createdAt), asc(workstreams.id))
}

/**
 * Cycle 83: refresh a coordinator's rolled-up `tree_used` (its own `used` + every child's) — called
 * after every step of any tree member and at spawn. A no-op for a workstream with no tree budget.
 */
export async function rollupTree(rootId: string): Promise<void> {
  const sum = (k: string) => sql.raw(`coalesce(sum((w.used->>'${k}')::numeric), 0)`)
  const res = await useDb().execute(sql`
    update workstreams p set tree_used = (
      select jsonb_build_object('steps', ${sum('steps')}, 'wallMs', ${sum('wallMs')}, 'inputTokens', ${sum('inputTokens')},
                                'outputTokens', ${sum('outputTokens')}, 'costUsd', ${sum('costUsd')})
      from workstreams w where w.id = p.id or w.parent_id = p.id)
    where p.id = ${rootId}::uuid and p.tree_budget is not null
    returning p.id`)
  if (res.rows.length) publishWorkstream(rootId)
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
/** Cycle 82 final review I2: called (worker only — runtime.ts installs it) when a patch moves a
 *  workstream to done / failed / cancelled, so its sandbox is torn down. Must not throw or block. */
let terminalHook: ((workstreamId: string) => void) | null = null
export function setWorkstreamTerminalHook(fn: ((workstreamId: string) => void) | null): void { terminalHook = fn }

export async function patchWorkstream(
  id: string,
  patch: Partial<Pick<WorkstreamRow, 'state' | 'used' | 'attention' | 'summary' | 'failureReason' | 'failures' | 'lastOutcome' | 'cancelRequested' | 'currentRunId' | 'finishedAt' | 'budget' | 'treeBudget' | 'tainted'>>,
  whenStates?: WorkstreamState[]
): Promise<WorkstreamRow | null> {
  const where: SQL = and(eq(workstreams.id, id), whenStates?.length ? inArray(workstreams.state, whenStates) : undefined)!
  const [r] = await useDb().update(workstreams).set({ ...patch, updatedAt: sql`now()` }).where(where).returning()
  if (r) publishWorkstream(id)
  if (r && patch.state && TERMINAL_WORKSTREAM_STATES.includes(patch.state)) {
    try { terminalHook?.(id) } catch { /* never blocks the transition */ }
  }
  // Cycle 83: every state change of a tree member — a child's reaches its coordinator (wake, refund,
  // escalation), a coordinator's ending cascades to its children. Awaited (a missed wake is a hung
  // tree) but never fails the transition itself. Imported at call time: coordinator.ts imports loop.ts.
  if (r && patch.state) {
    try { await (await import('./coordinator')).afterTransition(r) } catch (err) { console.error('[workstreams] tree transition hook failed:', err) }
  }
  return r ?? null
}
