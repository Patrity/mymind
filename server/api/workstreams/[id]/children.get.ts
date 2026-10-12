import { childrenOf, workstreamDTOs } from '@mymind/core/lib/agent/workstreams/store'
import { CHILDREN_PAGE_MAX } from '@mymind/core/shared/types/workstreams'
import { requireWorkstreamId } from '../../../utils/workstreams-http'

/**
 * Cycle 83 (spec §6): a coordinator's children, oldest first — the detail page's Children panel and
 * the list's "+N more". Paged: `?limit` (1–200, default 200) and `?offset`; the caller pages until a
 * short page (the coordinator's `childCount` is the total). Empty for a workstream with none.
 */
export default defineEventHandler(async (event) => {
  const id = requireWorkstreamId(event)
  const q = getQuery(event)
  const n = (v: unknown, d: number) => { const x = Math.floor(Number(v)); return Number.isFinite(x) ? x : d }
  const limit = Math.min(CHILDREN_PAGE_MAX, Math.max(1, n(q.limit, CHILDREN_PAGE_MAX)))
  const offset = Math.max(0, n(q.offset, 0))
  return workstreamDTOs(await childrenOf(id, { limit, offset }))
})
