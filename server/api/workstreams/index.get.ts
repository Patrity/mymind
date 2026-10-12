import { listChildrenEmbedded, listWorkstreams, toWorkstreamDTO } from '@mymind/core/lib/agent/workstreams/store'
import { CHILDREN_IN_LIST, type WorkstreamDTO, type WorkstreamState } from '@mymind/core/shared/types/workstreams'

/** Upper bound for `?limit` (a bad or huge value never becomes an unbounded scan). */
const MAX_LIMIT = 100

const STATES: readonly WorkstreamState[] = ['queued', 'running', 'attention', 'paused', 'done', 'failed', 'cancelled']

/**
 * /workstreams list (cycle 81 spec §5.5), newest first. `?state=running,attention` filters.
 * Cycle 83 (spec §6): `limit` and `state` apply to TOP-LEVEL workstreams. Each listed coordinator
 * brings at most CHILDREN_IN_LIST of its children (still-going first, then newest), its `childCount`
 * says how many it has in all, and its `childIds` here are the embedded ones only — the rest come from
 * GET /api/workstreams/:id/children (paged). So the response stays bounded: ≤ 100 × (1 + 20) rows.
 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const states = typeof q.state === 'string'
    ? q.state.split(',').filter((s): s is WorkstreamState => (STATES as readonly string[]).includes(s))
    : undefined
  const limit = Number(q.limit)
  const top = await listWorkstreams({ states, limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_LIMIT) : MAX_LIMIT, topLevel: true })
  const { byParent, counts } = await listChildrenEmbedded(top.filter(r => !r.isChild).map(r => r.id), CHILDREN_IN_LIST)
  const out: WorkstreamDTO[] = []
  for (const r of top) {
    const kids = byParent.get(r.id) ?? []
    out.push(toWorkstreamDTO(r, kids.map(k => k.id), counts.get(r.id) ?? 0))
  }
  for (const r of top) for (const k of byParent.get(r.id) ?? []) out.push(toWorkstreamDTO(k))
  return out
})
