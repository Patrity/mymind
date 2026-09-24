import { fitBudget, tier, ResidentOverflowError, type Tier } from './budget'
import { rankForContext } from './salience'
import { buildLiveContext } from './context'
import { listResidentMemories, recordRetrievals as realRecordRetrievals, searchMemories } from '../../services/memory'
import { useDb } from '../../db'
import { conversations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import type { MemoryDTO } from '../../../shared/types/memory'

export const DEFAULT_CONTEXT_BUDGET = 6000

export interface AssembleDeps {
  listResident?: () => Promise<MemoryDTO[]>
  search?: (q: string) => Promise<MemoryDTO[]>
  liveContext?: (now: Date) => Promise<string>
  summary?: (conversationId: string) => Promise<string | null>
  recordRetrievals?: (ids: string[]) => Promise<void>
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

export async function assembleContext(input: AssembleInput): Promise<AssembledContext> {
  const d = input.deps ?? {}
  const now = input.now ?? new Date()
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET

  const listResident = d.listResident ?? listResidentMemories
  const search = d.search ?? ((q: string) => searchMemories(q, { limit: 12, reviewed: true }))
  const liveContext = d.liveContext ?? buildLiveContext
  const summaryOf = d.summary ?? loadSummary
  const record = d.recordRetrievals ?? realRecordRetrievals

  const [resident, liveState, summary] = await Promise.all([
    safe(() => listResident(), [] as MemoryDTO[], 'resident'),
    safe(() => liveContext(now), '', 'liveState'),
    input.conversationId
      ? safe(() => summaryOf(input.conversationId!), null as string | null, 'summary')
      : Promise.resolve(null)
  ])

  const query = input.userText.trim() || synthesiseQuery(summary, liveState)
  const found = query ? await safe(() => search(query), [] as MemoryDTO[], 'search') : []

  // Resident memories are already in the fixed tier; never pay for them twice.
  const residentIds = new Set(resident.map(m => m.id))
  const deduped = found.filter(m => !residentIds.has(m.id))

  // Re-rank on structure before they compete for budget. Semantic relevance alone does not
  // know that one of these contradicts another memory, which is the thing most worth surfacing.
  const contradictedIds = new Set(
    deduped.flatMap(m => (m.relations ?? []).filter(r => r.type === 'contradicts' && r.status === 'active').map(() => m.id))
  )
  const retrieved = rankForContext(deduped, { projectSlug: input.projectSlug, now, contradictedIds })

  const fixed: Tier[] = []
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
  if (usedMemoryIds.length) await safe(() => record(usedMemoryIds), undefined, 'recordRetrievals')

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
