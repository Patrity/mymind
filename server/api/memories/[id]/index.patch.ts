import { z } from 'zod'
import { updateMemory } from '../../../services/memory'
import { publishChange } from '../../../utils/live-bus'

// Minimal content/scope/tags/project edit for a single memory. Wraps the
// existing `updateMemory` service (which re-embeds on a content change, so a
// label edit stays semantically searchable). Added for the Galaxy detail pane
// (Task 3.3) — the only HTTP surface that mutates memory content in place; the
// `memory` live-bus event fans out to the ['graph'] query so the node label
// updates in the galaxy without a manual reload.
const Body = z.object({
  content: z.string().min(1).max(2000).optional(),
  scope: z.enum(['user', 'agent', 'world']).optional(),
  project: z.string().nullish(),
  tags: z.array(z.string().max(100)).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const updated = await updateMemory(id, body)
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  publishChange({ resource: 'memory', action: 'updated', id })
  return updated
})
