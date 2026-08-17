import { retriageDocument } from '../../../services/triage'

/**
 * Put a document back in the triage sweeper's candidate pool.
 *
 * Explicit and user-initiated by design: `triaged_at` is deliberately NOT cleared when an
 * action is reverted or a proposal rejected, because the sweeper's candidate query is
 * `triaged_at IS NULL` — clearing it automatically would re-propose the same jot within ten
 * minutes, and once a confidence bar drops below 1.0 that becomes an apply → undo →
 * re-apply loop. This endpoint is the way back for a document the user actually wants
 * reconsidered. `retriageDocument` publishes the live-bus change itself.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const res = await retriageDocument(id)
  if (!res.ok) throw createError({ statusCode: 404, statusMessage: res.reason })
  return res
})
