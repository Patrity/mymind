import { fitBudget, tier, ResidentOverflowError, type Tier } from './budget'
import { rankForContext } from './salience'
import { buildLiveContext } from './context'
import { listResidentMemories, recordRetrievals as realRecordRetrievals, searchMemories } from '../../services/memory'
import { getSkill } from '../../services/skills'
import { useDb } from '../../db'
import { conversations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import type { MemoryDTO } from '../../../shared/types/memory'

export const DEFAULT_CONTEXT_BUDGET = 6000

/**
 * The deleted `buildMemoryContext` raced its search against 1.5s (`Promise.race([search(...),
 * 1500ms])`) so a slow embeddings rig degraded a turn instead of hanging it. `assembleContext`
 * lost that bound: `safe()` (below) only catches a THROW, not a dependency that never resolves,
 * and every await here — resident/live/summary/search/fitBudget — sits on the turn's hot path.
 * This is the same guarantee, moved to wrap the whole assembly rather than just search.
 */
export const ASSEMBLE_TIMEOUT_MS = 1500

/** Degraded result when assembly exceeds its timeout — no memory augmentation this turn, but
 *  the turn itself proceeds instead of hanging. */
const EMPTY_CONTEXT: AssembledContext = { context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 }

/** The old buildMemoryContext's floor: a memory below this relevance is noise, not signal —
 *  it should neither ride into the prompt nor earn a retrieval credit (resident self-nomination
 *  reads that counter, so letting ~0.077-relevance hits through pollutes it). */
export const RETRIEVAL_RELEVANCE_FLOOR = 0.2

/** A skill body larger than this is head/tail trimmed. `fitBudget` THROWS when the fixed
 *  tiers alone exceed the budget — deliberately, so a silently truncated prompt cannot
 *  happen — and a skill too large to fit in a prompt is a skill that needs splitting.
 *  Capping here, rather than raising the budget, is the fix (see assembleContext's skill tier). */
export const SKILL_TIER_MAX_CHARS = 8000

function capSkillBody(body: string): string {
  if (body.length <= SKILL_TIER_MAX_CHARS) return body
  const half = Math.floor(SKILL_TIER_MAX_CHARS / 2)
  return `${body.slice(0, half)}\n\n…\n\n${body.slice(-half)}`
}

export interface AssembleDeps {
  listResident?: () => Promise<MemoryDTO[]>
  search?: (q: string) => Promise<MemoryDTO[]>
  liveContext?: (now: Date) => Promise<string>
  summary?: (conversationId: string) => Promise<string | null>
  recordRetrievals?: (ids: string[]) => Promise<void>
  /** Test-only seam so skill resolution needs no database — defaults to `getSkill(name)`'s body. */
  getSkillBody?: (name: string) => Promise<string | null>
}

export interface AssembleInput {
  /** The user's message. EMPTY on a proactive turn — see synthesiseQuery. */
  userText: string
  conversationId?: string
  /** Project SLUG, not id — `memories.project` stores the slug, and that is what ranking compares. */
  projectSlug?: string
  /** Oldest-first prompt-ready turn blocks, if the caller is managing history text. */
  turns?: Tier[]
  budget?: number
  now?: Date
  /** Overrides ASSEMBLE_TIMEOUT_MS — test-only seam so a hang test doesn't need to wait 1.5s. */
  timeoutMs?: number
  /** Name of a skill the user explicitly invoked (the `/`-command menu's `skill` kind). Resolved
   *  server-side and pushed as a fixed tier — see assembleContext. A name that does not resolve
   *  degrades to an ordinary turn rather than failing it. */
  skill?: string
  deps?: AssembleDeps
}

export interface AssembledContext {
  context: string
  usedMemoryIds: string[]
  used: number
  droppedTurns: number
}

/**
 * A proactive turn has no user message, so there is nothing to embed against — that is the
 * core problem with bolting proactivity onto query-driven retrieval. The session's own rolling
 * summary is a running description of what Tony is doing, which is exactly the query a
 * proactive agent needs and never has. Live state fills in when there is no summary yet.
 */
export function synthesiseQuery(summary: string | null, liveState: string): string {
  return [summary?.trim(), liveState.trim()].filter(Boolean).join('\n').trim()
}

async function loadSummary(conversationId: string): Promise<string | null> {
  const [row] = await useDb().select({ summary: conversations.summary })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  return row?.summary ?? null
}

/** Best-effort: a failing tier degrades to empty rather than losing the whole context. */
async function safe<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn(`[assembleContext] ${label} failed:`, err)
    return fallback
  }
}

/** Public entry point: bounds `assembleContextInner` to `timeoutMs` (default
 *  ASSEMBLE_TIMEOUT_MS) so a hung dependency degrades this turn to no memory context instead
 *  of hanging it indefinitely. See ASSEMBLE_TIMEOUT_MS for why `safe()` alone isn't enough. */
