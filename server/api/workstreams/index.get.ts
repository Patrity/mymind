import { listWorkstreams, workstreamDTOs } from '@mymind/core/lib/agent/workstreams/store'
import type { WorkstreamState } from '@mymind/core/shared/types/workstreams'

/** Upper bound for `?limit` (a bad or huge value never becomes an unbounded scan). */
const MAX_LIMIT = 100

const STATES: readonly WorkstreamState[] = ['queued', 'running', 'attention', 'paused', 'done', 'failed', 'cancelled']

/** /workstreams list (cycle 81 spec §5.5), newest first. `?state=running,attention` filters. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const states = typeof q.state === 'string'
    ? q.state.split(',').filter((s): s is WorkstreamState => (STATES as readonly string[]).includes(s))
    : undefined
  const limit = Number(q.limit)
  const rows = await listWorkstreams({ states, limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_LIMIT) : MAX_LIMIT })
  return workstreamDTOs(rows)
})
