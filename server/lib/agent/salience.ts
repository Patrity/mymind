import type { MemoryDTO } from '../../../shared/types/memory'

export interface SalienceFeatures {
  relevance: number
  ageDays: number
  projectMatch: boolean
  global: boolean
  contradicted: boolean
  reviewed: boolean
}

/**
 * Explicit constants, NOT a fitted model.
 *
 * There are 45 hand labels in `scripts/data/memory-labels-2026-09-22.jsonl`. A ranker learned
 * from 45 examples would be fitting noise, and weights you can read and argue with beat a model
 * you cannot at this scale. Measured on those labels, an LLM's 4-level value rubric predicted
 * keep-vs-stale at AUC 0.55 — chance — which is why no feature here is a model's opinion of
 * importance. Every one is observable structure.
 */
export const WEIGHTS = {
  relevance: 1.0,
  contradicted: 0.5,
  projectMatch: 0.2,
  global: 0.05,
  unreviewed: -0.3,
  recency: 0.15
} as const

const DAY_MS = 86_400_000

export function extractFeatures(
  m: MemoryDTO,
  ctx: { projectSlug?: string, now: Date, contradictedIds: Set<string> }
): SalienceFeatures {
  const dateStr = m.sourceDate ?? m.createdAt
  const ageDays = Math.max(0, Math.floor((ctx.now.getTime() - new Date(dateStr).getTime()) / DAY_MS))
  return {
    relevance: m.relevance ?? 0,
    ageDays,
    projectMatch: !!ctx.projectSlug && m.project === ctx.projectSlug,
    global: m.applicability === 'global',
    contradicted: ctx.contradictedIds.has(m.id),
    reviewed: m.reviewedAt !== null
  }
}

export function relevanceScore(f: SalienceFeatures): number {
  // Half-life of ~90 days: recent facts win ties, old ones are damped, nothing is excluded
  // on age alone — an old convention can still be exactly right.
  const recency = 1 / (1 + f.ageDays / 90)
  return (
    WEIGHTS.relevance * f.relevance
    + WEIGHTS.recency * recency
    + (f.contradicted ? WEIGHTS.contradicted : 0)
    + (f.projectMatch ? WEIGHTS.projectMatch : 0)
    + (f.global ? WEIGHTS.global : 0)
    + (f.reviewed ? 0 : WEIGHTS.unreviewed)
  )
}

/** Stable sort: equal scores keep input order, so context does not reshuffle between turns. */
export function rankForContext(
  memories: MemoryDTO[],
  ctx: { projectSlug?: string, now: Date, contradictedIds: Set<string> }
): MemoryDTO[] {
  return memories
    .map((m, i) => ({ m, i, score: relevanceScore(extractFeatures(m, ctx)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.m)
}