export async function assembleContext(input: AssembleInput): Promise<AssembledContext> {
  const timeoutMs = input.timeoutMs ?? ASSEMBLE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<AssembledContext>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[assembleContext] assembly exceeded ${timeoutMs}ms — degrading to no memory context for this turn`)
      resolve(EMPTY_CONTEXT)
    }, timeoutMs)
  })
  try {
    return await Promise.race([assembleContextInner(input), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function assembleContextInner(input: AssembleInput): Promise<AssembledContext> {
  const d = input.deps ?? {}
  const now = input.now ?? new Date()
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET

  const listResident = d.listResident ?? listResidentMemories
  const search = d.search ?? ((q: string) => searchMemories(q, { limit: 12, reviewed: true }))
  const liveContext = d.liveContext ?? buildLiveContext
  const summaryOf = d.summary ?? loadSummary
  const record = d.recordRetrievals ?? realRecordRetrievals
  const getSkillBody = d.getSkillBody ?? (async (name: string) => (await getSkill(name))?.body ?? null)

  const [resident, liveState, summary, skillBody] = await Promise.all([
    safe(() => listResident(), [] as MemoryDTO[], 'resident'),
    safe(() => liveContext(now), '', 'liveState'),
    input.conversationId
      ? safe(() => summaryOf(input.conversationId!), null as string | null, 'summary')
      : Promise.resolve(null),
    input.skill
      ? safe(() => getSkillBody(input.skill!), null as string | null, 'skill')
      : Promise.resolve(null)
  ])

  const query = input.userText.trim() || synthesiseQuery(summary, liveState)
  const found = query ? await safe(() => search(query), [] as MemoryDTO[], 'search') : []

  // Below this, a hit is noise, not signal — it should neither occupy budget in the prompt
  // nor earn a retrieval credit (resident self-nomination depends on that counter).
  const aboveFloor = found.filter(m => (m.relevance ?? 0) >= RETRIEVAL_RELEVANCE_FLOOR)

  // Resident memories are already in the fixed tier; never pay for them twice.
  const residentIds = new Set(resident.map(m => m.id))
  const deduped = aboveFloor.filter(m => !residentIds.has(m.id))

  // Re-rank on structure before they compete for budget. Semantic relevance alone does not
  // know that one of these contradicts another memory, which is the thing most worth surfacing.
  const contradictedIds = new Set(
    deduped.flatMap(m => (m.relations ?? []).filter(r => r.type === 'contradicts' && r.status === 'active').map(() => m.id))
  )
  const retrieved = rankForContext(deduped, { projectSlug: input.projectSlug, now, contradictedIds })

  const fixed: Tier[] = []
  // First among the fixed tiers: the user asked for this skill by name, so it outranks
  // resident facts if anything has to give (fitBudget never evicts a fixed tier — it either
  // all fits, or the caller's ResidentOverflowError catch below drops every fixed tier at
  // once — so "first" here is about precedence in that all-or-nothing case, not eviction order).
  if (skillBody) {
    fixed.push(tier('skill', `You were explicitly asked to use the "${input.skill}" skill:\n${capSkillBody(skillBody)}`))
  }
  if (resident.length) {
    fixed.push(tier('resident', ['What you know about Tony:', ...resident.map(m => `- ${m.content}`)].join('\n')))
  }
  if (liveState) fixed.push(tier('live', liveState))
  if (summary) fixed.push(tier('summary', `Earlier in this conversation:\n${summary}`))

  const retrievedTiers = retrieved.map(m => tier(`mem:${m.id}`, `- ${m.content}`))

  let fit
  try {
    fit = fitBudget({ fixed, turns: input.turns ?? [], retrieved: retrievedTiers, budget })
  } catch (err) {
    if (!(err instanceof ResidentOverflowError)) throw err
    // The resident tier outgrew its allocation. Loud, but do not take the turn down with it:
    // drop retrieval entirely and let the caller's history stand.
    console.error('[assembleContext] resident tier overflow:', err.message)
    fit = fitBudget({ fixed: [], turns: input.turns ?? [], retrieved: [], budget })
  }

  const usedMemoryIds = fit.kept.retrieved.map(t => t.name.slice('mem:'.length))
  // Fire-and-forget: this must not add its own latency to the turn's hot path (it did, via
  // `await`, before this fix). Still caught so a rejection here can never become an unhandled
  // rejection that takes the process down.
  if (usedMemoryIds.length) {
    record(usedMemoryIds).catch(err => console.warn('[assembleContext] recordRetrievals failed:', err))
  }

  const blocks = [...fit.kept.fixed.map(t => t.text)]
  if (fit.kept.retrieved.length) {
    blocks.push([
      'Possibly relevant memories (background — may be stale or off-target; verify before relying on them):',
      ...fit.kept.retrieved.map(t => t.text)
    ].join('\n'))
  }

  return {
    context: blocks.filter(Boolean).join('\n\n'),
    usedMemoryIds,
    used: fit.used,
    droppedTurns: fit.droppedTurns
  }
}
