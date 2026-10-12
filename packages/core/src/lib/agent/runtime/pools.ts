// Cycle 83 (spec §3): per-model in-flight pools for workstream segments.
//
// A pool is not a structure in memory: it is the COUNT of `running` workstream segments
// (agent_runs kind='workstream') whose `model_def_id` is that model, checked by claimNextRun
// (runs.ts) against the model's `maxInFlight`. Because it is read from the database at every
// claim, a slot is free the moment its run leaves 'running' — done, failed, aborted or
// interrupted by recovery — and a worker restart recomputes nothing: the rows are the pool.
// Segments over the limit simply stay `queued` and are claimed oldest first (FIFO) when a slot
// frees. Chat turns (kind='turn') and wakes are never pooled: chat stays responsive.
//
// The pool key is the segment's PRIMARY model, stamped on the row when the segment is enqueued
// (workstreams/loop.ts enqueueSegment → segmentPrimaryModelId). It is never rewritten during the
// run, so failing over to another model mid-segment does not take a second slot (bounded
// overshoot on the fallback model, accepted by the spec).
import { loadConfig } from '../../ai/registry/store'
import { resolveChainFrom, resolveSubagentChainFrom } from '../../ai/registry/resolve'
import { UnknownSubagentModelError } from '../../ai/registry/errors'
import type { ResolvedModel } from '../../ai/registry/types'
import { DEFAULT_MAX_IN_FLIGHT, type AiConfigDoc } from '../../ai/registry/types'
import type { WorkstreamRow } from '../workstreams/store'

/** Pure: model id → its pool size (`maxInFlight`, or the default). */
export function poolLimitsFrom(doc: AiConfigDoc): Record<string, number> {
  return Object.fromEntries(doc.models.map(m => [m.id, m.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT]))
}

/** The pool sizes the claim uses. An unreadable config never stops claiming: every model then
 *  gets the default (a model not in the config — deleted since the segment was queued — too). */
export async function poolLimits(): Promise<Record<string, number>> {
  try { return poolLimitsFrom(await loadConfig()) } catch { return {} }
}

/**
 * Cycle 83: a CHILD workstream's failover chain — its label's model, the rest of `subagents`, then
 * `reasoning` (registry resolveSubagentChainFrom). A label removed from `subagents` since the child
 * was spawned falls back to the default (no label) instead of failing every segment; spawn itself
 * refuses an unknown label. Shared by the pool key below and the runner (model.ts subagentChain), so
 * the slot a segment takes and the model it tries first are always the same.
 */
export function childChainFrom(doc: AiConfigDoc, label: string | null): ResolvedModel[] {
  try { return resolveSubagentChainFrom(doc, label) } catch (err) {
    if (err instanceof UnknownSubagentModelError) return resolveSubagentChainFrom(doc, null)
    throw err
  }
}
export async function childChain(label: string | null): Promise<ResolvedModel[]> {
  return childChainFrom(await loadConfig(), label)
}

/**
 * The primary model a workstream's next segment runs on — its pool key. Called once per segment,
 * when the segment is enqueued, and stamped on agent_runs.model_def_id (the runner then tries that
 * model first). A CHILD (`parentId` set) runs on its subagents chain (no label = the first
 * `subagents` model, or `reasoning` when `subagents` is empty); everything else — coordinators
 * included — on the head of `reasoning`.
 * Null (AI not configured) = unpooled; the segment then fails in the runner as it would anyway.
 */
export async function segmentPrimaryModelId(ws: Pick<WorkstreamRow, 'parentId' | 'modelLabel'>): Promise<string | null> {
  try {
    const doc = await loadConfig()
    return (ws.parentId ? childChainFrom(doc, ws.modelLabel) : resolveChainFrom(doc, 'reasoning'))[0]!.modelDefId
  } catch { return null }
}
