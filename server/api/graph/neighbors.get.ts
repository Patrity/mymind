// Nearest semantic neighbors of a node. Auth-gated by server/middleware/auth.ts
// (only logged-in sessions / API tokens reach here) — same implicit guard as
// index.get.ts; no explicit call needed. Raw vectors never leave getNeighbors.
import { getNeighbors } from '../../services/graph'
import type { GraphNodeType } from '../../../shared/types/graph'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const type = String(q.type) as GraphNodeType
  const id = String(q.id)
  const k = Math.min(20, Number(q.k) || 8)
  return getNeighbors(type, id, k)
})
