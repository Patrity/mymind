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
import { resolveChainFrom } from '../../ai/registry/resolve'
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
 * THE HOOK (Task 2): the primary model a workstream's next segment runs on — its pool key.
 * Called once per segment, when the segment is enqueued, and stamped on agent_runs.model_def_id
 * (the runner then tries that model first). Today every workstream runs on `reasoning`, so this
 * is the head of the reasoning chain. Task 2 makes a child (`ws.parentId` set) return the head of
 * `resolveSubagentModel(ws.modelLabel)` instead — and the runner must then build the child's
 * chain from resolveSubagentModel too, since reasoningChain() only reorders within `reasoning`.
 * Null (AI not configured) = unpooled; the segment then fails in the runner as it would anyway.
 */
export async function segmentPrimaryModelId(_ws: WorkstreamRow): Promise<string | null> {
  try { return resolveChainFrom(await loadConfig(), 'reasoning')[0]!.modelDefId } catch { return null }
}
