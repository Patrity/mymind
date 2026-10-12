// Cycle 81 (spec §5.1): the workstreams table — reads, the guarded state writes, and the live
// `workstream` resource (published on every state/used change; the Task 6 UI subscribes).
// Transitions are decided in loop.ts; this file only persists them.
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../../db'
import { workspaces, workstreams, type WorkstreamRow } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import {
  DEFAULT_WORKSTREAM_BUDGET, TERMINAL_WORKSTREAM_STATES, ZERO_USED, normalizeTreeBudget,
  type TreeBudget, type WorkstreamAttention, type WorkstreamBudget, type WorkstreamDTO, type WorkstreamState, type WorkstreamUsed
} from '../../../shared/types/workstreams'
import { persistableTaint, TAINT_SOURCES, type ApprovalVerdictDTO, type TaintSource } from '../judge/types'

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
export function treeBudgetOf(row: Pick<WorkstreamRow, 'treeBudget'>): TreeBudget | null {
  return row.treeBudget ? normalizeTreeBudget(row.treeBudget) : null
}

/** `childIds`: the coordinator's children (workstreamDTOs/workstreamDTO load them); `childCount` how
 *  many it has in all (the list embeds only some — listChildrenEmbedded). */
export function toWorkstreamDTO(r: WorkstreamRow, childIds: string[] = [], childCount = childIds.length, resolvedModel: string | null = null): WorkstreamDTO {
  return {
    id: r.id, conversationId: r.conversationId, originConversationId: r.originConversationId,
    goal: r.goal, state: r.state, toolsets: r.toolsets, budget: budgetOf(r), used: usedOf(r),
    attention: (r.attention as WorkstreamAttention | null) ?? null, stateDetail: r.state === 'running' ? r.stateDetail ?? null : null,
    summary: r.summary, failureReason: r.failureReason,
    currentRunId: r.currentRunId,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    parentId: r.parentId, modelLabel: r.modelLabel, resolvedModel: r.isChild ? resolvedModel : null, workspaceMode: r.workspaceMode,
    treeBudget: treeBudgetOf(r), treeUsed: r.treeUsed ? usedOf({ used: r.treeUsed }) : null,
    childIds, childCount, tainted: r.tainted, isChild: r.isChild
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

/**
 * Final fix wave (C2): each CHILD's model as it resolves now (pools.ts childChainFrom — the model its
 * next segment is pooled on and tries first), by row id. One config read; one resolution per label.
 * Empty when the config cannot be read (the UI then shows the label, or "default model").
 */
export async function childModelLabels(rows: WorkstreamRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const kids = rows.filter(r => r.isChild)
  if (!kids.length) return out
  try {
    const [{ loadConfig }, { childChainFrom }] = await Promise.all([import('../../ai/registry/store'), import('../runtime/pools')])
    const doc = await loadConfig()
    const byLabel = new Map<string | null, string | null>()
    for (const k of kids) {
      if (!byLabel.has(k.modelLabel)) {
        let label: string | null = null
        try { label = childChainFrom(doc, k.modelLabel)[0]?.label ?? null } catch { /* unresolvable: none */ }
        byLabel.set(k.modelLabel, label)
      }
      out.set(k.id, byLabel.get(k.modelLabel) ?? null)
    }
  } catch { /* no config: leave them unresolved */ }
  return out
}

/** DTOs with their children's ids (and a child's resolved model) filled in. */
export async function workstreamDTOs(rows: WorkstreamRow[]): Promise<WorkstreamDTO[]> {
  const [kids, models] = await Promise.all([childIdsOf(rows.filter(r => !r.isChild).map(r => r.id)), childModelLabels(rows)])
  return rows.map(r => toWorkstreamDTO(r, kids.get(r.id) ?? [], undefined, models.get(r.id) ?? null))
}
export async function workstreamDTO(row: WorkstreamRow): Promise<WorkstreamDTO> {
  return (await workstreamDTOs([row]))[0]!
}

/** A coordinator's children (all states), oldest first; `page` pages them (the children route). */
export async function childrenOf(parentId: string, page?: { limit: number; offset: number }): Promise<WorkstreamRow[]> {
  const q = useDb().select().from(workstreams).where(eq(workstreams.parentId, parentId)).orderBy(asc(workstreams.createdAt), asc(workstreams.id))
  return page ? q.limit(page.limit).offset(page.offset) : q
}

/**
 * Cycle 83 Task 3 fix round 1 (I1/M1): the children the /api/workstreams list embeds — at most
 * `perParent` per coordinator, still-going ones first, then newest first — and each coordinator's
 * total, in ONE query (window functions), so a coordinator with hundreds of children never makes the
 * list unbounded. `byParent` keeps that order.
 */
export async function listChildrenEmbedded(parentIds: string[], perParent: number): Promise<{ byParent: Map<string, WorkstreamRow[]>; counts: Map<string, number> }> {
  const byParent = new Map<string, WorkstreamRow[]>()
  const counts = new Map<string, number>()
  if (!parentIds.length) return { byParent, counts }
  const db = useDb()
  const ended = sql`${workstreams.state} in ('done', 'failed', 'cancelled')`
  const k = db.select({
    ...getTableColumns(workstreams),
    total: sql<number>`count(*) over (partition by ${workstreams.parentId})`.mapWith(Number).as('total'),
    rank: sql<number>`row_number() over (partition by ${workstreams.parentId} order by ${ended}, ${workstreams.createdAt} desc, ${workstreams.id} desc)`.mapWith(Number).as('rank')
  }).from(workstreams).where(inArray(workstreams.parentId, parentIds)).as('k')
  const rows = await db.select().from(k).where(lte(k.rank, perParent)).orderBy(k.parentId, k.rank)
  for (const { total, rank: _rank, ...row } of rows) {
    const pid = row.parentId!
    counts.set(pid, total)
    byParent.set(pid, [...(byParent.get(pid) ?? []), row as WorkstreamRow])
  }
  return { byParent, counts }
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

/** `topLevel`: only rows with no coordinator (`parent_id` null — so an orphaned child, whose
 *  coordinator row is gone, is listed on its own rather than never). */
export async function listWorkstreams(o: { states?: WorkstreamState[]; limit?: number; topLevel?: boolean } = {}): Promise<WorkstreamRow[]> {
  return useDb().select().from(workstreams)
    .where(and(o.states?.length ? inArray(workstreams.state, o.states) : undefined, o.topLevel ? isNull(workstreams.parentId) : undefined))
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

/**
 * Cycle 84: keep an approval attention's judge state current as the verdict lands — only while the
 * row still waits on THAT card (state 'attention', same requestId). False when it no longer does.
 */
export async function patchAttentionJudge(id: string, requestId: string, judge: ApprovalVerdictDTO): Promise<boolean> {
  const rows = await useDb().update(workstreams)
    .set({ attention: sql`jsonb_set(${workstreams.attention}, '{judge}', ${JSON.stringify(judge)}::jsonb)`, updatedAt: sql`now()` })
    .where(and(eq(workstreams.id, id), eq(workstreams.state, 'attention'), sql`${workstreams.attention}->>'requestId' = ${requestId}`))
    .returning({ id: workstreams.id })
  if (rows.length) publishWorkstream(id)
  return rows.length > 0
}

/**
 * Cycle 84 final fix wave (C1): why a workstream is tainted, as stored. Taint is sticky for the
 * workstream's whole life — every segment's run is seeded from this. A row tainted before the sources
 * were stored (empty set) reads as `mail` (the cycle-83 meaning of `tainted`). Unknown strings are
 * dropped; order is TAINT_SOURCES'.
 */
export function storedTaintSources(row: Pick<WorkstreamRow, 'tainted' | 'taintSources'>): TaintSource[] {
  // Final follow-up (N1): only the persisted kinds count — a `workspace` written by the first fix wave
  // is ignored (it is derived live from the workspace's own flag now).
  const have = new Set(persistableTaint(row.taintSources ?? []))
  if (row.tainted && !have.size) have.add('mail')
  return TAINT_SOURCES.filter(x => have.has(x))
}

/** The workspace a workstream's commands run in is tainted (its own, or — a `shared` child — its
 *  coordinator's). Unreadable → tainted (fail closed). */
export async function workstreamWorkspaceTainted(row: Pick<WorkstreamRow, 'id' | 'parentId' | 'workspaceMode'>): Promise<boolean> {
  try {
    const wsId = row.workspaceMode === 'shared' ? row.parentId : row.id
    if (!wsId) return false
    const [w] = await useDb().select({ tainted: workspaces.tainted }).from(workspaces).where(eq(workspaces.workstreamId, wsId)).limit(1)
    return w?.tainted ?? false
  } catch { return true }
}

/**
 * Cycle 84 final fix wave (C1): mark the workstream tainted with these sources — a UNION in SQL (two
 * writers can never shrink the set; never cleared). Publishes the row. False: no such workstream.
 */
export async function addWorkstreamTaint(id: string, sources: readonly TaintSource[]): Promise<boolean> {
  const add = persistableTaint(sources)
  if (!add.length) return false
  const rows = await useDb().update(workstreams).set({
    tainted: true,
    taintSources: sql`(select coalesce(array_agg(distinct x order by x), '{}'::text[]) from unnest(${workstreams.taintSources} || ${sql.param(add)}::text[]) as x)`,
    updatedAt: sql`now()`
  }).where(eq(workstreams.id, id)).returning({ id: workstreams.id })
  if (rows.length) publishWorkstream(id)
  return rows.length > 0
}

export async function patchWorkstream(
  id: string,
  patch: Partial<Pick<WorkstreamRow, 'state' | 'used' | 'attention' | 'stateDetail' | 'summary' | 'failureReason' | 'failures' | 'lastOutcome' | 'cancelRequested' | 'currentRunId' | 'finishedAt' | 'budget' | 'treeBudget' | 'tainted'>>,
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
