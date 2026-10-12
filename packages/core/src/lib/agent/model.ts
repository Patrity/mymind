// server/lib/agent/model.ts
import type { LanguageModel } from 'ai'
import { resolveChain, reorderChain, languageModel } from '../ai/registry/resolve'

/**
 * Ordered AI SDK language models for the reasoning role, each paired with the registry
 * modelDefId that produced it. runAgent tries them in order at stream start (start-only
 * failover). An optional modelDefId reorders the chain so that model is tried first
 * (chosen = primary; the rest stay as failover) — an ephemeral, connection-level override.
 * The modelDefId travels alongside the model so a usage report can stamp which registry
 * entry actually answered (failover-aware — see run.ts's `chosenId`).
 */
export async function reasoningChain(modelDefId?: string | null): Promise<{ model: LanguageModel; modelDefId: string }[]> {
  const chain = reorderChain(await resolveChain('reasoning'), modelDefId)
  return chain.map(m => ({ model: languageModel(m), modelDefId: m.modelDefId }))
}

/**
 * Cycle 83 (spec §3): a CHILD workstream's chain — its `subagents` label's model, the rest of
 * `subagents`, then `reasoning` (runtime/pools.ts childChain) — with the segment's stamped primary
 * first. reasoningChain() only reorders WITHIN `reasoning`, so a child must never go through it.
 */
export async function subagentChain(label: string | null, modelDefId?: string | null): Promise<{ model: LanguageModel; modelDefId: string }[]> {
  const { childChain } = await import('./runtime/pools')
  return reorderChain(await childChain(label), modelDefId).map(m => ({ model: languageModel(m), modelDefId: m.modelDefId }))
}

/** The run's model chain: a child workstream's subagents chain, or the reasoning chain (chat,
 *  jobs, coordinators — coordinators always run on `reasoning`). */
export function agentChain(ctx: { modelDefId?: string | null; subagent?: { label: string | null } }): Promise<{ model: LanguageModel; modelDefId: string }[]> {
  return ctx.subagent ? subagentChain(ctx.subagent.label, ctx.modelDefId) : reasoningChain(ctx.modelDefId)
}
