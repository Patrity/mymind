import { listWorkstreams, toWorkstreamDTO } from '@mymind/core/lib/agent/workstreams/store'
import type { WorkstreamState } from '@mymind/core/shared/types/workstreams'

const STATES: readonly WorkstreamState[] = ['queued', 'running', 'attention', 'done', 'failed', 'cancelled']

/** /workstreams list (cycle 81 spec §5.5), newest first. `?state=running,attention` filters. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const states = typeof q.state === 'string'
    ? q.state.split(',').filter((s): s is WorkstreamState => (STATES as readonly string[]).includes(s))
    : undefined
  const limit = Number(q.limit)
  const rows = await listWorkstreams({ states, limit: Number.isFinite(limit) && limit > 0 ? limit : 100 })
  return rows.map(toWorkstreamDTO)
})
